/**
 * MockProvider 单元测试
 *
 * 验证伪装提供商的响应格式、错误模拟、流式行为。
 */

import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../src/core/mock-provider.js';
import { ApiError } from '../../src/core/api.js';
import type { Message } from '../../src/types/index.js';

describe('MockProvider', () => {
	const provider = new MockProvider();

	describe('chat() 非流式', () => {
		it('回复 "你好"', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			const resp = await provider.chat(messages);
			expect(resp.choices[0].message?.content).toBe('你好，我是测试提供商。');
		});

		it('回复 "hello"', async () => {
			const messages: Message[] = [{ role: 'user', content: 'hello' }];
			const resp = await provider.chat(messages);
			expect(resp.choices[0].message?.content).toBe('你好，我是测试提供商。');
		});

		it('回复 "你是谁"', async () => {
			const messages: Message[] = [{ role: 'user', content: '你是谁' }];
			const resp = await provider.chat(messages);
			expect(resp.choices[0].message?.content).toContain('MockProvider');
		});

		it('回复 "测试"', async () => {
			const messages: Message[] = [{ role: 'user', content: '运行测试' }];
			const resp = await provider.chat(messages);
			expect(resp.choices[0].message?.content).toContain('测试通过');
		});

		it('默认回复格式', async () => {
			const messages: Message[] = [{ role: 'user', content: '今天天气怎么样' }];
			const resp = await provider.chat(messages);
			expect(resp.choices[0].message?.content).toContain('你说了');
		});

		it('响应格式与真实 API 一致', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			const resp = await provider.chat(messages);
			expect(resp).toHaveProperty('id');
			expect(resp).toHaveProperty('object', 'chat.completion');
			expect(resp).toHaveProperty('created');
			expect(resp).toHaveProperty('model');
			expect(resp).toHaveProperty('choices');
			expect(resp.choices).toHaveLength(1);
			expect(resp.choices[0]).toHaveProperty('index', 0);
			expect(resp.choices[0]).toHaveProperty('finish_reason', 'stop');
		});

		it('返回 token usage', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			const resp = await provider.chat(messages);
			expect(resp.usage).toBeDefined();
			expect(resp.usage!.prompt_tokens).toBe(10);
			expect(resp.usage!.completion_tokens).toBe(5);
			expect(resp.usage!.total_tokens).toBe(15);
			expect(resp.usage!.prompt_cache_hit_tokens).toBe(8);
			expect(resp.usage!.prompt_cache_miss_tokens).toBe(2);
		});

		it('返回 reasoning_content', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			const resp = await provider.chat(messages);
			expect(resp.choices[0].message?.reasoning_content).toContain('[模拟思考]');
		});

		it('#nothink 跳过 reasoning_content', async () => {
			const messages: Message[] = [{ role: 'user', content: '#nothink 你好' }];
			const resp = await provider.chat(messages);
			expect(resp.choices[0].message?.reasoning_content).toBeUndefined();
		});

		it('支持自定义 model', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			const resp = await provider.chat(messages, { model: 'custom-model' });
			expect(resp.model).toBe('custom-model');
		});

		it('默认 model 名为 mock-chat', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			const resp = await provider.chat(messages);
			expect(resp.model).toBe('mock-chat');
		});
	});

	describe('chat() 错误模拟', () => {
		it('#error-401 抛出 ApiError', async () => {
			const messages: Message[] = [{ role: 'user', content: '#error-401 测试' }];
			await expect(provider.chat(messages)).rejects.toThrow(ApiError);
			await expect(provider.chat(messages)).rejects.toThrow('Invalid API Key');
		});

		it('#error-429 抛出 ApiError', async () => {
			const messages: Message[] = [{ role: 'user', content: '#error-429 测试' }];
			await expect(provider.chat(messages)).rejects.toThrow(ApiError);
			await expect(provider.chat(messages)).rejects.toThrow('Rate limit exceeded');
		});

		it('#error-500 抛出普通 Error', async () => {
			const messages: Message[] = [{ role: 'user', content: '#error-500 测试' }];
			await expect(provider.chat(messages)).rejects.toThrow('Internal Server Error');
		});
	});

	describe('chatStream() 流式', () => {
		it('一次性输出全部内容（无 #stream 标记）', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			const chunks: string[] = [];
			for await (const chunk of provider.chatStream(messages)) {
				const delta = chunk.choices[0]?.delta;
				if (delta?.content) chunks.push(delta.content);
			}
			// 无 #stream 标记时，全部内容作为一个 chunk
			expect(chunks).toHaveLength(1);
			expect(chunks[0]).toBe('你好，我是测试提供商。');
		});

		it('#stream 按字符逐个输出', async () => {
			const messages: Message[] = [{ role: 'user', content: '#stream hello' }];
			const chars: string[] = [];
			for await (const chunk of provider.chatStream(messages)) {
				const delta = chunk.choices[0]?.delta;
				if (delta?.content) chars.push(delta.content);
			}
			// 全部字符分开
			const expected = '你好，我是测试提供商。';
			expect(chars).toEqual(expected.split(''));
		});

		it('流式输出 reasoning_content', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			const reasoning: string[] = [];
			for await (const chunk of provider.chatStream(messages)) {
				const delta = chunk.choices[0]?.delta;
				if (delta?.reasoning_content) reasoning.push(delta.reasoning_content);
			}
			expect(reasoning.length).toBeGreaterThan(0);
			expect(reasoning.join('')).toContain('[模拟思考]');
		});

		it('#nothink 流式跳过 reasoning', async () => {
			const messages: Message[] = [{ role: 'user', content: '#nothink 你好' }];
			const reasoning: string[] = [];
			for await (const chunk of provider.chatStream(messages)) {
				const delta = chunk.choices[0]?.delta;
				if (delta?.reasoning_content) reasoning.push(delta.reasoning_content);
			}
			expect(reasoning).toHaveLength(0);
		});

		it('最后一个 chunk 携带 usage', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			let lastUsage: any = undefined;
			for await (const chunk of provider.chatStream(messages)) {
				if (chunk.usage) lastUsage = chunk.usage;
			}
			expect(lastUsage).toBeDefined();
			expect(lastUsage.total_tokens).toBe(15);
		});

		it('流式也支持 #error-401', async () => {
			const messages: Message[] = [{ role: 'user', content: '#error-401 测试' }];
			await expect(async () => {
				for await (const _ of provider.chatStream(messages)) {
					// 不应到达
				}
			}).rejects.toThrow(ApiError);
		});

		it('流式支持自定义 model', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			let modelName = '';
			for await (const chunk of provider.chatStream(messages, { model: 'my-model' })) {
				if (!modelName) modelName = chunk.model;
			}
			expect(modelName).toBe('my-model');
		});

		it('流式 chunk 格式与真实 API 一致', async () => {
			const messages: Message[] = [{ role: 'user', content: '你好' }];
			for await (const chunk of provider.chatStream(messages)) {
				expect(chunk).toHaveProperty('id');
				expect(chunk).toHaveProperty('object', 'chat.completion.chunk');
				expect(chunk).toHaveProperty('created');
				expect(chunk).toHaveProperty('model');
				expect(chunk).toHaveProperty('choices');
				expect(chunk.choices[0]).toHaveProperty('delta');
				break; // 只验证第一个 chunk
			}
		});
	});

	describe('历史消息过滤', () => {
		it('只取最后一条 user 消息', async () => {
			const messages: Message[] = [
				{ role: 'system', content: '你是一个助手。' },
				{ role: 'user', content: '#error-401' },
				{ role: 'assistant', content: '好的。' },
				{ role: 'user', content: '你好' },
			];
			const resp = await provider.chat(messages);
			// 应该跳过 #error-401（在 assistant 之前），取最后一条 "你好"
			expect(resp.choices[0].message?.content).toBe('你好，我是测试提供商。');
		});

		it('无 user 消息默认回复', async () => {
			const messages: Message[] = [{ role: 'system', content: '你是一个助手。' }];
			const resp = await provider.chat(messages);
			expect(resp.choices[0].message?.content).toContain('你说了');
		});
	});

	describe('构造函数', () => {
		it('默认模型名为 mock-chat', () => {
			const p = new MockProvider();
			expect(p).toBeInstanceOf(MockProvider);
		});

		it('可自定义模型名', () => {
			const p = new MockProvider('test-model-v1');
			expect(p).toBeInstanceOf(MockProvider);
		});
	});
});
