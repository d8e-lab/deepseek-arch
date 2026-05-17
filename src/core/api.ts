/**
 * ApiClient — DeepSeek Chat Completion API 适配器
 *
 * 职责：
 *   1. 封装 DeepSeek Chat Completion API 调用（OpenAI 兼容格式）
 *   2. 构造函数注入 baseUrl / apiKey / defaultModel，与 ConfigManager 解耦
 *   3. 非流式调用（Phase 3），流式在 Phase 4 扩展
 *   4. 统一错误处理：HTTP 错误 → ApiError
 *
 * 用法：
 *   const client = new ApiClient("https://api.deepseek.com", "sk-xxx", "deepseek-v4-pro");
 *   const resp = await client.chat([{ role: "user", content: "你好" }]);
 */

import type { Message, ChatCompletionRequest, ChatCompletionResponse } from './types.js';
import { ApiError } from './types.js';

export { ApiError };

const CHAT_ENDPOINT = '/v1/chat/completions';

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;

  /**
   * @param baseUrl   API 基地址，如 "https://api.deepseek.com"
   * @param apiKey    API 密钥
   * @param defaultModel  默认模型名
   */
  constructor(baseUrl: string, apiKey: string, defaultModel: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  /**
   * 发送 Chat Completion 请求（非流式）
   *
   * @param messages  消息列表（system / user / assistant）
   *                  注意：assistant 消息可附带 reasoning_content 以命中 kv-cache
   * @param options   可选的模型/温度/max_tokens 覆盖
   * @returns         API 响应体
   * @throws          ApiError  — HTTP 非 2xx（含 401/429/5xx）
   * @throws          Error     — 网络错误（fetch 自身抛出）
   */
  async chat(
    messages: Message[],
    options?: {
      model?: string;
      temperature?: number;
      max_tokens?: number;
    },
  ): Promise<ChatCompletionResponse> {
    const body: ChatCompletionRequest = {
      model: options?.model ?? this.defaultModel,
      messages,
      stream: false,
    };

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options?.max_tokens !== undefined) {
      body.max_tokens = options.max_tokens;
    }

    const url = `${this.baseUrl}${CHAT_ENDPOINT}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      let errorCode: string | undefined;

      try {
        const errorBody = await response.json();
        errorMessage = errorBody?.error?.message ?? errorMessage;
        errorCode = errorBody?.error?.code;
      } catch {
        // 非 JSON 响应体，使用默认错误消息
      }

      throw new ApiError(response.status, errorMessage, errorCode);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    return data;
  }
}
