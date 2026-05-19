/**
 * ModelProvider 接口层
 *
 * 将"真实 provider"与"伪装 provider"放在同一个抽象层后面。
 * 上层不直接依赖 ApiClient（HTTP 实现），而是依赖 ModelProvider 接口。
 *
 * 实现类：
 *   - ApiClient（src/core/api.ts）— 真实 HTTP 调用
 *   - MockProvider（src/core/mock-provider.ts）— 本地伪装返回
 */

import type { Message, ChatCompletionResponse, StreamChunk } from '../types/index.js';

/** 非流式调用选项 */
export interface ChatOptions {
	model?: string;
	temperature?: number;
	max_tokens?: number;
}

/** 流式调用选项（含非流式选项 + 超时/重试/中断） */
export interface StreamChatOptions extends ChatOptions {
	timeoutMs?: number;
	maxRetries?: number;
	signal?: AbortSignal;
}

/** 模型提供商统一接口 */
export interface ModelProvider {
	/** 非流式对话 */
	chat(messages: Message[], options?: ChatOptions): Promise<ChatCompletionResponse>;
	/** 流式对话（SSE） */
	chatStream(messages: Message[], options?: StreamChatOptions): AsyncGenerator<StreamChunk>;
}
