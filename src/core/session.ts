/**
 * SessionManager — 会话门面（Facade）
 *
 * 协调 ApiClient + Storage，封装对话生命周期：
 *   1. 创建/恢复会话
 *   2. 发送消息 → API 调用 → 自动持久化 turn JSON
 *   3. 构建请求消息队列（含历史轮次的 reasoning_content 以命中 kv-cache）
 *   4. 更新标题
 *   5. Agent loop（tool calling 支持）
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Storage } from './storage.js';
import type { ModelProvider } from './model-provider.js';
import { yieldEventLoop } from '../utils/event-loop.js';
import { appendCacheLog } from './cache-log.js';
import type {
	Message,
	Session,
	SessionMeta,
	TurnRecord,
	TokenUsage,
	ChatCompletionResponse,
	StreamChunk,
	StreamEvent,
	ToolDefinition,
	RoundUsage,
} from '../types/index.js';

// Re-export for backward compatibility (chat-ui.ts imports from here)
export type { StreamEvent };
import type { Tool, ToolCallRecord } from '../tools/types.js';
import type { ToolCall, ToolCallDelta } from '../types/api.js';

/** 单次 agent loop 最大迭代次数 */
const MAX_AGENT_ROUNDS = 25;

export class SessionManager {
	private storage: Storage;
	private provider: ModelProvider;
	private session: Session | null = null;
	private systemPrompt: Message | null = null;
	private tools: Tool[] = [];

	constructor(storage: Storage, provider: ModelProvider, tools?: Tool[]) {
		this.storage = storage;
		this.provider = provider;
		if (tools) this.tools = tools;
	}

	/** 设置 system prompt（每次请求前插入消息队列首位） */
	setSystemPrompt(prompt: Message | null): void {
		this.systemPrompt = prompt;
	}

	// ─── 会话生命周期 ──────────────────────────────

	/** 创建新会话并持久化 meta.json，同时保存 system prompt 供调试检查 */
	async startNewSession(title = ''): Promise<SessionMeta> {
		const meta = await this.storage.createSession(title);
		this.session = {
			meta,
			turns: [],
			systemPrompt: this.systemPrompt?.content,
		};

		// 将完整 system prompt 写入会话目录，方便调试 kv-cache 命中率
		if (this.systemPrompt?.content) {
			const dir = this.storage.sessionDir(meta.id);
			await writeFile(join(dir, 'system-prompt.txt'), this.systemPrompt.content, 'utf-8');
		}

		return meta;
	}

	/** 恢复已有会话（从文件加载所有 turn，恢复 system prompt 以命中 kv-cache） */
	async resumeSession(id: string): Promise<Session> {
		const session = await this.storage.getSession(id);
		if (!session) throw new Error(`会话不存在: ${id}`);
		this.session = session;
		// 使用持久化的 system prompt 覆盖当前构建的（保证消息前缀与缓存一致）
		if (session.systemPrompt) {
			this.systemPrompt = { role: 'system', content: session.systemPrompt };
		}
		return session;
	}

	/** 获取当前会话 */
	getSession(): Session | null {
		return this.session;
	}

	/** 获取当前会话 ID */
	getSessionId(): string | null {
		return this.session?.meta.id ?? null;
	}

	/** 切换默认模型 */
	setModel(model: string): void {
		this.provider.setModel?.(model);
	}

	/** 更新会话标题 */
	async setTitle(title: string): Promise<void> {
		if (!this.session) return;
		await this.storage.updateSessionTitle(this.session.meta.id, title);
		this.session.meta.title = title;
		this.session.meta.updated_at = new Date().toISOString();
	}

	// ─── Tool 辅助 ──────────────────────────────────

	/** 将 Tool[] 转为 API 所需的 ToolDefinition[] */
	private toolsToDefinitions(): ToolDefinition[] {
		return this.tools.map((t) => ({
			type: 'function' as const,
			function: {
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			},
		}));
	}

	/** 将流式 tool_calls delta 累积到 ToolCall[] 中 */
	private accumulateToolCalls(
		acc: ToolCall[],
		deltas: ToolCallDelta[],
	): void {
		for (const delta of deltas) {
			// 找到或创建对应 index 的 ToolCall
			while (acc.length <= delta.index) {
				acc.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
			}
			const tc = acc[delta.index];
			if (delta.id) tc.id = delta.id;
			if (delta.function?.name) tc.function.name += delta.function.name;
			if (delta.function?.arguments) tc.function.arguments += delta.function.arguments;
		}
	}

	// ─── 消息收发 ─────────────────────────────────

	/**
	 * 发送用户消息并返回本轮完整记录
	 *
	 * 自动构建消息队列（system prompt → 历史 turns → 当前消息），
	 * 调用 API 后持久化 turn JSON 到文件系统。
	 */
	async sendMessage(
		userContent: string,
	): Promise<{ turn: TurnRecord; response: ChatCompletionResponse }> {
		if (!this.session) {
			throw new Error('未创建会话——请先调用 startNewSession() 或 resumeSession()');
		}

		// 构建完整消息队列
		const messages = this.buildMessages(userContent);

		// 调用 API（带上 tools）
		const options = this.tools.length > 0 ? { tools: this.toolsToDefinitions() } : undefined;
		const response = await this.provider.chat(messages, options);

		const choice = response.choices[0];
		const assistantMsg = choice?.message;
		if (!assistantMsg) {
			throw new Error('模型返回空响应');
		}

		// 提取 usage（API 不保证一定有）
		const usage: TokenUsage = response.usage ?? {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		};

		// 费用暂为 0（Phase 7 TokenCalculator 实现后补全）
		const costRmb = 0;

		// 持久化 turn JSON
		const turn = await this.storage.saveTurn(
			this.session.meta.id,
			{ role: 'user', content: userContent },
			{
				id: response.id,
				role: 'assistant',
				content: assistantMsg.content,
				reasoning_content: assistantMsg.reasoning_content,
			},
			usage,
			costRmb,
		);

		// 更新内存中的会话
		this.session.turns.push(turn);
		this.session.meta.turnCount = this.session.turns.length;
		this.session.meta.updated_at = turn.created_at;

		return { turn, response };
	}

	/**
	 * 流式发送用户消息（支持 agent loop + tool calling）
	 *
	 * 当 tools 不为空时，模型可能返回 tool_calls。执行工具后将结果发回模型，
	 * 循环直到模型返回纯文本或无更多工具调用（最多 25 轮）。
	 *
	 * 通过 onEvent 回调推送增量内容，支持外部 AbortSignal 中断。
	 * 流式完成后自动持久化 turn；中断时保存不完整轮次（interrupted=true）。
	 *
	 * @returns 完整的 TurnRecord（正常完成），或 null（中断/错误）
	 */
	async sendMessageStream(
		userContent: string,
		onEvent: (event: StreamEvent) => void,
		signal?: AbortSignal,
		onConfirm?: (toolName: string, params: Record<string, unknown>) => Promise<boolean>,
	): Promise<TurnRecord | null> {
		if (!this.session) {
			throw new Error('未创建会话——请先调用 startNewSession() 或 resumeSession()');
		}

		const baseMessages = this.buildMessages(userContent);
		const toolDefs = this.tools.length > 0 ? this.toolsToDefinitions() : undefined;

		let responseId = '';
		let modelName = '';
		let finalContent = '';
		let finalReasoning = '';
		let usage: TokenUsage | undefined;
		const toolRecords: ToolCallRecord[] = [];
		/** Agent loop 中累积的 tool_call/results 消息 */
		const agentMessages: Message[] = [];
		/** 每轮 API 调用的 token 用量（用于监控缓存命中率） */
		const roundUsages: RoundUsage[] = [];

		try {
			// ── Agent Loop ──────────────────────────
			let userDenied = false;

			for (let round = 0; round < MAX_AGENT_ROUNDS && !userDenied; round++) {
				const roundMessages = [...baseMessages, ...agentMessages];

				let roundContent = '';
				let roundReasoning = '';
				const pendingToolCalls: ToolCall[] = [];

				for await (const chunk of this.provider.chatStream(roundMessages, {
					tools: toolDefs,
					signal,
				})) {
					if (!responseId) responseId = chunk.id;
					if (!modelName) modelName = chunk.model;

					const delta = chunk.choices[0]?.delta;
					if (!delta) continue;

					// reasoning delta
					if (delta.reasoning_content) {
						roundReasoning += delta.reasoning_content;
						finalReasoning += delta.reasoning_content;
						onEvent({ type: 'reasoning_delta', text: delta.reasoning_content });
					}

					// content delta
					if (delta.content) {
						roundContent += delta.content;
						finalContent += delta.content;
						onEvent({ type: 'content_delta', text: delta.content });
					}

					// tool_calls delta
					if (delta.tool_calls && delta.tool_calls.length > 0) {
						this.accumulateToolCalls(pendingToolCalls, delta.tool_calls);
						// 发送 tool_call_delta 事件（TUI 可选择性展示）
						for (const tcd of delta.tool_calls) {
							if (tcd.function?.arguments) {
								onEvent({ type: 'tool_call_delta', text: tcd.function.arguments });
							}
						}
					}

					if (chunk.usage) usage = chunk.usage;
					await yieldEventLoop();
				}

				// 记录本轮 API 调用的 token 用量
				if (usage) {
					roundUsages.push({
						round,
						prompt_tokens: usage.prompt_tokens,
						completion_tokens: usage.completion_tokens,
						cache_hit_tokens: usage.prompt_cache_hit_tokens ?? 0,
						cache_miss_tokens: usage.prompt_cache_miss_tokens ?? 0,
					});
				}

				// 本轮无 tool_calls → 自然终止
				if (pendingToolCalls.length === 0) {
					// 保存最终的 assistant 响应到 agentMessages（用于后续轮次重建）
					agentMessages.push({
						role: 'assistant',
						content: roundContent,
						reasoning_content: roundReasoning || undefined,
					});
					break;
				}

				// ── 执行 tool calls ──────────────────
				// 添加 assistant 消息（含 tool_calls, reasoning_content）
				agentMessages.push({
					role: 'assistant',
					content: roundContent || '',
					tool_calls: pendingToolCalls,
					reasoning_content: roundReasoning || undefined,
				});

				for (let i = 0; i < pendingToolCalls.length; i++) {
					const tc = pendingToolCalls[i];
					const tool = this.tools.find((t) => t.name === tc.function.name);
					let args: Record<string, unknown> = {};
					try {
						args = JSON.parse(tc.function.arguments);
					} catch {
						// JSON 解析失败，args 留空
					}

					// 通知 TUI：工具开始执行
					onEvent({
						type: 'tool_call_start',
						toolCallId: tc.id,
						toolName: tc.function.name,
						toolArgs: args,
					});

					// 生成 diff 预览（文件修改工具）
					let previewText: string | undefined;
					if (tool?.preview) {
						const preview = await tool.preview(args);
						if (preview !== null && preview !== undefined) {
							previewText = preview;
							onEvent({
								type: 'tool_preview',
								toolCallId: tc.id,
								toolName: tc.function.name,
								toolPreview: preview,
							});
						}
					}

					// 需要用户确认的工具：通过 onConfirm 回调确认（diff 已渲染在屏幕上）
					let denied = false;
					const isStalePreview = previewText?.startsWith('[STALE]');
					if (tool?.requiresConfirm && onConfirm && !isStalePreview) {
						const approved = await onConfirm(tc.function.name, args);
						if (!approved) {
							denied = true;
							userDenied = true;
						}
					}
					const startMs = Date.now();
					let toolResult: string;
					let toolError: string | undefined;

					if (denied) {
						toolResult = 'The user rejected this operation. Do not retry the same approach. Explain the reason for the change and suggest an alternative, or ask the user for guidance.';
						toolError = 'denied';
					} else if (tool) {
						try {
							const r = await tool.execute(
								args,
								signal,
								(line, stream) => {
									onEvent({
										type: 'tool_output',
										toolCallId: tc.id,
										toolName: tc.function.name,
										outputLine: line,
										outputStream: stream,
									});
								},
							);
							toolResult = r.content;
							toolError = r.error;
						} catch (err: unknown) {
							if (err instanceof Error && err.name === 'AbortError') {
								// 用户 Ctrl+C 中断工具执行，与拒绝对齐：设 userDenied，走同样的 skip+break 路径
								toolResult = 'The user cancelled this operation during execution. Do not retry the same approach. Explain the reason and suggest an alternative, or ask the user for guidance.';
								toolError = 'cancelled';
								userDenied = true;
							} else {
								throw err;
							}
						}
					} else {
						toolResult = `Unknown tool: ${tc.function.name}`;
						toolError = 'unknown_tool';
					}

				// 拼入 error 信息：确保模型能感知工具执行失败
				const toolMessage = toolError ? `${toolResult}\nError: ${toolError}` : toolResult;

					const durationMs = Date.now() - startMs;

					toolRecords.push({
						id: tc.id,
						name: tc.function.name,
						arguments: args,
						result: toolResult,
						error: toolError,
						duration_ms: durationMs,
						preview: previewText,
					});

					// 通知 TUI：工具执行完成
					onEvent({
						type: 'tool_result',
						toolCallId: tc.id,
						toolName: tc.function.name,
						toolResult,
						error: toolError,
						toolDenied: denied || toolError === 'cancelled',
					});

					// 拒绝/取消时：写入结果，剩余 tool 补 skip 结果，退出 agent loop
					if (denied || toolError === 'cancelled') {
						agentMessages.push({
							role: 'tool',
							content: toolMessage,
							tool_call_id: tc.id,
						});
						for (let j = i + 1; j < pendingToolCalls.length; j++) {
							agentMessages.push({
								role: 'tool',
								content: 'Skipped: a previous tool call was rejected or cancelled by the user.',
								tool_call_id: pendingToolCalls[j].id,
							});
						}
						break;
					}

					// 将 tool 结果加入 messages
					agentMessages.push({
						role: 'tool',
						content: toolMessage,
						tool_call_id: tc.id,
					});
				}
			}

			// 达到最大轮次上限：注入截断消息到 agentMessages 以保证序列完整
			if (!userDenied && !finalContent && toolRecords.length > 0) {
				const truncMsg = '(Reached max tool rounds — stopping.)';
				finalContent = truncMsg;
				agentMessages.push({
					role: 'assistant',
					content: truncMsg,
				});
				onEvent({ type: 'content_delta', text: truncMsg });
			}

			// ── 持久化 ──────────────────────────────
			const finalUsage = usage ?? {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
			};

			const costRmb = 0; // Phase 7

			const turn = await this.storage.saveTurn(
				this.session.meta.id,
				{ role: 'user', content: userContent },
				{
					id: responseId || '',
					role: 'assistant',
					content: finalContent || '(no response)',
					reasoning_content: finalReasoning || undefined,
				},
				finalUsage,
				costRmb,
				false,
				toolRecords.length > 0 ? toolRecords : undefined,
				agentMessages.length > 0 ? agentMessages : undefined,
				roundUsages.length > 0 ? roundUsages : undefined,
			);

			// 写入缓存命中率监控日志
			if (roundUsages.length > 0) {
				const dir = this.storage.sessionDir(this.session.meta.id);
				appendCacheLog(dir, this.session.meta.id, this.session.turns.length + 1, roundUsages);
			}

			this.session.turns.push(turn);
			this.session.meta.turnCount = this.session.turns.length;
			this.session.meta.updated_at = turn.created_at;

			onEvent({ type: 'done', usage: finalUsage });
			return turn;
		} catch (err: unknown) {
			const isAbort = err instanceof Error && err.name === 'AbortError';
			const msg = err instanceof Error ? err.message : String(err);

			if (isAbort && (finalReasoning || finalContent)) {
				// 中断：保存不完整轮次
				const partialUsage = usage ?? {
					prompt_tokens: 0,
					completion_tokens: 0,
					total_tokens: 0,
				};

				try {
					const turn = await this.storage.saveTurn(
						this.session.meta.id,
						{ role: 'user', content: userContent },
						{
							id: responseId || '',
							role: 'assistant',
							content: finalContent || '[已中断]',
							reasoning_content: finalReasoning || undefined,
						},
						partialUsage,
						0,
						true, // interrupted
						toolRecords.length > 0 ? toolRecords : undefined,
						agentMessages.length > 0 ? agentMessages : undefined,
						roundUsages.length > 0 ? roundUsages : undefined,
					);

					this.session.turns.push(turn);
					this.session.meta.turnCount = this.session.turns.length;
					this.session.meta.updated_at = turn.created_at;

					onEvent({ type: 'error', error: '已中断' });
					return turn;
				} catch {
					// 持久化失败，不阻塞
				}
			}

			onEvent({ type: 'error', error: msg });
			return null;
		}
	}

	/** 构建请求消息队列（跳过 interrupted 轮次，直接拼接存储的消息序列以命中 kv-cache） */
	private buildMessages(currentContent: string): Message[] {
		const messages: Message[] = [];

		// 1. System prompt
		if (this.systemPrompt) {
			messages.push(this.systemPrompt);
		}

		// 2. 历史轮次（跳过中断的不完整轮次）
		for (const turn of this.session!.turns) {
			if (turn.interrupted) continue;

			// 优先使用存储的完整消息序列（精确回放 API 收发的消息前缀）
			if (turn.messages && turn.messages.length > 0) {
				messages.push(...turn.messages);
				continue;
			}

			// 兼容旧数据：从 tool_calls 反向重建
			messages.push(turn.user);

			const tcRecords = (turn as unknown as Record<string, unknown>).tool_calls as ToolCallRecord[] | undefined;
			if (tcRecords && tcRecords.length > 0) {
				const toolCalls: ToolCall[] = tcRecords.map((tcr) => ({
					id: tcr.id,
					type: 'function' as const,
					function: {
						name: tcr.name,
						arguments: JSON.stringify(tcr.arguments),
					},
				}));
				messages.push({
					role: 'assistant',
					content: '',
					tool_calls: toolCalls,
				});
				for (const tcr of tcRecords) {
					const msgContent = tcr.result || tcr.error
						? `${tcr.result || ''}${tcr.error ? '\nError: ' + tcr.error : ''}`
						: '';
					messages.push({
						role: 'tool',
						content: msgContent,
						tool_call_id: tcr.id,
					});
				}
			}

			messages.push({
				role: 'assistant',
				content: turn.assistant.content,
				reasoning_content: turn.assistant.reasoning_content,
			});
		}

		// 3. 当前用户消息
		messages.push({ role: 'user', content: currentContent });

		return messages;
	}
}
