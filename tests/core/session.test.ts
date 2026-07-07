/**
 * SessionManager 单元测试
 *
 * 使用真实 Storage (临时目录) + mock ApiClient。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../../src/core/storage.js';
import type { ModelProvider } from '../../src/core/model-provider.js';
import { SessionManager, type StreamEvent } from '../../src/core/session.js';
import type { Message, ChatCompletionResponse, StreamChunk, TokenUsage } from '../../src/types/index.js';
import type { Tool, ToolResult } from '../../src/tools/types.js';

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
): ModelProvider {
  const mockChat = vi.fn().mockResolvedValue(response ?? makeResponse());
  return { chat: mockChat } as unknown as ModelProvider;
}

describe('SessionManager', () => {
  let testDir: string;
  let storage: Storage;
  let client: ModelProvider;
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

      const t1 = await manager.sendMessage('第一轮');
      expect(t1.turn.turn).toBe(1);

      const t2 = await manager.sendMessage('第二轮');
      expect(t2.turn.turn).toBe(2);

      const t3 = await manager.sendMessage('第三轮');
      expect(t3.turn.turn).toBe(3);
    });

    it('历史消息被传递到 API（含 reasoning_content）', async () => {
      await manager.startNewSession('历史测试');

      // 捕获 API 调用参数
      let capturedMessages: Message[] = [];
      const mockChat = vi.fn().mockImplementation(
        (messages: Message[]) => {
          capturedMessages = messages;
          return Promise.resolve(makeResponse());
        },
      );
      manager = new SessionManager(storage, { chat: mockChat } as unknown as ModelProvider);
      manager.setSystemPrompt({ role: 'system', content: '你是一个有用的助手。' });
      await manager.startNewSession('历史测试');

      // 发送两轮
      await manager.sendMessage('消息1');
      await manager.sendMessage('消息2');

      // 验证第二轮请求包含历史
      const userMsgs = capturedMessages.filter((m) => m.role === 'user');
      expect(userMsgs[0].content).toBe('消息1');
      expect(userMsgs[1].content).toBe('消息2');

      // 验证 assistant 消息包含 reasoning_content
      const assistantMsgs = capturedMessages.filter((m) => m.role === 'assistant');
      expect(assistantMsgs.length).toBeGreaterThan(0);
      expect(assistantMsgs[0].reasoning_content).toBe('用户说你好，我应回应问候。');
    });

    it('未创建会话时抛出错误', async () => {
      await expect(manager.sendMessage('test')).rejects.toThrow('未创建会话');
    });
  });

  describe('setTitle', () => {
    it('更新会话标题', async () => {
      await manager.startNewSession();
      await manager.setTitle('新标题');
      expect(manager.getSession()?.meta.title).toBe('新标题');
    });

    it('未创建会话时不会出错', async () => {
      await manager.setTitle('测试'); // 不应抛出
    });
  });

  // ─── 流式测试 ────────────────────────────────────

  describe('sendMessageStream', () => {
    /** 创建模拟流客户端 */
    function mockStreamClient(chunks: StreamChunk[]): ModelProvider {
      async function* gen(): AsyncGenerator<StreamChunk> {
        for (const c of chunks) yield c;
      }
      return { chatStream: gen } as unknown as ModelProvider;
    }

    function chunk(overrides?: Partial<StreamChunk>): StreamChunk {
      return {
        id: 'chatcmpl-stream-001',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: null }],
        ...overrides,
      };
    }

    function usageChunk(usage: TokenUsage): StreamChunk {
      return {
        id: 'chatcmpl-stream-001',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
        usage,
      };
    }

    it('正确累积流式内容并触发 done 事件', async () => {
      const streamClient = mockStreamClient([
        chunk({ choices: [{ index: 0, delta: { reasoning_content: '思考中' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { content: '世界' }, finish_reason: null }] }),
        usageChunk({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }),
      ]);

      const mgr = new SessionManager(storage, streamClient);
      await mgr.startNewSession('流式测试');
      mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

      const events: StreamEvent[] = [];
      const result = await mgr.sendMessageStream('你好', (e) => events.push(e));

      expect(result).not.toBeNull();
      expect(result!.turn).toBe(1);
      expect(result!.user.content).toBe('你好');
      expect(result!.assistant.content).toBe('你好世界');
      expect(result!.assistant.reasoning_content).toBe('思考中');
      expect(result!.interrupted).toBeUndefined();

      // 验证事件
      const reasoningEvents = events.filter((e) => e.type === 'reasoning_delta');
      const contentEvents = events.filter((e) => e.type === 'content_delta');
      const doneEvents = events.filter((e) => e.type === 'done');
      expect(reasoningEvents.map((e) => e.text)).toEqual(['思考中']);
      expect(contentEvents.map((e) => e.text)).toEqual(['你好', '世界']);
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0].usage?.total_tokens).toBe(12);
    });

    it('纯文本中断不保存（无工具调用）', async () => {
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

      const streamClient = { chatStream: abortedStream } as unknown as ModelProvider;

      const mgr = new SessionManager(storage, streamClient);
      await mgr.startNewSession('中断测试');

      const events: StreamEvent[] = [];
      const result = await mgr.sendMessageStream('Q', (e) => events.push(e), controller.signal);

      // 纯文本中断（无工具调用）：不保存轮次
      expect(result).toBeNull();

      // 验证 error 事件（无工具调用中断不保存，error 为原始 AbortError 消息）
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.error).toBe('aborted');
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
      const client2 = { chatStream: abortedStream2 } as unknown as ModelProvider;
      const mgr2 = new SessionManager(storage, client2);
      await mgr2.resumeSession(mgr.getSessionId()!);
      await mgr2.sendMessageStream('Q2', () => {}, controller.signal);

      // 第三轮：Q2 因无工具调用未被保存，验证其不在 API 请求中
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
      const client3 = { chatStream: captureStream } as unknown as ModelProvider;
      const mgr3 = new SessionManager(storage, client3);
      await mgr3.resumeSession(mgr.getSessionId()!);
      await mgr3.sendMessageStream('Q3', () => {});

      // Q2 因无工具调用未保存，API 请求中只有 Q1/Q3
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

    it('工具返回 error 时，错误信息被送回模型下一轮', async () => {
      // 工具：总是返回错误
      const errorTool: Tool = {
        name: 'test_error_tool',
        description: 'a tool that always errors',
        parameters: { type: 'object', properties: {}, required: [] },
        requiresConfirm: false,
        async execute(): Promise<ToolResult> {
          return { content: 'partial result', error: 'Something went wrong' };
        },
      };

      // 第一轮：模型调用工具 → 工具返回错误 → 第二轮：模型看到错误并回复
      let round = 0;
      let capturedMessages: Message[] = [];

      async function* twoRoundStream(
        messages: Message[],
        _options?: any,
      ): AsyncGenerator<StreamChunk> {
        if (round === 0) {
          // 第一轮：返回 tool_call
          round++;
          yield {
            id: 'call-1',
            object: 'chat.completion.chunk',
            created: 123,
            model: 'test',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_abc123',
                  type: 'function',
                  function: { name: 'test_error_tool', arguments: '{}' },
                }],
              },
              finish_reason: null,
            }],
          };
          yield {
            id: 'call-1',
            object: 'chat.completion.chunk',
            created: 123,
            model: 'test',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        } else {
          // 第二轮：模型看到了工具错误回复
          capturedMessages = messages;
          yield {
            id: 'call-2',
            object: 'chat.completion.chunk',
            created: 123,
            model: 'test',
            choices: [{ index: 0, delta: { content: 'I see the error, will retry.' }, finish_reason: null }],
          };
          yield {
            id: 'call-2',
            object: 'chat.completion.chunk',
            created: 123,
            model: 'test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          };
        }
      }

      const streamClient = { chatStream: twoRoundStream } as unknown as ModelProvider;
      const mgr = new SessionManager(storage, streamClient, [errorTool]);
      mgr.setSystemPrompt({ role: 'system', content: '你是一个测试助手。' });
      await mgr.startNewSession('工具错误测试');

      const events: StreamEvent[] = [];
      const result = await mgr.sendMessageStream('请测试工具错误', (e) => events.push(e));

      // 验证：turn 被保存
      expect(result).not.toBeNull();
      expect(result!.turn).toBe(1);

      // 验证：tool_record 中包含 error
      expect(result!.tool_calls).toHaveLength(1);
      expect(result!.tool_calls![0].error).toBe('Something went wrong');
      expect(result!.tool_calls![0].result).toBe('partial result');

      // 验证：tool 结果事件包含 error
      const toolResultEvents = events.filter((e) => e.type === 'tool_result');
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0].error).toBe('Something went wrong');
      expect(toolResultEvents[0].toolResult).toBe('partial result');

      // 验证：第二轮 API 请求中包含工具错误信息
      const toolMsgs = capturedMessages.filter((m) => m.role === 'tool');
      expect(toolMsgs).toHaveLength(1);
      expect(toolMsgs[0].content).toContain('partial result');
      expect(toolMsgs[0].content).toContain('Error: Something went wrong');
    });
  });
});
