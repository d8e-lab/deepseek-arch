/**
 * memory-store.ts — 记忆存储（两层：项目 / 全局）
 *
 * 目录布局（每层同构；不入版本控制）：
 *   <dir>/
 *   ├── MEMORY.md                索引：正式条目（confidence ≥ masterMinConfidence）；注入用
 *   ├── <slug>.md                主题文件：frontmatter + 正文（一条一个文件）
 *   ├── candidates.md            模糊条目（confidence < 阈值）：不注入、master 不可见
 *   ├── logs/yyyy/mm/dd.md       追加式日志（原始观察，不注入）
 *   ├── state.json               游标等状态（增量判断用）
 *   ├── audit.jsonl              机器可读审计（追加式）
 *   └── legacy/                  用户手写旧笔记（原样保留）
 *
 * 设计约束（见 plan/memory-heartbeat-design.md §13）：
 *   - 去重不靠相似度算法：代码只做三条确定性规则 —— ① 指定 slug → 改写该文件
 *     ② 同 subject 冲突 → supersede（旧条目留演化记录并退出索引）
 *     ③ 归一化正文完全相等 → 合并（提升置信度/刷新时间，不新建）
 *     ④ 其余情况新增（slug 冲突自动加后缀）
 *   - 模糊条目（confidence=1）由 memory agent 独占管理：写 candidates.md，不进 MEMORY.md
 *   - 写盘用「临时文件 + rename」保证原子性；索引可随时从磁盘重建（rebuildIndex）
 *
 * 本模块不依赖 core 其他模块（只依赖 node:fs / node:crypto），便于被 tools / agent 复用。
 */

import { readFile, writeFile, mkdir, readdir, rename, stat, appendFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** 记忆类型（受控词表，对齐 Claude Code） */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

/**
 * 单条记忆的大小上限（字节，含 frontmatter）。
 * 超过后读取会被截断（并在 TUI 给出提示），写入侧也会告警 —— 记忆应当是"一行偏好 + 简短说明"，
 * 超限通常意味着把正文/资料写进了记忆，应该改放普通文件。
 */
export const MAX_MEMORY_ENTRY_BYTES = 64 * 1024;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 记忆层级：项目层 / 全局层 */
export type MemoryScope = 'project' | 'global';

/** 条目状态：active（正式）/ candidate（模糊，待升级）/ superseded（被取代，留档） */
export type MemoryStatus = 'active' | 'candidate' | 'superseded';

/** 一条记忆 */
export interface MemoryEntry {
	/** 条目 id = 文件名（不含 .md） */
	slug: string;
	/** 人类可读标题（索引行显示） */
	name: string;
	/** 一句话描述（召回判断用，必须具体） */
	description: string;
	/** 类型（受控词表） */
	type: MemoryType;
	/** 合并键（同 subject 视为同一主题） */
	subject: string;
	/** 标签（1–6 个小写词） */
	tags: string[];
	/** 层级 */
	scope: MemoryScope;
	/** 置信度 1–3（1 = 模糊，仅 memory agent 可见） */
	confidence: number;
	/** 触发信号 A–F（审计用） */
	signal?: string;
	/** 适用路径 glob（可选） */
	paths?: string[];
	/** 用户钉住：免疫 LRU 升降级与归档（`/memory pin`） */
	pinned?: boolean;
	/** 创建/更新时间（ISO 8601） */
	created: string;
	updated: string;
	/** 状态 */
	status: MemoryStatus;
	/** 被取代时指向新条目 slug（status=superseded 时有值） */
	supersededBy?: string;
	/** 正文（含 Why / How to apply） */
	body: string;
	/** 来源文件绝对路径 */
	filePath: string;
}

/** 写入输入（memory_write 工具 / memory agent 产出） */
export interface MemoryWriteInput {
	/** 指定要更新的条目 slug（可选；给了就改这一条） */
	slug?: string;
	name?: string;
	description?: string;
	type?: MemoryType;
	subject: string;
	tags?: string[];
	confidence?: number;
	signal?: string;
	paths?: string[];
	/** 正文（必填） */
	body: string;
	/** 被取代的条目 slug（supersede 语义；省略时按 subject 自动判断） */
	supersedes?: string[];
	/** 审计用：谁写的（master / memory_agent） */
	by?: string;
	/** 审计用：为什么这样判定 */
	reason?: string;
}

export type MemoryWriteAction = 'add' | 'update' | 'merge' | 'supersede';

export interface MemoryWriteResult {
	action: MemoryWriteAction;
	slug: string;
	/** supersede 时被取代的 slug 列表 */
	superseded?: string[];
}

/** 清单（MEMORY.md 的模型可见投影） */
export interface MemoryManifest {
	scope: MemoryScope;
	/** 清单行（`- [名称](slug.md) — 描述 (confidence N, updated X)`） */
	lines: string[];
	/** 拼接后的文本（空集合为 ''） */
	text: string;
	/** 估算 tokens（UTF-8 字节 / 3，与 compact 的估算器一致） */
	tokens: number;
	/** 内容版本（集合真变化才变；用于变化检测） */
	rev: string;
}

/**
 * 单条记忆的使用统计（LRU 的输入信号）。
 *
 * 什么算"使用"（**只有这两种**，注入/出现在清单里不算 —— 否则"越注入越升级"会变成正反馈）：
 *   1. master 真的读了全文（`memory_read` 工具命中）；
 *   2. 被写入/合并重申（`write` / `merge`，写入即一次使用）。
 */
export interface MemoryUsage {
	/** 累计使用次数（升级判定用；升级/降级后清零，要求"重新积累证据"） */
	uses: number;
	/** 最近一次**使用**的时间（ISO）——LRU 排序键（窗口换出用；代理的"看到"不刷新它） */
	lastUsedAt: string;
	/**
	 * 最近一次**触达**（使用或代理"看到"）时的**活动日序号**（见 MemoryState.activeDayCount）。
	 * 老化按活动日计：程序没启动的日子不算 —— 用户长期不启动程序回来时不会被一次性清空。
	 * 缺失时（本机制上线前的条目）回退为按日历天估算。
	 */
	lastUsedDay?: number;
	/** 最近一次**结算**（升降级）的活动日：防止同一活动日内连跑两次结算连降两级 */
	lastStepDay?: number;
}

/** 持久化状态（state.json） */
export interface MemoryState {
	/** 归纳游标：已归纳到哪一轮（turn id） */
	lastExtractedTurnId?: string;
	/** 上次归一化的时间（ISO） */
	updatedAt?: string;
	/** LRU 使用统计：slug → usage */
	usage?: Record<string, MemoryUsage>;
	/**
	 * **活动日计数**：只在"出现新的一天且程序确实被使用"时 +1（每次 `reconcile` 至多 +1）。
	 * 这是老化的时间单位 —— 缺席（不开程序）不推进它，因此不会造成"回来一次全清"。
	 */
	activeDayCount?: number;
	/** 最近一次推进 activeDayCount 的日期（YYYY-MM-DD，UTC） */
	lastActiveDate?: string;
}

/**
 * LRU 维护参数（来自 `[memory]` 配置段）。
 *
 * **统一模型（R30/R31）：只靠 confidence 档位表达生命周期，不再有独立的"换出队列"。**
 *
 * ```
 *   conf 3 ──闲置超期──▶ 2 ──闲置超期──▶ 1 ──容量超限──▶ 0 ──闲置超期──▶ 销毁
 *          ◀──升级(uses≥N)──        ◀──升级──        ◀──触达(=回到 1 重新观察)
 * ```
 * | conf | 含义 | master 可见 |
 * |:--|:--|:--|
 * | 3 / 2 | 正式记忆（明确陈述 / 确认） | ✅ |
 * | 1 | **待观察**（模糊 / 曾可见但久未用；等待被印证） | ❌ |
 * | 0 | **待销毁**（只在**容量装不下**时产生；销毁期限一到即归档/删除） | ❌ |
 *
 * 两条关键边界（R31）：
 *   - **闲置的最低档位是 1**：只是没人用（没有容量压力）不会把记忆推向销毁；
 *   - **0 只由容量压力产生**（`totalLimit` 超限时把最久未用的**候选**降到 0）——
 *     这样"一年才提一次"的稀疏偏好永远不会被闲置清掉。
 *
 * 时间为**活动日**（程序实际被使用的天数），不是日历天。
 */
export interface MemoryLruOptions {
	/** 总开关（默认 true） */
	enabled?: boolean;
	/** 闲置超过该**活动日**数 → 降一级（默认 90；**下限是 1**，不会因闲置变成 0） */
	decayActiveDays?: number;
	/** 累计使用达到该次数且最近有使用 → 升一级（默认 2） */
	promoteUses?: number;
	/** memory window：master 可见条目上限（默认 200）；超出时按 LRU 把最久未用者降到 conf 1 */
	windowSize?: number;
	/**
	 * **记忆总量上限**（默认 400；可见 + 候选，不含 superseded）。
	 * 超出部分把**最久未用的候选条目**降到 **conf 0（待销毁）**。
	 *
	 * 为什么要它：**"只是闲置"不该致死** —— 没有容量压力时条目最多降到 conf 1（待观察，成本≈0）；
	 * 只有真的"装不下了"才动用销毁，于是稀疏偏好不会被闲置清掉。
	 */
	totalLimit?: number;
	/** **conf 0 的销毁期限**（活动日，默认 180）：期间被触达 → 回到 conf 1 重新观察 */
	destroyAfterDays?: number;
	/** 销毁方式：archive = 移到 legacy/archive/（默认）；delete = 物理删除 */
	destroyMode?: 'archive' | 'delete';
}

/** 一次 LRU 维护的结算结果（供 UI 打印与审计） */
export interface MemoryMaintenanceResult {
	scope: MemoryScope;
	/** 升级的条目（含前后 confidence） */
	promoted: { slug: string; from: number; to: number }[];
	/** 降级的条目（含 1 → 0） */
	demoted: { slug: string; from: number; to: number }[];
	/** 因超出 memory window 被降到 conf 1 的条目（观察区） */
	windowEvicted: string[];
	/** 因超出 totalLimit 被降到 conf 0 的候选条目（待销毁）—— 容量压力才会产生 0 */
	doomed: { slug: string; from: number; to: number }[];
	/** conf 0 → 1：被再次触达，回到观察区重新开始 */
	revived: string[];
	/** conf 0 且超过销毁期限 → 销毁（归档/删除） */
	destroyed: string[];
	/** 跳过的（pinned 免疫） */
	pinned: string[];
	/** 当前活动日序号（诊断用） */
	activeDay?: number;
	/** 仅预览、未落盘 */
	dryRun?: boolean;
}

/** 审计记录（audit.jsonl，追加式；kind 区分类型） */
export interface MemoryAuditRecord {
	kind:
		| 'write' | 'merge' | 'supersede' | 'forget' | 'inject'
		| 'error' | 'agent_run' | 'lru' | 'pin' | 'use';
	at: string;
	[extra: string]: unknown;
}

export interface MemoryStoreOptions {
	/** 项目层目录（{workspace}/.deepseek-arch/memory） */
	projectDir: string;
	/** 全局层目录（~/.deepseek-arch/memory） */
	globalDir: string;
	/** master 可见的最低置信度（默认 2） */
	masterMinConfidence?: number;
	/** LRU 局部判定总开关（默认 true）——关闭后只有检查点结算会升降级 */
	lruEnabled?: boolean;
	/** 会话内即时升级阈值：累计使用达到该次数就升一级（默认 2，与 [memory] 配置一致） */
	promoteUses?: number;
}

/** 索引/候选文件名（不参与条目扫描） */
const INDEX_FILE = 'MEMORY.md';
const CANDIDATES_FILE = 'candidates.md';
const STATE_FILE = 'state.json';
const AUDIT_FILE = 'audit.jsonl';

/** 机器可读总表（harness 工作集；由 store 自维护，不参与条目扫描） */
const MANIFEST_FILE = 'manifest.json';

/** 总表里单条记忆的元数据（**不含正文** —— 正文留在 `<slug>.md`） */
export type MemoryEntryMeta = Omit<MemoryEntry, 'body' | 'filePath'>;

/** 总表文件结构（每层一份） */
export interface LayerManifestFile {
	version: 1;
	updatedAt: string;
	activeDayCount?: number;
	lastActiveDate?: string;
	entries: MemoryEntryMeta[];
	usage: Record<string, MemoryUsage>;
}

/** 进程内工作集：由 manifest.json 载入，写入时就地更新 */
interface LayerCache {
	entries: Map<string, MemoryEntry>;
	usage: Record<string, MemoryUsage>;
	activeDayCount: number;
	lastActiveDate?: string;
	/** 载入时 manifest.json 的 mtime（用于检测其它进程的写入） */
	loadedAtMs: number;
	/** 有未落盘的本地变更：此时禁止从磁盘重载（否则会丢掉本进程刚写的条目） */
	dirty?: boolean;
}

/** 条目排序：updated 倒序，同时间按 slug（确定性） */
function byUpdatedDesc(a: MemoryEntry, b: MemoryEntry): number {
	return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.slug.localeCompare(b.slug);
}

/** 条目 → 总表元数据（去掉正文与派生路径） */
function toMeta(entry: MemoryEntry): MemoryEntryMeta {
	const { body: _body, filePath: _filePath, ...meta } = entry;
	return meta;
}

/** 总表元数据 → 条目（正文留空，按需从主题文件读） */
function fromMeta(meta: MemoryEntryMeta, dir: string, scope: MemoryScope): MemoryEntry {
	return { ...meta, scope: meta.scope ?? scope, body: '', filePath: join(dir, `${meta.slug}.md`) };
}

export class MemoryStore {
	private readonly dirs: Record<MemoryScope, string>;
	private readonly masterMinConfidence: number;
	private readonly lruEnabled: boolean;
	private readonly promoteUses: number;
	/** 每层的 harness 工作集（元数据 + 使用统计 + 活动日）；见 layer() */
	private readonly layers = new Map<MemoryScope, LayerCache>();

	constructor(opts: MemoryStoreOptions) {
		this.dirs = { project: opts.projectDir, global: opts.globalDir };
		this.masterMinConfidence = opts.masterMinConfidence ?? 2;
		this.lruEnabled = opts.lruEnabled ?? true;
		this.promoteUses = opts.promoteUses ?? 2;
	}

	/** 某层目录（不存在时按需创建） */
	async ensureDir(scope: MemoryScope): Promise<string> {
		const dir = this.dirs[scope];
		await mkdir(join(dir, 'legacy'), { recursive: true, mode: 0o700 });
		await mkdir(join(dir, 'logs'), { recursive: true, mode: 0o700 });
		return dir;
	}

	dirOf(scope: MemoryScope): string {
		return this.dirs[scope];
	}

	// ─── 读取 ──────────────────────────────────────────

	/**
	 * 正式条目（active 且 confidence ≥ 阈值）。
	 * 默认只返回元数据（工作集里没有正文）；`withBody` 时逐条读取主题文件 ——
	 * 只有"要按正文做关键词过滤/展示"的调用方（如 `/memory show <kw>`）才该用它。
	 */
	async listEntries(scope: MemoryScope, opts: { withBody?: boolean } = {}): Promise<MemoryEntry[]> {
		const layer = await this.layer(scope);
		const entries = [...layer.entries.values()]
			.filter((e) => e.status === 'active' && e.confidence >= this.masterMinConfidence)
			.sort(byUpdatedDesc);
		if (!opts.withBody) return entries;
		return Promise.all(entries.map(async (e) => ({
			...e,
			body: await this.entryBody(scope, e),
		})));
	}

	/** 模糊条目（candidate 或 confidence < 阈值）——master 不可见，仅 memory agent 管理 */
	async listCandidates(scope: MemoryScope): Promise<MemoryEntry[]> {
		const layer = await this.layer(scope);
		// superseded 是墓碑（被取代/被遗忘）：不参与候选池，否则归纳代理会去"提升"一条
		// 永远无法复活的条目，而 deriveStatus 会静默保持 superseded —— 工具报成功、实际无效。
		return [...layer.entries.values()]
			.filter(
				(e) => e.status !== 'superseded'
					&& (e.status === 'candidate' || e.confidence < this.masterMinConfidence),
			)
			.sort(byUpdatedDesc);
	}

	/**
	 * 按 slug 读取单条（不存在返回 null）。
	 * 总表只有元数据，**正文按需从主题文件读**（读全文才付出一次文件读）。
	 */
	async readEntry(scope: MemoryScope, slug: string): Promise<MemoryEntry | null> {
		const layer = await this.layer(scope);
		const entry = layer.entries.get(slug);
		if (!entry) return null;
		const raw = await this.readText(entry.filePath);
		return { ...entry, body: raw === null ? '' : (parseEntry(raw, entry.filePath, scope)?.body ?? '') };
	}

	/** 按 subject 精确匹配（合并/supersede 判定用；正文按需另读） */
	async findBySubject(scope: MemoryScope, subject: string): Promise<MemoryEntry[]> {
		const layer = await this.layer(scope);
		return [...layer.entries.values()].filter((e) => e.subject === subject && e.status !== 'superseded');
	}

	// ─── 工作集（manifest.json）──────────────────────────
	//
	// 背景（v3 D3）：条目元数据 + 使用统计 + 活动日统一放在每层的 manifest.json，
	// 进程内作为工作集；读操作不再逐个文件扫描，写操作就地更新并原子落盘。
	// 正文仍留在 <slug>.md（人可读、可 diff），MEMORY.md / candidates.md 仍是渲染视图。
	//
	// 跨进程：manifest.json 的 mtime 比我们载入时新 → 重新载入（TUI + cron 并发时保证看到对方写入）。

	/**
	 * 取得某层的工作集（必要时载入 / 重建）。
	 * 缺失或损坏时回退为全量扫描并**自愈**写回 manifest.json。
	 */
	private async layer(scope: MemoryScope): Promise<LayerCache> {
		const dir = this.dirs[scope];
		const manifestPath = join(dir, MANIFEST_FILE);
		let mtimeMs = 0;
		try {
			mtimeMs = (await stat(manifestPath)).mtimeMs;
		} catch { /* 无 manifest：需要重建 */ }

		const cached = this.layers.get(scope);
		if (cached && (cached.dirty || mtimeMs === 0 || mtimeMs <= cached.loadedAtMs)) return cached;

		if (mtimeMs > 0) {
			try {
				const raw = JSON.parse(await readFile(manifestPath, 'utf-8')) as LayerManifestFile;
				if (raw?.version === 1 && Array.isArray(raw.entries)) {
					const layer: LayerCache = {
						entries: new Map(raw.entries.map((m) => [m.slug, fromMeta(m, dir, scope)])),
						usage: raw.usage ?? {},
						activeDayCount: raw.activeDayCount ?? 0,
						lastActiveDate: raw.lastActiveDate,
						loadedAtMs: mtimeMs,
					};
					this.layers.set(scope, layer);
					return layer;
				}
			} catch { /* 损坏 → 走重建 */ }
		}

		// 重建：扫描主题文件（首次运行 / manifest 丢失 / 损坏），并导入旧的 state.json（游标时代遗留）
		const { entries } = await this.scanRaw(scope);
		let usage: Record<string, MemoryUsage> = {};
		let activeDayCount = 0;
		let lastActiveDate: string | undefined;
		try {
			const old = JSON.parse((await this.readText(join(dir, STATE_FILE))) ?? 'null') as MemoryState | null;
			if (old && typeof old === 'object') {
				usage = old.usage ?? {};
				activeDayCount = old.activeDayCount ?? 0;
				lastActiveDate = old.lastActiveDate;
			}
		} catch { /* 旧状态损坏 → 从零开始 */ }

		const layer: LayerCache = {
			entries: new Map(entries.map((e) => [e.slug, e])),
			usage,
			activeDayCount,
			lastActiveDate,
			loadedAtMs: 0,
		};
		this.layers.set(scope, layer);
		await this.persistManifest(scope, layer);
		return layer;
	}

	/** 把工作集原子写回 manifest.json，并记录新的 mtime（避免自我失效） */
	private async persistManifest(scope: MemoryScope, layer: LayerCache): Promise<void> {
		const dir = await this.ensureDir(scope);
		const path = join(dir, MANIFEST_FILE);
		const payload: LayerManifestFile = {
			version: 1,
			updatedAt: new Date().toISOString(),
			activeDayCount: layer.activeDayCount,
			lastActiveDate: layer.lastActiveDate,
			entries: [...layer.entries.values()].map(toMeta),
			usage: layer.usage,
		};
		await atomicWrite(path, JSON.stringify(payload, null, 2) + '\n');
		layer.dirty = false;
		try {
			layer.loadedAtMs = (await stat(path)).mtimeMs;
		} catch {
			layer.loadedAtMs = Date.now();
		}
	}

	/** 把工作集落盘（putEntry 之后由公开变更方法调用一次） */
	private async flush(scope: MemoryScope): Promise<void> {
		await this.persistManifest(scope, await this.layer(scope));
	}

	/** 丢弃某层的工作集（测试 / 强制重载用） */
	dropCache(scope?: MemoryScope): void {
		if (scope) this.layers.delete(scope);
		else this.layers.clear();
	}

	// ─── 读取（原始扫描，仅供重建 / legacy 检测）──────────

	/** 扫描某层全部条目（含 candidate / superseded；解析失败的返回 null 并计入 legacy） */
	async scan(scope: MemoryScope): Promise<{ entries: MemoryEntry[]; legacy: string[] }> {
		const { entries, legacy } = await this.scanRaw(scope);
		// 扫描是"从磁盘重建"，同步刷新工作集，避免调用方拿到与后续读不一致的快照
		const layer = await this.layer(scope);
		layer.entries = new Map(entries.map((e) => [e.slug, e]));
		return { entries, legacy };
	}

	/** 纯文件扫描（不触碰工作集） */
	private async scanRaw(scope: MemoryScope): Promise<{ entries: MemoryEntry[]; legacy: string[] }> {
		const dir = this.dirs[scope];
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return { entries: [], legacy: [] };
		}

		const entries: MemoryEntry[] = [];
		const legacy: string[] = [];
		for (const name of names) {
			if (!name.endsWith('.md')) continue;
			if (name === INDEX_FILE || name === CANDIDATES_FILE) continue;
			const filePath = join(dir, name);
			const raw = await this.readText(filePath);
			if (raw === null) continue;
			const entry = parseEntry(raw, filePath, scope);
			// 无 frontmatter / 缺 subject → 视为用户手写笔记：保留但不进索引
			if (!entry) {
				legacy.push(name);
				continue;
			}
			entries.push(entry);
		}
		entries.sort(byUpdatedDesc);
		legacy.sort();
		return { entries, legacy };
	}

	/**
	 * 清单（注入用）：只含正式条目，按 updated 倒序，超预算按行截断。
	 * 同集合字节稳定：行内不含「当前时间」，age 文字只在跨天时变化。
	 */
	async manifest(scope: MemoryScope, maxTokens = 800): Promise<MemoryManifest> {
		const entries = await this.listEntries(scope);
		const allLines = entries.map((e) => renderManifestLine(e));

		const lines: string[] = [];
		let used = 0;
		for (const line of allLines) {
			const t = estimateTokens(line) + 1;
			if (used + t > maxTokens) break;
			lines.push(line);
			used += t;
		}
		const omitted = allLines.length - lines.length;
		const text = lines.length === 0 ? '' : lines.join('\n') + (omitted > 0 ? `\n- …(${omitted} more)` : '');
		return {
			scope,
			lines,
			text,
			tokens: estimateTokens(text),
			rev: hashRev(entries.map((e) => `${e.slug}|${e.updated}|${e.confidence}`)),
		};
	}

	/** 两层合并清单（项目层优先；同主题时项目层覆盖全局层） */
	async manifestAll(maxTokens = 800): Promise<MemoryManifest> {
		const project = await this.manifest('project', maxTokens);
		const global = await this.manifest('global', maxTokens);
		// 清单行里带的是 slug（由 subject 派生，一一对应）→ 用 slug 判定"同主题"
		const projectSlugs = new Set((await this.listEntries('project')).map((e) => e.slug));
		const globalLines = global.lines.filter((line) => {
			const m = /\(([^()]+)\.md\)/.exec(line);
			return !m || !projectSlugs.has(m[1]);
		});

		const lines: string[] = [];
		let used = 0;
		for (const line of [...project.lines, ...globalLines]) {
			const t = estimateTokens(line) + 1;
			if (used + t > maxTokens) break;
			lines.push(line);
			used += t;
		}
		const text = lines.join('\n');
		return {
			scope: 'project',
			lines,
			text,
			tokens: estimateTokens(text),
			rev: hashRev([project.rev, global.rev]),
		};
	}

	// ─── 写入（三条确定性规则） ────────────────────────

	/**
	 * 写入一条记忆。
	 *
	 * 判定顺序（确定性，可审计）：
	 *   1. 给了 `slug` 且文件存在 → **update**（改写该文件，保留 created）
	 *   2. 同 `subject` 已有条目：
	 *      a. 归一化正文完全相等 → **merge**（提升置信度、刷新 updated、不新建）
	 *      b. 否则 → **supersede**（旧条目标记 superseded + supersededBy，退出索引，留演化记录）
	 *   3. 其余 → **add**（slug 由 subject 派生，冲突自动加后缀）
	 */
	/**
	 * 写入（唯一的公开写入口）：在 `applyWrite` 之上补两件"调用方不该再操心"的事 ——
	 *   ① 记一次使用（写入即重申，累计 use 可让条目回升）；
	 *   ② 索引自维护（`MEMORY.md` / `candidates.md` 随写随新）。
	 */
	async write(scope: MemoryScope, input: MemoryWriteInput): Promise<MemoryWriteResult> {
		const result = await this.applyWrite(scope, input);
		// 条目变更先落盘：之后的 recordUse/layer() 即使因其它进程写入而重载，也不会丢掉刚写的条目
		await this.flush(scope);
		let inherited = 0;
		if (result.superseded?.length) {
			// 同主题的「复现计数」跨取代延续：同 subject 的改写说明这个话题又出现了，
			// 计数清零会让"反复被提到但始终模糊"的候选条目永远升不上来（master 看不到它，
			// 唯一可能的使用信号就是"再次被提到/重申"）。
			inherited = await this.inheritUsage(scope, result.superseded, result.slug).catch(() => 0);
		}
		// 显式写入不做即时升级（否则"显式降到 1"会被同一次写入的 use 立刻抬回 2）；
		// 复活（conf 0 → 1）仍允许：再次写到它说明这个话题又出现了。
		await this.recordUse(scope, result.slug, undefined, inherited, { allowPromote: false }).catch(() => { /* 使用统计失败不影响写入 */ });
		await this.syncIndex(scope);
		return result;
	}

	private async applyWrite(scope: MemoryScope, input: MemoryWriteInput): Promise<MemoryWriteResult> {
		const dir = await this.ensureDir(scope);
		const now = new Date().toISOString();
		const target = input.slug ? await this.readEntry(scope, input.slug) : null;
		const sameSubject = await this.findBySubject(scope, input.subject);
		const auditBase = { scope, subject: input.subject, by: input.by ?? 'unknown', reason: input.reason };

		// 1. 指定 slug → 更新
		if (target) {
			const updated = mergeEntryFields(target, input, now);
			// 显式传低置信 → 真正降级（软淘汰）；未传则 confidence 原样保留（状态因此不变）
			updated.status = deriveStatus(target.status, updated.confidence, this.masterMinConfidence);
			await this.putEntry(scope, updated);
			await this.audit({ kind: 'write', at: now, action: 'update', slug: updated.slug, ...auditBase });
			return { action: 'update', slug: updated.slug };
		}

		// 2. 同 subject
		for (const existing of sameSubject) {
			const existingBody = await this.entryBody(scope, existing);
			if (normalizeText(existingBody) === normalizeText(input.body)) {
				const merged = mergeEntryFields(existing, input, now);
				// merge **不降级**：同义重复（哪怕是低置信推断）不得把正式条目踢出清单 → 取 max
				merged.confidence = Math.max(existing.confidence, input.confidence ?? existing.confidence);
				merged.status = deriveStatus(existing.status, merged.confidence, this.masterMinConfidence);
				await this.putEntry(scope, merged);
				await this.audit({ kind: 'merge', at: now, slug: merged.slug, ...auditBase });
				return { action: 'merge', slug: merged.slug };
			}
		}

		// 2b. supercede（显式指定优先 —— 可跨 subject 指名取代；否则用同 subject 的条目）
		let supersedeTargets: MemoryEntry[] = [];
		if (input.supersedes && input.supersedes.length > 0) {
			const layer = await this.layer(scope);
			supersedeTargets = [...layer.entries.values()].filter(
				(e) => input.supersedes!.includes(e.slug) && e.status !== 'superseded',
			);
		} else {
			supersedeTargets = sameSubject;
		}
		if (supersedeTargets.length > 0) {
			const slug = await this.uniqueSlug(scope, slugify(input.subject || input.name || 'memory'));
			const created: MemoryEntry = {
				...blankEntry(scope, slug, now, dir),
				...pickFields(input, now),
			};
			created.status = deriveStatus('active', created.confidence, this.masterMinConfidence);
			await this.putEntry(scope, created);
			for (const old of supersedeTargets) {
				const tomb = { ...old, status: 'superseded' as MemoryStatus, supersededBy: slug, updated: now };
				await this.putEntry(scope, tomb);
			}
			await this.audit({
				kind: 'supersede', at: now, slug, superseded: supersedeTargets.map((e) => e.slug), ...auditBase,
			});
			return { action: 'supersede', slug, superseded: supersedeTargets.map((e) => e.slug) };
		}

		// 3. 新增
		const slug = await this.uniqueSlug(scope, slugify(input.subject || input.name || 'memory'));
		const entry: MemoryEntry = { ...blankEntry(scope, slug, now, dir), ...pickFields(input, now) };
		entry.status = deriveStatus('active', entry.confidence, this.masterMinConfidence);
		await this.putEntry(scope, entry);
		await this.audit({ kind: 'write', at: now, action: 'add', slug, ...auditBase });
		return { action: 'add', slug };
	}

	/** 遗忘（写墓碑 + 退出索引；文件保留以留演化记录） */
	async forget(scope: MemoryScope, slug: string, reason?: string): Promise<boolean> {
		const dir = await this.ensureDir(scope);
		const entry = await this.readEntry(scope, slug);
		if (!entry) return false;
		const now = new Date().toISOString();
		await this.putEntry(scope, { ...entry, status: 'superseded', updated: now });
		await this.audit({ kind: 'forget', at: now, scope, slug, reason });
		await this.flush(scope); // 墓碑先落盘，再动使用统计
		await this.dropUsage(scope, [slug]).catch(() => { /* 清理失败不影响遗忘 */ });
		await this.syncIndex(scope);
		return true;
	}

	/** 追加一条原始观察到当日日志（logs/yyyy/mm/dd.md） */
	async appendLog(scope: MemoryScope, text: string): Promise<void> {
		const dir = await this.ensureDir(scope);
		const d = new Date();
		const yyyy = String(d.getUTCFullYear());
		const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
		const dd = String(d.getUTCDate()).padStart(2, '0');
		const logDir = join(dir, 'logs', yyyy, mm);
		await mkdir(logDir, { recursive: true, mode: 0o700 });
		await appendFile(join(logDir, `${yyyy}-${mm}-${dd}.md`), `- ${text}\n`, 'utf-8');
	}

	/** 追加审计记录（写日志本身不抛错） */
	async audit(record: MemoryAuditRecord): Promise<void> {
		try {
			const dir = await this.ensureDir((record.scope as MemoryScope) ?? 'project');
			await appendFile(join(dir, AUDIT_FILE), JSON.stringify(record) + '\n', 'utf-8');
		} catch {
			/* 审计失败不影响主流程 */
		}
	}

	// ─── 索引 ──────────────────────────────────────────

	/**
	 * 重建 MEMORY.md（正式条目）与 candidates.md（模糊条目）。
	 * 索引由文件内容派生 —— 任何时候都可重建，不需要额外状态。
	 */
	async rebuildIndex(scope: MemoryScope): Promise<void> {
		const dir = await this.ensureDir(scope);
		// 条目来自工作集（manifest 元数据），legacy 仍需扫目录（手写笔记不进工作集）
		const { legacy } = await this.scanLegacy(scope);
		const entries = [...(await this.layer(scope)).entries.values()];

		const active = entries.filter((e) => e.status === 'active' && e.confidence >= this.masterMinConfidence);
		const candidates = entries.filter((e) => e.status === 'candidate' || (e.status === 'active' && e.confidence < this.masterMinConfidence));

		const indexLines = active.map((e) => renderManifestLine(e));
		const indexBody = [
			'# Memory index',
			'',
			'> 本文件由条目文件自动生成（内容以各 `<slug>.md` 为准）。',
			...(legacy.length > 0 ? ['', `> 另有 ${legacy.length} 个未纳入索引的笔记（legacy/ 或手写文件）：${legacy.join(', ')}`] : []),
			'',
			...indexLines,
		].join('\n');
		await atomicWrite(join(dir, INDEX_FILE), indexBody + '\n');

		const candLines = candidates.map(
			(e) => `- [${e.name}](${e.slug}.md) — ${e.description} (confidence ${e.confidence}, updated ${ageText(e.updated)})`,
		);
		const candBody = ['# Candidate memories (confidence < 阈值，仅 memory agent 管理)', '', ...candLines].join('\n');
		await atomicWrite(join(dir, CANDIDATES_FILE), candBody + '\n');
	}

	// ─── 状态（活动日 / 使用统计；v3 起并入总表） ─────────

	/**
	 * 读取某层状态（活动日 + 使用统计）。
	 * v3：数据存在内存工作集里，持久化在 manifest.json；
	 * 首次重建时会从旧 `state.json` 导入一次（向后兼容）。
	 */
	async getState(scope: MemoryScope): Promise<MemoryState> {
		const layer = await this.layer(scope);
		return {
			activeDayCount: layer.activeDayCount,
			lastActiveDate: layer.lastActiveDate,
			usage: layer.usage,
			updatedAt: new Date(layer.loadedAtMs || Date.now()).toISOString(),
		};
	}

	async setState(scope: MemoryScope, patch: Partial<MemoryState>): Promise<void> {
		const layer = await this.layer(scope);
		if (patch.activeDayCount !== undefined) layer.activeDayCount = patch.activeDayCount;
		if (patch.lastActiveDate !== undefined) layer.lastActiveDate = patch.lastActiveDate;
		if (patch.usage !== undefined) layer.usage = { ...patch.usage };
		await this.persistManifest(scope, layer);
	}

	// ─── 使用统计与 LRU 维护 ─────────────────────────────

	/**
	 * 记录一次「使用」（master 读了全文 / 被写入重申）。
	 * 注入与出现在清单里**不算使用** —— 否则"越注入越升级"会形成正反馈。
	 */
	async recordUse(
		scope: MemoryScope,
		slug: string,
		now: string = new Date().toISOString(),
		inheritedUses = 0,
		opts: { allowPromote?: boolean } = {},
	): Promise<void> {
		const layer = await this.layer(scope);
		const usage = layer.usage;
		const cur = usage[slug] ?? { uses: 0, lastUsedAt: now };
		usage[slug] = {
			...cur,
			uses: cur.uses + inheritedUses + 1,
			lastUsedAt: now,
			// 记下"第几个活动日用的"——老化以活动日为钟（缺席不老化）
			lastUsedDay: layer.activeDayCount,
		};
		await this.persistManifest(scope, layer);
		await this.audit({ kind: 'use', at: now, scope, slug, uses: usage[slug].uses, activeDay: usage[slug].lastUsedDay });
		// v3：会话内局部判定 —— 不等检查点结算，被使用的这条立即升级 / 从"待销毁"复活
		await this.applyLocalJudgement(scope, slug, now, { allowPromote: opts.allowPromote ?? true }).catch(() => { /* 判定失败不影响读取/写入 */ });
	}

	/**
	 * 会话内**局部判定**（只作用于刚被触达的这一条，O(1)）：
	 *   - 待销毁（conf 0）被任何触达 → 回到 conf 1 重新观察（不越级）；
	 *   - 累计使用达到阈值且仍在活跃窗口内 → 升一级（封顶 3），uses 清零。
	 *
	 * 明确不做（留给检查点结算）：闲置降级、窗口换出、容量淘汰、销毁 —— 那些需要看全体。
	 * 显式降级（写入 confidence 1 / 遗忘 / 取代）本来就在写入路径即时生效，不经过这里。
	 */
	private async applyLocalJudgement(
		scope: MemoryScope,
		slug: string,
		now: string,
		opts: { allowPromote: boolean },
	): Promise<void> {
		if (!this.lruEnabled) return;
		const layer = await this.layer(scope);
		const entry = layer.entries.get(slug);
		if (!entry || entry.pinned || entry.status === 'superseded') return;
		const usage = layer.usage[slug];

		if (entry.confidence <= 0) {
			await this.putEntry(scope, {
				...entry, confidence: 1,
				status: deriveStatus(entry.status, 1, this.masterMinConfidence),
			});
			layer.usage[slug] = {
				...(usage ?? { uses: 0, lastUsedAt: now }),
				uses: 0,
				lastUsedDay: layer.activeDayCount,
				lastStepDay: layer.activeDayCount,
			};
			await this.persistManifest(scope, layer);
			await this.audit({ kind: 'lru', at: now, scope, local: true, revived: [slug], activeDay: layer.activeDayCount });
			return;
		}

		if (!opts.allowPromote || entry.confidence >= 3) return;
		if (!usage || usage.uses < this.promoteUses) return;
		const to = Math.min(3, entry.confidence + 1);
		await this.putEntry(scope, {
			...entry, confidence: to,
			status: deriveStatus(entry.status, to, this.masterMinConfidence),
		});
		layer.usage[slug] = { ...usage, uses: 0 };
		await this.persistManifest(scope, layer);
		await this.audit({
			kind: 'lru', at: now, scope, local: true,
			promoted: [{ slug, from: entry.confidence, to }], activeDay: layer.activeDayCount,
		});
	}

	/**
	 * 把被取代条目的使用计数转给新条目并清理旧记录。
	 * 返回转出的次数（调用方把它叠加到新条目上）。
	 *
	 * 为什么必须转：同主题"反复出现"是候选条目升级的唯一确定性证据（§4.2 通道 2），
	 * 清零会让"一年才提一次"的偏好永远攒不够证据。
	 */
	private async inheritUsage(scope: MemoryScope, fromSlugs: string[], toSlug: string): Promise<number> {
		const layer = await this.layer(scope);
		const usage = layer.usage;
		let inherited = 0;
		let lastUsedAt: string | undefined;
		let lastUsedDay: number | undefined;
		for (const slug of fromSlugs) {
			const old = usage[slug];
			if (!old) continue;
			inherited += old.uses;
			if (!lastUsedAt || old.lastUsedAt > lastUsedAt) lastUsedAt = old.lastUsedAt;
			if (old.lastUsedDay !== undefined) lastUsedDay = Math.max(lastUsedDay ?? 0, old.lastUsedDay);
			delete usage[slug];
		}
		if (lastUsedAt) {
			const cur = usage[toSlug] ?? { uses: 0, lastUsedAt };
			usage[toSlug] = {
				...cur,
				lastUsedAt: cur.lastUsedAt > lastUsedAt ? cur.lastUsedAt : lastUsedAt,
				...(lastUsedDay !== undefined ? { lastUsedDay: Math.max(cur.lastUsedDay ?? 0, lastUsedDay) } : {}),
			};
		}
		await this.persistManifest(scope, layer);
		return inherited;
	}

	/** 丢弃若干条目的使用记录（条目被取代/遗忘后不再需要；避免 state.json 无限累积） */
	private async dropUsage(scope: MemoryScope, slugs: string[]): Promise<void> {
		if (slugs.length === 0) return;
		const layer = await this.layer(scope);
		const usage = layer.usage;
		let changed = false;
		for (const slug of slugs) {
			if (usage[slug] !== undefined) {
				delete usage[slug];
				changed = true;
			}
		}
		if (changed) await this.persistManifest(scope, layer);
	}

	/**
	 * 记录一次**弱信号「看到」**（归纳代理为了查重读了某条）：**刷新老化时钟**，但
	 * **不增 `uses`、不动 `lastUsedAt`**。
	 *
	 * 语义：这个话题又出现了 → 它不该因为"长期闲置"被降级/销毁；
	 * 但"代理看过"不足以作为升级证据（升级只认 master 读全文 / 写入重申），
	 * 也不影响 LRU 排序（窗口换出仍按真实使用时间）。
	 */
	async recordTouch(scope: MemoryScope, slug: string, now: string = new Date().toISOString()): Promise<void> {
		const layer = await this.layer(scope);
		const usage = layer.usage;
		const cur = usage[slug] ?? { uses: 0, lastUsedAt: now };
		usage[slug] = { ...cur, lastUsedDay: layer.activeDayCount };
		await this.persistManifest(scope, layer);
		await this.audit({ kind: 'use', at: now, scope, slug, touch: true, activeDay: usage[slug].lastUsedDay });
		// 「看到」也足以把"待销毁"拉回观察区，但**不足以升级**
		await this.applyLocalJudgement(scope, slug, now, { allowPromote: false }).catch(() => { /* 同上 */ });
	}

	/**
	 * 钉住 / 取消钉住。
	 *
	 * 钉住 = 用户显式"留住它"：**把等级拉到可见阈值**（不低于原值）——
	 * pin 一条 master 看不见的条目（conf 0/1）没有意义，而且 conf 0 本身就是"待销毁"。
	 * 想升到 3 仍要靠"被反复使用"或用户显式写入（不在这里凭空加证据）。
	 * `reconcile` 会跳过 pinned（免疫自动升降级与销毁）；取消钉住后重新参与维护。
	 */
	async setPinned(scope: MemoryScope, slug: string, pinned: boolean): Promise<boolean> {
		const entry = await this.readEntry(scope, slug);
		if (!entry) return false;
		const now = new Date().toISOString();
		const confidence = pinned ? Math.max(entry.confidence, this.masterMinConfidence) : entry.confidence;
		await this.putEntry(scope, {
			...entry,
			pinned: pinned || undefined,
			confidence,
			status: deriveStatus(entry.status, confidence, this.masterMinConfidence),
		});
		await this.flush(scope);
		await this.audit({ kind: 'pin', at: now, scope, slug, pinned, confidence });
		await this.syncIndex(scope);
		return true;
	}

	/**
	 * LRU 维护（**统一 confidence 档位**：3/2 可见 → 1 待观察 → 0 待销毁 → 销毁）。
	 * 幂等、确定性、可预览、全程审计；**没有独立的"换出队列"** —— 生命周期全部由 confidence 表达。
	 *
	 * 时间单位是**活动日**（`state.activeDayCount`，只在"新的一天且程序确实被使用"时 +1）——
	 * 用户长期不启动程序时老化**不推进**，因此不会出现"半年没开，回来一次全清"。
	 *
	 * 一次结算的判定顺序（每条只命中一个分支）：
	 *   0. `pinned` → 跳过（免疫自动升降级与销毁）
	 *   1. **conf 0（待销毁）**：
	 *      a. 最近一个 decay 周期内被触达过（master 读全文/写入，或归纳代理查重读到）→ **回到 conf 1 重新观察**
	 *      b. 否则闲置活动日 > `destroyAfterDays` → **销毁**（默认归档 `legacy/archive/`，可配物理删除）
	 *   2. **conf ≥ 1**：
	 *      a. **升级**：`uses ≥ promoteUses` 且最近有使用（闲置 ≤ decay）且 conf < 3 → +1，uses 清零
	 *      b. **窗口换出**：属于"超出 `windowSize` 的最久未用者" → 降到 conf 1（观察区，不是判死刑）
	 *      c. **容量淘汰（conf → 0）**：属于"超出 `totalLimit` 的最久未用**候选**" → 降到 0（待销毁）
	 *      d. **闲置降级**：闲置活动日 > decay → −1（**下限 1**：只是没人用不会致死）
	 *
	 * 不变量：
	 *   - **一次结算每条只走一步**（`lastStepDay` 保证同一活动日内重复结算不连降）；
	 *   - conf 0 是**唯一**的"待销毁"状态；被任何触达即回到 **1**（不直接回 2：重新启用要重新观察）；
	 *   - 触达只刷新老化时钟，**LRU 排序键仍是真实使用时间**（代理的"看到"不会让它显得更"常用"）。
	 *
	 * @param dryRun true 时只返回计划、不落盘（`/memory gc --dry-run`）
	 */
	async reconcile(
		scope: MemoryScope,
		opts: MemoryLruOptions = {},
		dryRun = false,
	): Promise<MemoryMaintenanceResult> {
		const result: MemoryMaintenanceResult = {
			scope, promoted: [], demoted: [], windowEvicted: [], doomed: [], revived: [], destroyed: [],
			pinned: [], dryRun: dryRun || undefined,
		};
		if (opts.enabled === false) return result;

		const decayDays = opts.decayActiveDays ?? 90;
		const promoteUses = opts.promoteUses ?? 2;
		const windowSize = opts.windowSize ?? 200;
		const totalLimit = opts.totalLimit ?? 400;
		const destroyAfter = opts.destroyAfterDays ?? 180;
		const destroyMode = opts.destroyMode ?? 'archive';
		const DAY = 86_400_000;
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		const minConf = this.masterMinConfidence;

		const dir = await this.ensureDir(scope);
		const state = await this.getState(scope);

		// ── 活动时钟：每个"新的一天"至多 +1（缺席不推进）──────────
		const today = new Date(nowMs).toISOString().slice(0, 10);
		const advanced = state.lastActiveDate !== today;
		const activeDay = (state.activeDayCount ?? 0) + (advanced ? 1 : 0);
		result.activeDay = activeDay;

		const entries = [...(await this.layer(scope)).entries.values()];
		const live = entries.filter((e) => e.status !== 'superseded');
		const usage = { ...state.usage };

		// 健壮性：state.json 是未校验 JSON。缺失/非法的 lastUsedAt 会让 Date.parse → NaN；
		// NaN 参与排序比较器会让顺序不稳定，老化判定也可能被静默冻结。统一回退到 entry.updated。
		const updatedBySlug = new Map(live.map((e) => [e.slug, e.updated]));
		for (const [slug, u] of Object.entries(usage)) {
			if (!Number.isFinite(Date.parse(u.lastUsedAt ?? ''))) {
				usage[slug] = { ...u, lastUsedAt: updatedBySlug.get(slug) ?? new Date(0).toISOString() };
			}
		}

		/** 最近使用时间（毫秒，永不为 NaN；缺失回退条目的 updated） */
		const lastUsedMs = (u: MemoryUsage, entry: MemoryEntry): number => {
			const t = Date.parse(u.lastUsedAt || entry.updated);
			return Number.isFinite(t) ? t : 0;
		};

		/** 老化起点 = max(最近触达, 最近结算)——结算本身也算"走过一步"，防同一活动日连降 */
		const idleOf = (entry: MemoryEntry, u: MemoryUsage): number => {
			if (u.lastUsedDay !== undefined) {
				return Math.max(0, activeDay - Math.max(u.lastUsedDay, u.lastStepDay ?? 0));
			}
			// 老数据（无活动日记录）回退为日历天估算
			return Math.floor((nowMs - Date.parse(u.lastUsedAt || entry.updated)) / DAY);
		};
		/** 是否在最近一个 decay 周期内被触达过（conf 0 → 1 的"重新观察"判据） */
		const touchedRecently = (entry: MemoryEntry, u: MemoryUsage): boolean =>
			u.lastUsedDay !== undefined
				? activeDay - u.lastUsedDay <= decayDays
				: Math.floor((nowMs - Date.parse(u.lastUsedAt || entry.updated)) / DAY) <= decayDays;

		// 窗口：可见集合超容量 → 最久未用者（LRU 序：lastUsedAt → uses → slug）降到观察区
		const visible = live
			.filter((e) => !e.pinned && e.confidence >= minConf)
			.sort((a, b) => {
				const ua = usage[a.slug] ?? { uses: 0, lastUsedAt: a.updated };
				const ub = usage[b.slug] ?? { uses: 0, lastUsedAt: b.updated };
				const ta = lastUsedMs(ua, a);
				const tb = lastUsedMs(ub, b);
				if (ta !== tb) return ta - tb;                       // 最久未用在前
				if (ua.uses !== ub.uses) return ua.uses - ub.uses;    // 用得少者优先换出
				return a.slug.localeCompare(b.slug);                  // 确定性
			});
		const over = Math.max(0, visible.length - windowSize);
		const windowEvict = new Set(visible.slice(0, over).map((e) => e.slug));

		// 容量淘汰（R31）：**只有装不下时才会出现 conf 0**。
		// 候选区上限 = 总量上限 − 可见上限；超出的最久未用候选降到 0（待销毁）。
		const candidateLimit = Math.max(0, totalLimit - windowSize);
		const candidates = live
			.filter((e) => !e.pinned && e.confidence < minConf)
			.sort((a, b) => {
				const ua = usage[a.slug] ?? { uses: 0, lastUsedAt: a.updated };
				const ub = usage[b.slug] ?? { uses: 0, lastUsedAt: b.updated };
				const ta = lastUsedMs(ua, a);
				const tb = lastUsedMs(ub, b);
				if (ta !== tb) return ta - tb;
				if (ua.uses !== ub.uses) return ua.uses - ub.uses;
				return a.slug.localeCompare(b.slug);
			});
		const overCandidates = Math.max(0, candidates.length - candidateLimit);
		const capacityDoom = new Set(candidates.slice(0, overCandidates).map((e) => e.slug));

		/** 先算完整计划（纯计算），再统一落盘 —— dry-run 因此零副作用 */
		const plan: { slug: string; confidence: number; usage?: MemoryUsage; destroy?: boolean }[] = [];

		for (const entry of live) {
			if (entry.pinned) {
				result.pinned.push(entry.slug);
				continue;
			}
			const u = usage[entry.slug] ?? { uses: 0, lastUsedAt: entry.updated };
			const idle = idleOf(entry, u);
			const conf = entry.confidence;

			// 1. conf 0 = 待销毁
			if (conf <= 0) {
				if (touchedRecently(entry, u)) {
					// 被再次触达 → 回到 1 重新观察（不直接回 2：重新启用需要重新积累证据）
					result.revived.push(entry.slug);
					plan.push({ slug: entry.slug, confidence: 1, usage: { ...u, uses: 0, lastStepDay: activeDay } });
				} else if (idle > destroyAfter) {
					result.destroyed.push(entry.slug);
					plan.push({ slug: entry.slug, confidence: conf, destroy: true });
				}
				continue;
			}

			// 2a. 升级（要求最近有使用，避免靠历史计数升级）
			if (u.uses >= promoteUses && idle <= decayDays && conf < 3) {
				const to = Math.min(3, conf + 1);
				result.promoted.push({ slug: entry.slug, from: conf, to });
				plan.push({ slug: entry.slug, confidence: to, usage: { ...u, uses: 0 } });
				continue;
			}

			// 2b. 窗口换出 → 降到 conf 1（观察区）
			if (conf > 1 && windowEvict.has(entry.slug)) {
				result.windowEvicted.push(entry.slug);
				plan.push({ slug: entry.slug, confidence: 1, usage: { ...u, uses: 0, lastStepDay: activeDay } });
				continue;
			}

			// 2c. 容量淘汰 → 降到 conf 0（待销毁）：只有在"装不下"时才会发生
			if (capacityDoom.has(entry.slug)) {
				result.doomed.push({ slug: entry.slug, from: conf, to: 0 });
				plan.push({ slug: entry.slug, confidence: 0, usage: { ...u, uses: 0, lastStepDay: activeDay } });
				continue;
			}

			// 2d. 闲置降级（一次一级；**下限 1** —— 只是没人用不会把记忆推向销毁）
			if (idle > decayDays && conf > 1) {
				const to = conf - 1;
				result.demoted.push({ slug: entry.slug, from: conf, to });
				plan.push({ slug: entry.slug, confidence: to, usage: { ...u, uses: 0, lastStepDay: activeDay } });
			}
		}

		if (dryRun || (plan.length === 0 && !advanced)) return result;
		if (advanced) await this.setState(scope, { activeDayCount: activeDay, lastActiveDate: today });

		const archiveDir = join(dir, 'legacy', 'archive');
		for (const p of plan) {
			if (p.destroy) {
				// 归档/删除失败不应中断整批结算（旧实现在 archive 分支裸 rename，一个失败全批中止）
				try {
					if (destroyMode === 'delete') {
						await unlink(join(dir, `${p.slug}.md`));
					} else {
						await mkdir(archiveDir, { recursive: true, mode: 0o700 });
						await rename(join(dir, `${p.slug}.md`), join(archiveDir, `${p.slug}.md`));
					}
				} catch { /* 文件已不存在 / 无法移动：仍从工作集移除 */ }
				const layer = await this.layer(scope);
				layer.entries.delete(p.slug);
				delete usage[p.slug];
				continue;
			}
			const entry = entries.find((e) => e.slug === p.slug)!;
			await this.putEntry(scope, {
				...entry, confidence: p.confidence,
				status: deriveStatus(entry.status, p.confidence, minConf), updated: entry.updated,
			});
			if (p.usage) usage[p.slug] = p.usage;
		}
		await this.setState(scope, { usage });
		await this.syncIndex(scope);
		await this.audit({
			kind: 'lru', at: nowIso, scope, activeDay,
			promoted: result.promoted, demoted: result.demoted,
			windowEvicted: result.windowEvicted, doomed: result.doomed,
			revived: result.revived, destroyed: result.destroyed,
		});
		return result;
	}

	/**
	 * 索引自维护：`write` / `forget` / `pin` / `reconcile` 内部调用，
	 * 调用方**不需要**（也不应）再记得手动 `rebuildIndex`。
	 * 索引失败不影响已写入的条目（可随时重建），只落一条审计。
	 */
	private async syncIndex(scope: MemoryScope): Promise<void> {
		try {
			await this.rebuildIndex(scope);
		} catch (err) {
			await this.audit({
				kind: 'error', at: new Date().toISOString(), scope,
				where: 'rebuildIndex', message: (err as Error).message,
			}).catch(() => { /* 审计自身失败就放弃 */ });
		}
	}

	// ─── 内部 ──────────────────────────────────────────

	/**
	 * 写入一条条目：主题文件（人可读，正文在这里）+ 工作集（内存）。
	 * 不落 manifest —— 调用方在一次操作末尾 `persistManifest` 一次，避免批内多次写。
	 */
	private async putEntry(scope: MemoryScope, entry: MemoryEntry): Promise<void> {
		const dir = this.dirs[scope];
		const filePath = join(dir, `${entry.slug}.md`);
		await atomicWrite(filePath, serializeEntry(entry));
		const layer = await this.layer(scope);
		layer.entries.set(entry.slug, { ...entry, filePath });
		layer.dirty = true;
	}

	/** 读某条条目的正文（工作集只存元数据） */
	private async entryBody(scope: MemoryScope, entry: MemoryEntry): Promise<string> {
		if (entry.body) return entry.body;
		const raw = await this.readText(entry.filePath);
		return raw === null ? '' : (parseEntry(raw, entry.filePath, scope)?.body ?? '');
	}

	/** 扫描目录里的"非条目"文件（无 frontmatter / 缺 subject 的手写笔记） */
	private async scanLegacy(scope: MemoryScope): Promise<{ legacy: string[] }> {
		const dir = this.dirs[scope];
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return { legacy: [] };
		}
		const legacy: string[] = [];
		for (const name of names) {
			if (!name.endsWith('.md')) continue;
			if (name === INDEX_FILE || name === CANDIDATES_FILE) continue;
			const raw = await this.readText(join(dir, name));
			if (raw === null) continue;
			if (!parseEntry(raw, join(dir, name), scope)) legacy.push(name);
		}
		legacy.sort();
		return { legacy };
	}

	private async uniqueSlug(scope: MemoryScope, base: string): Promise<string> {
		const layer = await this.layer(scope);
		const taken = new Set(layer.entries.keys());
		if (!taken.has(base)) return base;
		for (let i = 2; i < 100; i++) {
			const candidate = `${base}-${i}`;
			if (!taken.has(candidate)) return candidate;
		}
		return `${base}-${Date.now()}`;
	}

	private async readText(path: string): Promise<string | null> {
		try {
			return await readFile(path, 'utf-8');
		} catch {
			return null;
		}
	}
}

// ─── frontmatter 解析/序列化 ──────────────────────────

const FRONTMATTER_FIELDS = [
	'name', 'description', 'type', 'subject', 'tags', 'scope',
	'confidence', 'signal', 'paths', 'pinned', 'created', 'updated', 'status', 'supersededBy',
] as const;

/** 解析条目文件；缺 frontmatter / 缺 subject 时返回 null（视为用户手写笔记） */
export function parseEntry(raw: string, filePath: string, scope: MemoryScope): MemoryEntry | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!m) return null;
	const fm = parseFrontmatter(m[1]);
	if (!fm.subject) return null;
	const slug = filePath.split('/').pop()!.replace(/\.md$/, '');
	const confidence = typeof fm.confidence === 'number' ? fm.confidence : Number(fm.confidence ?? 0) || 1;
	return {
		slug,
		name: String(fm.name ?? slug),
		description: String(fm.description ?? ''),
		type: (MEMORY_TYPES as readonly string[]).includes(String(fm.type)) ? (fm.type as MemoryType) : 'reference',
		subject: String(fm.subject),
		tags: toStringArray(fm.tags),
		scope: (fm.scope === 'global' || fm.scope === 'project' ? fm.scope : scope) as MemoryScope,
		confidence,
		signal: fm.signal === undefined ? undefined : String(fm.signal),
		paths: fm.paths === undefined ? undefined : toStringArray(fm.paths),
		pinned: fm.pinned === true || fm.pinned === 'true' || undefined,
		created: String(fm.created ?? new Date(0).toISOString()),
		updated: String(fm.updated ?? fm.created ?? new Date(0).toISOString()),
		status: (fm.status === 'candidate' || fm.status === 'superseded' ? fm.status : 'active') as MemoryStatus,
		supersededBy: fm.supersededBy === undefined ? undefined : String(fm.supersededBy),
		body: m[2].trim(),
		filePath,
	};
}

/** 极简 frontmatter 解析（只支持我们写出的形态：`key: value` / `key: [a, b]`） */
export function parseFrontmatter(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue;
		const idx = line.indexOf(':');
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const rawValue = line.slice(idx + 1).trim();
		out[key] = parseScalar(rawValue);
	}
	return out;
}

function parseScalar(raw: string): unknown {
	if (raw.startsWith('[') && raw.endsWith(']')) {
		const inner = raw.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(',').map((v) => unquote(v.trim()));
	}
	if (/^-?\d+$/.test(raw)) return Number(raw);
	return unquote(raw);
}

function unquote(v: string): string {
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

/** 序列化为「frontmatter + 正文」 */
export function serializeEntry(entry: MemoryEntry): string {
	const fm: Record<string, unknown> = {
		name: entry.name,
		description: entry.description,
		type: entry.type,
		subject: entry.subject,
		tags: entry.tags,
		scope: entry.scope,
		confidence: entry.confidence,
	}
	if (entry.signal) fm.signal = entry.signal;
	if (entry.paths && entry.paths.length > 0) fm.paths = entry.paths;
	if (entry.pinned) fm.pinned = true;
	fm.created = entry.created;
	fm.updated = entry.updated;
	if (entry.status !== 'active') fm.status = entry.status;
	if (entry.supersededBy) fm.supersededBy = entry.supersededBy;

	const lines = FRONTMATTER_FIELDS
		.filter((k) => fm[k] !== undefined)
		.map((k) => `${k}: ${serializeScalar(fm[k])}`);
	return `---\n${lines.join('\n')}\n---\n\n${entry.body.trim()}\n`;
}

function serializeScalar(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((v) => serializeScalar(v)).join(', ')}]`;
	}
	if (typeof value === 'number') return String(value);
	const s = String(value);
	// 需要引号：含结构字符 / 首尾空白 / 空串 / 看起来像数字或数组
	if (s === '' || /^[\s]|[\s]$/.test(s) || /[:#,[\]{}"']/.test(s) || /^-?\d+$/.test(s)) {
		return `"${s.replace(/"/g, '\\"')}"`;
	}
	return s;
}

// ─── 工具函数 ─────────────────────────────────────────

/** 索引/清单行（注入与 MEMORY.md 共用同一渲染，保证字节一致）；`now` 可注入以便确定性测试 */
export function renderManifestLine(entry: MemoryEntry, now: Date = new Date()): string {
	return `- [${entry.name}](${entry.slug}.md) — ${entry.description} (confidence ${entry.confidence}, updated ${ageText(entry.updated, now)})`;
}

/** 人话时间（模型对「3 days ago」比 ISO 时间戳更敏感；对齐 Claude Code 的 memoryAge） */
export function ageText(iso: string, now: Date = new Date()): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return 'unknown';
	const days = Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	return `${days} days ago`;
}

/** 归一化文本（比较用：去空白/标点差异，大小写不敏感） */
export function normalizeText(text: string): string {
	return text.replace(/\s+/g, '').replace(/[，。！？；：、,.!?;:'"`]/g, '').toLowerCase();
}

/** token 估算：UTF-8 字节 / 3（与 src/core/compact.ts 的 estimateTokens 一致） */
export function estimateTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, 'utf-8') / 3);
}

function hashRev(parts: string[]): string {
	return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 8);
}

/** 由 subject/名称派生 slug（`reply.format` → `reply-format`） */
export function slugify(text: string): string {
	const s = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return s || 'memory';
}

function toStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x));
	if (v === undefined || v === null || v === '') return [];
	return [String(v)];
}

function blankEntry(scope: MemoryScope, slug: string, now: string, dir: string): MemoryEntry {
	return {
		slug,
		name: slug,
		description: '',
		type: 'reference',
		subject: slug,
		tags: [],
		scope,
		confidence: 2,
		created: now,
		updated: now,
		status: 'active',
		body: '',
		filePath: join(dir, `${slug}.md`),
	};
}

function pickFields(input: MemoryWriteInput, now: string): Partial<MemoryEntry> {
	const out: Partial<MemoryEntry> = { subject: input.subject, body: input.body, updated: now };
	if (input.name !== undefined) out.name = input.name;
	if (input.description !== undefined) out.description = input.description;
	if (input.type !== undefined) out.type = input.type;
	if (input.tags !== undefined) out.tags = input.tags;
	if (input.signal !== undefined) out.signal = input.signal;
	if (input.paths !== undefined) out.paths = input.paths;
	if (input.confidence !== undefined) {
		out.confidence = clampConfidence(input.confidence);
	}
	return out;
}

function mergeEntryFields(entry: MemoryEntry, input: MemoryWriteInput, now: string): MemoryEntry {
	const patch = pickFields(input, now);
	return {
		...entry,
		...patch,
		// created 与 slug 永不改写；slug 由文件名决定
		slug: entry.slug,
		created: entry.created,
		// status 不在这里决定：由 MemoryStore.write() 依**最终 confidence** 统一派生
		// （否则"低置信的同义重复"会把正式条目挤进候选池，见 write() 的 deriveStatus）
		status: entry.status,
	};
}

/**
 * 状态派生（`status` 是 confidence 的投影，唯一例外见下）。
 * - `superseded` 是**终态**：只能由新条目改写，不会被后续 update/merge 复原；
 * - 其余按**最终 confidence** 对阈值取 `active` / `candidate`。
 *
 * 关键：必须在算出最终 confidence **之后**调用（merge 取 max、update 可能显式降级），
 * 否则会出现 `status=candidate` + `confidence=3` 这种自相矛盾、且条目静默消失于注入清单的状态。
 */
function deriveStatus(previous: MemoryStatus, confidence: number, minConfidence: number): MemoryStatus {
	if (previous === 'superseded') return 'superseded';
	return confidence >= minConfidence ? 'active' : 'candidate';
}

function clampConfidence(v?: number): number {
	if (v === undefined || Number.isNaN(v)) return 2;
	return Math.min(3, Math.max(1, Math.round(v)));
}

/** 原子写：临时文件 + rename */
async function atomicWrite(path: string, content: string): Promise<void> {
	// 临时名必须唯一：同进程同毫秒并发写同一目标（master 写入 + 后台归纳各自重建索引）
	// 曾用 `pid-Date.now()` 会撞名，导致第二个 rename 拿到 ENOENT、写入静默失败。
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	await writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
	await rename(tmp, path);
}

