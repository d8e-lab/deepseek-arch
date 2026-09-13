/**
 * memory-agent.ts — 后台记忆归纳代理（设计稿 §13 R1/R2/R3/R14/R24）
 *
 * 触发：用户发出消息后**并发**启动（不阻塞主 agent，独立 AbortController）。
 * 输入：**游标之后**的对话片段（上一轮「用户 + 助手最终回复」+ 本轮用户消息）；
 *       **不含工具轨迹、不含思维链**（R2）。游标防止同一段对话被反复归纳（R14）。
 *
 * 保护（§7.6）：
 *   - 同会话 single-flight（在跑则跳过，不排队）+ 最小间隔（默认 30s）
 *   - 主/后台互斥：本窗口内 master 自己写过记忆 → 跳过后台归纳并推进游标
 *   - watchdog：工具调用数上限 / 墙钟超时 / token 上限 → abort
 *   - 单次写入配额（默认 3 条，超出由包装后的工具拒绝并提示模型）
 *   - 失败/超时/中止**只写审计**，绝不抛给主流程
 */

import type { ModelProvider } from './model-provider.js';
import type { Tool } from '../tools/types.js';
import { runSubagentLoop } from './subagent.js';
import { MEMORY_AGENT_PROMPT } from './memory-agent-prompt.js';
import { memoryReadTool, readMemoryEntry } from '../tools/memory-read.js';
import { memoryWriteTool, writeMemoryEntry } from '../tools/memory-write.js';
import { memoryForgetTool, forgetMemoryEntry } from '../tools/memory-forget.js';
import { estimateTokens, type MemoryStore } from './memory-store.js';

/** 每轮归纳最多硬淘汰几条（独立于 maxWritesPerRun，防误删；软降级走 memory_write confidence=1） */
const MAX_FORGETS_PER_RUN = 3;

export interface MemoryAgentOptions {
	provider: ModelProvider;
	store: MemoryStore;
	/** 归纳模型（默认由调用方传 memory.agent_model） */
	model: string;
	/** 输入最多轮数（游标之后的保护上限，默认 3） */
	maxInputTurns: number;
	/** 输入 token 预算（默认 6000） */
	maxInputTokens: number;
	/** 单次归纳最多写入条数（默认 3） */
	maxWritesPerRun: number;
	/** 单轮最多工具调用数（默认 8） */
	maxToolCalls: number;
	/** 单次运行最长时长（毫秒，默认 90000） */
	timeoutMs: number;
	/** 同会话两次归纳最小间隔（秒，默认 30） */
	minIntervalSec: number;
	/** 会话 id（审计用） */
	sessionId?: string;
}

/** 一轮对话（已剥离工具轨迹与思维链） */
export interface MemoryAgentTurn {
	user: string;
	assistant: string;
	/** 该轮在会话里的标识（游标推进用） */
	turnId: string;
}

export interface MemoryAgentInput {
	/** 游标之后的对话片段（最新的一轮在最后；调用方已按游标裁剪） */
	turns: MemoryAgentTurn[];
	/** 本轮用户消息（通常等于最后一轮的 user；单独给出便于强调） */
	currentUser: string;
	/** 本窗口内 master 是否自己调用过 memory_write */
	masterWrote?: boolean;
	/** 成功归纳后要推进到的游标（通常是最后一轮的 turnId） */
	nextCursor?: string;
}

export type MemoryAgentStatus = 'done' | 'skipped' | 'error';

export interface MemoryAgentResult {
	status: MemoryAgentStatus;
	reason?:
		| 'busy' | 'interval' | 'no_input' | 'master_wrote'
		| 'timeout' | 'tool_limit' | 'token_limit' | 'aborted' | 'failed';
	/** 实际写入的条目 */
	writes: { slug: string; action: string }[];
	/** agent 的收尾文本（仅供审计） */
	notes?: string;
	elapsedMs: number;
}

export class MemoryAgent {
	private readonly opts: MemoryAgentOptions;
	private running = false;
	private lastRunAt = 0;
	private controller: AbortController | null = null;

	constructor(opts: MemoryAgentOptions) {
		this.opts = opts;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** 中止当前归纳（进程退出 / compact 前收敛用） */
	abort(): void {
		this.controller?.abort();
	}

	async run(input: MemoryAgentInput): Promise<MemoryAgentResult> {
		const started = Date.now();
		const { store } = this.opts;

		// ── 守卫 ──────────────────────────────────────
		if (this.running) return this.skip('busy', started);
		if (Date.now() - this.lastRunAt < this.opts.minIntervalSec * 1000) return this.skip('interval', started);
		if (input.masterWrote) {
			// 主/后台互斥：master 自己写过 → 跳过并推进游标（避免重复归纳同一窗口）
			await this.advanceCursor(input.nextCursor);
			return this.skip('master_wrote', started);
		}
		const turns = this.prepareTurns(input);
		if (turns.length === 0 || !input.currentUser.trim()) {
			await this.advanceCursor(input.nextCursor);
			return this.skip('no_input', started);
		}

		this.running = true;
		this.lastRunAt = Date.now();
		this.controller = new AbortController();
		const writes: MemoryAgentResult['writes'] = [];
		let toolCalls = 0;
		let totalTokens = 0;
		let limitReason: MemoryAgentResult['reason'];

		const timer = setTimeout(() => {
			limitReason = 'timeout';
			this.controller?.abort();
		}, this.opts.timeoutMs);
		if (typeof timer.unref === 'function') timer.unref();

		try {
			const tools = this.buildTools(writes);
			const { messages } = await runSubagentLoop(
				[
					{ role: 'system', content: MEMORY_AGENT_PROMPT },
					{ role: 'user', content: renderInput(turns, input.currentUser) },
				],
				this.opts.provider,
				tools,
				this.controller.signal,
				{
					onEntry: (entry) => {
						if (entry.type !== 'tool_call') return;
						toolCalls++;
						if (toolCalls > this.opts.maxToolCalls) {
							limitReason = 'tool_limit';
							this.controller?.abort();
						}
					},
					onUsage: (usage) => {
						totalTokens += usage.total_tokens;
						if (totalTokens > this.opts.maxInputTokens * 3) {
							limitReason = 'token_limit';
							this.controller?.abort();
						}
					},
				},
				{ model: this.opts.model, temperature: 0.2 },
			);

			const notes = extractFinalText(messages);
			await store.audit({
				kind: 'agent_run',
				at: new Date().toISOString(),
				sid: this.opts.sessionId,
				model: this.opts.model,
				elapsedMs: Date.now() - started,
				totalTokens,
				toolCalls,
				writes,
				aborted: limitReason !== undefined,
				reason: limitReason,
				notes: notes.slice(0, 200),
			});

			if (limitReason) {
				// 被 watchdog 中止：游标**不推进**，下一轮可重试这段窗口
				return { status: 'error', reason: limitReason, writes, notes, elapsedMs: Date.now() - started };
			}
			await this.advanceCursor(input.nextCursor);
			return { status: 'done', writes, notes, elapsedMs: Date.now() - started };
		} catch (err) {
			await store.audit({
				kind: 'error',
				at: new Date().toISOString(),
				scope: 'project',
				where: 'memory_agent',
				message: (err as Error).message,
				sid: this.opts.sessionId,
			});
			return { status: 'error', reason: 'failed', writes, elapsedMs: Date.now() - started };
		} finally {
			clearTimeout(timer);
			this.running = false;
			this.controller = null;
		}
	}

	// ─── 内部 ────────────────────────────────────────

	/** 按输入轮数上限 + token 预算裁剪（最新优先） */
	private prepareTurns(input: MemoryAgentInput): MemoryAgentTurn[] {
		const recent = input.turns.slice(-this.opts.maxInputTurns);
		const kept: MemoryAgentTurn[] = [];
		let used = 0;
		for (let i = recent.length - 1; i >= 0; i--) {
			const t = recent[i];
			const cost = estimateTokens(t.user) + estimateTokens(t.assistant) + 8;
			if (used + cost > this.opts.maxInputTokens && kept.length > 0) break;
			kept.unshift(t);
			used += cost;
		}
		return kept;
	}

	/**
	 * 工具集：记忆读 / 写 / 淘汰（绑定本 agent 的 store）。
	 * 配额包装：超配额返回错误提示（不抛），让 agent 自己收敛。
	 *
	 * 淘汰不计入 `maxWritesPerRun`（否则"写满了就没法清理"），但有独立的每轮上限
	 * `MAX_FORGETS_PER_RUN`，防误删。硬淘汰只对 confidence ≤ 2 开放（见 memory-forget.ts）。
	 */
	private buildTools(writes: MemoryAgentResult['writes']): Tool[] {
		const quota = this.opts.maxWritesPerRun;
		const store = this.opts.store;
		let forgets = 0;
		const readTool: Tool = {
			...memoryReadTool,
			execute: (params) => readMemoryEntry(store, String(params.path ?? '')),
		};
		const writeTool: Tool = {
			...memoryWriteTool,
			async execute(params, signal) {
				if (writes.length >= quota) {
					return {
						content: `memory_write quota reached (max ${quota} per run). Stop writing and finish with a short summary.`,
						error: 'quota_exceeded',
					};
				}
				const result = await writeMemoryEntry(store, params);
				if (!result.error) {
					const m = /"([^"]+\.md)"/.exec(result.content);
					const action = /added/.test(result.content) ? 'add'
						: /updated/.test(result.content) ? 'update'
						: /merged/.test(result.content) ? 'merge'
						: /superseded/.test(result.content) ? 'supersede'
						: 'unknown';
					writes.push({ slug: m ? m[1].replace(/\.md$/, '') : '?', action });
				}
				return result;
			},
		};
		const forgetTool: Tool = {
			...memoryForgetTool,
			async execute(params) {
				if (forgets >= MAX_FORGETS_PER_RUN) {
					return {
						content: `memory_forget limit reached (max ${MAX_FORGETS_PER_RUN} per run). Prefer confidence 1 (soft retire) for the rest.`,
						error: 'quota_exceeded',
					};
				}
				forgets++;
				const result = await forgetMemoryEntry(store, params);
				if (!result.error) writes.push({ slug: String(params.slug ?? '?'), action: 'forget' });
				return result;
			},
		};
		return [readTool, writeTool, forgetTool];
	}

	private async advanceCursor(nextCursor?: string): Promise<void> {
		if (!nextCursor) return;
		try {
			await this.opts.store.setState('project', { lastExtractedTurnId: nextCursor });
		} catch {
			/* 游标写失败不影响主流程 */
		}
	}

	private skip(reason: MemoryAgentResult['reason'], started: number): MemoryAgentResult {
		return { status: 'skipped', reason, writes: [], elapsedMs: Date.now() - started };
	}
}

/** 渲染输入片段：只有用户消息与助手最终回复（R2：无工具轨迹、无思维链） */
export function renderInput(turns: MemoryAgentTurn[], currentUser: string): string {
	const parts = [
		'以下是需要归纳的对话片段（只含用户消息与助手最终回复）：',
		'',
	];
	for (const t of turns) {
		parts.push(`## 用户\n${t.user}`);
		if (t.assistant.trim()) parts.push(`## 助手\n${t.assistant}`);
		parts.push('');
	}
	parts.push(`## 本轮用户消息（重点）\n${currentUser}`);
	return parts.join('\n');
}

/** 取 agent 的最终文本（最后一条非空 assistant content） */
function extractFinalText(messages: { role: string; content?: unknown }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content.trim();
	}
	return '';
}
