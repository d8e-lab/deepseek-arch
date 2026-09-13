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

import { readFile, writeFile, mkdir, readdir, rename, stat, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** 记忆类型（受控词表，对齐 Claude Code） */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
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
	/** 提醒时间（ISO 8601；到期后注入提醒） */
	remindAt?: string;
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
	remindAt?: string;
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

/** 持久化状态（state.json） */
export interface MemoryState {
	/** 归纳游标：已归纳到哪一轮（turn id） */
	lastExtractedTurnId?: string;
	/** 上次归一化的时间（ISO） */
	updatedAt?: string;
}

/** 审计记录（audit.jsonl，追加式；kind 区分类型） */
export interface MemoryAuditRecord {
	kind: 'write' | 'merge' | 'supersede' | 'forget' | 'fold' | 'inject' | 'error' | 'agent_run' | 'remind_due';
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
}

/** 索引/候选文件名（不参与条目扫描） */
const INDEX_FILE = 'MEMORY.md';
const CANDIDATES_FILE = 'candidates.md';
const STATE_FILE = 'state.json';
const AUDIT_FILE = 'audit.jsonl';

export class MemoryStore {
	private readonly dirs: Record<MemoryScope, string>;
	private readonly masterMinConfidence: number;

	constructor(opts: MemoryStoreOptions) {
		this.dirs = { project: opts.projectDir, global: opts.globalDir };
		this.masterMinConfidence = opts.masterMinConfidence ?? 2;
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

	/** 扫描某层全部条目（含 candidate / superseded；解析失败的返回 null 并计入 legacy） */
	async scan(scope: MemoryScope): Promise<{ entries: MemoryEntry[]; legacy: string[] }> {
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
		entries.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.slug.localeCompare(b.slug)));
		legacy.sort();
		return { entries, legacy };
	}

	/** 正式条目（active 且 confidence ≥ 阈值） */
	async listEntries(scope: MemoryScope): Promise<MemoryEntry[]> {
		const { entries } = await this.scan(scope);
		return entries.filter((e) => e.status === 'active' && e.confidence >= this.masterMinConfidence);
	}

	/** 模糊条目（candidate 或 confidence < 阈值）——master 不可见，仅 memory agent 管理 */
	async listCandidates(scope: MemoryScope): Promise<MemoryEntry[]> {
		const { entries } = await this.scan(scope);
		return entries.filter((e) => e.status === 'candidate' || e.confidence < this.masterMinConfidence);
	}

	/** 按 slug 读取单条（不存在返回 null） */
	async readEntry(scope: MemoryScope, slug: string): Promise<MemoryEntry | null> {
		const { entries } = await this.scan(scope);
		return entries.find((e) => e.slug === slug) ?? null;
	}

	/** 按 subject 精确匹配（合并/supersede 判定用） */
	async findBySubject(scope: MemoryScope, subject: string): Promise<MemoryEntry[]> {
		const { entries } = await this.scan(scope);
		return entries.filter((e) => e.subject === subject && e.status !== 'superseded');
	}

	/**
	 * 到期待提醒的条目（`remindAt` ≤ now，且未被取代）。
	 * **包含 confidence=1 的候选条目**：用户明确要求"到时候提醒我"，与"master 可见性"是两码事。
	 */
	async listDue(scope: MemoryScope, now: Date = new Date()): Promise<MemoryEntry[]> {
		const { entries } = await this.scan(scope);
		const ts = now.getTime();
		return entries
			.filter((e) => e.status !== 'superseded' && e.remindAt !== undefined)
			.filter((e) => {
				const t = Date.parse(e.remindAt!);
				return !Number.isNaN(t) && t <= ts;
			})
			.sort((a, b) => (a.remindAt! < b.remindAt! ? -1 : 1));
	}

	/**
	 * 提醒已发出：清空该条目的 `remindAt`（一次性提醒，避免每轮重复打扰）。
	 * 条目本身保留（正文与置信度不变），只是不再带提醒时间。
	 */
	async markReminded(scope: MemoryScope, slug: string): Promise<boolean> {
		const dir = await this.ensureDir(scope);
		const entry = await this.readEntry(scope, slug);
		if (!entry || entry.remindAt === undefined) return false;
		const now = new Date().toISOString();
		const next: MemoryEntry = { ...entry, remindAt: undefined, updated: now };
		await this.writeEntry(dir, next);
		await this.audit({ kind: 'remind_due', at: now, scope, slug, remindAt: entry.remindAt });
		return true;
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
	async write(scope: MemoryScope, input: MemoryWriteInput): Promise<MemoryWriteResult> {
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
			await this.writeEntry(dir, updated);
			await this.audit({ kind: 'write', at: now, action: 'update', slug: updated.slug, ...auditBase });
			return { action: 'update', slug: updated.slug };
		}

		// 2. 同 subject
		for (const existing of sameSubject) {
			if (normalizeText(existing.body) === normalizeText(input.body)) {
				const merged = mergeEntryFields(existing, input, now);
				// merge **不降级**：同义重复（哪怕是低置信推断）不得把正式条目踢出清单 → 取 max
				merged.confidence = Math.max(existing.confidence, input.confidence ?? existing.confidence);
				merged.status = deriveStatus(existing.status, merged.confidence, this.masterMinConfidence);
				await this.writeEntry(dir, merged);
				await this.audit({ kind: 'merge', at: now, slug: merged.slug, ...auditBase });
				return { action: 'merge', slug: merged.slug };
			}
		}

		// 2b. supercede（显式指定优先 —— 可跨 subject 指名取代；否则用同 subject 的条目）
		let supersedeTargets: MemoryEntry[] = [];
		if (input.supersedes && input.supersedes.length > 0) {
			const { entries } = await this.scan(scope);
			supersedeTargets = entries.filter(
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
			await this.writeEntry(dir, created);
			for (const old of supersedeTargets) {
				const tomb = { ...old, status: 'superseded' as MemoryStatus, supersededBy: slug, updated: now };
				await this.writeEntry(dir, tomb);
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
		await this.writeEntry(dir, entry);
		await this.audit({ kind: 'write', at: now, action: 'add', slug, ...auditBase });
		return { action: 'add', slug };
	}

	/** 遗忘（写墓碑 + 退出索引；文件保留以留演化记录） */
	async forget(scope: MemoryScope, slug: string, reason?: string): Promise<boolean> {
		const dir = await this.ensureDir(scope);
		const entry = await this.readEntry(scope, slug);
		if (!entry) return false;
		const now = new Date().toISOString();
		await this.writeEntry(dir, { ...entry, status: 'superseded', updated: now });
		await this.audit({ kind: 'forget', at: now, scope, slug, reason });
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
		const { entries, legacy } = await this.scan(scope);

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

	// ─── 状态（游标） ──────────────────────────────────

	async getState(scope: MemoryScope): Promise<MemoryState> {
		const raw = await this.readText(join(this.dirs[scope], STATE_FILE));
		if (!raw) return {};
		try {
			return JSON.parse(raw) as MemoryState;
		} catch {
			return {};
		}
	}

	async setState(scope: MemoryScope, patch: Partial<MemoryState>): Promise<void> {
		const dir = await this.ensureDir(scope);
		const current = await this.getState(scope);
		const next: MemoryState = { ...current, ...patch, updatedAt: new Date().toISOString() };
		await atomicWrite(join(dir, STATE_FILE), JSON.stringify(next, null, 2) + '\n');
	}

	// ─── 内部 ──────────────────────────────────────────

	private async writeEntry(dir: string, entry: MemoryEntry): Promise<void> {
		await atomicWrite(join(dir, `${entry.slug}.md`), serializeEntry(entry));
	}

	private async uniqueSlug(scope: MemoryScope, base: string): Promise<string> {
		const { entries } = await this.scan(scope);
		const taken = new Set(entries.map((e) => e.slug));
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
	'confidence', 'signal', 'paths', 'remindAt', 'created', 'updated', 'status', 'supersededBy',
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
		remindAt: fm.remindAt === undefined ? undefined : String(fm.remindAt),
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
	if (entry.remindAt) fm.remindAt = entry.remindAt;
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

/** 索引/清单行（注入与 MEMORY.md 共用同一渲染，保证字节一致） */
export function renderManifestLine(entry: MemoryEntry): string {
	return `- [${entry.name}](${entry.slug}.md) — ${entry.description} (confidence ${entry.confidence}, updated ${ageText(entry.updated)})`;
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
	if (input.remindAt !== undefined) out.remindAt = input.remindAt;
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
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
	await rename(tmp, path);
}

/** 文件是否存在（供上层判断空目录等） */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
