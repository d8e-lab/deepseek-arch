/**
 * Storage 单元测试（文件系统）
 *
 * 使用临时目录隔离测试，无外部依赖。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from './storage.js';
import type { Message, TokenUsage } from './types.js';

/** 创建已初始化的 Storage（临时目录） */
async function createStore(): Promise<Storage> {
  const dir = await mkdtemp(join(tmpdir(), 'deepseek-storage-test-'));
  return new Storage(dir);
}

/** 创建一条 session */
async function setupSession(store: Storage, title = '测试会话') {
  const meta = await store.createSession(title);
  return { sessionId: meta.id, meta };
}

/** 保存一轮对话的快捷方法 */
async function saveTurn(
  store: Storage,
  sessionId: string,
  userContent: string,
  assistantContent: string,
  reasoning?: string,
  usageOverrides?: Partial<TokenUsage>,
) {
  const userMsg: Message = { role: 'user', content: userContent };
  const assistantMsg: Message & { id: string } = {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    role: 'assistant',
    content: assistantContent,
    reasoning_content: reasoning,
  };
  const usage: TokenUsage = {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 20,
    ...usageOverrides,
  };
  return store.saveTurn(sessionId, userMsg, assistantMsg, usage, 0.0015);
}

describe('Storage (文件系统)', () => {
  let store: Storage;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'deepseek-storage-test-'));
    store = new Storage(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Sessions CRUD', () => {
    it('createSession() 创建会话目录和 meta.json', async () => {
      const meta = await store.createSession('我的对话');
      expect(meta.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(meta.title).toBe('我的对话');
      expect(meta.turnCount).toBe(0);
      expect(meta.totalCost).toBe(0);
      expect(meta.created_at).toBeTruthy();
    });

    it('createSession() 默认标题为空', async () => {
      const meta = await store.createSession();
      expect(meta.title).toBe('');
    });

    it('getSession() 返回完整会话', async () => {
      const { sessionId } = await setupSession(store, '完整会话');
      await saveTurn(store, sessionId, '你好', '你好！');

      const session = await store.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.meta.title).toBe('完整会话');
      expect(session!.turns).toHaveLength(1);
      expect(session!.turns[0].user.content).toBe('你好');
      expect(session!.turns[0].assistant.content).toBe('你好！');
      expect(session!.meta.turnCount).toBe(1);
    });

    it('getSession() 不存在的 ID 返回 null', async () => {
      expect(await store.getSession('nonexistent')).toBeNull();
    });

    it('getSessionByName() 精确匹配标题', async () => {
      await setupSession(store, 'Python 优化');
      await setupSession(store, 'Rust 内存');

      const session = await store.getSessionByName('Rust 内存');
      expect(session).not.toBeNull();
      expect(session!.meta.title).toBe('Rust 内存');
    });

    it('getSessionByName() 无匹配返回 null', async () => {
      expect(await store.getSessionByName('不存在')).toBeNull();
    });

    it('listSessions() 按更新时间降序', async () => {
      const s1 = await setupSession(store, '会话 A');
      const s2 = await setupSession(store, '会话 B');

      // 在 A 中保存一轮以更新 updated_at
      await saveTurn(store, s1.sessionId, 'hi', 'hello');

      const list = await store.listSessions();
      expect(list).toHaveLength(2);
      expect(list[0].title).toBe('会话 A');
      expect(list[0].turnCount).toBe(1);
      expect(list[0].index).toBe(1);
      expect(list[1].title).toBe('会话 B');
      expect(list[1].index).toBe(2);
    });

    it('updateSessionTitle() 更新标题', async () => {
      const { sessionId } = await setupSession(store, '旧标题');
      const ok = await store.updateSessionTitle(sessionId, '新标题');
      expect(ok).toBe(true);

      const session = await store.getSession(sessionId);
      expect(session!.meta.title).toBe('新标题');
    });

    it('updateSessionTitle() 不存在返回 false', async () => {
      expect(await store.updateSessionTitle('bad-id', 'x')).toBe(false);
    });

    it('deleteSession() 删除目录', async () => {
      const { sessionId } = await setupSession(store, '待删除');
      const ok = await store.deleteSession(sessionId);
      expect(ok).toBe(true);
      expect(await store.getSession(sessionId)).toBeNull();
    });

    it('deleteSession() 不存在返回 false', async () => {
      expect(await store.deleteSession('bad-id')).toBe(false);
    });
  });

  describe('Turns CRUD', () => {
    it('saveTurn() 保存轮次并返回记录', async () => {
      const { sessionId } = await setupSession(store);
      const turn = await saveTurn(store, sessionId, '你好', '你好！', '思考中...');

      expect(turn.turn).toBe(1);
      expect(turn.user.content).toBe('你好');
      expect(turn.assistant.content).toBe('你好！');
      expect(turn.assistant.reasoning_content).toBe('思考中...');
      expect(turn.usage.prompt_cache_hit_tokens).toBe(80);
      expect(turn.cost_rmb).toBe(0.0015);
      expect(turn.assistant.id).toMatch(/^chatcmpl-/);
    });

    it('saveTurn() 多轮序号递增', async () => {
      const { sessionId } = await setupSession(store);

      const t1 = await saveTurn(store, sessionId, 'Q1', 'A1');
      expect(t1.turn).toBe(1);

      const t2 = await saveTurn(store, sessionId, 'Q2', 'A2');
      expect(t2.turn).toBe(2);

      const t3 = await saveTurn(store, sessionId, 'Q3', 'A3');
      expect(t3.turn).toBe(3);
    });

    it('saveTurn() 更新 meta 的 turnCount 和 totalCost', async () => {
      const { sessionId } = await setupSession(store);

      await saveTurn(store, sessionId, 'Q1', 'A1');
      await saveTurn(store, sessionId, 'Q2', 'A2');

      const session = await store.getSession(sessionId);
      expect(session!.meta.turnCount).toBe(2);
      expect(session!.meta.totalCost).toBeCloseTo(0.003, 4);
    });

    it('getTurns() 返回所有轮次', async () => {
      const { sessionId } = await setupSession(store);

      await saveTurn(store, sessionId, 'Q1', 'A1');
      await saveTurn(store, sessionId, 'Q2', 'A2');

      const turns = await store.getTurns(sessionId);
      expect(turns).toHaveLength(2);
      expect(turns[0].user.content).toBe('Q1');
      expect(turns[1].user.content).toBe('Q2');
    });

    it('getTurns() 空会话返回空数组', async () => {
      const { sessionId } = await setupSession(store);
      expect(await store.getTurns(sessionId)).toHaveLength(0);
    });

    it('saveTurn() 保存 reasoning_content 为空时正常', async () => {
      const { sessionId } = await setupSession(store);
      const turn = await saveTurn(store, sessionId, 'hi', 'hello', undefined);
      expect(turn.assistant.reasoning_content).toBeUndefined();
    });
  });

  describe('费用统计', () => {
    it('getTotalCost() 返回累计费用', async () => {
      const { sessionId } = await setupSession(store);

      await saveTurn(store, sessionId, 'Q1', 'A1');
      await saveTurn(store, sessionId, 'Q2', 'A2');

      const cost = await store.getTotalCost(sessionId);
      expect(cost).toBeCloseTo(0.003, 4);
    });

    it('getTotalCost() 空会话返回 0', async () => {
      const { sessionId } = await setupSession(store);
      expect(await store.getTotalCost(sessionId)).toBe(0);
    });
  });

  describe('边界情况', () => {
    it('大量轮次读写正常', async () => {
      const { sessionId } = await setupSession(store, '大量轮次');

      for (let i = 0; i < 50; i++) {
        await saveTurn(store, sessionId, `消息 ${i}`, `回复 ${i}`);
      }

      const turns = await store.getTurns(sessionId);
      expect(turns).toHaveLength(50);
      expect(turns[49].turn).toBe(50);
    });

    it('超长 content 正常存储', async () => {
      const { sessionId } = await setupSession(store);
      const longContent = 'A'.repeat(50000);

      const turn = await saveTurn(store, sessionId, longContent, longContent);
      expect(turn.user.content).toBe(longContent);
      expect(turn.assistant.content).toBe(longContent);
    });

    it('特殊字符正常存储', async () => {
      const { sessionId } = await setupSession(store);
      const special = '你好\n世界 🚀\n换行 "引号" \'单引号\' \\反斜杠';

      const turn = await saveTurn(store, sessionId, special, special);
      expect(turn.user.content).toBe(special);
    });

    it('会话隔离', async () => {
      const s1 = await setupSession(store, '会话1');
      const s2 = await setupSession(store, '会话2');

      await saveTurn(store, s1.sessionId, 'S1-Q', 'S1-A');
      await saveTurn(store, s2.sessionId, 'S2-Q', 'S2-A');

      expect(await store.getTurns(s1.sessionId)).toHaveLength(1);
      expect(await store.getTurns(s2.sessionId)).toHaveLength(1);
    });
  });
});
