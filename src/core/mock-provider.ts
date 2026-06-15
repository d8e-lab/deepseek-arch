/**
 * MockProvider — 本地伪装模型提供商
 *
 * 在测试模式下返回与真实 provider 一致的请求/响应格式。
 * 支持非流式、流式、错误模拟，数据稳定可预测。
 *
 * 行为规则（仅检查最后一条 user 消息）：
 *   包含 "你好" / "hello" → 打招呼回复
 *   包含 "你是谁" → 自我介绍回复
 *   包含 "测试" → 测试确认回复
 *   包含 "#error-401" → 抛出 ApiError(401)
 *   包含 "#error-500" → 抛出 Error
 *   包含 "#stream" → 按字符流式输出
 *   其他 → "你说了: ..." 的默认回复
 */

import type { Message, ChatCompletionResponse, StreamChunk, TokenUsage } from '../types/index.js';
import { ApiError } from '../types/index.js';
import type { ModelProvider, ChatOptions, StreamChatOptions } from './model-provider.js';

/** 稳定可预测的假回复 */
function generateReply(input: string): string {
	if (/你好|hello/i.test(input)) return '你好，我是测试提供商。';
	if (/你是谁|你叫什么/.test(input)) return '我是 MockProvider，一个本地测试用的伪装模型提供商。';
	if (/测试/.test(input)) return '测试通过！MockProvider 运行正常。';
	return `你说了: "${input}"。这是 MockProvider 的默认回复。`;
}

/** 标准 mock usage（对每次调用都一样，便于断言） */
const STANDARD_USAGE: TokenUsage = {
	prompt_tokens: 10,
	completion_tokens: 5,
	total_tokens: 15,
	prompt_cache_hit_tokens: 8,
	prompt_cache_miss_tokens: 2,
};

export class MockProvider implements ModelProvider {
	private modelName: string;
	private streamDelayMs: number;

	constructor(modelName = 'mock-chat', streamDelayMs = 0) {
		this.modelName = modelName;
		this.streamDelayMs = streamDelayMs;
	}

	/** 切换模型名 */
	setModel(model: string): void {
		this.modelName = model;
	}

	/** 提取最后一条 user 消息内容 */
	private getLastUserContent(messages: Message[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') return messages[i].content;
		}
		return '';
	}

	/**
	 * 非流式对话
	 *
	 * 检查消息中的特殊标记后返回稳定响应。
	 * #error-401 和 #error-500 用于测试错误处理路径。
	 */
	async chat(
		messages: Message[],
		options?: ChatOptions,
	): Promise<ChatCompletionResponse> {
		const content = this.getLastUserContent(messages);

		// 错误模拟
		if (content.includes('#error-401')) {
			throw new ApiError(401, 'Invalid API Key', 'invalid_api_key');
		}
		if (content.includes('#error-429')) {
			throw new ApiError(429, 'Rate limit exceeded');
		}
		if (content.includes('#error-500')) {
			throw new Error('Internal Server Error');
		}

		const reply = generateReply(content);

		return {
			id: 'mock-cmpl-001',
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: options?.model ?? this.modelName,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: reply,
						reasoning_content: content.includes('#nothink') ? undefined : `[模拟思考] 用户说了 "${content}"`.repeat(20),
					},
					finish_reason: 'stop',
				},
			],
			usage: { ...STANDARD_USAGE },
		};
	}

	/** 流式延迟（模拟网络传输） */
	private async delay(): Promise<void> {
		if (this.streamDelayMs > 0) await new Promise(r => setTimeout(r, this.streamDelayMs));
	}

	/**
	 * 流式对话
	 *
	 * 含 #stream 标记时按字符逐个 yield；否则一次性 yield 全部内容。
	 * 支持 reasoning_content 模拟 DeepSeek 的思考过程。
	 */
	async *chatStream(
		messages: Message[],
		options?: StreamChatOptions,
	): AsyncGenerator<StreamChunk> {
		const content = this.getLastUserContent(messages);

		// 错误模拟（流式路径也应支持）
		if (content.includes('#error-401')) {
			throw new ApiError(401, 'Invalid API Key', 'invalid_api_key');
		}
		if (content.includes('#error-429')) {
			throw new ApiError(429, 'Rate limit exceeded');
		}

		const reply = generateReply(content);

		// reasoning 输出
		if (!content.includes('#nothink')) {
			const reasoning = `[模拟思考] 用户说了 "${content}"`;
			for (const char of reasoning) {
				yield {
					id: 'mock-chunk-001',
					object: 'chat.completion.chunk',
					created: Math.floor(Date.now() / 1000),
					model: options?.model ?? this.modelName,
					choices: [
						{
							index: 0,
							delta: { reasoning_content: char },
							finish_reason: null,
						},
					],
				};
				await this.delay();
			}
		}

		// 内容输出
		const chars = content.includes('#stream') ? reply.split('') : [reply];
		for (let i = 0; i < chars.length; i++) {
			const isLast = i === chars.length - 1;
			yield {
				id: 'mock-chunk-001',
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model: options?.model ?? this.modelName,
				choices: [
					{
						index: 0,
						delta: { content: chars[i] },
						finish_reason: isLast ? 'stop' : null,
					},
				],
				usage: isLast ? { ...STANDARD_USAGE } : undefined,
			};
			await this.delay();
		}
	}
}