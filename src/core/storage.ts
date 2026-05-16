/**
 * Storage — SQLite 持久层（Repository 模式）
 *
 * 职责：
 *   1. 管理 SQLite 数据库连接（WAL 模式、外键约束）
 *   2. sessions 表 CRUD
 *   3. messages 表 CRUD（含 reasoning_content）
 *   4. token_usage 表 CRUD
 *
 * 用法：
 *   const store = new Storage(dbPath);
 *   store.initialize();
 *   const session = store.createSession('我的对话');
 *   store.close();
 */

import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import type {
  SessionMeta,
  Session,
  SessionListItem,
  Message,
  MessageRecord,
  TokenUsage,
  TokenUsageRecord,
} from './types.js';

// ─── Schema ──────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
  content           TEXT NOT NULL,
  reasoning_content TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS token_usage (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id              INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  prompt_tokens           INTEGER NOT NULL DEFAULT 0,
  completion_tokens       INTEGER NOT NULL DEFAULT 0,
  total_tokens            INTEGER NOT NULL DEFAULT 0,
  prompt_cache_hit_tokens INTEGER DEFAULT 0,
  prompt_cache_miss_tokens INTEGER DEFAULT 0,
  cost_rmb                REAL NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_message ON token_usage(message_id);
`;

// ─── Storage 类 ──────────────────────────────────────

export class Storage {
  private db: Database.Database;
  private initialized = false;

  // Prepared statements — sessions
  private stmtInsertSession!: Statement<[string, string]>;
  private stmtGetSessionMeta!: Statement<[string]>;
  private stmtListSessions!: Statement;
  private stmtUpdateSessionTitle!: Statement<[string, string]>;
  private stmtDeleteSession!: Statement<[string]>;

  // Prepared statements — messages
  private stmtInsertMessage!: Statement<[string, string, string, string | null]>;
  private stmtGetMessages!: Statement<[string]>;
  private stmtGetLastMessageId!: Statement<[string]>;

  // Prepared statements — token_usage
  private stmtInsertTokenUsage!: Statement<[number, number, number, number, number, number, number]>;
  private stmtGetTokenUsagesBySession!: Statement<[string]>;
  private stmtGetTotalCost!: Statement<[string]>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  /** 初始化数据库：建表 + 准备语句 */
  initialize(): void {
    if (this.initialized) return;

    this.db.exec(SCHEMA);
    this.prepareStatements();
    this.initialized = true;
  }

  /** 编译 prepared statements */
  private prepareStatements(): void {
    // sessions
    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO sessions (id, title) VALUES (?, ?)
    `);
    this.stmtGetSessionMeta = this.db.prepare(`
      SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?
    `);
    this.stmtListSessions = this.db.prepare(`
      SELECT s.id, s.title, s.updated_at,
             (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS message_count
      FROM sessions s
      ORDER BY s.updated_at DESC
    `);
    this.stmtUpdateSessionTitle = this.db.prepare(`
      UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?
    `);
    this.stmtDeleteSession = this.db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `);

    // messages
    this.stmtInsertMessage = this.db.prepare(`
      INSERT INTO messages (session_id, role, content, reasoning_content)
      VALUES (?, ?, ?, ?)
    `);
    this.stmtGetMessages = this.db.prepare(`
      SELECT id, session_id, role, content, reasoning_content, created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY id ASC
    `);
    this.stmtGetLastMessageId = this.db.prepare(`
      SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1
    `);

    // token_usage
    this.stmtInsertTokenUsage = this.db.prepare(`
      INSERT INTO token_usage
        (message_id, prompt_tokens, completion_tokens, total_tokens,
         prompt_cache_hit_tokens, prompt_cache_miss_tokens, cost_rmb)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGetTokenUsagesBySession = this.db.prepare(`
      SELECT tu.* FROM token_usage tu
      JOIN messages m ON tu.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY tu.id ASC
    `);
    this.stmtGetTotalCost = this.db.prepare(`
      SELECT COALESCE(SUM(tu.cost_rmb), 0) AS total
      FROM token_usage tu
      JOIN messages m ON tu.message_id = m.id
      WHERE m.session_id = ?
    `);
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }

  // ─── Sessions ───────────────────────────────────

  /** 创建新会话，返回元数据 */
  createSession(title = ''): SessionMeta {
    const id = uuidv4();
    this.stmtInsertSession.run(id, title);

    return this.stmtGetSessionMeta.get(id) as SessionMeta;
  }

  /** 按 ID 获取完整会话（含消息 + token 记录） */
  getSession(id: string): Session | null {
    const meta = this.stmtGetSessionMeta.get(id) as SessionMeta | undefined;
    if (!meta) return null;

    const messages = this.stmtGetMessages.all(id) as MessageRecord[];
    const tokenUsages = this.stmtGetTokenUsagesBySession.all(id) as TokenUsageRecord[];

    return { meta, messages, tokenUsages };
  }

  /** 按标题精确匹配会话 */
  getSessionByName(name: string): Session | null {
    const row = this.db
      .prepare('SELECT id FROM sessions WHERE title = ?')
      .get(name) as { id: string } | undefined;
    if (!row) return null;
    return this.getSession(row.id);
  }

  /** 列出所有会话（用于 resume 列表） */
  listSessions(): SessionListItem[] {
    const rows = this.stmtListSessions.all() as Array<{
      id: string;
      title: string;
      updated_at: string;
      message_count: number;
    }>;
    return rows.map((row, i) => ({
      index: i + 1,
      id: row.id,
      title: row.title,
      updated_at: row.updated_at,
      messageCount: row.message_count,
    }));
  }

  /** 更新会话标题 */
  updateSessionTitle(id: string, title: string): boolean {
    const result = this.stmtUpdateSessionTitle.run(title, id);
    return result.changes > 0;
  }

  /** 删除会话（级联删除 messages + token_usage） */
  deleteSession(id: string): boolean {
    const result = this.stmtDeleteSession.run(id);
    return result.changes > 0;
  }

  // ─── Messages ───────────────────────────────────

  /** 保存一条消息，返回含数据库元数据的记录 */
  saveMessage(sessionId: string, message: Message): MessageRecord {
    // 更新会话的 updated_at
    this.db
      .prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`)
      .run(sessionId);

    const result = this.stmtInsertMessage.run(
      sessionId,
      message.role,
      message.content,
      message.reasoning_content ?? null,
    );

    return {
      id: Number(result.lastInsertRowid),
      session_id: sessionId,
      role: message.role,
      content: message.content,
      reasoning_content: message.reasoning_content,
      created_at: new Date().toISOString(),
    };
  }

  /** 获取会话的所有消息（按时间排序） */
  getMessages(sessionId: string): MessageRecord[] {
    return this.stmtGetMessages.all(sessionId) as MessageRecord[];
  }

  /** 获取会话最后一条 assistant 消息的 ID（用于关联 token_usage） */
  getLastAssistantMessageId(sessionId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as { id: number } | undefined;
    return row?.id ?? null;
  }

  // ─── Token Usage ────────────────────────────────

  /** 记录 token 用量 */
  saveTokenUsage(messageId: number, usage: TokenUsage, costRmb: number): TokenUsageRecord {
    const result = this.stmtInsertTokenUsage.run(
      messageId,
      usage.prompt_tokens,
      usage.completion_tokens,
      usage.total_tokens,
      usage.prompt_cache_hit_tokens ?? 0,
      usage.prompt_cache_miss_tokens ?? 0,
      costRmb,
    );

    return {
      id: Number(result.lastInsertRowid),
      message_id: messageId,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens ?? 0,
      prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? 0,
      cost_rmb: costRmb,
      created_at: new Date().toISOString(),
    };
  }

  /** 获取会话的所有 token 记录 */
  getTokenUsagesBySession(sessionId: string): TokenUsageRecord[] {
    return this.stmtGetTokenUsagesBySession.all(sessionId) as TokenUsageRecord[];
  }

  /** 获取会话累计费用 */
  getTotalCost(sessionId: string): number {
    const row = this.stmtGetTotalCost.get(sessionId) as { total: number };
    return row.total;
  }
}
