/**
 * Storage — 文件系统持久层（Repository 模式）
 *
 * 目录结构：
 *   <sessionsDir>/
 *   └── <session-id>/
 *       ├── meta.json        # 会话元数据
 *       ├── turns.json       # 全部轮次（单文件数组，v2 格式）
 *       ├── system-prompt.txt# 会话 system prompt（kv-cache 命中用）
 *       └── subagents/       # 子代理执行记录（<name>.json + _index.json）
 *
 * turns.json 为单文件全量读写（每轮对话一个 JSON 文件的旧格式已废弃，
 * loadTurns 保留读取兼容）。
 */

import { readFile, writeFile, mkdir, readdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import type {
	SessionMeta,
	Session,
	SessionListItem,
	Message,
	TurnRecord,
	TokenUsage,
} from '../types/index.js';
import type { SubagentRecord } from './subagent-store.js';

// ─── 文件模板 ────────────────────────────────────────

/** turns 文件名 */
const TURNS_FILE = 'turns.json';

const META_FILE = 'meta.json';

// ─── Storage 类 ──────────────────────────────────────

export class Storage {
	private sessionsDir: string;

	constructor(sessionsDir: string) {
		this.sessionsDir = sessionsDir;
	}

	/** 确保会话根目录存在 */
	private async ensureSessionsDir(): Promise<void> {
		try {
			await access(this.sessionsDir);
		} catch {
			await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
		}
	}

	/** 获取会话目录路径 */
	sessionDir(id: string): string {
		return join(this.sessionsDir, id);
	}

	/** 获取 meta 文件路径 */
	private metaPath(id: string): string {
		return join(this.sessionDir(id), META_FILE);
	}

	/** 获取 turns 文件路径 */
	private turnsPath(id: string): string {
		return join(this.sessionDir(id), TURNS_FILE);
	}

	/** 获取分代文件路径（turn_{gen}.json） */
	private generationPath(id: string, gen: number): string {
		return join(this.sessionDir(id), `turn_${gen}.json`);
	}

	/** 会话是否为分代格式（目录存在 turn_0.json） */
	private async hasGenerationFormat(sessionId: string): Promise<boolean> {
		try {
			await access(this.generationPath(sessionId, 0));
			return true;
		} catch {
			return false;
		}
	}

	/** 读取 JSON 文件 */
	private async readJSON<T>(path: string): Promise<T | null> {
		try {
			const raw = await readFile(path, 'utf-8');
			return JSON.parse(raw) as T;
		} catch (err: any) {
			if (err?.code === 'ENOENT') return null;
			throw err;
		}
	}

	/** 写入 JSON 文件 */
	private async writeJSON(path: string, data: unknown): Promise<void> {
		const content = JSON.stringify(data, null, 2) + '\n';
		await writeFile(path, content, { mode: 0o600 });
	}

	// ─── Sessions ───────────────────────────────────

	/** 创建新会话 */
	async createSession(title = ''): Promise<SessionMeta> {
		await this.ensureSessionsDir();

		const id = uuidv4();
		const now = new Date().toISOString();
		const meta: SessionMeta = {
			id,
			title,
			created_at: now,
			updated_at: now,
			turnCount: 0,
			totalCost: 0,
			currentGen: 0, // 新格式：初始分代 0
		};

		const dir = this.sessionDir(id);
		await mkdir(dir, { mode: 0o700 });
		await this.writeJSON(this.metaPath(id), meta);
		// 初始化分代文件 turn_0.json（空数组）
		await this.writeJSON(this.generationPath(id, 0), []);

		return meta;
	}

	/** 按 ID 获取完整会话 */
	async getSession(id: string): Promise<Session | null> {
		const meta = await this.readJSON<SessionMeta>(this.metaPath(id));
		if (!meta) return null;

		let turns: TurnRecord[];
		let allTurns: TurnRecord[] | undefined;
		if (await this.hasGenerationFormat(id)) {
			// 分代格式：合并所有分代（compact 边界由摘要轮 type='compact' 隐式标记）
			allTurns = [];
			for (const g of await this.listGenerations(id)) {
				allTurns.push(...(await this.loadGeneration(id, g)));
			}
			turns = allTurns;
		} else {
			// 旧 turns.json 格式
			turns = await this.loadTurns(id);
			allTurns = turns;
		}

		// 同步元数据中的计数字段（基于全量轮次）
		if (meta.turnCount !== allTurns.length) {
			meta.turnCount = allTurns.length;
			meta.totalCost = allTurns.reduce((sum, t) => sum + t.cost_rmb, 0);
		}

		// 读取持久化的 system prompt（用于 resume 时恢复，命中 KV cache）
		let systemPrompt: string | undefined;
		try {
			systemPrompt = await readFile(join(this.sessionDir(id), 'system-prompt.txt'), 'utf-8');
		} catch {
			// 旧会话可能没有此文件，忽略
		}

		return { meta, turns, allTurns, systemPrompt };
	}

	/** 按标题精确匹配会话 */
	async getSessionByName(name: string): Promise<Session | null> {
		await this.ensureSessionsDir();
		const entries = await readdir(this.sessionsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const meta = await this.readJSON<SessionMeta>(this.metaPath(entry.name));
			if (meta?.title === name) {
				return this.getSession(entry.name);
			}
		}
		return null;
	}

	/** 列出所有会话 */
	async listSessions(): Promise<SessionListItem[]> {
		await this.ensureSessionsDir();
		const entries = await readdir(this.sessionsDir, { withFileTypes: true });

		const items: SessionListItem[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const meta = await this.readJSON<SessionMeta>(this.metaPath(entry.name));
			if (!meta) continue;
			items.push({
				index: 0, // 后面赋值
				id: meta.id,
				title: meta.title,
				updated_at: meta.updated_at,
				turnCount: meta.turnCount,
			});
		}

		// 按更新时间降序
		items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
		items.forEach((item, i) => (item.index = i + 1));

		return items;
	}

	/** 更新会话标题 */
	async updateSessionTitle(id: string, title: string): Promise<boolean> {
		const meta = await this.readJSON<SessionMeta>(this.metaPath(id));
		if (!meta) return false;

		meta.title = title;
		meta.updated_at = new Date().toISOString();
		await this.writeJSON(this.metaPath(id), meta);
		return true;
	}

	/** 更新会话元数据（内部用） */
	private async updateMeta(id: string, patch: Partial<SessionMeta>): Promise<void> {
		const meta = await this.readJSON<SessionMeta>(this.metaPath(id));
		if (!meta) throw new Error(`会话不存在: ${id}`);
		Object.assign(meta, patch);
		meta.updated_at = new Date().toISOString();
		await this.writeJSON(this.metaPath(id), meta);
	}

	/** 删除会话目录 */
	async deleteSession(id: string): Promise<boolean> {
		const dir = this.sessionDir(id);
		try {
			await access(dir);
		} catch {
			return false;
		}
		await rm(dir, { recursive: true, force: true });
		return true;
	}

	// ─── Turns ───────────────────────────────────────

	/** 保存一轮对话 */
	async saveTurn(
		sessionId: string,
		userMessage: Message,
		assistantMessage: {
			id: string;
			role: 'assistant';
			content?: string;
			reasoning_content?: string;
		},
		usage: TokenUsage,
		costRmb: number,
		interrupted = false,
		toolCalls?: import('../tools/types.js').ToolCallRecord[],
		/** 本轮完整消息序列（含 user + 所有 agent loop 中间消息），用于 KV cache 精确回放 */
		agentLoopMessages?: Message[],
		/** Agent loop 每轮 API 调用的 token 用量，用于缓存命中率监控 */
		roundUsages?: import('../types/chat.js').RoundUsage[],
		/** 本轮最后一次浏览器访问的 URL（resume 时自动恢复） */
		lastBrowserUrl?: string,
	): Promise<TurnRecord> {
		// 确保会话目录存在
		try {
			await access(this.sessionDir(sessionId));
		} catch {
			throw new Error(`会话不存在: ${sessionId}`);
		}

		// 读取现有轮次（分代格式 → 最新分代文件；旧格式 → turns.json）
		let existingTurns: TurnRecord[];
		let gen = -1;
		if (await this.hasGenerationFormat(sessionId)) {
			gen = await this.getCurrentGen(sessionId);
			if (gen < 0) gen = 0;
			existingTurns = await this.loadGeneration(sessionId, gen);
		} else {
			existingTurns = await this.loadTurns(sessionId);
		}
		const turnNumber = existingTurns.length + 1;

		// v2：messages 恒存（唯一事实源），顶层不再存 turn/user/assistant。
		// C-2 修复：agentLoopMessages 由调用方传入且已含 user 消息，此处不再二次拼接；
		// 无工具轮次（agentLoopMessages 为空）由本层统一构造 [user, assistant]。
		const messages: Message[] = agentLoopMessages && agentLoopMessages.length > 0
			? agentLoopMessages
			: [
					userMessage,
					{
						role: 'assistant',
						content: assistantMessage.content ?? '',
						...(assistantMessage.reasoning_content !== undefined
							? { reasoning_content: assistantMessage.reasoning_content }
							: {}),
					},
				];

		const turn: Record<string, unknown> = {
			version: 2,
			messages,
			usage,
			cost_rmb: costRmb,
			created_at: new Date().toISOString(),
			...(interrupted ? { interrupted: true } : {}),
		};

		if (toolCalls && toolCalls.length > 0) {
			turn.tool_calls = toolCalls;
		}

		if (roundUsages && roundUsages.length > 0) {
			turn.round_usage = roundUsages;
		}

		// 将所有轮次写入（分代格式 → 当前分代文件；旧格式 → turns.json）
		const allTurns = [...existingTurns, turn as unknown as TurnRecord];
		if (gen >= 0) {
			await this.writeJSON(this.generationPath(sessionId, gen), allTurns);
		} else {
			await this.writeJSON(this.turnsPath(sessionId), allTurns);
		}

		// 更新元数据
		const totalCost = existingTurns.reduce((sum, t) => sum + t.cost_rmb, 0) + costRmb;
		const metaPatch: Partial<SessionMeta> = {
			turnCount: turnNumber,
			totalCost,
			lastUsage: usage,
		};
		if (lastBrowserUrl !== undefined) {
			metaPatch.lastBrowserUrl = lastBrowserUrl;
		}
		await this.updateMeta(sessionId, metaPatch);

		return turn as unknown as TurnRecord;
	}

	/** 加载会话的所有轮次（分代格式 = 最新分代；旧格式 = turns.json） */
	async getTurns(sessionId: string): Promise<TurnRecord[]> {
		if (await this.hasGenerationFormat(sessionId)) {
			const latest = await this.loadLatestGeneration(sessionId);
			return latest?.turns ?? [];
		}
		return this.loadTurns(sessionId);
	}

	/**
	 * 原地更新最后一条 turn。
	 * 用于 agent loop 中每次工具执行后的增量落盘。
	 * 如果 turns 为空则返回 null。
	 */
	async updateLastTurn(
		sessionId: string,
		patch: {
			assistant?: Partial<Message & { id: string }>;
			toolCalls?: import('../tools/types.js').ToolCallRecord[];
			messages?: Message[];
			usage?: TokenUsage;
			roundUsages?: import('../types/chat.js').RoundUsage[];
			interrupted?: boolean;
			lastBrowserUrl?: string;
		},
	): Promise<TurnRecord | null> {
		// 分代格式 → 最新分代文件；旧格式 → turns.json
		let turns: TurnRecord[];
		let gen = -1;
		if (await this.hasGenerationFormat(sessionId)) {
			gen = await this.getCurrentGen(sessionId);
			if (gen < 0) gen = 0;
			turns = await this.loadGeneration(sessionId, gen);
		} else {
			turns = await this.loadTurns(sessionId);
		}
		if (turns.length === 0) return null;

		const last = turns[turns.length - 1] as unknown as Record<string, unknown>;

		if (patch.assistant && last.assistant) Object.assign(last.assistant as object, patch.assistant);
		if (patch.toolCalls !== undefined) last.tool_calls = patch.toolCalls;
		if (patch.messages !== undefined) last.messages = patch.messages;
		if (patch.usage !== undefined) last.usage = patch.usage;
		if (patch.roundUsages !== undefined) last.round_usage = patch.roundUsages;
		if (patch.interrupted !== undefined) {
			if (patch.interrupted) last.interrupted = true;
			else delete last.interrupted;
		}
		if (patch.lastBrowserUrl !== undefined) {
			await this.updateMeta(sessionId, { lastBrowserUrl: patch.lastBrowserUrl });
		}

		if (gen >= 0) {
			await this.writeJSON(this.generationPath(sessionId, gen), turns);
		} else {
			await this.writeJSON(this.turnsPath(sessionId), turns);
		}
		return turns[turns.length - 1] as TurnRecord;
	}

	// ─── Generations（compact 分代存储）────────────────

	/** 获取当前分代 id（分代格式；旧格式返回 -1） */
	async getCurrentGen(sessionId: string): Promise<number> {
		const meta = await this.readJSON<SessionMeta>(this.metaPath(sessionId));
		return meta?.currentGen ?? -1;
	}

	/** 列出所有分代 id（升序）。非分代格式返回空数组 */
	async listGenerations(sessionId: string): Promise<number[]> {
		try {
			const entries = await readdir(this.sessionDir(sessionId));
			const gens = entries
				.filter((f) => /^turn_\d+\.json$/.test(f))
				.map((f) => parseInt(f.slice('turn_'.length, -'.json'.length), 10))
				.filter((n) => Number.isFinite(n))
				.sort((a, b) => a - b);
			return gens;
		} catch {
			return [];
		}
	}

	/** 加载指定分代的轮次（不存在返回空数组） */
	async loadGeneration(sessionId: string, gen: number): Promise<TurnRecord[]> {
		return (await this.readJSON<TurnRecord[]>(this.generationPath(sessionId, gen))) ?? [];
	}

	/** 加载最新分代的轮次（非分代格式返回 null） */
	async loadLatestGeneration(sessionId: string): Promise<{ gen: number; turns: TurnRecord[] } | null> {
		const gens = await this.listGenerations(sessionId);
		if (gens.length === 0) return null;
		const gen = gens[gens.length - 1];
		return { gen, turns: await this.loadGeneration(sessionId, gen) };
	}

	/**
	 * 开启新分代（compact 时调用）：genId+1，写入摘要轮，返回新 gen id。
	 * 旧 turns.json 会话首次调用时：将现有轮次迁移为 gen 0（保留原 turns.json 不动）。
	 */
	async newGeneration(sessionId: string, summaryTurn: TurnRecord): Promise<number> {
		let current = await this.getCurrentGen(sessionId);
		if (current < 0) {
			// 旧格式会话首次 compact：迁移现有 turns 为 gen 0
			const existing = await this.loadTurns(sessionId);
			await this.writeJSON(this.generationPath(sessionId, 0), existing);
			current = 0;
		}
		const next = current + 1;
		await this.writeJSON(this.generationPath(sessionId, next), [summaryTurn]);
		await this.updateMeta(sessionId, { currentGen: next });
		return next;
	}

	/** 内部：从 turns.json 加载轮次（兼容旧的 turn-NNN.json 格式） */
	private async loadTurns(sessionId: string): Promise<TurnRecord[]> {
		// 优先读取 turns.json（新格式）
		const turns = await this.readJSON<TurnRecord[]>(this.turnsPath(sessionId));
		if (turns) return turns;

		// 兼容旧格式：扫描 turn-NNN.json 文件
		try {
			const entries = await readdir(this.sessionDir(sessionId));
			const turnFiles = entries
				.filter((f) => f.startsWith('turn-') && f.endsWith('.json'))
				.sort();

			const legacyTurns: TurnRecord[] = [];
			for (const file of turnFiles) {
				const turn = await this.readJSON<TurnRecord>(
					join(this.sessionDir(sessionId), file),
				);
				if (turn) legacyTurns.push(turn);
			}
			return legacyTurns;
		} catch (err: any) {
			if (err?.code === 'ENOENT') return [];
			throw err;
		}
	}

	/** 获取会话累计费用 */
	async getTotalCost(sessionId: string): Promise<number> {
		const meta = await this.readJSON<SessionMeta>(this.metaPath(sessionId));
		return meta?.totalCost ?? 0;
	}

	// ─── Subagents ──────────────────────────────────

	/** 子代理记录目录 */
	private subagentDir(sessionId: string): string {
		return join(this.sessionDir(sessionId), 'subagents');
	}

	/** 子代理索引文件路径 */
	private subagentIndexPath(sessionId: string): string {
		return join(this.subagentDir(sessionId), '_index.json');
	}

	/** 单个子代理记录文件路径 */
	private subagentRecordPath(sessionId: string, name: string): string {
		return join(this.subagentDir(sessionId), `${name}.json`);
	}

	/** 保存子代理执行记录 */
	async saveSubagentRecord(sessionId: string, record: SubagentRecord): Promise<void> {
		const dir = this.subagentDir(sessionId);
		try { await access(dir); } catch { await mkdir(dir, { mode: 0o700 }); }

		await this.writeJSON(this.subagentRecordPath(sessionId, record.name), record);

		// 更新索引
		const indexPath = this.subagentIndexPath(sessionId);
		let index: string[] = [];
		try {
			const raw = await readFile(indexPath, 'utf-8');
			index = JSON.parse(raw) as string[];
		} catch { /* 首次创建 */ }

		if (!index.includes(record.name)) {
			index.push(record.name);
			await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n', { mode: 0o600 });
		}
	}

	/** 加载指定子代理记录 */
	async loadSubagentRecord(sessionId: string, name: string): Promise<SubagentRecord | null> {
		return this.readJSON<SubagentRecord>(this.subagentRecordPath(sessionId, name));
	}

	/** 列出会话的所有子代理名 */
	async listSubagentRecords(sessionId: string): Promise<string[]> {
		try {
			const raw = await readFile(this.subagentIndexPath(sessionId), 'utf-8');
			return JSON.parse(raw) as string[];
		} catch {
			return [];
		}
	}
}