/**
 * browser_snapshot — 获取当前页面的结构化文本快照
 *
 * 使用 Playwright ariaSnapshot() 输出 YAML 风格文本：
 *   - heading "标题" [level=1]
 *   - link "链接文字"
 *   - textbox "搜索"
 *   - paragraph: 正文内容
 *
 * 模型根据此快照理解页面结构，决定下一步操作。
 */

import type { Tool, ToolResult } from './types.js';
import { getBrowserState } from './browser-state.js';

export const browserSnapshotTool: Tool = {
	name: 'browser_snapshot',
	description:
		'获取当前页面的结构化文本快照。输出格式为 YAML 风格，包含所有可见元素（链接、按钮、输入框、文本内容等）。' +
		'用于在 browser_click/browser_type/browser_scroll 后确认页面变化，或单独查看当前页面状态。' +
		'每个元素的文本可作为 browser_click 的 text 参数使用。',
	parameters: {
		type: 'object',
		properties: {},
		required: [],
	},
	requiresConfirm: false,

	async execute(_params: Record<string, unknown>): Promise<ToolResult> {
		const state = getBrowserState();

		try {
			const snapshot = await state.buildSnapshot();
			return { content: snapshot };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: '', error: `Snapshot failed: ${msg}` };
		}
	},
};
