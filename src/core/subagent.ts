/**
 * subagent.ts — 子代理循环引擎
 *
 * 独立于 SessionManager，可被任何 ModelProvider 驱动。
 * 子代理有独立消息上下文和受限工具集，不与主代理共享状态。
 * 通过 SubagentCallbacks 将每轮输出（thinking/content/tool_call/tool_result）
 * 实时上报给调用方（SessionManager → SubagentStore → TUI 详情视图）。
 */

import type { ModelProvider } from './model-provider.js';
import type { Tool, ToolResult } from '../tools/types.js';
import type { Message, ToolDefinition, ToolCall, ToolCallDelta, TokenUsage } from '../types/index.js';
import type { SubagentRoundEntry } from './subagent-store.js';

/** 子代理执行回调（可选，用于实时捕获输出） */
export interface SubagentCallbacks {
	/** 每产生一条输出条目时调用 */
	onEntry?: (entry: SubagentRoundEntry) => void;
	/** 每轮 API 调用返回 usage 时调用（子代理 token 入账，O-1） */
	onUsage?: (usage: TokenUsage) => void;
}

/** 被取消时返回的统一标记（I-2：区别于失败，供状态机标 cancelled） */
export const SUBAGENT_CANCELLED = '(subagent cancelled by user)';

/**
 * 运行子代理循环。
 * 无轮次上限——子代理由模型自主决定完成时机（返回纯文本即结束），
 * 失控兜底依赖外部中断（signal）与工具自身超时。
 */
export async function runSubagentLoop(
	task: string,
	provider: ModelProvider,
	tools: Tool[],
	systemPrompt: string,
	signal?: AbortSignal,
	callbacks?: SubagentCallbacks,
): Promise<string> {
	const emit = (entry: SubagentRoundEntry) => {
		callbacks?.onEntry?.(entry);
	};

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

	while (true) {
		if (signal?.aborted) return SUBAGENT_CANCELLED;

		let content = '';
		let reasoning = '';
		const pendingToolCalls: ToolCall[] = [];

		const toolOptions = toolDefs.length > 0 ? { tools: toolDefs } : {};

		try {
			for await (const chunk of provider.chatStream(messages, {
				...toolOptions,
				signal,
			})) {
				const delta = chunk.choices[0]?.delta;
				if (!delta) continue;

				if (delta.reasoning_content) {
					reasoning += delta.reasoning_content;
					emit({ type: 'thinking', content: delta.reasoning_content, timestamp: Date.now() });
				}

				if (delta.content) {
					content += delta.content;
					emit({ type: 'content', content: delta.content, timestamp: Date.now() });
				}

				if (delta.tool_calls && delta.tool_calls.length > 0) {
					accumulateToolCalls(pendingToolCalls, delta.tool_calls);
				}

				// O-1：子代理每轮 usage 入账
				if (chunk.usage) callbacks?.onUsage?.(chunk.usage);
			}
		} catch (err: unknown) {
			// I-2：流式 API 因 signal abort 抛 AbortError → 统一返回取消标记
			if (err instanceof Error && err.name === 'AbortError') {
				return SUBAGENT_CANCELLED;
			}
			throw err;
		}

		if (content) finalContent = content;

		if (pendingToolCalls.length === 0) {
			return finalContent || '(subagent completed with no output)';
		}

		messages.push({
			role: 'assistant',
			content: content || '',
			reasoning_content: reasoning || undefined,
			tool_calls: pendingToolCalls,
		});

		for (const tc of pendingToolCalls) {
			const tool = tools.find((t) => t.name === tc.function.name);
			let args: Record<string, unknown> = {};
			try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }

			emit({
				type: 'tool_call',
				content: tc.function.name,
				timestamp: Date.now(),
				toolName: tc.function.name,
				toolArgs: args,
			});

			let result: string;
			let error: string | undefined;
			if (!tool) {
				result = `Unknown tool: ${tc.function.name}`;
				error = 'unknown_tool';
			} else {
				try {
					const r: ToolResult = await tool.execute(args, signal);
					result = r.content;
					error = r.error;
				} catch (err: unknown) {
					if (err instanceof Error && err.name === 'AbortError') {
						return SUBAGENT_CANCELLED;
					}
					result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
					error = 'tool_error';
				}
			}

			emit({
				type: 'tool_result',
				content: result,
				timestamp: Date.now(),
				toolName: tc.function.name,
				toolError: error,
			});

			messages.push({
				role: 'tool',
				content: result,
				tool_call_id: tc.id,
			});
		}
	}

	// 不可达兜底：循环内所有路径均 return；此处满足类型检查并保持语义
	return finalContent || '(subagent completed with no output)';
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
