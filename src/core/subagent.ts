/**
 * subagent.ts — 子代理循环引擎
 *
 * 独立于 SessionManager，可被任何 ModelProvider 驱动。
 * 子代理有独立消息上下文和受限工具集，不与主代理共享状态。
 * 通过 SubagentCallbacks 将每轮输出（thinking/content/tool_call/tool_result）
 * 实时上报给调用方（SessionManager → SubagentStore → TUI 详情视图）。
 */

import type { ModelProvider, ChatOptions } from './model-provider.js';
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

/**
 * 取消状态消息文案（I-2：区别于失败）。
 * 循环本身不再用它作为返回值——取消由 SubagentLoopResult.status 表达；
 * 本常量供会话层在 cancelled 状态下作为面向 master 的返回值。
 */
export const SUBAGENT_CANCELLED = '(subagent cancelled by user)';

/**
 * 工具执行中被打断时写入的合成 tool 结果。
 * 与主代理 session.ts 中断路径同一文案，保证两套循环的中断语义一致。
 */
const USER_CANCELLED_TOOL_RESULT =
	'The user cancelled this operation during execution. Do not retry the same approach. Explain the reason and suggest an alternative, or ask the user for guidance.';

/** 取消后本轮尚未执行的 tool_call 的配对结果（避免 assistant.tool_calls 悬空导致 API 报错） */
const NOT_EXECUTED_TOOL_RESULT = 'Not executed: the run was cancelled by the user.';

/** 子代理运行结束状态（cancelled 非终态：调用方可在消息序列合法后继续驱动） */
export type SubagentRunStatus = 'completed' | 'cancelled';

/**
 * 子代理循环结果。
 *
 * 不含「最终文本」字段：最终 content 作为最后一条 assistant 消息入队 messages，
 * 由调用方从 messages 派生（SubagentSession.lastContent），
 * 避免「result 字段与最后 content 重复」的历史设计（见 plan/20260912Task.md 需求 4）。
 */
export interface SubagentLoopResult {
	status: SubagentRunStatus;
	/** 最新消息队列（含 system/user/assistant/tool 全部；调用方持有以支持续跑） */
	messages: Message[];
}

/**
 * 运行子代理循环（可恢复会话）。
 *
 * 消息队列由调用方构造并持有（首启：`[system, user(task)]`；续跑：追加 user 指令后重新传入），
 * 循环内 push assistant/tool 消息到内部副本，结束后随结果返回最新队列——调用方保存后
 * 可再次驱动（追加指令续跑），实现"会话化"子代理。
 *
 * 无轮次上限——子代理由模型自主决定完成时机（返回纯文本即结束），
 * 失控兜底依赖外部中断（signal）与工具自身超时。
 *
 * 中断语义（与主代理一致）：signal 中断不会让消息序列出现「assistant.tool_calls 悬空」——
 * 被打断的工具写成合成 tool 结果，本轮剩余 tool_call 补 "not executed" 配对结果后再退出，
 * 因此 cancelled 之后的消息队列仍是合法 API 序列，可直接追加指令续跑。
 */
export async function runSubagentLoop(
	messages: Message[],
	provider: ModelProvider,
	tools: Tool[],
	signal?: AbortSignal,
	callbacks?: SubagentCallbacks,
	chatDefaults?: ChatOptions,
): Promise<SubagentLoopResult> {
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

	// 内部副本：不修改调用方持有的数组引用，返回时给最新队列
	const msgs: Message[] = [...messages];

	while (true) {
		if (signal?.aborted) return { status: 'cancelled', messages: msgs };

		let content = '';
		let reasoning = '';
		const pendingToolCalls: ToolCall[] = [];
		// 流式 content 累积缓冲：按完整行（\n 边界）emit，避免每个 chunk 一条碎 entry
		let contentPending = '';
		const emitContentLine = (line: string): void => {
			emit({ type: 'content', content: line, timestamp: Date.now() });
		};

		const toolOptions = toolDefs.length > 0 ? { tools: toolDefs } : {};

		try {
			for await (const chunk of provider.chatStream(msgs, {
				...toolOptions,
				signal,
				...(chatDefaults ?? {}),
			})) {
				const delta = chunk.choices[0]?.delta;
				if (!delta) continue;

				if (delta.reasoning_content) {
					reasoning += delta.reasoning_content;
					emit({ type: 'thinking', content: delta.reasoning_content, timestamp: Date.now() });
				}

				if (delta.content) {
					content += delta.content;
					contentPending += delta.content;
					// 按完整行 emit（\n 边界），半行留待后续 chunk / 轮次结束 flush
					while (true) {
						const nlIdx = contentPending.indexOf('\n');
						if (nlIdx < 0) break;
						const line = contentPending.slice(0, nlIdx);
						contentPending = contentPending.slice(nlIdx + 1);
						emitContentLine(line);
					}
				}

				if (delta.tool_calls && delta.tool_calls.length > 0) {
					accumulateToolCalls(pendingToolCalls, delta.tool_calls);
				}

				// O-1：子代理每轮 usage 入账
				if (chunk.usage) callbacks?.onUsage?.(chunk.usage);
			}
		} catch (err: unknown) {
			// I-2：流式 API 因 signal abort 抛 AbortError → 统一返回取消状态
			// （此时本轮 assistant 消息尚未入队，队列中不存在悬空 tool_calls）
			if (err instanceof Error && err.name === 'AbortError') {
				return { status: 'cancelled', messages: msgs };
			}
			throw err;
		}

		// flush 剩余未按行拆分的 content 半行（无 \n 结尾的尾部）
		if (contentPending) {
			emitContentLine(contentPending);
			contentPending = '';
		}

		// 自然结束：本轮无工具调用 → 本轮 content 作为最后一条 assistant 消息入队
		// （调用方据此派生返回值；同时让下次续跑时模型能看到自己上次的回答）
		if (pendingToolCalls.length === 0) {
			if (content) {
				msgs.push({
					role: 'assistant',
					content,
					reasoning_content: reasoning || undefined,
				});
			}
			return { status: 'completed', messages: msgs };
		}

		msgs.push({
			role: 'assistant',
			content: content || '',
			reasoning_content: reasoning || undefined,
			tool_calls: pendingToolCalls,
		});

		/** 本轮是否已因用户中断而取消（取消后不再执行剩余工具，只补配对结果） */
		let cancelled = false;

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
			if (cancelled || signal?.aborted) {
				// 已中断：本轮剩余 tool_call 不再执行，只补配对结果，保证序列合法
				cancelled = true;
				result = NOT_EXECUTED_TOOL_RESULT;
				error = 'cancelled';
			} else if (!tool) {
				result = `Unknown tool: ${tc.function.name}`;
				error = 'unknown_tool';
			} else {
				try {
					const r: ToolResult = await tool.execute(args, signal);
					result = r.content;
					error = r.error;
				} catch (err: unknown) {
					if (err instanceof Error && err.name === 'AbortError') {
						// 与主代理一致：中断转为合成 tool 结果，而不是直接 return
						// （直接 return 会让 assistant.tool_calls 悬空 → 续跑时 API 报错）
						cancelled = true;
						result = USER_CANCELLED_TOOL_RESULT;
						error = 'cancelled';
					} else {
						result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
						error = 'tool_error';
					}
				}
			}

			emit({
				type: 'tool_result',
				content: result,
				timestamp: Date.now(),
				toolName: tc.function.name,
				toolError: error,
			});

			msgs.push({
				role: 'tool',
				content: result,
				tool_call_id: tc.id,
			});
		}

		// 中断：本轮工具已全部配对完毕，干净退出（cancelled 非终态，可追加指令续跑）
		if (cancelled) return { status: 'cancelled', messages: msgs };
	}
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
