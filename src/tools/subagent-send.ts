/**
 * subagent_send 工具 — 向已完成/失败的子代理追加指令并续跑
 *
 * 子代理会话化（方案 B）后的续谈通道：master agent 在子代理返回结果后，
 * 可追加进一步指令，子代理保留完整上下文继续执行并返回新结果。
 * 与 spawn/wait/list_subagents 一样，Agent Loop 会拦截此工具做特殊处理
 * （通过 SessionManager.sendToSubagent 驱动 SubagentSession 续跑）。
 * 此文件中的 execute 仅为 fallback（返回占位错误）。
 *
 * 守卫：running 中拒绝（并发保护）；cancelled 拒绝（上下文已中止）。
 * 语义：同步等待——master 发指令后需要新结果才能规划下一步。
 */

import type { Tool, ToolResult } from './types.js';

export const subagentSendTool: Tool = {
	name: 'subagent_send',
	description:
		'Send a follow-up instruction to a completed or failed subagent and get its new result. ' +
		'The subagent resumes with its full previous context (messages preserved) and continues ' +
		'working on the new instruction — do NOT spawn a new subagent for follow-ups. ' +
		'Use when a subagent result needs refinement, extension, or fixes. ' +
		'This call waits synchronously for the subagent to finish the follow-up.',
	parameters: {
		type: 'object',
		properties: {
			subagent_name: {
				type: 'string',
				description: 'Name of the completed/failed subagent (from subagent_spawn).',
			},
			instruction: {
				type: 'string',
				description: 'Follow-up instruction (be specific about what to extend, fix, or refine).',
			},
		},
		required: ['subagent_name', 'instruction'],
	},
	requiresConfirm: false,

	async execute(params, _signal): Promise<ToolResult> {
		const name = params.subagent_name as string;
		const instruction = params.instruction as string;
		if (!name || !instruction) {
			return {
				content: 'Error: both "subagent_name" and "instruction" are required.',
				error: 'invalid_params',
			};
		}
		return {
			content: `subagent_send must be called from within an active agent loop. No follow-up sent to '${name}'.`,
			error: 'not_in_loop',
		};
	},
};
