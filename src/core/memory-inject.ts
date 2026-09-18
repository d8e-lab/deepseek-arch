/**
 * memory-inject.ts — 记忆注入层（设计稿 §13 R11/R12/R21/R22）
 *
 * 两条通道，各司其职：
 *
 * ① **清单进 system prompt**（会话创建 / `resume` 复用的快照 / `/memory refresh` / compact 重建）：
 *    渲染 `<memory_listing>` 块。system prompt 在一个会话内冻结 → 零缓存代价，代价只是"可能过期"。
 *
 * ② **变化提醒落盘**（会话内清单发生变化 / 模型读过的条目被更新）：
 *    渲染 `<memory-update>` 块，交给会话层作为**一条独立 user 消息落盘**（历史字节稳定 → 前缀不断），
 *    UI 只渲染一行。不落盘会让下一轮前缀在该位置断开，把上一轮内容重算一次。
 *
 * 变化检测不依赖额外状态：把「清单里有哪些 slug、各自 updated」记在内存里；
 * `resume` 时从**磁盘上的 system prompt 快照**里解析出旧的清单（模型已经看过的那份）来播种。
 */

import { renderManifestLine, estimateTokens, type MemoryEntry, type MemoryStore } from './memory-store.js';
import type { MemoryRecall, RecallMode } from './memory-recall.js';

/** system prompt 里的清单块标签（渲染与解析共用） */
export const MEMORY_LISTING_TAG = 'memory_listing';
/** 会话内变化提醒块标签 */
export const MEMORY_UPDATE_TAG = 'memory-update';

export interface MemoryInjectorOptions {
	store: MemoryStore;
	recall: MemoryRecall;
	/** 清单注入预算（tokens） */
	maxInjectTokens: number;
	/** 变化提醒预算（tokens） */
	deltaInjectTokens: number;
	/** 总开关（false 时所有方法返回"无内容"） */
	enabled?: boolean;
}

export interface ListingResult {
	/** 要追加进 system prompt 的块（无记忆/关闭时 null） */
	block: string | null;
	rev: string;
	mode: RecallMode;
	/** 召回退化/未调用模型的原因（审计用；预算内直接全给时为 budget_fits） */
	recallReason?: string;
	/** 清单块自身的 token 估算（审计用） */
	tokens: number;
}

export interface MemoryDiff {
	added: MemoryEntry[];
	updated: MemoryEntry[];
	removed: string[];
}

export class MemoryInjector {
	private readonly store: MemoryStore;
	private readonly recall: MemoryRecall;
	private readonly maxInjectTokens: number;
	private readonly deltaInjectTokens: number;
	private readonly enabled: boolean;
	/** 模型当前"看到"的清单：slug → 版本键（updated|confidence，用于变化检测） */
	private seen = new Map<string, string>();
	/** 会话内已出示过的 slug（去重；compact 后由会话层重置） */
	private surfaced = new Set<string>();

	constructor(opts: MemoryInjectorOptions) {
		this.store = opts.store;
		this.recall = opts.recall;
		this.maxInjectTokens = opts.maxInjectTokens;
		this.deltaInjectTokens = opts.deltaInjectTokens;
		this.enabled = opts.enabled ?? true;
	}

	// ─── 通道 ①：清单 → system prompt ────────────────

	/**
	 * 构建清单块（会话创建 / refresh 时调用）。
	 * 预算内直接全给；超预算时用 recall 模型挑选；失败自动退化（见 memory-recall）。
	 * 返回 `mode`/`recallReason` 供调用方落审计（旧实现把它们丢掉，"为何退化"无从追查）。
	 */
	async buildListingBlock(taskText = ''): Promise<ListingResult> {
		if (!this.enabled) return { block: null, rev: '', mode: 'all', tokens: 0 };

		const manifest = await this.store.manifestAll(this.maxInjectTokens);
		if (manifest.lines.length === 0) {
			this.seen = new Map();
			return { block: null, rev: manifest.rev, mode: 'all', tokens: 0 };
		}

		// 预算内：直接全给（零额外调用）
		const entries = await this.allEntries();
		let selected = entries;
		let mode: RecallMode = 'all';
		let recallReason: string | undefined = 'budget_fits';
		if (entries.length > manifest.lines.length) {
			const result = await this.recall.select({
				taskText,
				candidates: entries,
				maxItems: Math.max(1, manifest.lines.length),
				maxTokens: this.maxInjectTokens,
				alreadySurfaced: this.surfaced,
			});
			selected = result.entries;
			mode = result.mode;
			recallReason = result.reason;
		}

		if (selected.length === 0) {
			this.seen = new Map();
			return { block: null, rev: manifest.rev, mode, recallReason, tokens: 0 };
		}

		const lines = selected.map((e) => renderManifestLine(e));
		const block = [
			`<${MEMORY_LISTING_TAG}>`,
			'[Long-term memory index] Preferences and conventions remembered from earlier sessions.',
			'Entries marked with a file name can be read in full with the memory_read tool.',
			...lines,
			`</${MEMORY_LISTING_TAG}>`,
		].join('\n');

		this.seen = new Map(selected.map((e) => [e.slug, visibilityKey(e)]));
		for (const e of selected) this.surfaced.add(e.slug);
		return { block, rev: manifest.rev, mode, recallReason, tokens: estimateTokens(block) };
	}

	/**
	 * 用「磁盘 system prompt 快照里已有的清单」播种已见集合（resume 场景）。
	 * 快照里那份清单就是模型当前看到的 → 之后只提醒差异。
	 */
	seedFromSystemPrompt(systemPromptContent: string | undefined): void {
		this.seen = new Map();
		if (!systemPromptContent) return;
		for (const slug of parseListingSlugs(systemPromptContent)) this.seen.set(slug, '');
	}

	// ─── 通道 ②：变化提醒（落盘） ─────────────────────

	/**
	 * 检查清单是否变化；有变化则返回要落盘的提醒块（无变化返回 null）。
	 * 变化 = 新增 / 版本变化（更新时间 **或置信度**）/ 移除（含置信度降到阈值以下、被取代、被遗忘）。
	 *
	 * 只有**真正展示给模型**的条目才推进 `seen`：被 maxEntries 截断的变更保持旧值，
	 * 下一轮继续上报（旧实现先把全部标为已见，导致未展示的变更永久静默）。
	 */
	async buildUpdateBlock(): Promise<string | null> {
		if (!this.enabled) return null;

		const entries = await this.allEntries();
		const diff = diffSeen(this.seen, entries);
		const hasChange = diff.added.length > 0 || diff.updated.length > 0 || diff.removed.length > 0;
		if (!hasChange) return null;

		const maxEntries = 6;
		const lines: string[] = [];
		/** 真正展示给模型的条目（只有这些推进 seen） */
		const shown: MemoryEntry[] = [];
		const push = (label: string, list: MemoryEntry[]) => {
			for (const e of list.slice(0, maxEntries)) {
				lines.push(`- ${label}: ${renderManifestLine(e)}`);
				shown.push(e);
			}
		};
		push('added', diff.added);
		push('updated', diff.updated);
		const removedShown = diff.removed.slice(0, maxEntries);
		if (removedShown.length > 0) {
			lines.push(`- removed/retired: ${removedShown.join(', ')}`);
		}
		const omitted =
			Math.max(0, diff.added.length - maxEntries) +
			Math.max(0, diff.updated.length - maxEntries) +
			Math.max(0, diff.removed.length - maxEntries);
		if (omitted > 0) lines.push(`- …(${omitted} more, will be reported on a later turn)`);

		// seen 只推进"已展示"的条目；removed 从 seen 删除。
		// 未展示的变更保持旧键 → 下一轮再次进入 diff，不再静默丢失。
		const nextSeen = new Map(this.seen);
		for (const e of shown) nextSeen.set(e.slug, visibilityKey(e));
		for (const slug of diff.removed) nextSeen.delete(slug);
		this.seen = nextSeen;

		const block = [
			`<${MEMORY_UPDATE_TAG}>`,
			'[Memory updated] Your long-term memory index changed after this conversation started:',
			...lines,
			'Use memory_read("<slug>.md") to read a changed entry in full before relying on it;',
			'memory that was retired must not be treated as a current preference.',
			`</${MEMORY_UPDATE_TAG}>`,
		].join('\n');

		return truncateToBudget(block, this.deltaInjectTokens);
	}

	/**
	 * 记录「模型读过某条目的当前版本」→ 之后该条目变化才会提醒（对齐 Claude Code 的已读追踪）。
	 * 由 memory_read 工具路径调用。
	 */
	async markRead(slug: string): Promise<void> {
		for (const scope of ['project', 'global'] as const) {
			const entries = await this.store.listEntries(scope);
			const entry = entries.find((e) => e.slug === slug);
			if (entry) {
				this.seen.set(entry.slug, visibilityKey(entry));
				this.surfaced.add(entry.slug);
				return;
			}
		}
	}

	/** 读过的条目被更新：会话层传入 slug → 返回提醒块（无变化返回 null，且提醒一次后不再重复） */
	async buildReadUpdateBlock(readSlugs: Iterable<string>): Promise<string | null> {
		if (!this.enabled) return null;
		const entries = await this.allEntries();
		const bySlug = new Map(entries.map((e) => [e.slug, e]));
		const lines: string[] = [];
		for (const slug of readSlugs) {
			const entry = bySlug.get(slug);
			if (!entry) continue;
			if (this.seen.get(slug) === visibilityKey(entry)) continue;
			lines.push(`- ${renderManifestLine(entry)}`);
			// 提醒一次即推进，避免每轮重复打扰（模型重新 memory_read 会再次刷新）
			this.seen.set(slug, visibilityKey(entry));
		}
		if (lines.length === 0) return null;
		const block = [
			`<${MEMORY_UPDATE_TAG}>`,
			'[Memory updated] Entries you read earlier have changed since you read them:',
			...lines,
			'Re-read them with memory_read before relying on the old content.',
			`</${MEMORY_UPDATE_TAG}>`,
		].join('\n');
		return truncateToBudget(block, this.deltaInjectTokens);
	}

	/** 标记"已出示"（会话内动态出示去重） */
	markSurfaced(slugs: Iterable<string>): void {
		for (const s of slugs) this.surfaced.add(s);
	}

	/** compact 之后：附件随被压缩的历史消失 → 去重集合自然重置（对齐 Claude Code） */
	resetSurfaced(): void {
		this.surfaced = new Set();
	}

	/** 当前已见清单（测试与审计用） */
	seenSnapshot(): Map<string, string> {
		return new Map(this.seen);
	}

	private async allEntries(): Promise<MemoryEntry[]> {
		const project = await this.store.listEntries('project');
		const global = await this.store.listEntries('global');
		const projectSlugs = new Set(project.map((e) => e.slug));
		// 项目层优先：同 slug（同主题）时屏蔽全局层
		return [...project, ...global.filter((e) => !projectSlugs.has(e.slug))];
	}
}

// ─── 纯函数（可独立测试） ──────────────────────────────

/** 从 system prompt 内容里解析出清单中的 slug 列表 */
export function parseListingSlugs(content: string): string[] {
	const m = new RegExp(`<${MEMORY_LISTING_TAG}>([\\s\\S]*?)</${MEMORY_LISTING_TAG}>`).exec(content);
	if (!m) return [];
	const slugs = new Set<string>();
	for (const line of m[1].split('\n')) {
		const link = /\(([^()]+)\.md\)/.exec(line);
		if (link) slugs.add(link[1]);
	}
	return [...slugs];
}

/**
 * 「模型看到的那一版」的版本键。
 *
 * 含置信度：升/降档（3↔2↔1）也要被变化检测看见 —— 旧实现只比 `updated`，
 * 而 LRU 升降级**不改**更新时间，于是"这条已经退出可见清单"永远不会通知模型。
 */
export function visibilityKey(entry: MemoryEntry): string {
	return `${entry.updated}|${entry.confidence}`;
}

/** 对比「已见集合」与「当前条目」→ 新增/更新/移除 */
export function diffSeen(seen: Map<string, string>, entries: MemoryEntry[]): MemoryDiff {
	const added: MemoryEntry[] = [];
	const updated: MemoryEntry[] = [];
	const current = new Set<string>();
	for (const e of entries) {
		current.add(e.slug);
		const prev = seen.get(e.slug);
		if (prev === undefined) added.push(e);
		else if (prev !== '' && prev !== visibilityKey(e)) updated.push(e);
	}
	const removed = [...seen.keys()].filter((slug) => !current.has(slug));
	return { added, updated, removed };
}

/** 按 token 预算截断文本（保留开头，尾部加省略标记）；按字符截断避免切断多字节字符 */
export function truncateToBudget(text: string, maxTokens: number): string {
	const maxBytes = maxTokens * 3;
	if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
	// 逐字符累加，保证不在 UTF-8 码点中间切断（旧实现按字节 subarray，可能产出 U+FFFD）
	let used = 0;
	let out = '';
	for (const ch of text) {
		const b = Buffer.byteLength(ch, 'utf-8');
		if (used + b > maxBytes) break;
		out += ch;
		used += b;
	}
	return `${out}\n…(truncated)`;
}
