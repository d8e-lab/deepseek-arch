/**
 * ShellTool — 执行 shell 命令
 *
 * 安全约束：
 *   1. 禁止 sudo
 *   2. 工作目录限制为指定目录或其子目录
 *   3. 超时 10 分钟
 *   4. stdin → /dev/null（不支持交互式命令）
 *   5. stdout/stderr 各截断至最后 8192 字节
 *   6. 返回退出码 + killed 标记
 */

import { spawn } from 'node:child_process';
import { resolve, relative } from 'node:path';
import type { Tool, ToolResult } from './types.js';
import { isInteractiveCommand } from './utils.js';

/** 单侧输出截断字节数 */
const TRUNCATE_BYTES = 8192;
/** 命令超时 (10 分钟) */
const CMD_TIMEOUT_MS = 10 * 60 * 1000;

/** 截断字节串：保留最后 N 字节，前缀 “... (truncated)” */
function truncateOutput(raw: string, maxBytes: number): string {
	const buf = Buffer.from(raw, 'utf-8');
	if (buf.length <= maxBytes) return raw;
	const suffix = buf.subarray(buf.length - maxBytes);
	return `... (truncated)\n${Buffer.from(suffix).toString('utf-8')}`;
}

export const shellTool: Tool = {
	name: 'execute_command',
	description:
		'执行 shell 命令。文件操作有专属工具（read_file/edit_file/write_file/search_content），仅在无专属工具覆盖时才用本工具。典型适用场景：git、npm/pip、测试运行、构建脚本、权限修改等系统操作。禁止 sudo。默认工作目录为会话目录。',
	parameters: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: '要执行的 shell 命令（非交互式）',
			},
			cwd: {
				type: 'string',
				description: '工作目录（必须为会话目录的子目录，默认为会话目录）',
			},
		},
		required: ['command'],
	},
	requiresConfirm: true,

	async execute(
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onOutput?: (line: string, stream: 'stdout' | 'stderr') => void,
	): Promise<ToolResult> {
		const command = String(params.command ?? '');
		const cwdParam = params.cwd ? String(params.cwd) : undefined;

		if (!command.trim()) {
			return { content: '', error: 'empty command' };
		}

		// ── sudo 禁止 ──────────────────────────────
		if (/\bsudo\b/.test(command)) {
			return { content: '', error: 'sudo is forbidden' };
		}

		// ── 交互式命令禁止 ──────────────────────────
		const interactiveBlocked = isInteractiveCommand(command);
		if (interactiveBlocked) {
			return { content: '', error: interactiveBlocked };
		}

		// ── 工作目录校验 ──────────────────────────
		const sessionCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();
		let workDir = sessionCwd;
		if (cwdParam) {
			const resolved = resolve(sessionCwd, cwdParam);
			// 必须在 sessionCwd 或其子目录内
			const rel = relative(sessionCwd, resolved);
			if (rel.startsWith('..') || rel === '') {
				// 允许 sessionCwd 本身 (rel === '') 和子目录
				workDir = resolved;
			} else if (resolved === sessionCwd) {
				workDir = resolved;
			} else {
				return { content: '', error: `directory outside workspace: ${cwdParam}` };
			}
		}

		// ── 执行 ──────────────────────────────────
		// 如果 signal 已提前 abort，直接抛出，不启动子进程
		if (signal?.aborted) {
			const err = new Error('The operation was aborted');
			err.name = 'AbortError';
			throw err;
		}

		return new Promise((resolveResult, reject) => {
			let settled = false;
			const child = spawn('/bin/bash', ['-c', command], {
				cwd: workDir,
				timeout: CMD_TIMEOUT_MS,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			// 立即关闭 stdin
			child.stdin?.end();

			const emitLine = (stream: 'stdout' | 'stderr', line: string): void => {
				if (onOutput) {
					try { onOutput(line, stream); } catch { /* 忽略回调异常 */ }
				}
			};

			/**
			 * 处理流数据：\n 触发发出，\r 合并进度条段，超时兜底。
			 * @param stream  stdout 或 stderr
			 * @param text    新到达的数据块
			 * @param fullBuf 完整缓冲区（收集所有数据）
			 * @param pending 未完成行暂存
			 * @param timer   超时定时器引用
			 */
			const processChunk = (
				stream: 'stdout' | 'stderr',
				text: string,
				fullBuf: { buf: string },
				pending: { val: string },
				timer: { ref: ReturnType<typeof setTimeout> | null },
			): void => {
				fullBuf.buf += text;
				pending.val += text;

				// 按 \n 分割：完整行立即发出
				const newlineParts = pending.val.split('\n');
				pending.val = newlineParts.pop() ?? '';

				for (const part of newlineParts) {
					if (!part) continue;
					// 段内可能含 \r（进度条中间态）→ 只保留最后一段
					if (part.includes('\r')) {
						const crParts = part.split('\r');
						const last = crParts[crParts.length - 1];
						if (last) emitLine(stream, last);
					} else {
						emitLine(stream, part);
					}
				}

				// 重置超时：200ms 无新数据则发出当前暂存行
				if (timer.ref) clearTimeout(timer.ref);
				timer.ref = setTimeout(() => {
					if (pending.val) {
						// 可能含 \r（进度条未以 \n 结束时）→ 只保留最后一段
						if (pending.val.includes('\r')) {
							const crParts = pending.val.split('\r');
							const last = crParts[crParts.length - 1];
							if (last) emitLine(stream, last);
						} else {
							emitLine(stream, pending.val);
						}
						pending.val = '';
					}
					timer.ref = null;
				}, 200);
			};

			const stdoutFull = { buf: '' };
			const stderrFull = { buf: '' };
			const stdoutPend = { val: '' };
			const stderrPend = { val: '' };
			const stdoutTmr = { ref: null as ReturnType<typeof setTimeout> | null };
			const stderrTmr = { ref: null as ReturnType<typeof setTimeout> | null };

			child.stdout?.on('data', (chunk: Buffer) => {
				processChunk('stdout', chunk.toString('utf-8'), stdoutFull, stdoutPend, stdoutTmr);
			});

			child.stderr?.on('data', (chunk: Buffer) => {
				processChunk('stderr', chunk.toString('utf-8'), stderrFull, stderrPend, stderrTmr);
			});

			child.on('close', (exitCode: number | null, termSignal: string | null) => {
				if (settled) return;
				settled = true;

				// 清除定时器，发出剩余暂存行（\r 合并为最后一段）
				if (stdoutTmr.ref) { clearTimeout(stdoutTmr.ref); stdoutTmr.ref = null; }
				if (stderrTmr.ref) { clearTimeout(stderrTmr.ref); stderrTmr.ref = null; }
				const flushPending = (stream: 'stdout' | 'stderr', p: string): void => {
					if (!p) return;
					if (p.includes('\r')) {
						const parts = p.split('\r');
						const last = parts[parts.length - 1];
						if (last) emitLine(stream, last);
					} else {
						emitLine(stream, p);
					}
				};
				flushPending('stdout', stdoutPend.val); stdoutPend.val = '';
				flushPending('stderr', stderrPend.val); stderrPend.val = '';

				const killed = termSignal !== null;
				const code = exitCode ?? (killed ? -1 : 0);

				const result: ToolResult = {
					content: [
						`exit code: ${code}`,
						stdoutFull.buf.trim() ? `stdout:\n${truncateOutput(stdoutFull.buf, TRUNCATE_BYTES)}` : 'stdout: (empty)',
						stderrFull.buf.trim() ? `stderr:\n${truncateOutput(stderrFull.buf, TRUNCATE_BYTES)}` : 'stderr: (empty)',
						killed ? '(killed by signal)' : '',
					]
						.filter(Boolean)
						.join('\n'),
				};

				resolveResult(result);
			});

			child.on('error', (err: Error) => {
				if (settled) return;
				settled = true;

				if (stdoutTmr.ref) { clearTimeout(stdoutTmr.ref); stdoutTmr.ref = null; }
				if (stderrTmr.ref) { clearTimeout(stderrTmr.ref); stderrTmr.ref = null; }

				const result: ToolResult = {
					content: [
						`exit code: -1`,
						`stdout: (empty)`,
						stderrFull.buf.trim() ? `stderr:\n${truncateOutput(stderrFull.buf, TRUNCATE_BYTES)}` : 'stderr: (empty)',
						err.message ? `error: ${err.message}` : '',
					]
						.filter(Boolean)
						.join('\n'),
					error: err.message,
				};

				resolveResult(result);
			});

			// 监听外部 AbortSignal，终止子进程并 reject
			if (signal) {
				const onAbort = () => {
					child.kill('SIGTERM');
					setTimeout(() => {
						if (!child.killed) child.kill('SIGKILL');
					}, 1000);
					if (!settled) {
						settled = true;
						const err = new Error('The operation was aborted');
						err.name = 'AbortError';
						reject(err);
					}
				};
				signal.addEventListener('abort', onAbort, { once: true });
			}
		});
	},
};
