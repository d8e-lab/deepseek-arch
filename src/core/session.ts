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
import { reviewConversation } from './reviewer.js';
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
	ReviewVerdict,
} from '../types/index.js';

// Re-export for backward compatibility (chat-ui.ts imports from here)
export type { StreamEvent };
import type { Tool, ToolCallRecord } from '../tools/types.js';
import type { ToolCall, ToolCallDelta } from '../types/api.js';
import { getAllTools } from '../tools/index.js';
import { runSubagentLoop } from './subagent.js';

/** 单次 agent loop 最大迭代次数 */
const MAX_AGENT_ROUNDS = 25;

/** 子代理 System Prompt 追加内容（行为约束） */
const SUBAGENT_APPEND_PROMPT = `
## Subagent Mode

You are running as a subagent delegated by a master agent. Key constraints:

- Execute the assigned sub-task and return a concise result.
- You have access to shell, file, and browser tools.
- Do NOT ask the user questions — there is no interactive user in this context.
- Do NOT spawn sub-subagents, use wait, or list_subagents (these tools are not available to you).
- Do NOT use plan_on or save_plan (not available).
- If you cannot complete the task, explain why and return what you have.
- Keep output focused: the master agent needs your result, not a conversation.`;

/** 后台子代理状态（Agent Loop 中追踪） */
interface PendingSubagent {
	toolCallId: string;
	promise: Promise<string>;
	status: 'running' | 'completed' | 'failed';
	result?: string;
	startMs: number;
}

export class SessionManager {
	private storage: Storage;
	private provider: ModelProvider;
	private session: Session | null = null;
	private systemPrompt: Message | null = null;
	private tools: Tool[] = [];
	private _subagentAsync: boolean = false;

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

		// 恢复浏览器到上次访问的 URL（如果浏览器工具可用）
		this._restoreBrowserUrl(session);

		return session;
	}

	/**
	 * 尝试恢复浏览器到上次访问的 URL
	 * 浏览器工具不可用时静默跳过
	 */
	private async _restoreBrowserUrl(session: Session): Promise<void> {
		if (!session.meta.lastBrowserUrl) return;
		try {
			const { getBrowserState } = await import('../tools/browser-state.js');
			const state = getBrowserState();
			await state.restoreUrl(session.meta.lastBrowserUrl);
		} catch {
			/* 浏览器工具不可用（未安装 playwright），静默跳过 */
		}
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

	/** 设置子代理异步模式 */
	setSubagentAsync(enabled: boolean): void {
		this._subagentAsync = enabled;
	}

	/** 获取子代理异步模式 */
	getSubagentAsync(): boolean {
		return this._subagentAsync;
	}

	/**
	 * 运行子代理循环（供 subagent_spawn 工具调用）
	 *
	 * 子代理使用独立消息上下文、受限工具集（无 spawn/wait/list/plan），
	 * 复用当前 provider 和 system prompt（追加子代理行为约束）。
	 */
	async runSubagent(task: string, signal?: AbortSignal): Promise<string> {
		const subagentTools = getAllTools(); // 不含 subagent 管理工具
		const basePrompt = this.systemPrompt?.content ?? '';
		const subagentPrompt = basePrompt + SUBAGENT_APPEND_PROMPT;
		return runSubagentLoop(task, this.provider, subagentTools, subagentPrompt, signal);
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

	/**
	 * 尝试获取浏览器当前 URL（浏览器工具不可用时返回 undefined）
	 */
	private async _browserLastUrl(): Promise<string | undefined> {
		try {
			const { getBrowserState } = await import('../tools/browser-state.js');
			const url = getBrowserState().getLastUrl();
			return url || undefined;
		} catch {
			return undefined;
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
		const browserUrl = await this._browserLastUrl();
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
			undefined,
			undefined,
			undefined,
			undefined,
			browserUrl,
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
		reviewModelName?: string,
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
		/** 审查自动续期计数（防无限循环） */
		let autoContinueCount = 0;
		const MAX_AUTO_CONTINUE = 3;
		/** 是否已创建进行中的 turn（用于增量落盘） */
		let turnSaved = false;
		const userMsg: Message = { role: 'user', content: userContent };

		// ── 子代理状态追踪 ──────────────────────
		const pendingSubagents = new Map<string, PendingSubagent>();
		/** 模型已通过 wait 取走结果的 subagent 名称集合 */
		const retrievedSubagents = new Set<string>();
		/** 是否异步模式（默认非异步） */
		const asyncMode = this._subagentAsync ?? false;

		/** 拦截子代理工具调用（subagent_spawn / wait / list_subagents），返回 true 表示已处理 */
		const interceptSubagentTool = async (
			tc: ToolCall,
			args: Record<string, unknown>,
			pending: Map<string, PendingSubagent>,
			retrieved: Set<string>,
			async: boolean,
			msgs: Message[],
			records: ToolCallRecord[],
			emit: (event: StreamEvent) => void,
			launch: (task: string) => Promise<string>,
			signal?: AbortSignal,
		): Promise<boolean> => {
			const pushResult = (result: string, error?: string, durationMs = 0) => {
				msgs.push({ role: 'tool', content: result, tool_call_id: tc.id });
				records.push({
					id: tc.id, name: tc.function.name, arguments: args,
					result, error, duration_ms: durationMs,
				});
				emit({
					type: 'tool_result', toolCallId: tc.id,
					toolName: tc.function.name, toolResult: result, error,
				});
			};

			switch (tc.function.name) {
				case 'subagent_spawn': {
					const name = (args.subagent_name as string) || '';
					const task = (args.task as string) || '';
					if (!name || !task) {
						pushResult('Error: both "subagent_name" and "task" are required.', 'invalid_params');
						return true;
					}
					if (pending.has(name)) {
						pushResult(`Error: subagent "${name}" already exists. Use a unique name.`, 'duplicate');
						return true;
					}

					const startMs = Date.now();
					const promise = launch(task).then((r) => {
						const sub = pending.get(name);
						if (sub) {
							sub.status = r.startsWith('Error:') ? 'failed' : 'completed';
							sub.result = r;
						}
						return r;
					}).catch((err) => {
						const sub = pending.get(name);
						if (sub) {
							sub.status = 'failed';
							sub.result = `Error: ${err instanceof Error ? err.message : String(err)}`;
						}
						return '';  // 不会到这里
					});

					pending.set(name, {
						toolCallId: tc.id,
						promise,
						status: 'running',
						startMs,
					});

					if (async) {
						pushResult(
							`[SPAWNED] Subagent "${name}" started. Task: ${task.slice(0, 150)}${task.length > 150 ? '...' : ''}\nUse list_subagents to check status, wait("${name}") to retrieve result.`,
						);
					} else {
						// 非异步：阻塞等待
						const result = await promise;
						// 此时 status 已由 then/catch 更新为 completed/failed
						pushResult(
							`Subagent "${name}" completed.\n\n${result}`,
							pending.get(name)?.status === 'failed' ? 'subagent_failed' : undefined,
							Date.now() - startMs,
						);
					}
					return true;
				}

				case 'wait': {
					const name = (args.subagent_name as string) || '';
					if (!name) {
						pushResult('Error: "subagent_name" is required.', 'invalid_params');
						return true;
					}
					const sub = pending.get(name);
					if (!sub) {
						pushResult(
							`Subagent "${name}" not found. It may have already been retrieved or never existed. Use list_subagents to check.`,
							'not_found',
						);
						return true;
					}
					if (retrieved.has(name)) {
						pushResult(
							`Subagent "${name}" result was already retrieved and cannot be retrieved again.`,
							'already_retrieved',
						);
						return true;
					}

					const startMs = Date.now();
					const result = await sub.promise;
					const elapsed = Date.now() - startMs;

					retrieved.add(name);
					pushResult(
						`Subagent "${name}" result:\n\n${result}`,
						sub.status === 'failed' ? 'subagent_failed' : undefined,
						elapsed,
					);
					return true;
				}

				case 'list_subagents': {
					if (pending.size === 0) {
						pushResult('No subagents in this session.');
						return true;
					}
					const now = Date.now();
					const lines: string[] = [];
					for (const [n, sub] of pending) {
						const elapsed = Math.round((now - sub.startMs) / 1000);
						const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
						const retrievedStr = retrieved.has(n) ? ' [retrieved]' : '';

						if (sub.status === 'running') {
							lines.push(`- "${n}"  running (${elapsedStr})`);
						} else if (sub.status === 'completed') {
							lines.push(`- "${n}"  completed (${elapsedStr}) — use wait("${n}")${retrievedStr}`);
						} else {
							lines.push(`- "${n}"  failed (${elapsedStr}) — use wait("${n}")${retrievedStr}`);
						}
					}
					pushResult(lines.join('\n'));
					return true;
				}

				default:
					return false;
			}
		};

		try {
			// ── Agent Loop ──────────────────────────
			let userDenied = false;

			for (let round = 0; !userDenied; round++) {
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

				// 本轮无 tool_calls → 检查子代理状态
				if (pendingToolCalls.length === 0) {
					agentMessages.push({
						role: 'assistant',
						content: roundContent,
						reasoning_content: roundReasoning || undefined,
					});

					// 异步模式：存在未取走且未完成的子代理 → 提醒模型继续
					if (asyncMode && pendingSubagents.size > 0) {
						const hasIncomplete = [...pendingSubagents.values()].some(
							(s) => s.status === 'running',
						);
						const hasUnretrieved = [...pendingSubagents.entries()].some(
							([name, s]) =>
								(s.status === 'completed' || s.status === 'failed') &&
								!retrievedSubagents.has(name),
						);

						if (hasIncomplete || hasUnretrieved) {
							// 静态提醒，不随子代理状态变化——保证 kv-cache 前缀稳定
							agentMessages.push({
								role: 'user',
								content: '[system] You have pending subagents. Use list_subagents to check status, wait("<name>") to retrieve results.',
							});
							continue;
						}
						// All retrieved → normal flow (break)
					}

					// ── YOLO 审查：检查模型回复是否需要自动继续 ──────
					if (reviewModelName && autoContinueCount < MAX_AUTO_CONTINUE) {
						const pastInputs = this.session!.turns
							.slice(-(MAX_AUTO_CONTINUE + 1))
							.map(t => t.user.content);
						const recentInputs = [...pastInputs, userContent].slice(-5);

						const { verdict, reason } = await reviewConversation(
							recentInputs,
							roundContent,
							this.provider,
							reviewModelName,
						);

						if (verdict === 'stalled' || verdict === 'deflecting') {
							autoContinueCount++;
							const prompt = verdict === 'stalled'
								? '[auto-continue] 任务未完成，请继续执行。直接完成剩余操作，使用所需的工具。如果任务已完成，请输出完成情况说明。'
								: '[auto-continue] 请直接使用工具执行所需命令来完成任务。不要将操作推给用户，你有 shell、文件编辑等工具可用。任务完成后请输出完成情况说明。';

							agentMessages.push({ role: 'user', content: prompt });

							onEvent({
								type: 'review_verdict',
								verdict,
								reviewReason: reason,
								autoContinue: true,
							});

							continue;
						}

						onEvent({
							type: 'review_verdict',
							verdict,
							reviewReason: reason,
							autoContinue: false,
						});
					}

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

				// 首次遇到 tool call：创建进行中的 turn 落盘
				if (!turnSaved) {
					turnSaved = true;
					try {
						await this.storage.saveTurn(
							this.session.meta.id,
							userMsg,
							{ id: responseId || '', role: 'assistant', content: roundContent || '', reasoning_content: roundReasoning || undefined },
							{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
							0,
							true, // interrupted — 进行中
							undefined, // toolCalls 稍后由 updateLastTurn 设置
							[userMsg, ...agentMessages],
							roundUsages.length > 0 ? roundUsages : undefined,
							await this._browserLastUrl(),
						);
					} catch { /* 持久化失败不阻塞 */ }
				}

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

					// ── 子代理工具拦截 ──────────────────
					const intercepted = await interceptSubagentTool(
						tc, args, pendingSubagents, retrievedSubagents,
						asyncMode, agentMessages, toolRecords, onEvent,
						(task) => this.runSubagent(task, signal),
						signal,
					);
					if (intercepted) continue;
					// ───────────────────────────────────

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

				// 每轮工具执行后增量落盘（在 agent loop 内）
				if (turnSaved) {
					try {
						await this.storage.updateLastTurn(this.session.meta.id, {
							toolCalls: toolRecords,
							messages: [userMsg, ...agentMessages],
							usage: usage ?? undefined,
							roundUsages: roundUsages.length > 0 ? roundUsages : undefined,
							lastBrowserUrl: await this._browserLastUrl(),
						});
					} catch { /* 持久化失败不阻塞 */ }
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

			const browserUrl = await this._browserLastUrl();
			let turn: TurnRecord;

			if (turnSaved) {
				// 已有进行中的 turn：更新为完成状态
				turn = (await this.storage.updateLastTurn(this.session.meta.id, {
					assistant: { content: finalContent || '(no response)', reasoning_content: finalReasoning || undefined },
					toolCalls: toolRecords.length > 0 ? toolRecords : undefined,
					messages: agentMessages.length > 0 ? [userMsg, ...agentMessages] : undefined,
					usage: finalUsage,
					roundUsages: roundUsages.length > 0 ? roundUsages : undefined,
					interrupted: false,
					lastBrowserUrl: browserUrl,
				}))!;
			} else {
				// 无工具调用：直接追加新 turn
				const costRmb = 0;
				turn = await this.storage.saveTurn(
					this.session.meta.id,
					userMsg,
					{
						id: responseId || '',
						role: 'assistant',
						content: finalContent || '(no response)',
						reasoning_content: finalReasoning || undefined,
					},
					finalUsage,
					costRmb,
					false,
					undefined,
					undefined,
					roundUsages.length > 0 ? roundUsages : undefined,
					browserUrl,
				);
				this.session.turns.push(turn);
			}

			// 写入缓存命中率监控日志
			if (roundUsages.length > 0) {
				const dir = this.storage.sessionDir(this.session.meta.id);
				appendCacheLog(dir, this.session.meta.id, this.session.turns.length + 1, roundUsages);
			}

			// 更新内存中的 session 元数据（turnSaved 时 turn 已在 turns 数组中）
			if (turnSaved) {
				const lastIdx = this.session.turns.length - 1;
				if (lastIdx >= 0) {
					this.session.turns[lastIdx] = turn;
				} else {
					this.session.turns.push(turn);
				}
			}
			this.session.meta.turnCount = this.session.turns.length;
			this.session.meta.updated_at = turn.created_at;

			onEvent({ type: 'done', usage: finalUsage });
			return turn;
		} catch (err: unknown) {
			const isAbort = err instanceof Error && err.name === 'AbortError';
			const msg = err instanceof Error ? err.message : String(err);

			// 有工具调用记录才保留中断轮次
			if (toolRecords.length > 0) {
				const partialUsage = usage ?? {
					prompt_tokens: 0,
					completion_tokens: 0,
					total_tokens: 0,
				};

				try {
					const browserUrl = await this._browserLastUrl();
					let turn: TurnRecord;

					if (turnSaved) {
						// 已有进行中的 turn：更新为中断状态
						turn = (await this.storage.updateLastTurn(this.session.meta.id, {
							assistant: { content: '[已中断]', reasoning_content: finalReasoning || undefined },
							toolCalls: toolRecords,
							messages: [userMsg, ...agentMessages],
							usage: partialUsage,
							roundUsages: roundUsages.length > 0 ? roundUsages : undefined,
							interrupted: true,
							lastBrowserUrl: browserUrl,
						}))!;
						const lastIdx = this.session.turns.length - 1;
						if (lastIdx >= 0) this.session.turns[lastIdx] = turn;
					} else {
						// 工具刚返回 tool_calls 但尚未首次 saveTurn → 直接追加
						turn = await this.storage.saveTurn(
							this.session.meta.id,
							userMsg,
							{ id: responseId || '', role: 'assistant', content: '[已中断]', reasoning_content: finalReasoning || undefined },
							partialUsage,
							0,
							true,
							toolRecords,
							[userMsg, ...agentMessages],
							roundUsages.length > 0 ? roundUsages : undefined,
							browserUrl,
						);
						this.session.turns.push(turn);
					}

					this.session.meta.turnCount = this.session.turns.length;
					this.session.meta.updated_at = turn.created_at;

					onEvent({ type: 'error', error: isAbort ? '已中断' : msg });
					return turn;
				} catch {
					// 持久化失败，不阻塞
				}
			}

			onEvent({ type: 'error', error: msg });
			return null;
		}
	}

	/** 构建请求消息队列（中断轮次保留用户消息 + 已完成工具结果，以维持上下文连续性） */
	private buildMessages(currentContent: string): Message[] {
		const messages: Message[] = [];

		// 1. System prompt
		if (this.systemPrompt) {
			messages.push(this.systemPrompt);
		}

		// 2. 历史轮次
		for (const turn of this.session!.turns) {
			if (turn.interrupted) {
				// 中断轮次：保留用户消息 + 已完成的工具交互，但不包含截断的 assistant 最终回复
				if (turn.messages && turn.messages.length > 0) {
					messages.push(...turn.messages);
				} else {
					// 兼容旧数据：至少保留用户消息
					messages.push(turn.user);
				}
				continue;
			}

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
