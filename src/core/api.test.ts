/**
 * ApiClient 单元测试
 *
 * 使用 vitest mock fetch 模拟 HTTP 层，无真实网络请求。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiClient, ApiError } from './api.js';
import type { Message, ChatCompletionResponse } from './types.js';

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
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_tokens');
    });

    it('baseUrl 末尾斜杠被规范化', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(successResponse()),
      });
      globalThis.fetch = mockFetch;

      const client = createClient('https://api.deepseek.com///');
      await client.chat([{ role: 'user', content: 'test' }]);

      expect(mockFetch.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/chat/completions');
    });

    it('assistant 消息保留 reasoning_content', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(successResponse()),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      const messages: Message[] = [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1', reasoning_content: '思考过程...' },
        { role: 'user', content: 'Q2' },
      ];
      await client.chat(messages);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages).toEqual(messages);
    });

    it('空消息列表正常发送', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(successResponse()),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      const result = await client.chat([]);

      expect(result.choices[0].message.content).toBe('你好！有什么可以帮助你的？');
    });

    it('返回的 usage 包含缓存统计', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve(
            successResponse({
              usage: {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
                prompt_cache_hit_tokens: 80,
                prompt_cache_miss_tokens: 20,
              },
            }),
          ),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      const result = await client.chat([{ role: 'user', content: 'test' }]);

      expect(result.usage?.prompt_cache_hit_tokens).toBe(80);
      expect(result.usage?.prompt_cache_miss_tokens).toBe(20);
    });
  });

  // ─── 错误场景 ────────────────────────────────────

  describe('chat() 错误处理', () => {
    it('401 未授权抛出 ApiError', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: { message: 'Invalid API key', code: 'invalid_api_key' },
          }),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(ApiError);

      try {
        await client.chat([{ role: 'user', content: 'test' }]);
        expect.fail('应该抛出 ApiError');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(401);
        expect((e as ApiError).message).toBe('Invalid API key');
        expect((e as ApiError).code).toBe('invalid_api_key');
      }
    });

    it('429 限流抛出 ApiError', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: { message: 'Rate limit exceeded' },
          }),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(ApiError);

      try {
        await client.chat([{ role: 'user', content: 'test' }]);
        expect.fail('应该抛出 ApiError');
      } catch (e) {
        expect((e as ApiError).status).toBe(429);
        expect((e as ApiError).message).toBe('Rate limit exceeded');
      }
    });

    it('500 服务端错误抛出 ApiError', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () =>
          Promise.resolve({
            error: { message: 'Internal server error' },
          }),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      try {
        await client.chat([{ role: 'user', content: 'test' }]);
        expect.fail('应该抛出 ApiError');
      } catch (e) {
        expect((e as ApiError).status).toBe(500);
      }
    });

    it('非 JSON 错误响应体使用默认消息', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error('Unexpected token')),
      });
      globalThis.fetch = mockFetch;

      const client = createClient();
      try {
        await client.chat([{ role: 'user', content: 'test' }]);
        expect.fail('应该抛出 ApiError');
      } catch (e) {
        expect((e as ApiError).status).toBe(502);
        expect((e as ApiError).message).toBe('HTTP 502');
        expect((e as ApiError).code).toBeUndefined();
      }
    });

    it('网络错误直接向上抛出', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
      globalThis.fetch = mockFetch;

      const client = createClient();
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(
        'connect ECONNREFUSED',
      );
    });
  });

  // ─── 构造函数 ────────────────────────────────────

  describe('构造函数', () => {
    it('保存 baseUrl/apiKey/model', () => {
      const client = new ApiClient('https://custom.api.com', 'sk-abc', 'custom-model');

      // 通过发送请求间接验证构造参数
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(successResponse({ model: 'custom-model' })),
      });
      globalThis.fetch = mockFetch;

      return client.chat([{ role: 'user', content: 'test' }]).then(() => {
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.model).toBe('custom-model');
        expect(mockFetch.mock.calls[0][0]).toBe('https://custom.api.com/v1/chat/completions');
      });
    });
  });
});
