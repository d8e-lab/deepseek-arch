/**
 * ShellTool — 执行 shell / PowerShell 命令
 *
 * 平台适配：
 *   - Linux/macOS: /bin/bash -c
 *   - Windows:      powershell.exe -Command (fallback cmd.exe /c)
 *
 * 安全约束：
 *   1. 禁止 sudo
 *   2. 工作目录限制为指定目录或其子目录
 *   3. 超时 10 分钟
 *   4. stdin → /dev/null（不支持交互式命令）
 *   5. stdout/stderr 各截断至最后 8192 字节
 *   6. 返回退出码 + killed 标记
 *   7. 命令自成进程组：超时/中止时杀掉整组，避免后台子进程逃逸
 *   8. 命令结束后仍有子进程占住管道时，按 graceMs 兜底收尾（不永久挂起）
 *
 * 进程组与收尾语义（R-fix）：
 *   `spawn({ timeout })` 单独使用不可靠——父 shell 退出后它已不存在，
 *   到点 kill 打空、SIGKILL 升级被取消，而 `close` 要等所有子进程关闭
 *   继承来的 stdout/stderr 管道才会触发，于是工具调用会永久挂起。
 *   因此这里改为：detached 建组 + 自己的超时定时器 + 组级 kill +
 *   exit 后的管道排空兜底。
 */

import { spawn, execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolve, relative } from 'node:path';
import type { Tool, ToolResult } from './types.js';

/** 单侧输出截断字节数 */
const TRUNCATE_BYTES = 8192;
/** 命令超时 (10 分钟) */
const CMD_TIMEOUT_MS = 10 * 60 * 1000;
/** SIGTERM → SIGKILL 宽限期 */
export const KILL_GRACE_MS = 3000;
/** 命令已退出、但仍有子进程占住管道时的排水兜底时长 */
export const PIPE_DRAIN_GRACE_MS = 3000;

const IS_WINDOWS = process.platform === 'win32';

/**
 * 杀掉整棵进程树。
 * POSIX 用负 PID 打整个进程组（命令已 detached 成组长）；Windows 用 taskkill /T。
 * 从不抛错：进程可能已退出（ESRCH），或组已不存在。
 * @param childId 子进程 pid（即进程组 id）
 * @param signal  POSIX 信号，默认 SIGKILL
 */
export function killProcessGroup(childId: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
	if (childId === undefined) return;
	if (IS_WINDOWS) {
		try {
			execFileSync('taskkill', ['/pid', String(childId), '/T', '/F'], { stdio: 'ignore' });
		} catch { /* 进程树已退出 */ }
		return;
	}
	try {
		process.kill(-childId, signal);
	} catch { /* ESRCH：组已不存在 */ }
}

/**
 * 让 spawn 返回的 child.kill() 也作用于整个进程组，保留 Node 内建
 * AbortSignal 支持（它内部只对直接子进程发信号）。
 * @param child  spawn 返回的子进程
 * @param signal 要转发的信号
 */
export function killTree(child: { pid?: number | undefined; kill: (signal?: NodeJS.Signals) => boolean }, signal?: NodeJS.Signals): boolean {
	killProcessGroup(child.pid, signal ?? 'SIGKILL');
	return true;
}

/**
 * Windows PowerShell 编码前缀：
 *  - `[Console]::OutputEncoding=UTF8`：PS 5.1 写重定向 stdout/stderr 管道时按 UTF-8 编码；
 *  - `$OutputEncoding=UTF8`：PS 将字符串管道给子进程（输入侧）时按 UTF-8；
 *  - `chcp 65001`：修正 cmd 内建命令 / CRT 工具的输出代码页（无控制台时失败被吞掉，无害）。
 * 配合 Node 端统一按 UTF-8 解码，避免 Windows 默认 OEM 代码页（GBK/CP437）造成的乱码。
 */
export const PS_ENCODING_PREAMBLE =
	'$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 2>$null | Out-Null; ';

/**
 * 构造 spawn 用的可执行文件与参数。
 * Windows 下注入编码前缀并禁用 profile（避免用户 profile 注入额外输出干扰解析）。
 * @param command 原始命令
 * @param platform 平台（可注入以便测试 win32 分支），默认取当前进程平台
 */
export function buildInvocation(
	command: string,
	platform: NodeJS.Platform = process.platform,
): { bin: string; args: string[] } {
	if (platform === 'win32') {
		return {
			bin: 'powershell.exe',
			args: ['-NoProfile', '-NonInteractive', '-Command', PS_ENCODING_PREAMBLE + command],
		};
	}
	return { bin: '/bin/bash', args: ['-c', command] };
}

/** 截断字节串：保留最后 N 字节（对齐 UTF-8 字符边界），前缀 "... (truncated)" */
function truncateOutput(raw: string, maxBytes: number): string {
	const buf = Buffer.from(raw, 'utf-8');
	if (buf.length <= maxBytes) return raw;
	// 截断点可能落在多字节字符中间：跳过 continuation 字节（10xxxxxx），
	// 从完整字符边界开始保留，避免截断边界处解码出 U+FFFD。
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
	const suffix = buf.subarray(start);
	return `... (truncated)\n${Buffer.from(suffix).toString('utf-8')}`;
}

export const shellTool: Tool = {
	name: 'execute_command',
	description: IS_WINDOWS
		? '执行 PowerShell 命令。文件操作有专属工具（read_file/edit_file/write_file/search_content），仅在无专属工具覆盖时才用本工具。典型适用场景：git、npm/pip、测试运行、构建脚本、权限修改等系统操作。注意：命令在 PowerShell 中执行，请使用 PowerShell 语法（如 Get-ChildItem 而非 ls，Select-String 而非 grep，Get-Content 而非 cat）。默认工作目录为会话目录。'
		: '执行 shell 命令。文件操作有专属工具（read_file/edit_file/write_file/search_content），仅在无专属工具覆盖时才用本工具。典型适用场景：git、npm/pip、测试运行、构建脚本、权限修改等系统操作。禁止 sudo。默认工作目录为会话目录。',
	parameters: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: IS_WINDOWS
					? '要执行的 PowerShell 命令（非交互式）'
					: '要执行的 shell 命令（非交互式）',
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
		if (!IS_WINDOWS && /\bsudo\b/.test(command)) {
			return { content: '', error: 'sudo is forbidden' };
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

		const { bin, args } = buildInvocation(command);

		return new Promise((resolveResult, reject) => {
			let settled = false;
			// detached：命令自成进程组（组长），后续可用 kill(-pid) 清掉整棵树。
			const child = spawn(bin, args, {
				cwd: workDir,
				detached: !IS_WINDOWS,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			// Node 内建的 timeout/AbortSignal 只对直接子进程发信号；这里改写成组级。
			child.kill = (signal?: NodeJS.Signals): boolean => killTree(child, signal);

			// 立即关闭 stdin
			child.stdin?.end();

			/** 命令退出后的排水兜底定时器 */
			let drainTimer: ReturnType<typeof setTimeout> | null = null;
			/** 超时 / 中止的终止流程是否已启动 */
			let terminating = false;

			/**
			 * 终止整棵进程树：先 SIGTERM，宽限期后升级 SIGKILL。
			 * 幂等——超时与中止同时发生也只会走一遍。
			 */
			const terminateTree = (): void => {
				if (terminating) return;
				terminating = true;
				killProcessGroup(child.pid, IS_WINDOWS ? undefined : 'SIGTERM');
				setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref?.();
			};

			const timeoutTimer = setTimeout(terminateTree, CMD_TIMEOUT_MS);
			timeoutTimer.unref?.();

			/** 收尾：清定时器 + 终止残留进程树 */
			const cleanup = (): void => {
				clearTimeout(timeoutTimer);
				if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
				killProcessGroup(child.pid, 'SIGKILL');
			};

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

			// 流式 UTF-8 解码：逐 chunk 直接 toString 会把落在 chunk 边界的多字节字符切成 U+FFFD，
			// StringDecoder 内部保留跨块状态，保证多字节字符完整解码。
			const stdoutDecoder = new StringDecoder('utf8');
			const stderrDecoder = new StringDecoder('utf8');

			/** 冲刷 decoder 尾串（end() 只能调用一次，须在 settled 置位后的收尾路径执行） */
			const flushDecoders = (): void => {
				const tailOut = stdoutDecoder.end();
				if (tailOut) { stdoutFull.buf += tailOut; stdoutPend.val += tailOut; }
				const tailErr = stderrDecoder.end();
				if (tailErr) { stderrFull.buf += tailErr; stderrPend.val += tailErr; }
			};

			child.stdout?.on('data', (chunk: Buffer) => {
				processChunk('stdout', stdoutDecoder.write(chunk), stdoutFull, stdoutPend, stdoutTmr);
			});

			child.stderr?.on('data', (chunk: Buffer) => {
				processChunk('stderr', stderrDecoder.write(chunk), stderrFull, stderrPend, stderrTmr);
			});

			/**
			 * 命令已结束、管道仍未关闭时的兜底：exit/close 都可能先到，
			 * 由这个定时器保证 Promise 一定收尾（这是"永久挂起"的解药）。
			 */
			let exitFacts: { code: number | null; signal: string | null } | null = null;
			let drainArmed = false;

			child.on('exit', (code: number | null, signal: string | null) => {
				exitFacts = { code, signal };
				if (settled || drainArmed) return;
				// close 事件仍在等继承管道的子进程；给一个宽限期，
				// 超时即按已拿到的退出状态收尾，并清掉残留进程树。
				drainArmed = true;
				drainTimer = setTimeout(() => {
					drainTimer = null;
					finish(exitFacts?.code ?? null, exitFacts?.signal ?? null);
				}, PIPE_DRAIN_GRACE_MS);
				drainTimer.unref?.();
			});

			child.on('close', (exitCode: number | null, termSignal: string | null) => {
				finish(exitCode, termSignal);
			});

			/**
			 * 统一收尾：发出剩余暂存行、冲刷解码器、构造结果并 resolve。
			 * close 与排水兜底两条路径共用，`settled` 保证只执行一次。
			 * @param exitCode    退出码（null 表示被信号终止）
			 * @param termSignal  终止信号
			 */
			function finish(exitCode: number | null, termSignal: string | null): void {
				if (settled) return;
				settled = true;
				cleanup();

				// 清除定时器，发出剩余暂存行（\r 合并为最后一段）
				if (stdoutTmr.ref) { clearTimeout(stdoutTmr.ref); stdoutTmr.ref = null; }
				if (stderrTmr.ref) { clearTimeout(stderrTmr.ref); stderrTmr.ref = null; }

				// 冲刷 decoder 尾串（跨块残留在缓冲区中的字符），随后统一 flush
				flushDecoders();

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
			}

			child.on('error', (err: Error) => {
				if (settled) return;
				settled = true;
				cleanup();

				if (stdoutTmr.ref) { clearTimeout(stdoutTmr.ref); stdoutTmr.ref = null; }
				if (stderrTmr.ref) { clearTimeout(stderrTmr.ref); stderrTmr.ref = null; }

				// spawn 失败时通常无流数据，end() 返回空串；此处保证 end() 恰好执行一次
				flushDecoders();

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

			// 监听外部 AbortSignal，终止整棵进程树（Windows 走 taskkill /T）
			if (signal) {
				const onAbort = () => {
					terminateTree();
					if (!settled) {
						settled = true;
						cleanup();
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
