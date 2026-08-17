/**
 * 终端 I/O 工具 — 尺寸、光标、清屏、粘贴模式（表示层用）
 *
 * 从 src/cli/tui/renderer.ts 拆分：
 * - 本文件：直接操作 process.stdout 的终端控制（表示层）
 * - 纯计算样式/文本工具见 src/render/ansi.ts
 */

// ─── 终端尺寸 ─────────────────────────────────────

/** 获取终端尺寸（columns/rows 为 0 或 undefined 时回退默认值，兼容非 TTY/PTY 环境） */
export function getTermSize(): { rows: number; cols: number } {
	return {
		rows: process.stdout.rows || 24,
		cols: process.stdout.columns || 80,
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
