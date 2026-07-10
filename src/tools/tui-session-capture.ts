/**
 * tui_session_capture — 获取子 TUI 会话的结构化屏幕状态
 *
 * 从子会话的 PTY 输出中解析出结构化渲染报告，
 * 类似 tui_capture 但对远程子进程生效。
 */

import type { Tool, ToolResult } from './types.js';
import { sessionManager } from './tui-session-manager.js';

/** 将 ScreenCapture 格式化为文本报告（复用 tui-capture 的格式） */
function formatCapture(cap: import('../cli/tui/types.js').ScreenCapture): string {
	const lines: string[] = [];

	lines.push('=== TUI Session Screen Capture ===');
	lines.push(`Terminal: ${cap.terminal.cols}×${cap.terminal.rows}`);
	lines.push(`State: ${cap.appState}`);
	lines.push('');

	if (cap.header) {
		lines.push('── Header ──');
		lines.push(`  ${cap.header}`);
		lines.push('');
	}

	lines.push(`── Turns (${cap.turnCount}) ──`);
	for (const turn of cap.turns) {
		lines.push(`  Turn #${turn.index + 1}:`);
		const userFirstLine = turn.userText.split('\n')[0] ?? '';
		const userSnippet = userFirstLine.length > 80 ? userFirstLine.slice(0, 80) + '...' : userFirstLine;
		lines.push(`    [User] ${userSnippet}`);

		if (turn.thinkLines > 0) {
			const truncMsg = turn.thinkTruncated ? ' (TRUNCATED)' : '';
			lines.push(`    [Think] ${turn.thinkLines} lines${truncMsg}`);
		}

		for (const tc of turn.toolCalls) {
			const errMsg = tc.error ? ` ✖ ${tc.error}` : '';
			lines.push(`    [T: ${tc.name}] ${tc.args.slice(0, 120)}${errMsg}`);
		}

		if (turn.contentLines > 0) {
			lines.push(`    [Reply] ${turn.contentLines} lines`);
		}

		if (turn.usage) {
			lines.push(`    (${turn.usage})`);
		}
	}
	lines.push('');

	lines.push('── Input Area ──');
	lines.push(`  ${cap.inputArea.shellMode ? 'Shell Mode' : 'Normal'}`);
	lines.push(`  Lines: ${cap.inputArea.lineCount}/${cap.inputArea.maxVisibleLines}`);
	if (cap.inputArea.textPreview) {
		lines.push(`  Preview: ${cap.inputArea.textPreview.slice(0, 100)}`);
	}
	lines.push('');

	if (cap.warnings.length > 0) {
		lines.push('── Warnings ──');
		for (const w of cap.warnings) {
			lines.push(`  ⚠ ${w}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

export const tuiSessionCaptureTool: Tool = {
	name: 'tui_session_capture',
	description:
		'Get a structured rendering report of a child TUI session. ' +
		'Parses the PTY output to extract terminal dimensions, ' +
		'conversation turns (with user/think/tool/reply sections), ' +
		'input area state, and diagnostic warnings. ' +
		'Use this to debug TUI rendering behavior in the child session.',
	parameters: {
		type: 'object',
		properties: {
			session_id: {
				type: 'string',
				description: 'Session ID from tui_session_start',
			},
		},
		required: ['session_id'],
	},
	requiresConfirm: false,
	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const sessionId = params.session_id as string;
		if (!sessionId || !sessionManager.hasSession(sessionId)) {
			return { content: `Error: session "${sessionId}" not found.` };
		}

		// 先等一会让任何进行中的渲染完成
		await new Promise(resolve => setTimeout(resolve, 300));

		const cap = sessionManager.captureScreen(sessionId);
		if (!cap) {
			return { content: `Error: session "${sessionId}" returned no data.` };
		}

		return { content: formatCapture(cap) };
	},
};
