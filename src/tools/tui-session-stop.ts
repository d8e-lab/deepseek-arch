/**
 * tui_session_stop — 终止子 TUI 会话
 *
 * 发送 SIGTERM → 2秒后 SIGKILL 清理子进程。
 * 清理后 session 管理器中的状态将被删除。
 */

import type { Tool, ToolResult } from './types.js';
import { sessionManager } from './tui-session-manager.js';

export const tuiSessionStopTool: Tool = {
	name: 'tui_session_stop',
	description:
		'Stop a child TUI session and clean up resources. ' +
		'Sends SIGTERM first, then SIGKILL after 2s if needed. ' +
		'After stopping, the session_id is no longer valid.',
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
			return { content: `Error: session "${sessionId}" not found or already stopped.` };
		}

		const ok = sessionManager.stop(sessionId);
		if (!ok) {
			return { content: `Error: failed to stop session "${sessionId}".` };
		}

		// 等进程完全退出
		await new Promise(resolve => setTimeout(resolve, 500));

		return { content: `Session "${sessionId}" stopped successfully.` };
	},
};

export const tuiSessionListTool: Tool = {
	name: 'tui_session_list',
	description:
		'List all active child TUI sessions. Returns session IDs, PIDs, and uptime.',
	parameters: {
		type: 'object',
		properties: {},
		required: [],
	},
	requiresConfirm: false,
	async execute(_params: Record<string, unknown>): Promise<ToolResult> {
		const sessions = sessionManager.list();
		if (sessions.length === 0) {
			return { content: 'No active TUI sessions. Use tui_session_start to create one.' };
		}

		const lines: string[] = ['Active TUI Sessions:', ''];
		for (const s of sessions) {
			const uptime = Math.round((Date.now() - s.startMs) / 1000);
			lines.push(`  ${s.sessionId}  | PID: ${s.pid}  | Uptime: ${uptime}s`);
		}
		lines.push('', `Total: ${sessions.length} session(s)`);

		return { content: lines.join('\n') };
	},
};
