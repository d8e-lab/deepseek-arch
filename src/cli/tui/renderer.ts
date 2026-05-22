/**
 * ANSI 渲染工具 — 终端控制、颜色、光标
 */

// ─── 终端尺寸 ─────────────────────────────────────

/** 获取终端尺寸 */
export function getTermSize(): { rows: number; cols: number } {
	return {
		rows: process.stdout.rows ?? 24,
		cols: process.stdout.columns ?? 80,
	};
}

/** 注册 SIGWINCH 回调 */
export function onResize(callback: () => void): void {
	process.stdout.on('resize', callback);
}

/** 移除 SIGWINCH 回调 */
export function offResize(callback: () => void): void {
	process.stdout.off('resize', callback);
}

// ─── 屏幕缓冲 ─────────────────────────────────────

export function enterAltScreen(): void {
	process.stdout.write('\x1b[?1049h');
}

export function leaveAltScreen(): void {
	process.stdout.write('\x1b[?1049l');
}

// ─── 粘贴模式 ─────────────────────────────────────

export function enableBracketedPaste(): void {
	process.stdout.write('\x1b[?2004h');
}

export function disableBracketedPaste(): void {
	process.stdout.write('\x1b[?2004l');
}

// ─── 光标控制 ─────────────────────────────────────

export function hideCursor(): void {
	process.stdout.write('\x1b[?25l');
}

export function showCursor(): void {
	process.stdout.write('\x1b[?25h');
}

export function moveTo(row: number, col: number): void {
	process.stdout.write(`\x1b[${row + 1};${col + 1}H`);
}

export function moveUp(n: number = 1): void {
	if (n > 0) process.stdout.write(`\x1b[${n}A`);
}

// ─── 清屏 ─────────────────────────────────────────

export function clearScreen(): void {
	process.stdout.write('\x1b[2J');
}

export function clearToEnd(): void {
	process.stdout.write('\x1b[0J');
}

export function clearLine(): void {
	process.stdout.write('\x1b[2K');
}

export function clearLineToEnd(): void {
	process.stdout.write('\x1b[0K');
}

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

// ─── CJK 字符宽度 ─────────────────────────────────

/**
 * 判断字符是否为 CJK 宽字符（显示宽度 = 2）
 * 覆盖 CJK Unified Ideographs、CJK Symbols、全角形式等
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
