/**
 * ApiClient — DeepSeek Chat Completion API 适配器
 *
 * 职责：
 *   1. 封装 DeepSeek Chat Completion API 调用（OpenAI 兼容格式）
 *   2. 构造函数注入 baseUrl / apiKey / defaultModel，与 ConfigManager 解耦
 *   3. 非流式调用 + 流式调用 (SSE)
 *   4. 统一错误处理：HTTP 错误 → ApiError
 *   5. 实现 ModelProvider 接口
 *
 * 用法：
 *   const client = new ApiClient("https://api.deepseek.com", "sk-xxx", "deepseek-v4-pro");
 *   const resp = await client.chat([{ role: "user", content: "你好" }]);
 */

import { request as httpRequest } from 'node:http';
import type { Message, ChatCompletionRequest, ChatCompletionResponse, StreamChunk } from '../types/index.js';
import { ApiError } from '../types/index.js';
import type { ModelProvider, ChatOptions, StreamChatOptions } from './model-provider.js';

export { ApiError };

const CHAT_ENDPOINT = '/v1/chat/completions';

export class ApiClient implements ModelProvider {
	private baseUrl: string;
	private apiKey: string;
	private defaultModel: string;
	/** 请求镜像监听地址（可选，如 http://127.0.0.1:8899） */
	private mirrorUrl?: string;
	/** 当前会话 ID（用于镜像请求的 X-Session-Id 头） */
	private sessionId: string | null = null;

	/**
	 * @param baseUrl   API 基地址，如 "https://api.deepseek.com"
	 * @param apiKey    API 密钥
	 * @param defaultModel  默认模型名
	 * @param mirrorUrl 请求镜像监听地址（可选）。设置后每次发 API 请求都会
	 *                  同步把相同请求体 POST 给该地址，供监听进程原样保存。
	 *                  镜像请求失败不影响主请求。
	 */
	constructor(baseUrl: string, apiKey: string, defaultModel: string, mirrorUrl?: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.apiKey = apiKey;
		this.defaultModel = defaultModel;
		this.mirrorUrl = mirrorUrl?.replace(/\/+$/, '');
	}

	/** 切换默认模型 */
	setModel(model: string): void {
		this.defaultModel = model;
	}

	/** 设置当前会话 ID（镜像请求通过 X-Session-Id 头关联会话） */
	setSessionId(id: string | null): void {
		this.sessionId = id;
	}

	/**
	 * 将请求体镜像发送到监听进程（fire-and-forget）。
	 * 使用 node:http 直接发送，不经过全局 fetch——保证与主请求的 fetch
	 * 互相独立，且测试中 stub 全局 fetch 不会影响镜像链路。
	 * 监听地址为本地 http 服务（deepseek-arch api-monitor 启动）。
	 * 任何失败（监听未启动、超时、网络错误）都静默忽略。
	 */
	private mirrorRequest(body: ChatCompletionRequest): void {
		if (!this.mirrorUrl) return;
		try {
			const url = new URL(`${this.mirrorUrl}/`);
			const payload = JSON.stringify(body);
			const req = httpRequest(
				{
					hostname: url.hostname,
					port: url.port ? Number(url.port) : 80,
					path: '/',
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(payload),
						...(this.sessionId ? { 'X-Session-Id': this.sessionId } : {}),
					},
					timeout: 2000,
				},
				(res) => {
					res.resume(); // 丢弃响应体
				},
			);
			req.on('error', () => { /* 镜像失败静默 */ });
			req.on('timeout', () => req.destroy());
			req.write(payload);
			req.end();
		} catch {
			/* 镜像失败静默 */
		}
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
		options?: ChatOptions,
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
		if (options?.tools?.length) {
			body.tools = options.tools;
		}

		const url = `${this.baseUrl}${CHAT_ENDPOINT}`;

		// 镜像请求到监听进程（fire-and-forget，失败静默）
		this.mirrorRequest(body);

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

	/**
	 * 发送 Chat Completion 请求（流式 SSE）
	 *
	 * 返回 AsyncGenerator，逐个产出 StreamChunk。
	 * 超时和中断通过 AbortController 实现：内部超时 + 外部 signal 组合。
	 * 网络错误和 5xx 自动重试（指数退避）。
	 *
	 * @param messages  消息列表
	 * @param options   模型/温度/max_tokens 覆盖 + 流式选项 (timeoutMs, maxRetries, signal)
	 * @yields         StreamChunk — SSE data 行解析结果
	 * @throws         ApiError  — HTTP 4xx（不重试）
	 * @throws         Error     — 超时、网络错误（重试耗尽后）
	 */
	async *chatStream(
		messages: Message[],
		options?: StreamChatOptions,
	): AsyncGenerator<StreamChunk> {
		const timeoutMs = options?.timeoutMs ?? 120_000;
		const maxRetries = options?.maxRetries ?? 2;
		const externalSignal = options?.signal;

		// 外部 signal 已 abort：直接抛出
		if (externalSignal?.aborted) {
			throw new Error(externalSignal.reason ?? '请求已取消');
		}

		const body: ChatCompletionRequest = {
			model: options?.model ?? this.defaultModel,
			messages,
			stream: true,
		};
		if (options?.temperature !== undefined) body.temperature = options.temperature;
		if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;
		if (options?.tools?.length) body.tools = options.tools;

		const url = `${this.baseUrl}${CHAT_ENDPOINT}`;

		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			// 每次尝试创建独立的 AbortController
			const controller = new AbortController();

			// 超时
			const timeoutId = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);

			// 外部信号转发
			const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
			externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

			// 镜像请求到监听进程（fire-and-forget，失败静默；每次实际尝试都镜像）
			this.mirrorRequest(body);

			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});

				if (!response.ok) {
					// 4xx 不重试
					if (response.status >= 400 && response.status < 500) {
						let errorMessage = `HTTP ${response.status}`;
						let errorCode: string | undefined;
						try {
							const errBody = await response.json();
							errorMessage = errBody?.error?.message ?? errorMessage;
							errorCode = errBody?.error?.code;
						} catch { /* 非 JSON 响应 */ }
						throw new ApiError(response.status, errorMessage, errorCode);
					}
					// 5xx 可重试
					throw new Error(`HTTP ${response.status}`);
				}

				if (!response.body) {
					throw new Error('响应体为空');
				}

				// 解析 SSE 流
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split('\n');
						// 最后一行可能不完整，保留到下次
						buffer = lines.pop() ?? '';

						for (const line of lines) {
							const trimmed = line.trim();
							if (trimmed === '' || trimmed.startsWith(':')) continue;

							if (trimmed.startsWith('data: ')) {
								const data = trimmed.slice(6);
								if (data === '[DONE]') return;

								try {
									const chunk = JSON.parse(data) as StreamChunk;
									yield chunk;
								} catch {
									// 忽略无法解析的 data 行
								}
							}
						}
					}
				} finally {
					reader.releaseLock();
				}

				// 成功，退出重试循环
				return;
			} catch (err) {
				clearTimeout(timeoutId);
				externalSignal?.removeEventListener('abort', onExternalAbort);

				// 不重试的情况
				if (err instanceof ApiError) throw err;           // 4xx
				if (externalSignal?.aborted) throw err;            // 用户中断
				if (err instanceof Error && err.name === 'AbortError') {
					// 检查是否超时（内部 abort）
					if (controller.signal.aborted && !externalSignal?.aborted) {
						lastError = new Error('请求超时');
					} else {
						lastError = err;
					}
				} else {
					lastError = err instanceof Error ? err : new Error(String(err));
				}

				// 最后一次尝试，抛出错误
				if (attempt === maxRetries) {
					throw lastError;
				}

				// 指数退避
				const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}
}
