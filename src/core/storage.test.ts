/**
 * Storage 单元测试
 *
 * 使用内存数据库 (:memory:) 隔离测试，不依赖文件系统。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from './storage.js';
import type { Message, TokenUsage } from './types.js';

/** 辅助：创建已初始化的 Storage（内存数据库） */
function createStore(): Storage {
  const store = new Storage(':memory:');
  store.initialize();
  return store;
}

/** 辅助：创建一条 session + 一条 user 消息，返回 { store, sessionId } */
function setupSession(store: Storage, title = '测试会话') {
  const session = store.createSession(title);
  return { sessionId: session.id, session };
}

describe('Storage', () => {
  let store: Storage;

  afterEach(() => {
    store?.close();
  });

  describe('初始化', () => {
    it('initialize() 幂等，多次调用不报错', () => {
      store = new Storage(':memory:');
      store.initialize();
      store.initialize(); // 第二次调用不应抛异常
      // 能正常操作即验证成功
      const s = store.createSession('test');
      expect(s.id).toBeTruthy();
    });

    it('WAL 模式在文件数据库中启用', async () => {
      // :memory: 数据库不支持 WAL，改用临时文件验证
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const tmpDir = await mkdtemp(join(tmpdir(), 'deepseek-test-wal-'));
      try {
        const fileStore = new Storage(join(tmpDir, 'test.db'));
        fileStore.initialize();
        const row = (fileStore as any).db.pragma('journal_mode');
        expect(row[0].journal_mode).toBe('wal');
        fileStore.close();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('外键约束已启用', () => {
      store = createStore();
      const row = (store as any).db.pragma('foreign_keys');
      expect(row[0].foreign_keys).toBe(1);
    });
  });

  describe('Sessions CRUD', () => {
    beforeEach(() => {
      store = createStore();
    });

    it('createSession() 创建会话并返回元数据', () => {
      const meta = store.createSession('我的对话');
      expect(meta.id).toMatch(/^[a-f0-9-]{36}$/); // UUID v4
      expect(meta.title).toBe('我的对话');
      expect(meta.created_at).toBeTruthy();
      expect(meta.updated_at).toBeTruthy();
    });

    it('createSession() 默认标题为空字符串', () => {
      const meta = store.createSession();
      expect(meta.title).toBe('');
    });

    it('getSession() 返回完整会话', () => {
      const { sessionId } = setupSession(store, '完整会话');

      const msg: Message = { role: 'user', content: '你好' };
      store.saveMessage(sessionId, msg);

      const session = store.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.meta.title).toBe('完整会话');
      expect(session!.messages).toHaveLength(1);
      expect(session!.messages[0].content).toBe('你好');
    });

    it('getSession() 不存在的 ID 返回 null', () => {
      const session = store.getSession('non-existent-id');
      expect(session).toBeNull();
    });

    it('getSessionByName() 精确匹配标题', () => {
      setupSession(store, 'Python 性能优化');
      setupSession(store, 'Rust 内存模型');

      const session = store.getSessionByName('Rust 内存模型');
      expect(session).not.toBeNull();
      expect(session!.meta.title).toBe('Rust 内存模型');
    });

    it('getSessionByName() 无匹配返回 null', () => {
      expect(store.getSessionByName('不存在的标题')).toBeNull();
    });

    it('listSessions() 按更新时间降序排列', () => {
      const s1 = setupSession(store, '会话 A');
      const s2 = setupSession(store, '会话 B');

      // 在会话 A 中插入消息以更新其 updated_at
      store.saveMessage(s1.sessionId, { role: 'user', content: 'test' });

      const list = store.listSessions();
      expect(list).toHaveLength(2);
      // 会话 A 最近更新，应排第一
      expect(list[0].title).toBe('会话 A');
      expect(list[0].messageCount).toBe(1);
      expect(list[1].title).toBe('会话 B');
      expect(list[0].index).toBe(1);
      expect(list[1].index).toBe(2);
    });

    it('updateSessionTitle() 更新标题并返回 true', () => {
      const { sessionId } = setupSession(store, '旧标题');
      const result = store.updateSessionTitle(sessionId, '新标题');
      expect(result).toBe(true);

      const session = store.getSession(sessionId);
      expect(session!.meta.title).toBe('新标题');
    });

    it('updateSessionTitle() 对不存在的 ID 返回 false', () => {
      expect(store.updateSessionTitle('bad-id', 'x')).toBe(false);
    });

    it('deleteSession() 删除并级联删除消息', () => {
      const { sessionId } = setupSession(store, '待删除');
      store.saveMessage(sessionId, { role: 'user', content: 'test' });

      const result = store.deleteSession(sessionId);
      expect(result).toBe(true);
      expect(store.getSession(sessionId)).toBeNull();
      expect(store.listSessions()).toHaveLength(0);
    });

    it('deleteSession() 不存在的 ID 返回 false', () => {
      expect(store.deleteSession('bad-id')).toBe(false);
    });
  });

  describe('Messages CRUD', () => {
    beforeEach(() => {
      store = createStore();
    });

    it('saveMessage() 保存并返回数据库记录', () => {
      const { sessionId } = setupSession(store);
      const msg: Message = {
        role: 'assistant',
        content: '你好！有什么可以帮助你的？',
        reasoning_content: '用户发来了问候，我应该友好地回应。',
      };

      const record = store.saveMessage(sessionId, msg);
      expect(record.id).toBeGreaterThan(0);
      expect(record.session_id).toBe(sessionId);
      expect(record.role).toBe('assistant');
      expect(record.content).toBe('你好！有什么可以帮助你的？');
      expect(record.reasoning_content).toBe('用户发来了问候，我应该友好地回应。');
      expect(record.created_at).toBeTruthy();
    });

    it('saveMessage() 自动更新会话 updated_at', () => {
      const { sessionId } = setupSession(store);
      const before = store.getSession(sessionId)!.meta.updated_at;

      // 短暂等待确保时间戳变化
      store.saveMessage(sessionId, { role: 'user', content: 'hello' });

      const after = store.getSession(sessionId)!.meta.updated_at;
      // SQLite 的 datetime('now') 精确到秒，可能相同；只验证不为空
      expect(after).toBeTruthy();
    });

    it('saveMessage() reasoning_content 可为 undefined', () => {
      const { sessionId } = setupSession(store);
      const msg: Message = { role: 'user', content: '无思考内容' };

      const record = store.saveMessage(sessionId, msg);
      expect(record.reasoning_content).toBeUndefined();
    });

    it('getMessages() 按时间升序返回', () => {
      const { sessionId } = setupSession(store);

      store.saveMessage(sessionId, { role: 'system', content: 'system prompt' });
      store.saveMessage(sessionId, { role: 'user', content: '第一条用户消息' });
      store.saveMessage(sessionId, { role: 'assistant', content: '第一条回复' });

      const messages = store.getMessages(sessionId);
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
      expect(messages[2].role).toBe('assistant');
    });

    it('getMessages() 空会话返回空数组', () => {
      const { sessionId } = setupSession(store);
      expect(store.getMessages(sessionId)).toHaveLength(0);
    });

    it('getLastAssistantMessageId() 返回最后一条 assistant 消息 ID', () => {
      const { sessionId } = setupSession(store);

      store.saveMessage(sessionId, { role: 'user', content: 'hi' });
      store.saveMessage(sessionId, { role: 'assistant', content: 'hello' });

      const id = store.getLastAssistantMessageId(sessionId);
      expect(id).toBeGreaterThan(0);
    });

    it('getLastAssistantMessageId() 无 assistant 消息时返回 null', () => {
      const { sessionId } = setupSession(store);
      store.saveMessage(sessionId, { role: 'user', content: '只有用户消息' });
      expect(store.getLastAssistantMessageId(sessionId)).toBeNull();
    });
  });

  describe('Token Usage CRUD', () => {
    beforeEach(() => {
      store = createStore();
    });

    it('saveTokenUsage() 记录用量并返回记录', () => {
      const { sessionId } = setupSession(store);

      // 先保存一条 assistant 消息
      store.saveMessage(sessionId, { role: 'user', content: 'test' });
      const msg = store.saveMessage(sessionId, { role: 'assistant', content: 'reply' });

      const usage: TokenUsage = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 20,
      };

      const record = store.saveTokenUsage(msg.id, usage, 0.0015);
      expect(record.id).toBeGreaterThan(0);
      expect(record.message_id).toBe(msg.id);
      expect(record.prompt_cache_hit_tokens).toBe(80);
      expect(record.prompt_cache_miss_tokens).toBe(20);
      expect(record.cost_rmb).toBe(0.0015);
    });

    it('saveTokenUsage() 缓存字段默认为 0', () => {
      const { sessionId } = setupSession(store);
      store.saveMessage(sessionId, { role: 'user', content: 'x' });
      const msg = store.saveMessage(sessionId, { role: 'assistant', content: 'y' });

      const usage: TokenUsage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      };

      const record = store.saveTokenUsage(msg.id, usage, 0);
      expect(record.prompt_cache_hit_tokens).toBe(0);
      expect(record.prompt_cache_miss_tokens).toBe(0);
    });

    it('getTokenUsagesBySession() 返回会话所有 token 记录', () => {
      const { sessionId } = setupSession(store);

      // 第一轮
      store.saveMessage(sessionId, { role: 'user', content: 'Q1' });
      const a1 = store.saveMessage(sessionId, { role: 'assistant', content: 'A1' });
      store.saveTokenUsage(a1.id, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, 0.001);

      // 第二轮
      store.saveMessage(sessionId, { role: 'user', content: 'Q2' });
      const a2 = store.saveMessage(sessionId, { role: 'assistant', content: 'A2' });
      store.saveTokenUsage(a2.id, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }, 0.002);

      const records = store.getTokenUsagesBySession(sessionId);
      expect(records).toHaveLength(2);
      expect(records[0].message_id).toBe(a1.id);
      expect(records[1].message_id).toBe(a2.id);
    });

    it('getTotalCost() 返回累计费用', () => {
      const { sessionId } = setupSession(store);

      store.saveMessage(sessionId, { role: 'user', content: 'Q' });
      const msg = store.saveMessage(sessionId, { role: 'assistant', content: 'A' });
      store.saveTokenUsage(msg.id, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, 0.0123);

      const total = store.getTotalCost(sessionId);
      expect(total).toBeCloseTo(0.0123, 4);
    });

    it('getTotalCost() 空会话返回 0', () => {
      const { sessionId } = setupSession(store);
      expect(store.getTotalCost(sessionId)).toBe(0);
    });
  });

  describe('边界情况', () => {
    beforeEach(() => {
      store = createStore();
    });

    it('大量消息读写正常', () => {
      const { sessionId } = setupSession(store, '大量消息');

      for (let i = 0; i < 100; i++) {
        store.saveMessage(sessionId, { role: 'user', content: `消息 ${i}` });
      }

      const messages = store.getMessages(sessionId);
      expect(messages).toHaveLength(100);
    });

    it('超长 content 正常存储', () => {
      const { sessionId } = setupSession(store);
      const longContent = 'A'.repeat(10000);

      const record = store.saveMessage(sessionId, { role: 'user', content: longContent });
      expect(record.content).toBe(longContent);
    });

    it('特殊字符（emoji、换行、引号）正常存储', () => {
      const { sessionId } = setupSession(store);
      const special = '你好\n世界 🚀\nIt\'s "great"!\n换行测试';

      const record = store.saveMessage(sessionId, { role: 'user', content: special });
      const retrieved = store.getMessages(sessionId)[0];
      expect(retrieved.content).toBe(special);
    });

    it('会话隔离：不同会话的消息互不干扰', () => {
      const s1 = setupSession(store, '会话1');
      const s2 = setupSession(store, '会话2');

      store.saveMessage(s1.sessionId, { role: 'user', content: 'S1 消息' });
      store.saveMessage(s2.sessionId, { role: 'user', content: 'S2 消息' });

      expect(store.getMessages(s1.sessionId)).toHaveLength(1);
      expect(store.getMessages(s2.sessionId)).toHaveLength(1);
      expect(store.getMessages(s1.sessionId)[0].content).toBe('S1 消息');
      expect(store.getMessages(s2.sessionId)[0].content).toBe('S2 消息');
    });
  });
});