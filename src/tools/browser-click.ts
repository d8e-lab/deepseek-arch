/**
 * browser_click — 点击页面元素
 *
 * 通过文本或 role+name 定位元素：
 *   - text 模式：匹配元素文本（从 browser_snapshot 中获取），如 "Login"、"77 comments"
 *   - role 模式：指定 ARIA role 精确定位，如 role=button + text="Submit"
 *
 * 点击后自动获取页面快照。
 */

import type { Tool, ToolResult } from './types.js';
import { getBrowserState } from './browser-state.js';
import type { Page } from 'playwright';

export const browserClickTool: Tool = {
	name: 'browser_click',
	description:
		'点击页面上的元素。使用 text 参数指定要点击的元素文本（从 browser_snapshot 输出中获取）。' +
		'可选指定 role 以去歧义（如 role="button", role="link"）。点击后自动返回新页面快照。',
	parameters: {
		type: 'object',
		properties: {
			text: {
				type: 'string',
				description: '要点击的元素文本，即 browser_snapshot 中显示的元素名称',
			},
			role: {
				type: 'string',
				description: 'ARIA role 用于去歧义，如 "link", "button", "option", "tab"。可选',
			},
		},
		required: ['text'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const text = String(params.text ?? '').trim();
		const role = params.role ? String(params.role).trim() : undefined;

		if (!text) {
			return { content: '', error: 'text is required' };
		}

		try {
			const state = getBrowserState();
			const page = await state.getPage();
			await tryClick(page, text, role);

			// 等待可能的导航
			try {
				await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
			} catch {
				/* ignore */
			}

			// 自动快照
			const snapshot = await state.buildSnapshot();
			return { content: snapshot };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: '', error: `Click failed: ${msg}` };
		}
	},
};

/**
 * 尝试多种定位策略点击元素
 *   1. role + text → page.getByRole(role, { name: text })
 *   2. text only → page.getByText(text)
 *   3. 两者都失败 → 报错
 */
async function tryClick(page: Page, text: string, role?: string): Promise<void> {
	// 策略 1: role + text 精确匹配
	if (role) {
		const locator = page.getByRole(role as any, { name: text });
		const count = await locator.count();
		if (count === 1) {
			await locator.click();
			return;
		}
		if (count > 1) {
			// 多个匹配：点击第一个并提示
			await locator.first().click();
			return;
		}
		// count === 0 → fall through to next strategy
	}

	// 策略 2: 纯文本匹配（精确）
	const textLocator = page.getByText(text, { exact: true });
	const textCount = await textLocator.count();
	if (textCount >= 1) {
		await textLocator.first().click();
		return;
	}

	// 策略 3: 子串匹配
	const subLocator = page.getByText(text);
	const subCount = await subLocator.count();
	if (subCount >= 1) {
		await subLocator.first().click();
		return;
	}

	// 策略 4: 尝试 CSS 选择器（如果 text 看起来像选择器）
	if (text.startsWith('.') || text.startsWith('#') || text.startsWith('a[')) {
		const cssLocator = page.locator(text);
		const cssCount = await cssLocator.count();
		if (cssCount >= 1) {
			await cssLocator.first().click();
			return;
		}
	}

	throw new Error(
		`Could not find clickable element matching "${text}"` +
		(role ? ` with role "${role}"` : '') +
		'. Try using browser_snapshot to see current page elements.'
	);
}
