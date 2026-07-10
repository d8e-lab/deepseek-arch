/**
 * tui_render_preview 工具 — 预览 TUI 渲染效果
 *
 * 让模型预览对话数据在 TUI 中的渲染效果，无需运行完整 TUI。
 * 适用于调试 rendering 逻辑变化后的显示效果。
 *
 * 用法：
 *   1. 从 session 目录读取 turns.json 或从 shell 输出获取 JSON
 *   2. 调用本工具传入数据路径或直接传入文本内容
 *   3. 获取渲染后的文本行
 */

import type { Tool, ToolResult } from './types.js';
import { ConversationView, wrapText } from '../cli/tui/conversation.js';
import { stripAnsi, dim, green, strDisplayWidth } from '../cli/tui/renderer.js';
import { readFile } from 'node:fs/promises';

/** 尝试从路径读取 JSON 并解析为 turns 数组 */
async function loadTurnsFromPath(path: string): Promise<unknown[] | null> {
	try {
		const content = await readFile(path, 'utf-8');
		// turns.json 可能是 { turns: [...] } 或直接 [...]
		const parsed = JSON.parse(content);
		if (Array.isArray(parsed)) return parsed;
		if (parsed && Array.isArray(parsed.turns)) return parsed.turns;
		if (parsed && Array.isArray(parsed.session?.turns)) return parsed.session.turns;
		return null;
	} catch {
		return null;
	}
}

export const tuiRenderPreviewTool: Tool = {
	name: 'tui_render_preview',
	description:
		'Preview how text or conversation turns would render in the TUI. ' +
		'Useful for debugging rendering changes without running the full TUI. ' +
		'You can either: (1) provide a `data_path` to a JSON file containing turn data, ' +
		'or (2) provide `text` and `label` to preview a single piece of text. ' +
		'Returns the rendered lines as they would appear on screen (ANSI codes stripped by default).',
	parameters: {
		type: 'object',
		properties: {
			data_path: {
				type: 'string',
				description:
					'Path to a JSON file containing turn data. ' +
					'Can be a session turns.json (e.g., ~/.deepseek-arch/sessions/<id>/turns.json) ' +
					'or any JSON file with an array of TurnRecord objects.',
			},
			text: {
				type: 'string',
				description:
					'Single text content to preview (e.g., a message or code block). ' +
					'Used when you want to see how a specific piece of text wraps/renders. ' +
					'Requires `label` to be set.',
			},
			label: {
				type: 'string',
				description:
					'Label style for single text preview: "user", "assistant", "think", or "plain". ' +
					'Default: "plain" (no label).',
				enum: ['user', 'assistant', 'think', 'plain'],
			},
			term_width: {
				type: 'number',
				description: 'Terminal width in columns (default: 80).',
				default: 80,
			},
			strip_ansi: {
				type: 'boolean',
				description: 'Strip ANSI color codes from output (default: true). Set to false to see raw ANSI.',
				default: true,
			},
		},
		required: [],
	},
	requiresConfirm: false,
	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const termWidth = (params.term_width as number) ?? 80;
		const stripAnsiFlag = (params.strip_ansi as boolean) ?? true;

		// 模式 1：从 data_path 加载 turns
		const dataPath = params.data_path as string | undefined;
		if (dataPath) {
			const turns = await loadTurnsFromPath(dataPath);
			if (!turns) {
				return {
					content: `Could not parse turn data from: ${dataPath}\n` +
						'The file must contain a JSON array of TurnRecord objects, ' +
						'or an object with a "turns" or "session.turns" field.',
				};
			}

			const view = new ConversationView();
			// 使用 any 转换，因为 TurnRecord 来自 types/index.ts
			const rendered = view.renderToText(turns as any, termWidth);

			const lines: string[] = [];
			lines.push(`=== TUI Render Preview (${termWidth} cols, ${rendered.length} lines) ===`);
			lines.push('');
			for (const line of rendered) {
				lines.push(stripAnsiFlag ? stripAnsi(line) : line);
			}
			lines.push('');
			lines.push(`=== End (${rendered.length} lines) ===`);

			return { content: lines.join('\n') };
		}

		// 模式 2：单段文本预览
		const text = params.text as string | undefined;
		if (text) {
			const label = (params.label as string) ?? 'plain';
			const rendered = renderSingleText(text, label, termWidth);
			const result = stripAnsiFlag ? stripAnsi(rendered) : rendered;

			const lines: string[] = [];
			lines.push(`=== TUI Render Preview (${termWidth} cols) ===`);
			lines.push('');
			lines.push(result);
			lines.push('');
			lines.push('=== End ===');

			return { content: lines.join('\n') };
		}

		// 无参数：返回帮助信息
		return {
			content:
				'tui_render_preview: provide `data_path` to render session turns, ' +
				'or `text` + `label` to render a single text.\n' +
				'Examples:\n' +
				'  { "data_path": "~/.deepseek-arch/sessions/<id>/turns.json" }\n' +
				'  { "text": "Hello world", "label": "user", "term_width": 100 }\n' +
				'  { "text": "Some code\\nblock", "label": "assistant", "strip_ansi": false }',
		};
	},
};

/** 单段文本渲染（模拟 TUI 标签样式） */
function renderSingleText(text: string, label: string, termWidth: number): string {
	switch (label) {
		case 'user': {
			const labelText = '[You] ';
			const labelWidth = strDisplayWidth(labelText);
			const wrapped = wrapText(text, termWidth - labelWidth);
			return wrapped.map((line, i) =>
				i === 0 ? green(labelText) + green(line) : ' '.repeat(labelWidth) + green(line),
			).join('\n');
		}
		case 'think': {
			const labelText = '[Think] ';
			const labelWidth = strDisplayWidth(labelText);
			const wrapped = wrapText(text, termWidth - labelWidth);
			return wrapped.map((line, i) =>
				i === 0 ? dim(labelText + line) : ' '.repeat(labelWidth) + dim(line),
			).join('\n');
		}
		case 'assistant': {
			const wrapped = wrapText(text, termWidth);
			return wrapped.join('\n');
		}
		default:
			return text;
	}
}
