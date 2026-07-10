/**
 * tui_session_read — 读取子 TUI 会话的输出
 *
 * 返回子会话的完整 PTY 输出缓冲区，包含原始 ANSI 和纯文本两种格式。
 * 可选等待时间让更多输出到达。
 */

import type { Tool, ToolResult } from './types.js';
import { sessionManager } from './tui-session-manager.js';

export const tuiSessionReadTool: Tool = {
	name: 'tui_session_read',
	description:
		'Read the current output buffer from a child TUI session. ' +
		'Returns both raw (with ANSI codes) and stripped (plain text) output. ' +
		'Use timeout_ms to wait for more output. ' +
		'The output includes the full ring buffer (up to 200KB).',
	parameters: {
		type: 'object',
		properties: {
			session_id: {
				type: 'string',
				description: 'Session ID from tui_session_start',
			},
			timeout_ms: {
				type: 'number',
				description: 'Additional wait time (ms) for more output. Default: 0',
				default: 0,
			},
			last_screen_only: {
				type: 'boolean',
				description: 'Only return the most recent full-screen render. Default: true',
				default: true,
			},
			max_chars: {
				type: 'number',
				description: 'Maximum characters to return. Default: 5000',
				default: 5000,
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

		const timeoutMs = (params.timeout_ms as number) ?? 0;
		const lastScreenOnly = (params.last_screen_only as boolean) ?? true;
		const maxChars = (params.max_chars as number) ?? 5000;

		// 可选等待
		if (timeoutMs > 0) {
			await new Promise(resolve => setTimeout(resolve, timeoutMs));
		}

		// 读取输出
		const rawBuffer = lastScreenOnly
			? sessionManager.readLastScreen(sessionId) ?? ''
			: sessionManager.readBuffer(sessionId) ?? '';

		const raw = rawBuffer.slice(-maxChars);
		const stripped = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r\n?/g, '\n');

		return {
			content: [
				`=== Session Output (${raw.length} bytes, ${stripped.length} chars plain) ===`,
				'',
				'-- Raw (with ANSI) --',
				raw.slice(-2000),
				'',
				'-- Plain Text --',
				stripped.slice(-3000),
				'',
				'=== End ===',
			].join('\n'),
		};
	},
};
