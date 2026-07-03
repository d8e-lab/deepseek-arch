/**
 * browser_press_key — 在页面上按一个键盘键
 *
 * 用于 Enter（提交表单）、Escape（关闭弹窗）、Tab（切换焦点）、
 * 以及 Ctrl+C、ArrowDown、ArrowUp 等键盘操作。
 * 按完后自动获取页面快照。
 */

import type { Tool, ToolResult } from './types.js';
import { getBrowserState } from './browser-state.js';

/** 已知的键盘键名映射（playwright 接受的 key 值） */
const KNOWN_KEYS = new Set([
	'Enter',
	'Escape',
	'Tab',
	'Backspace',
	'Delete',
	'ArrowUp',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight',
	'Home',
	'End',
	'PageUp',
	'PageDown',
	'Space',
	'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

export const browserPressKeyTool: Tool = {
	name: 'browser_press_key',
	description:
		'在页面上按一个键盘键。用于 Enter（提交表单或确认）、Escape（关闭弹窗或取消）、' +
		'Tab（切换焦点）、ArrowDown/ArrowUp（下拉选择）、' +
		'Ctrl+A（全选）、Ctrl+C（复制）等。' +
		'只按一个键或快捷键组合，不能输入文本。输入文本请用 browser_type。' +
		'按键后自动返回页面快照。',
	parameters: {
		type: 'object',
		properties: {
			key: {
				type: 'string',
				description: '要按的键名，例如 "Enter"、"Escape"、"Tab"、"ArrowDown"、"ArrowUp"、"Space"。' +
					'组合键用 "+" 连接，如 "Control+a"、"Control+Shift+End"',
			},
		},
		required: ['key'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const key = String(params.key ?? '').trim();

		if (!key) {
			return { content: '', error: 'key is required' };
		}

		const state = getBrowserState();
		const page = await state.getPage();

		try {
			if (key.includes('+')) {
				// 组合键：如 Control+a, Control+Shift+End
				const parts = key.split('+').map((s) => s.trim());
				const modifiers = parts.slice(0, -1);
				const actualKey = parts[parts.length - 1];

				if (!KNOWN_KEYS.has(actualKey) && actualKey.length > 1) {
					return { content: '', error: `Unknown key "${actualKey}". For text input use browser_type, for keys use: Enter, Escape, Tab, ArrowDown, ArrowUp, Space, etc.` };
				}

				await page.keyboard.press(parts.join('+'));
			} else {
				if (!KNOWN_KEYS.has(key) && key.length > 1) {
					return { content: '', error: `Unknown key "${key}". Supported keys: Enter, Escape, Tab, ArrowDown, ArrowUp, Space, etc. For text input, use browser_type.` };
				}
				await page.keyboard.press(key);
			}

			// 等待可能的页面变化
			try {
				await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
			} catch {
				/* ignore */
			}

			const snapshot = await state.buildSnapshot();
			return { content: snapshot };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: '', error: `Press key failed: ${msg}` };
		}
	},
};
