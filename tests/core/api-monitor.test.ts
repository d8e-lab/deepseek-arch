/**
 * ApiMonitor 请求监听测试
 *
 * 验证：
 * 1. saveApiRequest 原封不动保存请求记录
 * 2. ApiClient 配置 mirrorUrl 后，chat/chatStream 每次请求都镜像到监听进程
 * 3. setSessionId 关联会话（X-Session-Id 头 → 按会话目录保存）
 * 4. 镜像失败静默（监听未启动不影响主请求）
 *
 * 说明：镜像发送使用 node:http（不经过全局 fetch），
 * 因此 stub 全局 fetch 只影响主请求，不影响镜像链路——测试全链路真实。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ApiClient } from '../../src/core/api.js';
import { startApiMonitor, saveApiRequest } from '../../src/core/api-monitor.js';
import type { ChatCompletionResponse, Message } from '../../src/types/index.js';

/** 轮询等待 dir 下出现 expected 个文件（镜像请求为异步 fire-and-forget） */
async function waitForFiles(
	dir: string,
	expected: number,
	timeoutMs = 3000,
): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const files = await readdir(dir);
			if (files.length >= expected) return files.sort();
		} catch {
			/* 目录尚未创建（saveApiRequest 首次 mkdir） */
		}
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timeout waiting for ${expected} file(s) in ${dir}`);
}

/** 标准非流式响应 */
function mockChatResponse(): ChatCompletionResponse {
	return {
		id: 'chatcmpl-monitor-001',
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: 'deepseek-v4-pro',
		choices: [
			{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
		],
		usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
	};
}

function sseChunk(obj: Record<string, unknown>): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

/** 从预定义字符串数组创建 SSE ReadableStream */
function mockSSEStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) controller.enqueue(encoder.encode(line));
			controller.close();
		},
	});
}

describe('api-monitor 请求监听', () => {
	let monitors: Server[] = [];
	let tempDirs: string[] = [];
	let originalFetch: typeof globalThis.fetch;

	/** 启动监听进程（随机端口），返回 server / port / outDir */
	async function startMonitor(): Promise<{ server: Server; port: number; outDir: string }> {
		const outDir = await mkdtemp(join(tmpdir(), 'api-monitor-test-'));
		tempDirs.push(outDir);
		const server = startApiMonitor({ port: 0, outDir });
		monitors.push(server);
		await new Promise<void>((resolve) => server.once('listening', resolve));
		const addr = server.address() as AddressInfo;
		return { server, port: addr.port, outDir };
	}

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
		for (const s of monitors) s.close();
		monitors = [];
		for (const d of tempDirs) {
			await rm(d, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	it('saveApiRequest 原封不动保存请求记录', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'api-monitor-test-'));
		tempDirs.push(outDir);

		const record = {
			received_at: '2026-08-06T00:00:00.000Z',
			session_id: 'sess-1',
			endpoint: '/v1/chat/completions',
			body: {
				model: 'deepseek-v4-pro',
				messages: [{ role: 'user', content: 'hi' }],
				stream: false,
			},
		};
		const path = await saveApiRequest(outDir, record);
		expect(path).toContain('sess-1');

		const saved = JSON.parse(await readFile(path, 'utf-8'));
		expect(saved.body).toEqual(record.body); // 请求体原封不动
		expect(saved.session_id).toBe('sess-1');
		expect(saved.received_at).toBe('2026-08-06T00:00:00.000Z');
	});

	it('chat() 每次请求同步镜像到监听进程，body 与请求一致', async () => {
		const { port, outDir } = await startMonitor();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockChatResponse()),
		});

		const client = new ApiClient(
			'https://api.deepseek.com',
			'sk-test',
			'deepseek-v4-pro',
			`http://127.0.0.1:${port}`,
		);
		const messages: Message[] = [{ role: 'user', content: '你好' }];
		await client.chat(messages);

		const files = await waitForFiles(join(outDir, 'nosession'), 1);
		const saved = JSON.parse(
			await readFile(join(outDir, 'nosession', files[0]), 'utf-8'),
		);
		expect(saved.body.model).toBe('deepseek-v4-pro');
		expect(saved.body.messages).toEqual(messages);
		expect(saved.body.stream).toBe(false);
	});

	it('setSessionId 后镜像按会话目录保存（X-Session-Id 关联）', async () => {
		const { port, outDir } = await startMonitor();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockChatResponse()),
		});

		const client = new ApiClient(
			'https://api.deepseek.com',
			'sk-test',
			'deepseek-v4-pro',
			`http://127.0.0.1:${port}`,
		);
		client.setSessionId('sess-abc');
		await client.chat([{ role: 'user', content: 'test' }]);

		const files = await waitForFiles(join(outDir, 'sess-abc'), 1);
		const saved = JSON.parse(
			await readFile(join(outDir, 'sess-abc', files[0]), 'utf-8'),
		);
		expect(saved.session_id).toBe('sess-abc');
	});

	it('chatStream() 流式请求也镜像', async () => {
		const { port, outDir } = await startMonitor();
		const chunks = [
			sseChunk({
				id: 'chatcmpl-001',
				object: 'chat.completion.chunk',
				created: 1234567890,
				model: 'deepseek-v4-pro',
				choices: [
					{ index: 0, delta: { content: 'hi' }, finish_reason: null },
				],
			}),
		];
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			body: mockSSEStream(chunks),
		});

		const client = new ApiClient(
			'https://api.deepseek.com',
			'sk-test',
			'deepseek-v4-pro',
			`http://127.0.0.1:${port}`,
		);
		for await (const _ of client.chatStream([{ role: 'user', content: '你好' }])) {
			/* consume */
		}

		const files = await waitForFiles(join(outDir, 'nosession'), 1);
		const saved = JSON.parse(
			await readFile(join(outDir, 'nosession', files[0]), 'utf-8'),
		);
		expect(saved.body.stream).toBe(true);
		expect(saved.body.messages[0].content).toBe('你好');
	});

	it('镜像失败静默：监听未启动不影响主请求', async () => {
		// 先占一个端口再关闭，确保该端口未监听
		const { server, port } = await startMonitor();
		server.close();
		monitors = monitors.filter((s) => s !== server);

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockChatResponse()),
		});

		const client = new ApiClient(
			'https://api.deepseek.com',
			'sk-test',
			'deepseek-v4-pro',
			`http://127.0.0.1:${port}`,
		);
		const result = await client.chat([{ role: 'user', content: 'test' }]);
		expect(result.choices[0].message.content).toBe('ok');
		expect(globalThis.fetch).toHaveBeenCalledTimes(1); // 主请求只发一次，未受影响
	});

	it('未配置 mirrorUrl 时不发镜像请求', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockChatResponse()),
		});

		const client = new ApiClient('https://api.deepseek.com', 'sk-test', 'deepseek-v4-pro');
		await client.chat([{ role: 'user', content: 'test' }]);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});
