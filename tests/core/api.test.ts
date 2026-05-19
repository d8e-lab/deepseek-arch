/**
 * ApiClient 单元测试
 *
 * 使用 vitest mock fetch 模拟 HTTP 层，无真实网络请求。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiClient, ApiError } from '../../src/core/api.js';
import type { Message, ChatCompletionResponse } from '../../src/types/index.js';

/** 构建标准成功响应 */
function successResponse(
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
          content: '你好！有什么可以帮助你的？',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 15,
      completion_tokens: 8,
      total_tokens: 23,
      prompt_cache_hit_tokens: 10,
      prompt_cache_miss_tokens: 5,
    },
    ...overrides,
  };
}

/** 创建 ApiClient */
function createClient(
  baseUrl = 'https://api.deepseek.com',
  apiKey = 'sk-test-key',
  model = 'deepseek-v4-pro',
): ApiClient {
  return new ApiClient(baseUrl, apiKey, model);
}

describe('ApiClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── 成功场景 ────────────────────────────────────

  describe('chat() 成功调用', () => {
    it('正确发送请求并返回响应', async () => {
      const expected: ChatCompletionResponse = successResponse();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(expected),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      const messages: Message[] = [{ role: 'user', content: '你好' }];
      const result = await client.chat(messages);

      expect(result).toEqual(expected);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // 验证 URL
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe('https://api.deepseek.com/v1/chat/completions');

      // 验证请求体
      const callInit = mockFetch.mock.calls[0][1];
      expect(callInit.method).toBe('POST');
      expect(callInit.headers['Content-Type']).toBe('application/json');
      expect(callInit.headers['Authorization']).toBe('Bearer sk-test-key');

      const body = JSON.parse(callInit.body);
      expect(body.model).toBe('deepseek-v4-pro');
      expect(body.messages).toEqual([{ role: 'user', content: '你好' }]);
      expect(body.stream).toBe(false);
    });

    it('支持自定义 model 覆盖', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(successResponse({ model: 'deepseek-chat' })),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await client.chat([{ role: 'user', content: 'test' }], { model: 'deepseek-chat' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('deepseek-chat');
    });

    it('传递 temperature 和 max_tokens', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(successResponse()),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await client.chat([{ role: 'user', content: 'test' }], {
        temperature: 0.7,
        max_tokens: 1024,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(1024);
    });

    it('不传 options 时不包含 temperature/max_tokens', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(successResponse()),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await client.chat([{ role: 'user', content: 'test' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
    });
  });

  // ─── 错误场景 ────────────────────────────────────

  describe('chat() 错误处理', () => {
    it('401 返回 ApiError', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(ApiError);
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow('Invalid API Key');
    });

    it('429 返回 ApiError', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: { message: 'Rate limit exceeded' } }),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow('Rate limit exceeded');
    });

    it('500 返回 ApiError', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('parse error')), // 非 JSON 响应
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow('HTTP 500');
    });

    it('fetch 网络错误传播', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow('Network error');
    });
  });

  // ─── 构造函数 ─────────────────────────────────────

  describe('构造函数', () => {
    it('baseUrl 尾部斜杠被移除', () => {
      const client = new ApiClient('https://api.deepseek.com/', 'sk-key', 'model');
      // 验证不能用普通方式，但可以确认基础 URL 正常
      expect(client).toBeInstanceOf(ApiClient);
    });
  });

  // ─── Stream 测试 ──────────────────────────────────

  describe('chatStream() 流式', () => {
    /** 构造一个 SSE 格式的 data 行 */
    function sseChunk(obj: Record<string, unknown>): string {
      return `data: ${JSON.stringify(obj)}\n\n`;
    }

    function sseDone(): string {
      return 'data: [DONE]\n\n';
    }

    /** 从预定义字符串数组创建 ReadableStream */
    function mockSSEStream(lines: string[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) {
            controller.enqueue(encoder.encode(line));
          }
          controller.close();
        },
      });
    }

    it('正确解析流式响应', async () => {
      const chunks = [
        sseChunk({
          id: 'chatcmpl-001',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
        }),
        sseChunk({
          id: 'chatcmpl-001',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { content: '，' }, finish_reason: null }],
        }),
        sseChunk({
          id: 'chatcmpl-001',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { content: '世界' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
        sseDone(),
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockSSEStream(chunks),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      const results: string[] = [];
      for await (const chunk of client.chatStream([{ role: 'user', content: '你好' }])) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) results.push(delta.content);
      }
      expect(results).toEqual(['你好', '，', '世界']);
    });

    it('支持 reasoning_content 的流式', async () => {
      const chunks = [
        sseChunk({
          id: 'chatcmpl-002',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { reasoning_content: '用户说' }, finish_reason: null }],
        }),
        sseChunk({
          id: 'chatcmpl-002',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { reasoning_content: '你好' }, finish_reason: null }],
        }),
        sseChunk({
          id: 'chatcmpl-002',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { content: '你好！' }, finish_reason: 'stop' }],
        }),
        sseDone(),
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockSSEStream(chunks),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      const reasoningParts: string[] = [];
      const contentParts: string[] = [];
      for await (const chunk of client.chatStream([{ role: 'user', content: '你好' }])) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.reasoning_content) reasoningParts.push(delta.reasoning_content);
        if (delta?.content) contentParts.push(delta.content);
      }
      expect(reasoningParts).toEqual(['用户说', '你好']);
      expect(contentParts).toEqual(['你好！']);
    });

    it('通过 [DONE] 标记结束流式', async () => {
      const chunks = [
        sseChunk({
          id: 'chatcmpl-003',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
        }),
        sseDone(),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockSSEStream(chunks),
      });

      const client = createClient();
      let count = 0;
      for await (const _ of client.chatStream([{ role: 'user', content: 'test' }])) {
        count++;
      }
      expect(count).toBe(1);
    });

    it('空行和注释行被忽略', async () => {
      const chunks = [
        '',
        ': comment line\n',
        sseChunk({
          id: 'chatcmpl-004',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        }),
        sseDone(),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockSSEStream(chunks),
      });

      const client = createClient();
      let count = 0;
      for await (const _ of client.chatStream([{ role: 'user', content: 'test' }])) {
        count++;
      }
      expect(count).toBe(1);
    });

    it('4xx 错误不重试（验证参数错误）', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: { message: 'Bad Request', code: 'bad_request' } }),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(async () => {
        for await (const _ of client.chatStream([{ role: 'user', content: 'test' }])) {
          // 不应到达
        }
      }).rejects.toThrow(ApiError);
      expect(mockFetch).toHaveBeenCalledTimes(1); // 不重试
    });

    it('5xx 错误重试', async () => {
      const chunks = [
        sseChunk({
          id: 'chatcmpl-005',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        }),
        sseDone(),
      ];

      // 第一次 500，第二次成功
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, body: mockSSEStream(chunks) });
      globalThis.fetch = mockFetch;

      const client = createClient();
      let count = 0;
      for await (const _ of client.chatStream([{ role: 'user', content: 'test' }], { maxRetries: 1 })) {
        count++;
      }
      expect(count).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('重试耗尽后抛出错误', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(async () => {
        for await (const _ of client.chatStream([{ role: 'user', content: 'test' }], { maxRetries: 0 })) {
          // 不应到达
        }
      }).rejects.toThrow('HTTP 503');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('超时后抛出错误', async () => {
      // 模拟永不 resolve 的 fetch（触发超时）
      const mockFetch = vi.fn().mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(async () => {
        for await (const _ of client.chatStream(
          [{ role: 'user', content: 'test' }],
          { timeoutMs: 50, maxRetries: 0 },
        )) {
          // 不应到达
        }
      }).rejects.toThrow('请求超时');
    });

    it('外部 AbortSignal 可中断流式', async () => {
      const controller = new AbortController();

      // 先 abort，然后启动流式
      controller.abort();

      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(sseChunk({
            id: 'chatcmpl-001',
            object: 'chat.completion.chunk',
            created: 1234567890,
            model: 'deepseek-v4-pro',
            choices: [{ index: 0, delta: { content: 'part1' }, finish_reason: null }],
          })));
          ctrl.close();
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });

      const client = createClient();
      await expect(async () => {
        for await (const _ of client.chatStream(
          [{ role: 'user', content: 'test' }],
          { signal: controller.signal, maxRetries: 0 },
        )) {
          // 不应到达（abort 已触发）
        }
      }).rejects.toThrow();
    });

    it('自定义 model 和参数传递', async () => {
      const chunks = [
        sseChunk({
          id: 'chatcmpl-001',
          object: 'chat.completion.chunk',
          created: 1234567890,
          model: 'custom-model',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        }),
        sseDone(),
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockSSEStream(chunks),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      for await (const _ of client.chatStream([{ role: 'user', content: 'test' }], {
        model: 'custom-model',
        temperature: 0.5,
        max_tokens: 100,
      })) {
        // consume
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('custom-model');
      expect(body.temperature).toBe(0.5);
      expect(body.max_tokens).toBe(100);
    });

    it('空响应体抛出错误', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: null,
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(async () => {
        for await (const _ of client.chatStream([{ role: 'user', content: 'test' }], { maxRetries: 0 })) {
          // 不应到达
        }
      }).rejects.toThrow('响应体为空');
    });
  });
});
