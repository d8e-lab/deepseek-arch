/**
 * ANSI 转义序列 — 终端控制常量与工具函数
 *
 * 从 chat-ui.ts 剥离的独立模块。
 * 零额外依赖，纯 ANSI 转义码。
 */

/** CSI (Control Sequence Introducer) */
export const CSI = '\x1b[';

export const CURSOR_HOME = `${CSI}H`;
export const CLEAR_SCREEN = `${CSI}2J`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
export const ERASE_LINE = `${CSI}2K`;
export const ERASE_SCREEN_BELOW = `${CSI}0J`;
export const ENTER_ALT_SCREEN = `${CSI}?1049h`;
export const EXIT_ALT_SCREEN = `${CSI}?1049l`;
export const RESET_BG = `${CSI}49m`;

/** 灰底背景色（236 = dark gray） */
export const BG_GRAY = `${CSI}48;5;236m`;

/**
 * 移动光标到指定行列
 *
 * @param row 行（从 0 开始）
 * @param col 列（从 0 开始）
 */
export function cursorTo(row: number, col: number = 0): string {
	return `${CSI}${row + 1};${col + 1}H`;
}

/**
 * 光标上移 N 行
 */
export function cursorUp(n: number): string {
	return `${CSI}${n}A`;
}
