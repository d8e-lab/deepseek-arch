/**
 * list_subagents 工具 — 列出所有 subagent 的状态
 *
 * 返回当前 pending 的 subagent 列表（running/completed/failed）。
 * Agent Loop 拦截此工具做特殊处理（读取内部状态生成列表）。
 * 此文件中的 execute 仅为 fallback。
 */

import type { Tool, ToolResult } from './types.js';

export const listSubagentsTool: Tool = {
	name: 'list_subagents',
	description:
		'List all subagents and their current status. ' +
		'Shows subagent_name, status (running/completed/failed), and elapsed time. ' +
		'Completed subagents show whether their result has been retrieved. ' +
		'Use this to check progress before calling wait on a specific subagent.',
	parameters: {
		type: 'object',
		properties: {},
		required: [],
	},
	requiresConfirm: false,

	async execute(_params, _signal): Promise<ToolResult> {
		return {
			content: 'No subagents in current context. This tool only works within an active agent loop.',
		};
	},
};
