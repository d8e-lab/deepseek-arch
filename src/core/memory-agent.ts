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
import { estimateTokens, renderManifestLine, type MemoryEntry, type MemoryStore } from './memory-store.js';

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
	/** 索引里"⏳待销毁(已 N/limit 活动日)"的分母（与 [memory] 配置保持一致） */
	destroyAfterDays?: number;
	candidateTtlDays?: number;
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

/**
 * 渲染「现有记忆索引」注入归纳代理的输入（对齐 Claude Code 的"清单前置"）。
 *
 * 为什么必须有：
 *   - 没有它，agent 无从判断"该更新哪条"，只能靠瞎猜 subject → 产生重复条目；
 *   - **候选池（confidence 1）master 看不到、也不会被 `memory_read` 命中**，
 *     因此那批条目的升级只能由 agent 在归纳时决定 —— 它必须先"看得见"候选池。
 *
 * 另外给一段「**可能与本轮相关**」：条目多时上面的索引会截断，靠这段把"语义接近的几条"
 * 顶到眼前（本轮对话关键词 × 条目 name/description/tags/subject/正文的**确定性**重叠打分，
 * 零 API 成本；只负责"挑出来给你看"，是否同义/该更新哪条仍由你判断）。
 *
 * @param maxPerSection 每段最多列多少条（防超长；超出标注省略数）
 * @param taskText 本轮对话文本（用于相关性初筛；省略则不生成"可能相关"段）
 */
export async function renderMemoryIndex(
	store: MemoryStore,
	maxPerSection = 30,
	taskText = '',
	limits: { activeDay?: number; destroyAfterDays?: number; candidateTtlDays?: number } = {},
): Promise<string> {
	const out: string[] = [];
	const destroyAfter = limits.destroyAfterDays ?? 30;
	const candidateTtl = limits.candidateTtlDays ?? 365;
	const all: (MemoryEntry & { scopeLabel: string })[] = [];
	for (const scope of ['project', 'global'] as const) {
		const label = scope === 'project' ? '项目层' : '全局层';
		const active = await store.listEntries(scope);
		const candidates = await store.listCandidates(scope);
		const state = await store.getState(scope);
		const usage = state.usage ?? {};
		const day = limits.activeDay || state.activeDayCount || 0;
		all.push(...active.map((e) => ({ ...e, scopeLabel: label })), ...candidates.map((e) => ({ ...e, scopeLabel: label })));
		if (active.length === 0 && candidates.length === 0) continue;

		out.push(`### ${label} — 正式条目（master 可见，已在清单里）`);
		if (active.length === 0) out.push('(无)');
		for (const e of active.slice(0, maxPerSection)) {
			out.push(e.pinned ? `${renderManifestLine(e)}  📌用户已钉住(不要淘汰它)` : renderManifestLine(e));
		}
		if (active.length > maxPerSection) out.push(`- …(${active.length - maxPerSection} more)`);

		out.push('');
		out.push(`### ${label} — 候选池（confidence 1，**master 看不到**，需要你维护：被再次印证就升级，确认无价值才淘汰）`);
		if (candidates.length === 0) out.push('(无)');
		for (const e of candidates.slice(0, maxPerSection)) {
			const u = usage[e.slug];
			const bits = [`共被使用 ${u?.uses ?? 0} 次`];
			if (e.pinned) bits.push('📌用户已钉住(别淘汰它)');
			if (u?.evictedAt !== undefined) {
				// 让代理看到"离销毁还有多久"：它才能决定 救（升到 2）/ 放手（什么都不做）/ 立即淘汰
				const start = Math.max(u.evictedDay ?? 0, u.lastSeenDay ?? 0);
				let elapsed: number;
				if (start > 0 && day > 0) {
					elapsed = Math.max(0, day - start);
				} else {
					// 老数据（无活动日记录）回退日历天
					const ts = [Date.parse(u.evictedAt), Date.parse(u.lastSeenAt ?? '')].filter((t) => !Number.isNaN(t));
					elapsed = ts.length > 0 ? Math.max(0, Math.floor((Date.now() - Math.max(...ts)) / 86_400_000)) : 0;
				}
				bits.push(`⏳待销毁(已 ${elapsed}/${u.evictReason === 'candidate' ? candidateTtl : destroyAfter} 活动日)`);
			}
			out.push(`${renderManifestLine(e).replace(/ \(confidence/, ` (${bits.join(', ')}, confidence`)}`);
		}
		if (candidates.length > maxPerSection) out.push(`- …(${candidates.length - maxPerSection} more)`);
		out.push('');
	}

	const related = pickRelated(all, taskText);
	if (related.length > 0) {
		out.push('### 可能与本轮相关（按关键词初筛，仅供定位；**判断语义是否接近要你自己读**）');
		for (const e of related) out.push(`${renderManifestLine(e)}  [${e.scopeLabel}${e.confidence < 2 ? ', 候选池' : ''}]`);
		out.push('');
	}
	return out.join('\n');
}

/** 说话文本的粗分词：拉丁词（≥3 字母）+ 中日韩二元组（确定性、零依赖） */
export function keywordsOf(text: string): Set<string> {
	const out = new Set<string>();
	const lower = text.toLowerCase();
	for (const m of lower.matchAll(/[a-z0-9_][a-z0-9_.-]{2,}/g)) out.add(m[0]);
	const cjk = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
	for (const chunk of cjk) {
		for (let i = 0; i < chunk.length - 1; i++) out.add(chunk.slice(i, i + 2));
		if (chunk.length === 1) out.add(chunk);
	}
	return out;
}

/** 从全部条目里挑出"与本轮对话关键词重叠最多"的若干条（确定性；不调模型） */
export function pickRelated<T extends MemoryEntry>(entries: T[], taskText: string, limit = 8): T[] {
	const task = keywordsOf(taskText);
	if (task.size === 0) return [];
	const scored: { entry: T; score: number }[] = [];
	for (const entry of entries) {
		const own = keywordsOf([entry.name, entry.description, entry.subject, entry.tags.join(' '), entry.body].join(' '));
		let score = 0;
		for (const k of own) if (task.has(k)) score++;
		// 标签/subject 命中加权（比正文泛词更能代表主题）
		if (task.has(entry.subject.toLowerCase())) score += 3;
		for (const tag of entry.tags) if (task.has(tag.toLowerCase())) score += 2;
		if (score > 0) scored.push({ entry, score });
	}
	return scored
		.sort((a, b) => (b.score - a.score) || (a.entry.updated < b.entry.updated ? 1 : -1) || a.entry.slug.localeCompare(b.entry.slug))
		.slice(0, limit)
		.map((s) => s.entry);
}

export class MemoryAgent {	private readonly opts: MemoryAgentOptions;
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
			// 索引前置：正式条目 + 候选池 + 「可能与本轮相关」（关键词初筛），并附本轮对话文本供初筛
			const taskText = [...turns.map((t) => `${t.user}\n${t.assistant}`), input.currentUser].join('\n');
			const index = await renderMemoryIndex(store, 30, taskText, {
				destroyAfterDays: this.opts.destroyAfterDays,
				candidateTtlDays: this.opts.candidateTtlDays,
			}).catch(() => '');
			const { messages } = await runSubagentLoop(
				[
					{ role: 'system', content: MEMORY_AGENT_PROMPT },
					{ role: 'user', content: renderInput(turns, input.currentUser, index) },
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
			// 代理的读是「看到」而非「使用」：只推迟销毁倒计时，不参与升级/复活判定
			execute: (params) => readMemoryEntry(store, String(params.path ?? ''), 'touch'),
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
export function renderInput(turns: MemoryAgentTurn[], currentUser: string, index = ''): string {
	const parts: string[] = [];
	// 记忆索引前置（对齐 Claude Code）：没有它，agent 无法判断"该更新哪条"，
	// 也看不到候选池（confidence 1）——那批条目 master 不可见，只能由 agent 维护
	if (index.trim()) {
		parts.push('## 现有记忆（先看这里判断：该更新哪条 / 哪条该升级）', '', index.trim(), '');
	}
	parts.push('## 需要归纳的对话片段（只含用户消息与助手最终回复）', '');
	for (const t of turns) {
		parts.push(`### 用户\n${t.user}`);
		if (t.assistant.trim()) parts.push(`### 助手\n${t.assistant}`);
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
