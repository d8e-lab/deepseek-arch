/**
 * browser_navigate_back — 浏览器后退
 *
 * 回到历史记录中的上一页，自动获取页面快照。
 */

import type { Tool, ToolResult } from './types.js';
import { getBrowserState } from './browser-state.js';

export const browserNavigateBackTool: Tool = {
	name: 'browser_navigate_back',
	description:
		'浏览器后退到上一页。等价于点击浏览器的返回按钮。后退后自动返回页面快照。',
	parameters: {
		type: 'object',
		properties: {},
		required: [],
	},
	requiresConfirm: false,

	async execute(_params: Record<string, unknown>): Promise<ToolResult> {
		const state = getBrowserState();
		const page = await state.getPage();

		try {
			await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: '', error: `Go back failed: ${msg}` };
		}

		// 自动快照
		try {
			const snapshot = await state.buildSnapshot();
			return { content: snapshot };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: `Navigated back`, error: `Snapshot failed: ${msg}` };
		}
	},
};
