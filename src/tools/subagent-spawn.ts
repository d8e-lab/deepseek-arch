/**
 * subagent_spawn 工具 — 主代理委派子任务给独立子代理
 *
 * 子代理有独立消息上下文和受限工具集（无 spawn/wait/list_subagents/plan/save_plan）。
 * Agent Loop 会拦截此工具做特殊处理（非阻塞启动 + 状态追踪）。
 * 此文件中的 execute 仅为 fallback（直接调用时阻塞等待）。
 */

import type { Tool, ToolResult } from './types.js';

export type SubagentRunner = (task: string, signal?: AbortSignal) => Promise<string>;

let _runner: SubagentRunner | null = null;

export function setSubagentRunner(runner: SubagentRunner): void {
	_runner = runner;
}

export const subagentSpawnTool: Tool = {
	name: 'subagent_spawn',
	description:
		'Spawn a subagent to independently execute a sub-task. ' +
		'The subagent has shell, file (read/write/edit/search), and browser tools. ' +
		'It CANNOT spawn sub-subagents or use plan/save_plan. ' +
		'Use this to parallelize independent work: spawn multiple subagents in one round. ' +
		'Each subagent needs a unique subagent_name for later tracking (via wait/list_subagents). ' +
		'Be specific about the task and expected output format — the subagent works independently.',
	parameters: {
		type: 'object',
		properties: {
			subagent_name: {
				type: 'string',
				description:
					'Unique name for this subagent. Used to reference it in wait/list_subagents. ' +
					'Must be unique among all currently running or unretrieved subagents.',
			},
			task: {
				type: 'string',
				description:
					'Detailed task description including expected output format and any constraints. ' +
					'The subagent cannot ask questions — give it everything it needs.',
			},
		},
		required: ['subagent_name', 'task'],
	},
	requiresConfirm: false,

	async execute(params, signal): Promise<ToolResult> {
		const name = params.subagent_name as string;
		const task = params.task as string;
		if (!name || !task) {
			return { content: 'Error: both "subagent_name" and "task" are required.', error: 'invalid_params' };
		}
		if (!_runner) {
			return { content: 'Error: subagent runner not configured.', error: 'not_configured' };
		}

		const result = await _runner(task, signal);
		return { content: `Subagent '${name}' result:\n\n${result}` };
	},
};
