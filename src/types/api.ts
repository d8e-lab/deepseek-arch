/**
 * API 请求/响应相关类型
 */

import type { Message } from './chat.js';

/** DeepSeek Chat Completion 请求体 */
export interface ChatCompletionRequest {
	model: string;
	messages: Message[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	top_p?: number;
}

/** DeepSeek Delta (流式) */
export interface StreamDelta {
	role?: string;
	content?: string;
	reasoning_content?: string;
}

/** DeepSeek Choice */
export interface ChatChoice {
	index: number;
	message?: Message;
	delta?: StreamDelta;
	finish_reason: string | null;
}

/** DeepSeek Chat Completion 响应体 */
export interface ChatCompletionResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: ChatChoice[];
	usage?: TokenUsage;
}

/** SSE 流式块（DeepSeek API text/event-stream 单条 data） */
export interface StreamChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: ChatChoice[];
	usage?: TokenUsage;
}

/** 流式调用选项 */
export interface StreamOptions {
	/** 请求超时（毫秒），默认 120_000 */
	timeoutMs?: number;
	/** 最大重试次数，默认 2 */
	maxRetries?: number;
	/** 外部 AbortController（用于用户中断），调用方可在外部 abort() */
	signal?: AbortSignal;
}

// ─── TokenUsage import ─────────────────────────────

import type { TokenUsage } from './token.js';

// ─── 错误类型 ──────────────────────────────────────

/** API 错误响应（JSON body） */
export interface ApiErrorBody {
	message?: string;
	type?: string;
	code?: string;
}

/** API 调用错误 */
export class ApiError extends Error {
	/** HTTP 状态码 */
	status: number;
	/** API 错误码（如 "invalid_api_key"） */
	code?: string;

	constructor(status: number, message: string, code?: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}
