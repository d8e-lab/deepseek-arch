/**
 * browser_type — 在输入框中输入文本
 *
 * 通过 placeholder 或 name 定位输入框，填入指定文本。
 * 输入完成后自动获取页面快照。
 */

import type { Tool, ToolResult } from './types.js';
import { getBrowserState } from './browser-state.js';
import type { Page } from 'playwright';

export const browserTypeTool: Tool = {
	name: 'browser_type',
	description:
		'在输入框中输入文本。通过 placeholder（输入框占位文字）或 name（从 browser_snapshot 中获取的标签名）定位输入框。' +
		'可选指定 role 去歧义。输入完成后自动返回页面快照。',
	parameters: {
		type: 'object',
		properties: {
			text: {
				type: 'string',
				description: '要输入的文本内容',
			},
			placeholder: {
				type: 'string',
				description: '输入框的 placeholder 文字，如 "Search..."、"Email"',
			},
			name: {
				type: 'string',
				description: '输入框的 accessible name（browser_snapshot 中 textbox 后的引号内容），与 placeholder 二选一',
			},
			role: {
				type: 'string',
				description: 'ARIA role 去歧义，如 "textbox", "searchbox", "combobox"。可选',
			},
		},
		required: ['text'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const text = String(params.text ?? '');
		const placeholder = params.placeholder ? String(params.placeholder).trim() : undefined;
		const name = params.name ? String(params.name).trim() : undefined;
		const role = params.role ? String(params.role).trim() : undefined;

		if (!placeholder && !name) {
			return { content: '', error: 'Either placeholder or name is required to locate the input' };
		}

		const state = getBrowserState();
		const page = await state.getPage();

		try {
			await tryFill(page, text, placeholder, name, role);

			// 自动快照
			const snapshot = await state.buildSnapshot();
			return { content: snapshot };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: '', error: `Type failed: ${msg}` };
		}
	},
};

async function tryFill(
	page: Page,
	fillText: string,
	placeholder?: string,
	name?: string,
	role?: string,
): Promise<void> {
	// 策略 1: placeholder 定位
	if (placeholder) {
		const locator = page.getByPlaceholder(placeholder);
		if (await locator.count() > 0) {
			await locator.first().fill(fillText);
			return;
		}
	}

	// 策略 2: role + name
	if (role && name) {
		const locator = page.getByRole(role as any, { name });
		if (await locator.count() > 0) {
			await locator.first().fill(fillText);
			return;
		}
	}

	// 策略 3: label 匹配（name 作为 label）
	if (name) {
		const locator = page.getByLabel(name);
		if (await locator.count() > 0) {
			await locator.first().fill(fillText);
			return;
		}
	}

	// 策略 4: 通用 textbox/text 角色
	const textboxRole = role || 'textbox';
	const allInputs = page.getByRole(textboxRole as any);
	const inputCount = await allInputs.count();
	if (inputCount > 0 && !name && !placeholder) {
		// 没有具体定位信息但有唯一输入框 → 使用它
		if (inputCount === 1) {
			await allInputs.fill(fillText);
			return;
		}
	}

	throw new Error(
		`Could not find input field` +
		(placeholder ? ` with placeholder "${placeholder}"` : '') +
		(name ? ` with name "${name}"` : '') +
		'. Try using browser_snapshot to see current page elements.'
	);
}
