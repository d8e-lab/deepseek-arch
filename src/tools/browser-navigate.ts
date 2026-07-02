/**
 * browser_navigate — 导航到指定 URL，自动返回页面快照
 *
 * 导航完成后自动调用 ariaSnapshot() 格式化页面内容，
 * 模型可以立即看到页面结构而无需额外调用 browser_snapshot。
 */

import type { Tool, ToolResult } from './types.js';
import { getBrowserState, NAVIGATION_TIMEOUT_MS } from './browser-state.js';

export const browserNavigateTool: Tool = {
	name: 'browser_navigate',
	description:
		'导航到指定 URL。导航完成后自动返回页面快照，无需再调用 browser_snapshot。' +
		'用于打开新网站或跳转到新页面。',
	parameters: {
		type: 'object',
		properties: {
			url: {
				type: 'string',
				description: '目标 URL，需包含协议（如 https://example.com）',
			},
		},
		required: ['url'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const url = String(params.url ?? '').trim();

		if (!url) {
			return { content: '', error: 'URL is required' };
		}

		if (!url.startsWith('http://') && !url.startsWith('https://')) {
			return { content: '', error: `URL must start with http:// or https://, got: ${url}` };
		}

		const state = getBrowserState();
		const page = await state.getPage();

		try {
			await page.goto(url, {
				waitUntil: 'domcontentloaded',
				timeout: NAVIGATION_TIMEOUT_MS,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: '', error: `Navigation failed: ${msg}` };
		}

		// 自动获取快照
		try {
			const snapshot = await state.buildSnapshot();
			return { content: snapshot };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: `Navigated to ${url}`, error: `Snapshot failed: ${msg}` };
		}
	},
};
