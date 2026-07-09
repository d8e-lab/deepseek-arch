/**
 * Tools 共享工具 — 路径校验、二进制检测、交互命令拦截
 */

import { resolve, relative, normalize, isAbsolute, basename } from 'node:path';
import { stat, open } from 'node:fs/promises';

const IS_WINDOWS = process.platform === 'win32';

/** 搜索时默认跳过的目录 */
export const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'coverage',
	'__pycache__',
	'.next',
	'.nuxt',
	'build',
	'.cache',
]);

/** 路径校验结果 */
export type PathCheck =
	| { valid: true; resolved: string }
	| { valid: false; error: string };

/** 校验路径必须在 sessionCwd 或其子目录内 */
export function checkPath(inputPath: string, sessionCwd: string): PathCheck {
	const normalized = normalize(inputPath);
	const resolved = resolve(sessionCwd, normalized);
	const rel = relative(sessionCwd, resolved);
	if (rel.startsWith('..')) {
		return { valid: false, error: `path outside workspace: ${inputPath}` };
	}
	// 跨盘符（Windows）或非子目录路径
	if (isAbsolute(rel)) {
		return { valid: false, error: `path outside workspace: ${inputPath}` };
	}
	return { valid: true, resolved };
}

/** 检测前 4096 字节是否含 null byte（二进制文件） */
export async function isBinaryFile(filePath: string): Promise<boolean> {
	let fd: Awaited<ReturnType<typeof open>> | null = null;
	try {
		fd = await open(filePath, 'r');
		const buf = Buffer.alloc(4096);
		const { bytesRead } = await fd.read(buf, 0, 4096, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (buf[i] === 0) return true;
		}
		return false;
	} catch {
		return false;
	} finally {
		if (fd) await fd.close();
	}
}

// ─── 交互式命令拦截 ─────────────────────────────

/**
 * 无条件阻塞的交互式命令（无论参数如何，总是需要 TTY）
 * 命令名直接在此集合中即被阻塞。
 */
const ALWAYS_INTERACTIVE = IS_WINDOWS
	? new Set([
		'diskpart',   // Windows 磁盘管理
		'ftp',        // 交互式 FTP 客户端
	])
	: new Set([
		'less',
		'more',
		'most',
		'vim',
		'vi',
		'nvim',
		'nano',
		'emacs',
		'ne',
		'top',
		'htop',
		'btop',
		'atop',
		'glances',
		'ssh',
		'telnet',
		'mosh',
		'dialog',
		'whiptail',
		'gdb',
		'lldb',
		'watch',
		'man',
		'info',
	]);

/**
 * 条件阻塞：仅当没有有效"脚本/命令参数"时视为交互式 REPL
 * key = 命令名, value = 表示"有脚本"的 flag 前缀集合
 * Windows 上 PowerShell -Command 天然非交互，此表仅用于 Linux/macOS。
 */
const REPL_COMMANDS: Record<string, string[]> = IS_WINDOWS
	? {}
	: {
		python: ['-c', '-m', '--'],
		python3: ['-c', '-m', '--'],
		node: ['-e', '-p', '--eval', '--print', '-r', '--require', '--'],
		irb: ['-e', '-r', '--'],
		lua: ['-e', '-l', '--'],
		psql: ['-c', '-f', '-d', '--command', '--file', '--dbname'],
		mysql: ['-e', '--execute'],
		sqlite3: [], // 仅当参数含有 .db/.sqlite 文件时才视为非交互
		'redis-cli': [], // 仅当参数非空且不以 - 开头才视为有命令
		bash: ['-c'],
		zsh: ['-c'],
		fish: ['-c'],
		sh: ['-c'],
	};

/** 检查命令名（首词）是否为无条件交互式 */
function isAlwaysInteractive(cmdName: string): boolean {
	return ALWAYS_INTERACTIVE.has(cmdName);
}

/** 检查 REPL 类命令是否有非交互参数 */
function hasScriptArgs(cmdName: string, args: string[]): boolean {
	const flags = REPL_COMMANDS[cmdName];
	if (!flags) return true; // 不在表中 → 不放行

	// 空参数列表 → 视为 REPL 模式（如纯 `python`）
	if (args.length === 0) return false;

	// 特殊处理 sqlite3：有 .db/.sqlite 文件参数 ≡ 非交互
	if (cmdName === 'sqlite3') {
		return args.some((a) => !a.startsWith('-') && (a.endsWith('.db') || a.endsWith('.sqlite')));
	}

	// 特殊处理 redis-cli：有位置参数（非 flag）≡ 有命令
	if (cmdName === 'redis-cli') {
		return args.some((a) => !a.startsWith('-'));
	}

	// 通用检测：参数中包含已知 flag 即视为非交互（flag 后可能跟值）
	for (const flag of flags) {
		if (args.includes(flag)) return true;
		// 如 `-c "print(1)"` 这种 flag+value 合并的情况
		if (flag.length > 1) {
			for (const a of args) {
				if (a.startsWith(flag)) return true;
			}
		}
	}

	// 参数以 .py / .js / .sql 等脚本文件结尾 → 非交互
	const scriptExts = ['.py', '.js', '.mjs', '.cjs', '.ts', '.lua', '.rb', '.sql', '.sh'];
	if (args.some((a) => scriptExts.some((ext) => a.endsWith(ext)))) {
		return true;
	}

	return false;
}

/**
 * 检测 shell 命令是否需要终端交互。
 * 返回 null 表示安全（非交互），否则返回错误信息。
 *
 * 解析规则：
 *   1. 取首词（去掉路径前缀 /usr/bin/ 等）
 *   2. 首词在 ALWAYS_INTERACTIVE 中 → 阻塞
 *   3. 首词在 REPL_COMMANDS 中但无脚本参数 → 阻塞
 *   4. 此外放行
 */
export function isInteractiveCommand(command: string): string | null {
	const trimmed = command.trim();

	// 跳过前导环境变量设置: FOO=bar cmd → cmd
	const envStripped = trimmed.replace(/^(\s*\w+=\S+\s+)+/, '').trim();

	// 解析管线和运算符，检查所有分段
	const segments = splitPipeSegments(envStripped);

	for (const seg of segments) {
		const tokens = seg.trim().split(/\s+/);
		if (tokens.length === 0) continue;

		const cmdName = basename(tokens[0]);

		if (isAlwaysInteractive(cmdName)) {
			return `interactive command blocked: ${cmdName}`;
		}

		if (cmdName in REPL_COMMANDS) {
			const args = tokens.slice(1);
			if (!hasScriptArgs(cmdName, args)) {
				return `interactive command blocked: ${cmdName} (REPL mode, provide a script or -c flag)`;
			}
		}
	}

	return null;
}

/**
 * 按 && | || ; 分割命令，以便检查每个子命令
 * 注意：不处理引号内特殊字符，简单 split 足够（命令名不可能含这些字符）
 */
function splitPipeSegments(command: string): string[] {
	// 先按 && 分
	const segments: string[] = [];
	let current = '';
	// 简单状态机：跟踪单引号/双引号
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
		} else if (!inSingle && !inDouble) {
			// 检测分隔符
			if (ch === '&' && command[i + 1] === '&') {
				segments.push(current);
				current = '';
				i++; // skip second &
				continue;
			}
			if (ch === '|' && command[i + 1] === '|') {
				segments.push(current);
				current = '';
				i++;
				continue;
			}
			if (ch === '|' && command[i + 1] !== '|') {
				// 纯管道 | 不分割——管道的目标命令同样应该被检查
				// 先 finish 当前段，但不 reset（管道左右合并检查）
				segments.push(current);
				current = '';
				continue;
			}
			if (ch === ';') {
				segments.push(current);
				current = '';
				continue;
			}
		}
		current += ch;
	}
	if (current.trim()) segments.push(current);

	return segments;
}
