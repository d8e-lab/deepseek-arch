/**
 * wait 工具 — 等待/获取指定 subagent 的结果
 *
 * 异步模式下，模型通过此工具主动获取 subagent 结果。
 * Agent Loop 拦截此工具做特殊处理（等待 + 标记已获取）。
 * 此文件中的 execute 仅为 fallback（返回占位错误）。
 */

import type { Tool, ToolResult } from './types.js';

export const waitTool: Tool = {
	name: 'wait',
	description:
		'Wait for one or more subagents to complete and read their output. ' +
		'Pass a single name to wait for one subagent; an array of names to wait for all of them; ' +
		'or omit subagent_name to wait for every subagent that is still running or whose latest output you have not read yet. ' +
		'If a subagent is still running, this blocks until it finishes. ' +
		'Output can be read repeatedly — there is no "already retrieved" restriction, so you can re-read a subagent\'s ' +
		'output any time (e.g. after a context compaction). ' +
		'If the subagent has had several exchanges with the user, the full user ↔ subagent conversation is returned ' +
		'(text only: no thinking, no tool traces). Use list_subagents to check status first.',
	parameters: {
		type: 'object',
		properties: {
			subagent_name: {
				type: ['string', 'array'],
				items: { type: 'string' },
				description:
					'Name(s) of subagent(s) to wait for (from subagent_spawn). ' +
					'Omit to wait for every pending subagent.',
			},
		},
		required: [],
	},
	requiresConfirm: false,

	async execute(params, _signal): Promise<ToolResult> {
		const name = params.subagent_name as string;
		if (!name) {
			return { content: 'Error: "subagent_name" is required.', error: 'invalid_params' };
		}
		return {
			content: `Wait tool must be called from within an active agent loop. No subagent named '${name}' found in current context.`,
			error: 'not_in_loop',
		};
	},
};
