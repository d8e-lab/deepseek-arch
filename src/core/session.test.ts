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
import { SessionManager, type StreamEvent } from './session.js';
import type { Message, ChatCompletionResponse, StreamChunk, TokenUsage } from './types.js';

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

  // ─── 流式 (sendMessageStream) ─────────────────

  describe('sendMessageStream()', () => {
    /** 创建带 chatStream mock 的 ApiClient */
    function mockStreamClient(chunks: StreamChunk[]): ApiClient {
      async function* chatStream(
        _messages: Message[],
        _options?: any,
      ): AsyncGenerator<StreamChunk> {
        for (const chunk of chunks) {
          yield chunk;
        }
      }
      return { chatStream } as unknown as ApiClient;
    }

    function chunk(
      overrides: Partial<StreamChunk> = {},
    ): StreamChunk {
      return {
        id: 'chatcmpl-stream-001',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        ...overrides,
      };
    }

    function usageChunk(usage: TokenUsage): StreamChunk {
      return chunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      });
    }

    it('流式接收 reasoning_content 和 content', async () => {
      const streamClient = mockStreamClient([
        chunk({
          choices: [{ index: 0, delta: { reasoning_content: '我在思考' }, finish_reason: null }],
        }),
        chunk({
          choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
        }),
        chunk({
          choices: [{ index: 0, delta: { content: '世界' }, finish_reason: null }],
        }),
        usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      ]);

      const mgr = new SessionManager(storage, streamClient);
      await mgr.startNewSession('流式测试');

      const events: StreamEvent[] = [];
      const result = await mgr.sendMessageStream('Q', (e) => events.push(e));

      expect(result).not.toBeNull();
      expect(result!.assistant.content).toBe('你好世界');
      expect(result!.assistant.reasoning_content).toBe('我在思考');

      // 验证事件序列
      expect(events).toEqual([
        { type: 'reasoning_delta', text: '我在思考' },
        { type: 'content_delta', text: '你好' },
        { type: 'content_delta', text: '世界' },
        {
          type: 'done',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]);
    });

    it('流式完成后持久化 turn', async () => {
      const streamClient = mockStreamClient([
        chunk({
          choices: [{ index: 0, delta: { content: '回复' }, finish_reason: null }],
        }),
        usageChunk({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
      ]);

      const mgr = new SessionManager(storage, streamClient);
      await mgr.startNewSession('持久化');
      const id = mgr.getSessionId()!;

      await mgr.sendMessageStream('Q', () => {});

      const session = await storage.getSession(id);
      expect(session!.turns).toHaveLength(1);
      expect(session!.turns[0].user.content).toBe('Q');
      expect(session!.turns[0].assistant.content).toBe('回复');
      expect(session!.meta.turnCount).toBe(1);
    });

    it('中断后保存 interrupted 轮次', async () => {
      const controller = new AbortController();

      async function* abortedStream(
        _messages: Message[],
        options?: any,
      ): AsyncGenerator<StreamChunk> {
        yield chunk({
          choices: [{ index: 0, delta: { content: '部分' }, finish_reason: null }],
        });
        // 模拟真实 chatStream：检查 signal 后抛出 AbortError
        if (options?.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        // 如果 signal 未 abort，主动 abort 然后等待传播
        controller.abort();
        // 等待 signal 事件传播到内部 controller
        await new Promise((r) => setTimeout(r, 30));
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }

      const streamClient = { chatStream: abortedStream } as unknown as ApiClient;

      const mgr = new SessionManager(storage, streamClient);
      await mgr.startNewSession('中断测试');

      const events: StreamEvent[] = [];
      const result = await mgr.sendMessageStream('Q', (e) => events.push(e), controller.signal);

      expect(result).not.toBeNull();
      expect(result!.interrupted).toBe(true);
      expect(result!.assistant.content).toBe('部分');

      // 验证 error 事件
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.error).toBe('已中断');
    });

    it('中断轮次不向 API 发送', async () => {
      // 第一轮正常完成
      const client1 = mockStreamClient([
        chunk({
          choices: [{ index: 0, delta: { content: 'A1' }, finish_reason: null }],
        }),
        usageChunk({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
      ]);

      const mgr = new SessionManager(storage, client1);
      await mgr.startNewSession('上下文测试');
      await mgr.sendMessageStream('Q1', () => {});

      // 第二轮中断
      const controller = new AbortController();
      async function* abortedStream2(
        _messages: Message[],
        options?: any,
      ): AsyncGenerator<StreamChunk> {
        yield chunk({
          choices: [{ index: 0, delta: { content: '部分回复' }, finish_reason: null }],
        });
        if (options?.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        controller.abort();
        await new Promise((r) => setTimeout(r, 30));
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      const client2 = { chatStream: abortedStream2 } as unknown as ApiClient;
      const mgr2 = new SessionManager(storage, client2);
      await mgr2.resumeSession(mgr.getSessionId()!);
      await mgr2.sendMessageStream('Q2', () => {}, controller.signal);

      // 第三轮：验证 Q2 的中断轮次不会被发送给 API
      let capturedMessages: Message[] = [];
      async function* captureStream(
        messages: Message[],
        _options?: any,
      ): AsyncGenerator<StreamChunk> {
        capturedMessages = messages;
        yield chunk({
          choices: [{ index: 0, delta: { content: 'A3' }, finish_reason: null }],
        });
        yield usageChunk({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
      }
      const client3 = { chatStream: captureStream } as unknown as ApiClient;
      const mgr3 = new SessionManager(storage, client3);
      await mgr3.resumeSession(mgr.getSessionId()!);
      await mgr3.sendMessageStream('Q3', () => {});

      // 应该只有 system + Q1/A1 + Q3，没有 Q2/部分回复（A3 是第三轮的回复，不在请求消息中）
      const userMsgs = capturedMessages.filter((m) => m.role === 'user');
      const assistantMsgs = capturedMessages.filter((m) => m.role === 'assistant');
      expect(userMsgs.map((m) => m.content)).toEqual(['Q1', 'Q3']);
      expect(assistantMsgs.map((m) => m.content)).toEqual(['A1']);
    });

    it('未创建会话时抛出错误', async () => {
      const streamClient = mockStreamClient([]);

      // 需要给 chatStream 添加一个空的 setSystemPrompt，但不用
      const mgr = new SessionManager(storage, streamClient as any);
      await expect(mgr.sendMessageStream('test', () => {})).rejects.toThrow('未创建会话');
    });
  });
});
