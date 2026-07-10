/**
 * tui_capture 工具 — 捕获当前 TUI 屏幕状态
 *
 * 返回结构化渲染报告，使模型能了解当前 TUI 前端展示情况，
 * 用于调试渲染布局、对齐、截断、颜色等问题。
 *
 * 注册模式：TuiApp 在构造时调用 setCaptureFn 注入捕获函数，
 * 工具通过 _captureFn 获取当前屏幕快照。
 */

import type { Tool, ToolResult } from './types.js';
import type { ScreenCapture } from '../cli/tui/types.js';

/** TUI 屏幕捕获函数类型 */
export type CaptureFn = () => ScreenCapture | null;

/** 全局捕获函数（由 TuiApp 注册） */
let _captureFn: CaptureFn | null = null;

/** 注册 TUI 屏幕捕获函数（由 TuiApp 在构造时调用） */
export function setCaptureFn(fn: CaptureFn): void {
	_captureFn = fn;
}

/** 格式化 ScreenCapture 为结构化文本报告 */
function formatCapture(cap: ScreenCapture): string {
	const lines: string[] = [];

	lines.push('=== TUI Screen Capture ===');
	lines.push(`Terminal: ${cap.terminal.cols}×${cap.terminal.rows}`);
	lines.push(`State: ${cap.appState}`);
	lines.push('');

	// Header
	lines.push('── Header ──');
	lines.push(`  ${cap.header}`);
	lines.push('');

	// Turns
	lines.push(`── Turns (${cap.turnCount}) ──`);
	for (const turn of cap.turns) {
		lines.push(`  Turn #${turn.index + 1}:`);

		// User text (first line only)
		const userFirstLine = turn.userText.split('\n')[0] ?? '';
		const userSnippet = userFirstLine.length > 80 ? userFirstLine.slice(0, 80) + '...' : userFirstLine;
		lines.push(`    [You] ${userSnippet}`);

		// Think
		if (turn.thinkLines > 0) {
			const truncMsg = turn.thinkTruncated ? ' (TRUNCATED)' : '';
			lines.push(`    [Think] ${turn.thinkLines} lines${truncMsg}`);
		}

		// Tool calls
		for (const tc of turn.toolCalls) {
			const errMsg = tc.error ? ` ✖ ${tc.error}` : '';
			lines.push(`    [T: ${tc.name}] ${tc.args} (${tc.durationMs}ms)${errMsg}`);
			if (tc.resultPreview) {
				for (const rl of tc.resultPreview.split('\n')) {
					lines.push(`      │ ${rl}`);
				}
			}
		}

		// Content
		if (turn.contentLines > 0) {
			lines.push(`    [Reply] ${turn.contentLines} lines`);
		}

		// Usage
		if (turn.usage) {
			lines.push(`    (${turn.usage})`);
		}
	}
	lines.push('');

	// Input area
	lines.push('── Input Area ──');
	const modeLabel = cap.inputArea.shellMode ? 'SHELL MODE' : 'normal';
	lines.push(`  Mode: ${modeLabel}`);
	lines.push(`  Lines: ${cap.inputArea.lineCount}/${cap.inputArea.maxVisibleLines}`);
	lines.push(`  Cursor: row ${cap.inputArea.cursorRow + 1}, col ${cap.inputArea.cursorCol + 1}`);
	if (cap.inputArea.textPreview) {
		lines.push(`  Text: ${cap.inputArea.textPreview.slice(0, 100)}${cap.inputArea.textPreview.length > 100 ? '...' : ''}`);
	}
	lines.push('');

	// Warnings
	if (cap.warnings.length > 0) {
		lines.push('── Warnings ──');
		for (const w of cap.warnings) {
			lines.push(`  ⚠ ${w}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

export const tuiCaptureTool: Tool = {
	name: 'tui_capture',
	description:
		'Capture the current TUI screen state and return a structured rendering report. ' +
		'Useful for debugging TUI layout, alignment, content truncation, and rendering issues. ' +
		'Returns terminal dimensions, conversation turns (plain text with section labels), ' +
		'input area state, and diagnostic warnings. ' +
		'Only works when the TUI is in IDLE state (not streaming/sending).',
	parameters: {
		type: 'object',
		properties: {},
		required: [],
	},
	requiresConfirm: false,
	async execute(_params: Record<string, unknown>): Promise<ToolResult> {
		if (!_captureFn) {
			return {
				content: 'TUI screen capture not available. This tool only works during an active TUI chat session.',
			};
		}

		const cap = _captureFn();
		if (!cap) {
			return {
				content: 'Cannot capture: TUI is not in IDLE state (currently streaming/sending/confirming). Wait for the current operation to complete.',
			};
		}

		return { content: formatCapture(cap) };
	},
};
