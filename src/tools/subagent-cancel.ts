/**
 * subagent_cancel 工具 — 主动取消一个或多个子代理
 *
 * 主代理通过此工具中止仍在运行的后台子代理（不等待其完成）。
 * 与 spawn/wait/list_subagents 一样，Agent Loop 会拦截此工具做特殊处理
 * （通过 SessionManager 的独立 AbortController 中止目标子代理）。
 * 此文件中的 execute 仅为 fallback（返回占位错误）。
 */

import type { Tool, ToolResult } from './types.js';

export const subagentCancelTool: Tool = {
	name: 'subagent_cancel',
	description:
		'Cancel one or more running subagents. Pass a specific subagent_name to cancel that subagent, ' +
		'or pass "all" to cancel every running subagent. ' +
		'Cancelled subagents stop immediately and their results are discarded. ' +
		'Use list_subagents to check which subagents are still running before cancelling.',
	parameters: {
		type: 'object',
		properties: {
			subagent_name: {
				type: 'string',
				description:
					'Name of the subagent to cancel (from subagent_spawn), or "all" to cancel every running subagent.',
			},
		},
		required: ['subagent_name'],
	},
	requiresConfirm: false,

	async execute(params, _signal): Promise<ToolResult> {
		const name = params.subagent_name as string;
		if (!name) {
			return { content: 'Error: "subagent_name" is required ("all" cancels every running subagent).', error: 'invalid_params' };
		}
		return {
			content: `subagent_cancel must be called from within an active agent loop. No subagent '${name}' cancelled.`,
			error: 'not_in_loop',
		};
	},
};
