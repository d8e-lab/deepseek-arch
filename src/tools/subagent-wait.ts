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
		'Wait for a specific subagent to complete and retrieve its result. ' +
		'If the subagent is still running, this blocks until it finishes. ' +
		'If the subagent has already completed but the result hasn\'t been retrieved yet, returns immediately. ' +
		'Use list_subagents to check which subagents are running/completed before calling wait. ' +
		'Each subagent result can only be retrieved once.\n\n' +
		'TYPICAL WORKFLOW:\n' +
		'1. Spawn multiple subagents in one round (parallel)\n' +
		'2. Continue your own main-line work while they run\n' +
		'3. Call list_subagents to see who\'s done\n' +
		'4. Call wait("name") for each completed subagent to get results\n' +
		'5. Newly spawned subagents can be waited for after they finish',
	parameters: {
		type: 'object',
		properties: {
			subagent_name: {
				type: 'string',
				description: 'Name of the subagent to wait for (from subagent_spawn).',
			},
		},
		required: ['subagent_name'],
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
