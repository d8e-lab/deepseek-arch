/**
 * list_subagents 工具 — 列出所有 subagent 的状态
 *
 * 返回当前会话内的 subagent 列表（running/completed/failed/cancelled），
 * 并用 [new] / [read] 标注 master 是否已看过其最新产出（[read] 只是不再重复通知，wait 仍可读）。
 * Agent Loop 拦截此工具做特殊处理（读取内部状态生成列表）。
 * 此文件中的 execute 仅为 fallback。
 */

import type { Tool, ToolResult } from './types.js';

export const listSubagentsTool: Tool = {
	name: 'list_subagents',
	description:
		'List all subagents and their current status. ' +
		'Shows subagent_name, status (running/completed/failed/cancelled), elapsed time, ' +
		'and whether its latest output is [new] or already [read] by you. ' +
		'[read] only means you will not be notified about it again — wait("name") can still read it. ' +
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
