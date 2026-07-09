/**
 * subagent.ts — 子代理循环引擎
 *
 * 独立于 SessionManager，可被任何 ModelProvider 驱动。
 * 子代理有独立消息上下文和受限工具集，不与主代理共享状态。
 */

import type { ModelProvider } from './model-provider.js';
import type { Tool, ToolResult } from '../tools/types.js';
import type { Message, ToolDefinition, ToolCall, ToolCallDelta } from '../types/index.js';

/** 子代理最大轮次（安全上限，防止失控） */
const MAX_SUBAGENT_ROUNDS = 25;

/**
 * 运行子代理循环。
 */
export async function runSubagentLoop(
	task: string,
	provider: ModelProvider,
	tools: Tool[],
	systemPrompt: string,
	signal?: AbortSignal,
): Promise<string> {
	const toolDefs: ToolDefinition[] = tools.map((t) => ({
		type: 'function' as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));

	const messages: Message[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: task },
	];

	let finalContent = '';

	for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round++) {
		if (signal?.aborted) return '(subagent cancelled by user)';

		let content = '';
		const pendingToolCalls: ToolCall[] = [];

		const toolOptions = toolDefs.length > 0 ? { tools: toolDefs } : {};

		for await (const chunk of provider.chatStream(messages, {
			...toolOptions,
			signal,
		})) {
			const delta = chunk.choices[0]?.delta;
			if (!delta) continue;

			if (delta.content) content += delta.content;

			if (delta.tool_calls && delta.tool_calls.length > 0) {
				accumulateToolCalls(pendingToolCalls, delta.tool_calls);
			}
		}

		if (content) finalContent = content;

		if (pendingToolCalls.length === 0) {
			return finalContent || '(subagent completed with no output)';
		}

		messages.push({
			role: 'assistant',
			content: content || '',
			tool_calls: pendingToolCalls,
		});

		for (const tc of pendingToolCalls) {
			const tool = tools.find((t) => t.name === tc.function.name);
			let args: Record<string, unknown> = {};
			try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }

			let result: string;
			if (!tool) {
				result = `Unknown tool: ${tc.function.name}`;
			} else {
				try {
					const r: ToolResult = await tool.execute(args, signal);
					result = r.content;
				} catch (err: unknown) {
					if (err instanceof Error && err.name === 'AbortError') {
						return '(subagent cancelled by user)';
					}
					result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
				}
			}

			messages.push({
				role: 'tool',
				content: result,
				tool_call_id: tc.id,
			});
		}
	}

	return finalContent || '(subagent hit max rounds limit)';
}

function accumulateToolCalls(toolCalls: ToolCall[], deltas: ToolCallDelta[]): void {
	for (const delta of deltas) {
		if (delta.index === undefined) continue;
		while (toolCalls.length <= delta.index) {
			toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
		}
		const tc = toolCalls[delta.index];
		if (delta.id) tc.id = delta.id;
		if (delta.function?.name) tc.function.name += delta.function.name;
		if (delta.function?.arguments) tc.function.arguments += delta.function.arguments;
	}
}
