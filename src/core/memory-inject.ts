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

import { renderManifestLine, type MemoryEntry, type MemoryStore } from './memory-store.js';
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
	/** 模型当前"看到"的清单：slug → updated（用于变化检测） */
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
	 */
	async buildListingBlock(taskText = ''): Promise<ListingResult> {
		if (!this.enabled) return { block: null, rev: '', mode: 'all' };

		const manifest = await this.store.manifestAll(this.maxInjectTokens);
		if (manifest.lines.length === 0) {
			this.seen = new Map();
			return { block: null, rev: manifest.rev, mode: 'all' };
		}

		// 预算内：直接全给（零额外调用）
		const entries = await this.allEntries();
		let selected = entries;
		let mode: RecallMode = 'all';
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
		}

		if (selected.length === 0) {
			this.seen = new Map();
			return { block: null, rev: manifest.rev, mode };
		}

		const lines = selected.map((e) => renderManifestLine(e));
		const block = [
			`<${MEMORY_LISTING_TAG}>`,
			'[Long-term memory index] Preferences and conventions remembered from earlier sessions.',
			'Entries marked with a file name can be read in full with the memory_read tool.',
			...lines,
			`</${MEMORY_LISTING_TAG}>`,
		].join('\n');

		this.seen = new Map(selected.map((e) => [e.slug, e.updated]));
		for (const e of selected) this.surfaced.add(e.slug);
		return { block, rev: manifest.rev, mode };
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
	 * 变化 = 新增 / updated 变化 / 移除（含置信度降到阈值以下、被取代、被遗忘）。
	 */
	async buildUpdateBlock(): Promise<string | null> {
		if (!this.enabled) return null;

		const entries = await this.allEntries();
		const diff = diffSeen(this.seen, entries);
		const hasChange = diff.added.length > 0 || diff.updated.length > 0 || diff.removed.length > 0;
		this.seen = new Map(entries.map((e) => [e.slug, e.updated]));
		if (!hasChange) return null;

		const maxEntries = 6;
		const lines: string[] = [];
		const push = (label: string, list: MemoryEntry[]) => {
			for (const e of list.slice(0, maxEntries)) lines.push(`- ${label}: ${renderManifestLine(e)}`);
		};
		push('added', diff.added);
		push('updated', diff.updated);
		if (diff.removed.length > 0) {
			lines.push(`- removed/retired: ${diff.removed.slice(0, maxEntries).join(', ')}`);
		}
		const omitted =
			Math.max(0, diff.added.length - maxEntries) +
			Math.max(0, diff.updated.length - maxEntries) +
			Math.max(0, diff.removed.length - maxEntries);
		if (omitted > 0) lines.push(`- …(${omitted} more)`);

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
				this.seen.set(entry.slug, entry.updated);
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
			if (this.seen.get(slug) === entry.updated) continue;
			lines.push(`- ${renderManifestLine(entry)}`);
			// 提醒一次即推进，避免每轮重复打扰（模型重新 memory_read 会再次刷新）
			this.seen.set(slug, entry.updated);
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

/** 对比「已见集合」与「当前条目」→ 新增/更新/移除 */
export function diffSeen(seen: Map<string, string>, entries: MemoryEntry[]): MemoryDiff {
	const added: MemoryEntry[] = [];
	const updated: MemoryEntry[] = [];
	const current = new Set<string>();
	for (const e of entries) {
		current.add(e.slug);
		const prev = seen.get(e.slug);
		if (prev === undefined) added.push(e);
		else if (prev !== '' && prev !== e.updated) updated.push(e);
	}
	const removed = [...seen.keys()].filter((slug) => !current.has(slug));
	return { added, updated, removed };
}

/** 按 token 预算截断文本（保留开头，尾部加省略标记） */
export function truncateToBudget(text: string, maxTokens: number): string {
	const maxBytes = maxTokens * 3;
	const buf = Buffer.from(text, 'utf-8');
	if (buf.length <= maxBytes) return text;
	return `${buf.subarray(0, maxBytes).toString('utf-8')}\n…(truncated)`;
}
