/**
 * tui_session_start — 启动子 TUI 会话
 *
 * 在 PTY 中启动一个独立的 deepseek-arch chat 实例，
 * 返回 session_id 供其他 tui_session_* 工具使用。
 */

import type { Tool, ToolResult } from './types.js';
import { sessionManager } from './tui-session-manager.js';

export const tuiSessionStartTool: Tool = {
	name: 'tui_session_start',
	description:
		'Start a child deepseek-arch TUI session in a pseudo-terminal. ' +
		'The child runs independently with its own stdin/stdout. ' +
		'Returns a session_id to use with tui_session_send/read/capture/stop. ' +
		'The child session has a 300×200 terminal, simulating a large screen. ' +
		'Use this to test and debug TUI rendering behavior interactively.',
	parameters: {
		type: 'object',
		properties: {
			yolo: {
				type: 'boolean',
				description: 'Use --yolo mode (auto-approve tools). Default: true',
				default: true,
			},
			mock: {
				type: 'boolean',
				description: 'Use --mock mode (MockProvider, no API cost). Default: true',
				default: true,
			},
		},
		required: [],
	},
	requiresConfirm: false,
	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const useYolo = (params.yolo as boolean) ?? true;
		const useMock = (params.mock as boolean) ?? true;

		const args: string[] = ['dist/cli/index.js', 'chat'];
		if (useYolo) args.push('--yolo');
		if (useMock) args.push('--mock');

		const info = sessionManager.spawn(['node', ...args], {
			cols: 300,
			rows: 200,
			env: {
				DEEPSEEK_API_KEY: 'mock-key',
			},
		});

		// 等待初始渲染
		await new Promise(resolve => setTimeout(resolve, 800));

		// 读取初始输出
		const buf = sessionManager.readBuffer(info.sessionId) ?? '';
		const preview = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r\n?/g, '\n').slice(-500);

		return {
			content: [
				`Session started: ${info.sessionId}`,
				`PID: ${info.pid}`,
				`Terminal: 300×200`,
				`Args: ${args.join(' ')}`,
				'',
				'=== Initial Output (last 500 chars) ===',
				preview.slice(-500),
				'=== End ===',
				'',
				'Use tui_session_send to type text, tui_session_read to get output,',
				'tui_session_capture for structured TUI state, and tui_session_stop to end.',
			].join('\n'),
		};
	},
};
