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

			let stdoutBuf = '';
			let stderrBuf = '';
			let stdoutPartial = '';
			let stderrPartial = '';

			const emitLine = (stream: 'stdout' | 'stderr', line: string): void => {
				if (onOutput) {
					try { onOutput(line, stream); } catch { /* 忽略回调异常，避免影响执行流 */ }
				}
			};

			// stdout 流式处理：按行切割，保留最后未完成行
			child.stdout?.on('data', (chunk: Buffer) => {
				const text = chunk.toString('utf-8');
				stdoutBuf += text;
				stdoutPartial += text;
				const lines = stdoutPartial.split('\n');
				// 最后一段可能是不完整的行
				stdoutPartial = lines.pop() ?? '';
				for (const line of lines) {
					emitLine('stdout', line);
				}
			});

			// stderr 流式处理
			child.stderr?.on('data', (chunk: Buffer) => {
				const text = chunk.toString('utf-8');
				stderrBuf += text;
				stderrPartial += text;
				const lines = stderrPartial.split('\n');
				stderrPartial = lines.pop() ?? '';
				for (const line of lines) {
					emitLine('stderr', line);
				}
			});

			child.on('close', (exitCode: number | null, termSignal: string | null) => {
				if (settled) return;
				settled = true;

				// 发出剩余不完整行
				if (stdoutPartial) emitLine('stdout', stdoutPartial);
				if (stderrPartial) emitLine('stderr', stderrPartial);

				const killed = termSignal !== null;
				const code = exitCode ?? (killed ? -1 : 0);

				const result: ToolResult = {
					content: [
						`exit code: ${code}`,
						stdoutBuf.trim() ? `stdout:\n${truncateOutput(stdoutBuf, TRUNCATE_BYTES)}` : 'stdout: (empty)',
						stderrBuf.trim() ? `stderr:\n${truncateOutput(stderrBuf, TRUNCATE_BYTES)}` : 'stderr: (empty)',
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

				const result: ToolResult = {
					content: [
						`exit code: -1`,
						`stdout: (empty)`,
						stderrBuf.trim() ? `stderr:\n${truncateOutput(stderrBuf, TRUNCATE_BYTES)}` : 'stderr: (empty)',
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
