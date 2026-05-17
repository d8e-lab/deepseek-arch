/**
 * SessionManager 单元测试
 *
 * 使用真实 Storage (临时目录) + mock ApiClient。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from './storage.js';
import { ApiClient } from './api.js';
import { SessionManager } from './session.js';
import type { Message, ChatCompletionResponse } from './types.js';

/** 构建标准成功响应 */
function makeResponse(
  overrides?: Partial<ChatCompletionResponse>,
): ChatCompletionResponse {
  return {
    id: 'chatcmpl-test-001',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-v4-pro',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '你好！',
          reasoning_content: '用户说你好，我应回应问候。',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      prompt_cache_hit_tokens: 15,
      prompt_cache_miss_tokens: 5,
    },
    ...overrides,
  };
}

/** 创建 mock ApiClient */
function mockClient(
  response?: ChatCompletionResponse,
): ApiClient {
  const mockChat = vi.fn().mockResolvedValue(response ?? makeResponse());
  return { chat: mockChat } as unknown as ApiClient;
}

describe('SessionManager', () => {
  let testDir: string;
  let storage: Storage;
  let client: ApiClient;
  let manager: SessionManager;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'deepseek-session-test-'));
    storage = new Storage(testDir);
    client = mockClient();
    manager = new SessionManager(storage, client);
    manager.setSystemPrompt({ role: 'system', content: '你是一个有用的助手。' });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('startNewSession', () => {
    it('创建新会话并返回 SessionMeta', async () => {
      const meta = await manager.startNewSession('测试会话');
      expect(meta.title).toBe('测试会话');
      expect(meta.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(meta.turnCount).toBe(0);

      const session = manager.getSession();
      expect(session).not.toBeNull();
      expect(session!.meta.id).toBe(meta.id);
      expect(session!.turns).toHaveLength(0);
    });

    it('默认标题为空', async () => {
      const meta = await manager.startNewSession();
      expect(meta.title).toBe('');
    });

    it('getSessionId 返回正确 ID', async () => {
      await manager.startNewSession();
      expect(manager.getSessionId()).toMatch(/^[a-f0-9-]{36}$/);
    });

    it('未创建会话时 getSessionId 返回 null', () => {
      expect(manager.getSessionId()).toBeNull();
    });
  });

  describe('resumeSession', () => {
    it('恢复已有会话', async () => {
      const meta = await manager.startNewSession('恢复测试');
      const id = meta.id;

      // 在新的 SessionManager 中恢复
      const manager2 = new SessionManager(storage, client);
      const session = await manager2.resumeSession(id);
      expect(session.meta.title).toBe('恢复测试');
    });

    it('恢复不存在的 ID 抛出错误', async () => {
      await expect(manager.resumeSession('nonexistent')).rejects.toThrow('会话不存在');
    });
  });

  describe('sendMessage', () => {
    it('发送消息并返回 turn + response', async () => {
      await manager.startNewSession('消息测试');

      const { turn, response } = await manager.sendMessage('你好');
      expect(turn.turn).toBe(1);
      expect(turn.user.content).toBe('你好');
      expect(turn.assistant.content).toBe('你好！');
      expect(turn.assistant.reasoning_content).toBe('用户说你好，我应回应问候。');
      expect(turn.assistant.id).toBe('chatcmpl-test-001');
      expect(turn.usage.total_tokens).toBe(30);
      expect(turn.cost_rmb).toBe(0); // Phase 7 前为 0
      expect(response.choices[0].message?.content).toBe('你好！');
    });

    it('发送多轮消息后 turn 序号递增', async () => {
      await manager.startNewSession();

      const t1 = await manager.sendMessage('Q1');
      expect(t1.turn.turn).toBe(1);

      const t2 = await manager.sendMessage('Q2');
      expect(t2.turn.turn).toBe(2);

      const t3 = await manager.sendMessage('Q3');
      expect(t3.turn.turn).toBe(3);
    });

    it('turn 持久化到文件系统（可通过 Storage 读取）', async () => {
      await manager.startNewSession('持久化测试');
      const id = manager.getSessionId()!;

      await manager.sendMessage('持久化消息');

      const session = await storage.getSession(id);
      expect(session).not.toBeNull();
      expect(session!.turns).toHaveLength(1);
      expect(session!.turns[0].user.content).toBe('持久化消息');
      expect(session!.meta.turnCount).toBe(1);
    });

    it('API 调用包含 system prompt 和历史 reasoning_content', async () => {
      await manager.startNewSession();
      await manager.sendMessage('Q1');

      // 第二轮的 API 调用应包含 system prompt + Q1/A1 + Q2
      await manager.sendMessage('Q2');

      const mockChat = (client as any).chat as ReturnType<typeof vi.fn>;
      expect(mockChat).toHaveBeenCalledTimes(2);

      const messages: Message[] = mockChat.mock.calls[1][0];
      expect(messages[0]).toEqual({ role: 'system', content: '你是一个有用的助手。' });
      expect(messages[1]).toEqual({ role: 'user', content: 'Q1' });
      expect(messages[2].role).toBe('assistant');
      expect(messages[2].reasoning_content).toBeTruthy(); // 含 reasoning_content 以命中 kv-cache
      expect(messages[3]).toEqual({ role: 'user', content: 'Q2' });
    });

    it('未创建会话时抛出错误', async () => {
      await expect(manager.sendMessage('test')).rejects.toThrow('未创建会话');
    });

    it('API 返回空 choices 抛出错误', async () => {
      const emptyClient = mockClient(makeResponse({ choices: [] }));
      const mgr = new SessionManager(storage, emptyClient);
      await mgr.startNewSession();
      await expect(mgr.sendMessage('test')).rejects.toThrow('模型返回空响应');
    });

    it('API 不返回 usage 时使用默认值', async () => {
      const noUsageClient = mockClient(
        makeResponse({ usage: undefined as any }),
      );
      const mgr = new SessionManager(storage, noUsageClient);
      await mgr.startNewSession();
      const { turn } = await mgr.sendMessage('test');
      expect(turn.usage.prompt_tokens).toBe(0);
      expect(turn.usage.completion_tokens).toBe(0);
    });
  });

  describe('setTitle', () => {
    it('更新会话标题并持久化', async () => {
      await manager.startNewSession('旧标题');
      await manager.setTitle('新标题');

      const session = manager.getSession();
      expect(session!.meta.title).toBe('新标题');

      // 验证持久化
      const loaded = await storage.getSession(session!.meta.id);
      expect(loaded!.meta.title).toBe('新标题');
    });
  });

  describe('setSystemPrompt', () => {
    it('设置为 null 时不发送 system prompt', async () => {
      manager.setSystemPrompt(null);
      await manager.startNewSession();
      await manager.sendMessage('test');

      const mockChat = (client as any).chat as ReturnType<typeof vi.fn>;
      const messages: Message[] = mockChat.mock.calls[0][0];
      expect(messages[0].role).not.toBe('system');
    });
  });
});
