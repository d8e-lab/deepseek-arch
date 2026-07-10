/**
 * tui_session_send — 向子 TUI 会话发送输入
 *
 * 模拟键盘输入文本到子 TUI 实例，可选择是否按 Enter 发送。
 * 支持逐字符模拟（char_delay_ms）以测试流式渲染。
 */

import type { Tool, ToolResult } from './types.js';
import { sessionManager } from './tui-session-manager.js';

export const tuiSessionSendTool: Tool = {
	name: 'tui_session_send',
	description:
		'Send text and/or keystrokes to a child TUI session. ' +
		'The text is typed into the child\'s terminal input. ' +
		'Use enter=true to press Enter after typing (simulates sending a message). ' +
		'Use char_delay_ms > 0 to simulate slow typing (for testing streaming rendering). ' +
		'After sending, automatically waits and returns the session output.',
	parameters: {
		type: 'object',
		properties: {
			session_id: {
				type: 'string',
				description: 'Session ID from tui_session_start',
			},
			text: {
				type: 'string',
				description: 'Text to type into the terminal',
			},
			enter: {
				type: 'boolean',
				description: 'Press Enter after typing. Default: true',
				default: true,
			},
			wait_ms: {
				type: 'number',
				description: 'Wait time (ms) after sending, for output to arrive. Default: 2000',
				default: 2000,
			},
			char_delay_ms: {
				type: 'number',
				description: 'Delay (ms) between each character. 0 = instant paste. Default: 0',
				default: 0,
			},
			key: {
				type: 'string',
				description: 'Optional special key to press: "Enter", "Escape", "Tab", "Ctrl+C", "Ctrl+J". ' +
					'If set, text and enter are ignored.',
			},
		},
		required: ['session_id'],
	},
	requiresConfirm: false,
	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const sessionId = params.session_id as string;
		if (!sessionId || !sessionManager.hasSession(sessionId)) {
			return { content: `Error: session "${sessionId}" not found. Use tui_session_start first.` };
		}

		// 特殊按键模式
		const key = params.key as string | undefined;
		if (key) {
			const keyMap: Record<string, string> = {
				'Enter': '\r',
				'Escape': '\x1b',
				'Tab': '\t',
				'Ctrl+C': '\x03',
				'Ctrl+J': '\x0a',
				'ArrowUp': '\x1b[A',
				'ArrowDown': '\x1b[B',
				'ArrowLeft': '\x1b[D',
				'ArrowRight': '\x1b[C',
			};
			const mapped = keyMap[key];
			if (!mapped) {
				return { content: `Error: unknown key "${key}". Valid keys: ${Object.keys(keyMap).join(', ')}` };
			}
			const ok = sessionManager.write(sessionId, mapped);
			if (!ok) return { content: `Error: failed to send key to session "${sessionId}"` };

			const waitMs = (params.wait_ms as number) ?? 500;
			await new Promise(resolve => setTimeout(resolve, waitMs));

			const output = sessionManager.readBuffer(sessionId) ?? '';
			const stripped = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r\n?/g, '\n');

			return { content: `Sent key: ${key}\n\n=== Session Output ===\n${stripped.slice(-3000)}\n=== End ===` };
		}

		// 文本输入模式
		const text = (params.text as string) ?? '';
		const pressEnter = (params.enter as boolean) ?? true;
		const charDelay = (params.char_delay_ms as number) ?? 0;
		const waitMs = (params.wait_ms as number) ?? 2000;

		if (charDelay > 0) {
			// 逐字符模拟输入
			for (const ch of text) {
				const ok = sessionManager.write(sessionId, ch);
				if (!ok) return { content: `Error: session "${sessionId}" disconnected during typing` };
				await new Promise(resolve => setTimeout(resolve, charDelay));
			}
		} else {
			// 整段粘贴
			const ok = sessionManager.write(sessionId, text);
			if (!ok) return { content: `Error: failed to write to session "${sessionId}"` };
		}

		if (pressEnter) {
			// 等待一下让输入回显完成，然后按 Enter
			await new Promise(resolve => setTimeout(resolve, 100));
			sessionManager.write(sessionId, '\r');
		}

		// 等待响应
		await new Promise(resolve => setTimeout(resolve, waitMs));

		const output = sessionManager.readBuffer(sessionId) ?? '';
		const stripped = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r\n?/g, '\n');

		const lines: string[] = [
			`Sent: "${text}"${pressEnter ? ' + Enter' : ''}`,
			`Wait: ${waitMs}ms`,
			`Buffer: ${output.length} bytes`,
			'',
			'=== Session Output (last 3000 chars) ===',
			stripped.slice(-3000),
			'=== End ===',
		];

		return { content: lines.join('\n') };
	},
};
