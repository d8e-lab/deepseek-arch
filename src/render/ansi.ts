/**
 * ANSI 样式与文本工具（纯计算，无 I/O）
 *
 * 从 src/cli/tui/renderer.ts 拆分：
 * - 本文件：样式、diff 渲染、CJK 宽度、ANSI 剥离等纯函数（渲染 SDK 用）
 * - 终端 I/O（尺寸/光标/清屏）见 src/presentation/terminal.ts
 */

// ─── 样式 ─────────────────────────────────────────

export function resetStyle(): string {
	return '\x1b[0m';
}

export function bold(text: string): string {
	return `\x1b[1m${text}\x1b[0m`;
}

export function dim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

/** 灰色背景（输入框） */
export function grayBg(text: string): string {
	return `\x1b[48;5;238m${text}\x1b[0m`;
}

/** 灰色背景起始/结束（用于多行渲染） */
export const GRAY_BG_START = '\x1b[48;5;238m';
export const GRAY_BG_END = '\x1b[0m';

/** 粉紫色背景（shell 命令模式输入框） */
export const PINK_BG_START = '\x1b[48;5;133m';
export const PINK_BG_END = '\x1b[0m';

/** 前景色 */
export function cyan(text: string): string {
	return `\x1b[36m${text}\x1b[0m`;
}

export function green(text: string): string {
	return `\x1b[32m${text}\x1b[0m`;
}

export function yellow(text: string): string {
	return `\x1b[33m${text}\x1b[0m`;
}

export function red(text: string): string {
	return `\x1b[31m${text}\x1b[0m`;
}

// ─── Diff 渲染（背景色）───────────────────────────

/** 深绿色背景（新增行） */
export const GREEN_BG_START = '\x1b[48;5;22m';
/** 深红色背景（删除行） */
export const RED_BG_START = '\x1b[48;5;52m';

/**
 * 渲染一行 diff——根据行前缀选择颜色
 * - "+" → 绿底
 * - "-" → 红底
 * - "@@" → cyan dim
 * - "---" / "+++" → dim
 * - 其他 → dim
 */
export function renderDiffLine(line: string, indent: string): string {
	if (line.startsWith('+')) {
		return GREEN_BG_START + indent + line + '\x1b[0m';
	}
	if (line.startsWith('-')) {
		return RED_BG_START + indent + line + '\x1b[0m';
	}
	return dim(indent + line);
}

// ─── CJK 字符宽度 ─────────────────────────────────

/**
 * 判断字符是否为 CJK 宽字符（显示宽度 = 2）
 * 覆盖 CJK Unified Ideographs、CJK Symbols、全角形式、emoji（F-7）
 */
export function isWideChar(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
		(code >= 0x2329 && code <= 0x232a) || // Angle brackets
		(code >= 0x2e80 && code <= 0x303e) || // CJK Radicals / Symbols
		(code >= 0x3040 && code <= 0x33bf) || // Hiragana, Katakana, Bopomofo, Hangul Compatibility Jamo, Kanbun
		(code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
		(code >= 0x4e00 && code <= 0xa4cf) || // CJK Unified Ideographs + Yi
		(code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
		(code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
		(code >= 0xfe10 && code <= 0xfe6f) || // Vertical forms, CJK Compatibility Forms, Small Form Variants
		(code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
		(code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
		(code >= 0x1f000 && code <= 0x1faff) || // Emoji（含部分符号/旗帜/补充符号，F-7）
		(code >= 0x20000 && code <= 0x2ffff) || // CJK Unified Ideographs Extension B+
		(code >= 0x30000 && code <= 0x3ffff) // CJK Unified Ideographs Extension G+
	);
}

/** 计算字符显示宽度（CJK = 2，其他 = 1） */
export function charDisplayWidth(ch: string): number {
	const code = ch.codePointAt(0) ?? 0;
	// 控制字符宽度为 0
	if (code < 0x20) return 0;
	if (code >= 0x7f && code <= 0x9f) return 0;
	return isWideChar(code) ? 2 : 1;
}

/** ANSI 转义序列正则（匹配所有 CSI/SGR 序列，含 private sequences） */
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/**
 * 剥离 ANSI 转义序列，返回纯文本
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '');
}

/** 计算字符串显示宽度 */
export function strDisplayWidth(str: string): number {
	let width = 0;
	for (const ch of str) {
		width += charDisplayWidth(ch);
	}
	return width;
}

/**
 * 截断字符串使其显示宽度不超过 maxWidth
 * 在末尾添加 "…"（如果被截断）
 */
export function truncateByWidth(str: string, maxWidth: number): string {
	let width = 0;
	let i = 0;
	for (const ch of str) {
		const cw = charDisplayWidth(ch);
		if (width + cw > maxWidth) break;
		width += cw;
		i += ch.length;
	}
	if (i >= str.length) return str;
	return str.slice(0, i) + '…';
}

/**
 * 填充空格使字符串显示宽度达到 targetWidth
 */
export function padToWidth(str: string, targetWidth: number): string {
	const current = strDisplayWidth(str);
	if (current >= targetWidth) return str;
	return str + ' '.repeat(targetWidth - current);
}

/**
 * 工具调用紧凑摘要（节省显示空间，保留关键信息）：
 * - execute_command：只显示命令本身（换行合并，超长截断）
 * - write/edit/read 文件工具：显示文件路径
 * - browser_navigate：显示 URL
 * - search_content：显示 pattern
 * - 其他工具：JSON 参数摘要（超长截断）
 */
export function formatToolCallSummary(toolName: string, args: Record<string, unknown>): string {
	if (toolName === 'execute_command') {
		const cmd = String(args.command ?? '').replace(/\s*\n\s*/g, ' ').trim();
		return cmd.length > 100 ? cmd.slice(0, 97) + '...' : cmd;
	}
	if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'read_file') {
		return String(args.path ?? '');
	}
	if (toolName === 'browser_navigate') {
		return String(args.url ?? '');
	}
	if (toolName === 'search_content') {
		return String(args.pattern ?? '');
	}
	const json = JSON.stringify(args);
	return json.length > 80 ? json.slice(0, 77) + '...' : json;
}
