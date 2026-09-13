/**
 * memory-recall.ts — 记忆召回选择（设计稿 §13 R20）
 *
 * 只做一件事：**从候选条目里挑出该注入/该出示的条目**。
 *
 * - 清单在预算内（且数量未超上限）→ 直接全给，**不调用模型**（零额外成本）；
 * - 超出预算 → 用 `recall_model`（默认 deepseek-v4-flash）从清单里挑；
 * - 任何失败（超时 / API 错误 / 返回不可解析）→ 退化为「按 updated 倒序取预算内的条目」，
 *   并返回原因供审计 —— **绝不因为召回失败而少注入或不注入**。
 *
 * 另：`alreadySurfaced` 用于会话内去重（已出示过的条目不重复出示；compact 后集合自然重置）。
 */

import type { Message } from '../types/index.js';
import type { ModelProvider } from './model-provider.js';
import { renderManifestLine, estimateTokens, type MemoryEntry } from './memory-store.js';

/** 召回模式：all = 预算内直接全给；llm = 模型挑选；fallback = 退化（按更新时间倒序） */
export type RecallMode = 'all' | 'llm' | 'fallback';

export interface MemoryRecallOptions {
	provider: ModelProvider;
	/** 召回模型（默认由调用方传 memory.recall_model） */
	model: string;
	/** 自身超时（毫秒，默认 20000；超时后退化，不等底层请求） */
	timeoutMs?: number;
	/** 选择结果的最大输出 tokens（默认 256） */
	maxOutputTokens?: number;
}

export interface MemoryRecallRequest {
	/** 当前任务文本（用户消息 + 最近轮次，由调用方拼接并截断） */
	taskText: string;
	/** 候选条目（通常是 manifest 覆盖的正式条目） */
	candidates: MemoryEntry[];
	/** 最多选几条 */
	maxItems: number;
	/** 注入预算（tokens） */
	maxTokens: number;
	/** 会话内已出示过的 slug（去重） */
	alreadySurfaced?: ReadonlySet<string>;
}

export interface MemoryRecallResult {
	entries: MemoryEntry[];
	mode: RecallMode;
	/** 退化/未调用模型的原因（审计用） */
	reason?: 'no_candidates' | 'budget_fits' | 'timeout' | 'llm_error' | 'llm_invalid';
	tokens: number;
	elapsedMs: number;
}

const SELECT_SYSTEM_PROMPT = [
	'You select which long-term memories about the user should be injected into a coding assistant\'s context.',
	'You will get the user\'s current task and a numbered list of available memories.',
	'Pick ONLY the memories that are clearly useful for THIS task. If unsure, leave them out.',
	'Return JSON only: {"selected": [index, ...]} using the given indices. Prefer fewer, higher-signal memories.',
	'Never invent indices. An empty list is a valid answer.',
].join('\n');

export class MemoryRecall {
	private readonly provider: ModelProvider;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly maxOutputTokens: number;

	constructor(opts: MemoryRecallOptions) {
		this.provider = opts.provider;
		this.model = opts.model;
		this.timeoutMs = opts.timeoutMs ?? 20_000;
		this.maxOutputTokens = opts.maxOutputTokens ?? 256;
	}

	async select(req: MemoryRecallRequest): Promise<MemoryRecallResult> {
		const started = Date.now();
		const pool = req.candidates.filter((e) => !req.alreadySurfaced?.has(e.slug));

		if (pool.length === 0) {
			return { entries: [], mode: 'all', reason: 'no_candidates', tokens: 0, elapsedMs: Date.now() - started };
		}

		// 预算内直接全给（含数量上限）：不调用模型
		const fullText = pool.map((e) => renderManifestLine(e)).join('\n');
		if (estimateTokens(fullText) <= req.maxTokens && pool.length <= req.maxItems) {
			return {
				entries: pool,
				mode: 'all',
				reason: 'budget_fits',
				tokens: estimateTokens(fullText),
				elapsedMs: Date.now() - started,
			};
		}

		// 超预算 → 让模型挑
		try {
			const indices = await this.askModel(req.taskText, pool, req.maxItems);
			if (indices === null) return this.fallback(pool, req, started, 'llm_invalid');
			const picked: MemoryEntry[] = [];
			let used = 0;
			for (const idx of indices) {
				const entry = pool[idx];
				if (!entry) continue;
				const cost = estimateTokens(renderManifestLine(entry)) + 1;
				if (used + cost > req.maxTokens) break;
				if (picked.length >= req.maxItems) break;
				picked.push(entry);
				used += cost;
			}
			if (picked.length === 0 && indices.length === 0) {
				// 模型明确表示"都不相关"：尊重该判断（不是失败）
				return { entries: [], mode: 'llm', tokens: 0, elapsedMs: Date.now() - started };
			}
			if (picked.length === 0) {
				return this.fallback(pool, req, started, 'llm_invalid');
			}
			return { entries: picked, mode: 'llm', tokens: used, elapsedMs: Date.now() - started };
		} catch (err) {
			const reason = (err as Error).name === 'RecallTimeout' ? 'timeout' : 'llm_error';
			return this.fallback(pool, req, started, reason);
		}
	}

	/** 退化路径：按 updated 倒序（manifest 顺序）取预算内的条目 */
	private fallback(
		pool: MemoryEntry[],
		req: MemoryRecallRequest,
		started: number,
		reason: MemoryRecallResult['reason'],
	): MemoryRecallResult {
		const entries: MemoryEntry[] = [];
		let used = 0;
		for (const entry of pool) {
			if (entries.length >= req.maxItems) break;
			const cost = estimateTokens(renderManifestLine(entry)) + 1;
			if (used + cost > req.maxTokens) break;
			entries.push(entry);
			used += cost;
		}
		return { entries, mode: 'fallback', reason, tokens: used, elapsedMs: Date.now() - started };
	}

	/** 调用召回模型，返回被选中的下标（越界/非法值被过滤）；无法解析返回 null（走退化） */
	private async askModel(taskText: string, pool: MemoryEntry[], maxItems: number): Promise<number[] | null> {
		const list = pool
			.map((e, i) => `${i + 1}. [${e.type}] ${e.slug} (priority subject: ${e.subject}) — ${e.description}`)
			.join('\n');
		const messages: Message[] = [
			{ role: 'system', content: SELECT_SYSTEM_PROMPT },
			{
				role: 'user',
				content: `Current task:\n${taskText.slice(0, 2000)}\n\nAvailable memories (pick at most ${maxItems}):\n${list}`,
			},
		];

		const timeout = new Promise<never>((_, reject) => {
			const t = setTimeout(() => {
				const err = new Error('recall timeout');
				err.name = 'RecallTimeout';
				reject(err);
			}, this.timeoutMs);
			// 不阻塞进程退出
			if (typeof t.unref === 'function') t.unref();
		});

		const response = await Promise.race([
			this.provider.chat(messages, {
				model: this.model,
				temperature: 0.1,
				max_tokens: this.maxOutputTokens,
				thinking: { type: 'disabled' },
			}),
			timeout,
		]);

		const content = response?.choices?.[0]?.message?.content ?? '';
		const parsed = extractSelectedIndices(content);
		if (parsed === null) return null;
		// 1-based → 0-based，去重、滤波、保序
		const seen = new Set<number>();
		const out: number[] = [];
		for (const n of parsed) {
			const idx = n - 1;
			if (!Number.isInteger(idx) || idx < 0 || idx >= pool.length || seen.has(idx)) continue;
			seen.add(idx);
			out.push(idx);
		}
		return out;
	}
}

/**
 * 从模型输出里提取 selected 下标数组。
 * 宽容解析：优先 JSON；失败则退化为抓取所有整数（模型偶尔会写 `selected: 1, 3`）。
 * 完全解析不出返回 null（调用方走退化路径）。
 */
export function extractSelectedIndices(content: string): number[] | null {
	if (!content) return null;
	const jsonMatch = /\{[\s\S]*\}/.exec(content);
	if (jsonMatch) {
		try {
			const obj = JSON.parse(jsonMatch[0]) as { selected?: unknown };
			if (Array.isArray(obj.selected)) {
				return obj.selected.map((v) => Number(v)).filter((n) => Number.isFinite(n));
			}
			if (obj.selected === undefined) return [];
		} catch {
			/* 落到下方宽松解析 */
		}
	}
	const nums = content.match(/\d+/g);
	if (!nums) return null;
	return nums.map((n) => Number(n));
}
