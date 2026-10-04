/**
 * API 请求/响应相关类型
 */

import type { Message, MessageRole } from './chat.js';
import type { ImageDetail } from './image.js';

/** 工具定义（发送给 API） */
export interface ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, any>;
	};
}

/**
 * OpenAI 兼容内容块（仅 user 消息可含图片块）
 *
 * 文档方式 1（Base64 内联）：url 为 `data:<mime>;base64,<data>`。
 * 外部 URL / Files API 为后续扩展预留。
 */
export type ApiContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string; detail?: ImageDetail } };

/**
 * 上线消息（API 适配层契约）
 *
 * 与领域层 `Message` 的唯一区别：`content` 允许为内容块数组。
 * 由 `materializeMessages()` 在调用 provider 之前从 `Message`（含 images 引用）生成，
 * 领域层 / 持久化层不感知块结构。
 */
export interface ApiMessage {
	role: MessageRole;
	content: string | ApiContentBlock[];
	reasoning_content?: string;
	tool_call_id?: string;
	name?: string;
	tool_calls?: ToolCall[];
}

/** DeepSeek Chat Completion 请求体 */
export interface ChatCompletionRequest {
	model: string;
	messages: ApiMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	top_p?: number;
	tools?: ToolDefinition[];
	tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
	/** 思考模式开关（deepseek-v4 系列） */
	thinking?: { type?: 'enabled' | 'disabled' };
	/** 推理强度：low / high / max（medium/xhigh 映射为 high） */
	reasoning_effort?: string;
	/** 流式选项：include_usage=true 时流式末尾额外传 usage 块 */
	stream_options?: { include_usage?: boolean };
}

/** Tool call delta（流式增量） */
export interface ToolCallDelta {
	index: number;
	id?: string;
	type?: 'function';
	function?: {
		name?: string;
		arguments?: string;
	};
}

/** Tool call（非流式完整返回） */
export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

/** DeepSeek Delta (流式) */
export interface StreamDelta {
	role?: string;
	content?: string;
	reasoning_content?: string;
	tool_calls?: ToolCallDelta[];
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
