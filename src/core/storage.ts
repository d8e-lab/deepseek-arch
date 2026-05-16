/**
 * Storage — 文件系统持久层（Repository 模式）
 *
 * 目录结构：
 *   <sessionsDir>/
 *   └── <session-id>/
 *       ├── meta.json        # 会话元数据
 *       ├── turn-001.json    # 第 1 轮对话
 *       ├── turn-002.json    # 第 2 轮对话
 *       └── ...
 *
 * 每轮对话一个 JSON 文件，独立管理，避免长上下文下数据库膨胀。
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
} from './types.js';

// ─── 文件模板 ────────────────────────────────────────

/** turn 文件填充位数 */
const TURN_PAD = 3;

function turnFileName(turn: number): string {
  return `turn-${String(turn).padStart(TURN_PAD, '0')}.json`;
}

function metaFileName(): string {
  return 'meta.json';
}

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
  private sessionDir(id: string): string {
    return join(this.sessionsDir, id);
  }

  /** 获取 meta 文件路径 */
  private metaPath(id: string): string {
    return join(this.sessionDir(id), metaFileName());
  }

  /** 获取 turn 文件路径 */
  private turnPath(id: string, turn: number): string {
    return join(this.sessionDir(id), turnFileName(turn));
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
    };

    const dir = this.sessionDir(id);
    await mkdir(dir, { mode: 0o700 });
    await this.writeJSON(this.metaPath(id), meta);

    return meta;
  }

  /** 按 ID 获取完整会话 */
  async getSession(id: string): Promise<Session | null> {
    const meta = await this.readJSON<SessionMeta>(this.metaPath(id));
    if (!meta) return null;

    const turns = await this.loadTurns(id);

    // 同步元数据中的计数字段
    if (meta.turnCount !== turns.length) {
      meta.turnCount = turns.length;
      meta.totalCost = turns.reduce((sum, t) => sum + t.cost_rmb, 0);
    }

    return { meta, turns };
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
    assistantMessage: Message & { id: string },
    usage: TokenUsage,
    costRmb: number,
  ): Promise<TurnRecord> {
    // 确保会话目录存在
    try {
      await access(this.sessionDir(sessionId));
    } catch {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    // 读取现有轮次确定序号
    const existingTurns = await this.loadTurns(sessionId);
    const turnNumber = existingTurns.length + 1;

    const turn: TurnRecord = {
      turn: turnNumber,
      user: userMessage,
      assistant: {
        id: assistantMessage.id,
        role: 'assistant',
        content: assistantMessage.content,
        reasoning_content: assistantMessage.reasoning_content,
      },
      usage,
      cost_rmb: costRmb,
      created_at: new Date().toISOString(),
    };

    await this.writeJSON(this.turnPath(sessionId, turnNumber), turn);

    // 更新元数据
    const totalCost = existingTurns.reduce((sum, t) => sum + t.cost_rmb, 0) + costRmb;
    await this.updateMeta(sessionId, {
      turnCount: turnNumber,
      totalCost,
    });

    return turn;
  }

  /** 加载会话的所有轮次 */
  async getTurns(sessionId: string): Promise<TurnRecord[]> {
    return this.loadTurns(sessionId);
  }

  /** 内部：从文件加载轮次 */
  private async loadTurns(sessionId: string): Promise<TurnRecord[]> {
    try {
      const entries = await readdir(this.sessionDir(sessionId));
      const turnFiles = entries
        .filter((f) => f.startsWith('turn-') && f.endsWith('.json'))
        .sort(); // 文件名字母序即轮次顺序

      const turns: TurnRecord[] = [];
      for (const file of turnFiles) {
        const turn = await this.readJSON<TurnRecord>(
          join(this.sessionDir(sessionId), file),
        );
        if (turn) turns.push(turn);
      }
      return turns;
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
}
