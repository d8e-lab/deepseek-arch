/**
 * browser_scroll — 滚动当前页面
 *
 * 滚动后自动获取页面快照，模型可看到新出现的内容。
 */

import type { Tool, ToolResult } from './types.js';
import { getBrowserState } from './browser-state.js';

export const browserScrollTool: Tool = {
	name: 'browser_scroll',
	description:
		'滚动当前页面。向上或向下滚动，默认滚动一整屏（page）。滚动后自动返回新页面快照。' +
		'用于查看长页面中未显示的内容。',
	parameters: {
		type: 'object',
		properties: {
			direction: {
				type: 'string',
				description: '滚动方向，"down"（向下）或 "up"（向上），默认 "down"',
				enum: ['down', 'up'],
			},
			amount: {
				type: 'string',
				description: '滚动量，"page" 表示一整屏，或数字像素值（如 "500"），默认 "page"',
			},
		},
		required: [],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const direction = (String(params.direction ?? 'down')).trim().toLowerCase();
		const amountStr = params.amount ? String(params.amount).trim() : 'page';

		if (direction !== 'down' && direction !== 'up') {
			return { content: '', error: `Invalid direction "${direction}", must be "up" or "down"` };
		}

		const state = getBrowserState();
		const page = await state.getPage();

		let scrollAmount: number;
		if (amountStr === 'page') {
			scrollAmount = await page.evaluate(() => window.innerHeight);
		} else {
			scrollAmount = parseInt(amountStr, 10);
			if (isNaN(scrollAmount) || scrollAmount <= 0) {
				return { content: '', error: `Invalid amount "${amountStr}", must be "page" or a positive number` };
			}
		}

		const delta = direction === 'down' ? scrollAmount : -scrollAmount;

		try {
			await page.evaluate((d) => { window.scrollBy(0, d); }, delta);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: '', error: `Scroll failed: ${msg}` };
		}

		// 自动快照
		const snapshot = await state.buildSnapshot();
		return { content: snapshot };
	},
};
