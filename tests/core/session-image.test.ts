/**
 * 图片附件与会话集成测试
 *
 * 覆盖：附加落盘 → 发送时物化为 base64 内容块 → turn 只持久化引用 →
 * resume 后历史图片仍可重放 → 资产缺失降级 → 超限抛错不落盘。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../../src/core/storage.js';
import { SessionManager } from '../../src/core/session.js';
import { ImageError } from '../../src/core/image.js';
import type { ModelProvider } from '../../src/core/model-provider.js';
import type {
	ApiMessage,
	ChatCompletionResponse,
	ImageAttachment,
	Message,
	StreamChunk,
} from '../../src/types/index.js';
import { turnUserImages } from '../../src/utils/turn-utils.js';

/** 最小 PNG 头（宽高在偏移 16/20） */
function pngBuffer(width = 64, height = 32): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(8);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	return Buffer.concat([
		signature,
		Buffer.from([0, 0, 0, 13]),
		Buffer.from('IHDR', 'ascii'),
		ihdr,
		Buffer.alloc(8),
	]);
}

function makeResponse(): ChatCompletionResponse {
	return {
		id: 'chatcmpl-img-001',
		object: 'chat.completion',
		created: 0,
		model: 'deepseek-flash',
		choices: [{ index: 0, message: { role: 'assistant', content: '我看到了一张图片。' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	};
}

/** 记录每次 provider 收到的上线消息 */
function capturingProvider(calls: ApiMessage[][]): ModelProvider {
	return {
		async chat(messages: ApiMessage[]): Promise<ChatCompletionResponse> {
			calls.push(messages);
			return makeResponse();
		},
		async *chatStream(messages: ApiMessage[]): AsyncGenerator<StreamChunk> {
			calls.push(messages);
			yield {
				id: 'chunk-1',
				object: 'chat.completion.chunk',
				created: 0,
				model: 'deepseek-flash',
				choices: [{ index: 0, delta: { content: '我看到了一张图片。' }, finish_reason: 'stop' }],
			};
		},
	};
}

/** 取出消息中的内容块（非数组时为空） */
function blocksOf(message: ApiMessage): Array<{ type: string; text?: string; image_url?: { url: string } }> {
	return Array.isArray(message.content) ? message.content as never : [];
}

describe('SessionManager 图片附件', () => {
	let dir: string;
	let storage: Storage;
	let calls: ApiMessage[][];
	let manager: SessionManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'deepseek-session-image-'));
		storage = new Storage(dir);
		calls = [];
		manager = new SessionManager(storage, capturingProvider(calls));
		await manager.startNewSession('图片测试');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('未创建会话时附加图片报 no_session', async () => {
		const fresh = new SessionManager(storage, capturingProvider([]));
		await expect(fresh.attachImage('/tmp/a.png')).rejects.toMatchObject({ code: 'no_session' });
	});

	it('附加图片写入会话资产目录，并在发送时物化为 base64 块', async () => {
		const shot = join(dir, 'shot.png');
		await writeFile(shot, pngBuffer(128, 64));

		const att = await manager.attachImage(shot);
		expect(att.mime).toBe('image/png');
		expect(att.path.startsWith('images/')).toBe(true);

		const turn = await manager.sendMessageStream('这张图里有什么？', () => {}, undefined, undefined, [att]);
		expect(turn).not.toBeNull();

		// provider 收到块数组
		const sent = calls.at(-1)!;
		const userMsg = sent.find((m) => m.role === 'user')!;
		const blocks = blocksOf(userMsg);
		expect(blocks[0]).toEqual({ type: 'text', text: '这张图里有什么？' });
		expect(blocks[1].image_url?.url).toMatch(/^data:image\/png;base64,/);

		// turn 只持久化引用，不含 base64
		expect(turnUserImages(turn!)).toHaveLength(1);
		const sessionId = manager.getSession()!.meta.id;
		const meta = JSON.parse(await readFile(join(dir, sessionId, 'meta.json'), 'utf-8'));
		expect(meta.turnCount).toBe(1);

		const files = await readdir(join(dir, sessionId));
		const turnsFile = files.find((f) => f.startsWith('turn_')) ?? 'turns.json';
		const raw = await readFile(join(dir, sessionId, turnsFile), 'utf-8');
		expect(raw).toContain('"images"');
		expect(raw).toContain(att.sha256);
		expect(raw).not.toContain('base64');
		expect(raw).not.toContain(pngBuffer(128, 64).toString('base64'));
	});

	it('resume 后历史轮次的图片仍能重放为内容块', async () => {
		const shot = join(dir, 'a.png');
		await writeFile(shot, pngBuffer(10, 10));
		const att = await manager.attachImage(shot);
		await manager.sendMessageStream('第一轮', () => {}, undefined, undefined, [att]);

		const sessionId = manager.getSession()!.meta.id;
		const resumed = new SessionManager(storage, capturingProvider(calls));
		await resumed.resumeSession(sessionId);
		await resumed.sendMessageStream('第二轮', () => {});

		const sent = calls.at(-1)!;
		const historyUser = sent.filter((m) => m.role === 'user')[0];
		expect(blocksOf(historyUser)[1].image_url?.url).toMatch(/^data:image\/png;base64,/);
		expect(sent.filter((m) => m.role === 'user')[1].content).toBe('第二轮');
	});

	it('资产被删除后降级为 unavailable 文本块，不阻断发送', async () => {
		const shot = join(dir, 'gone.png');
		await writeFile(shot, pngBuffer(8, 8));
		const att = await manager.attachImage(shot);
		await manager.sendMessageStream('第一轮', () => {}, undefined, undefined, [att]);

		// 删除资产文件
		await unlink(join(dir, manager.getSession()!.meta.id, att.path));

		const turn = await manager.sendMessageStream('第二轮', () => {});
		expect(turn).not.toBeNull();
		const sent = calls.at(-1)!;
		const firstUser = sent.find((m) => m.role === 'user')!;
		const texts = blocksOf(firstUser).filter((b) => b.type === 'text').map((b) => b.text ?? '');
		expect(texts.join('\n')).toContain('[image unavailable: gone.png]');
	});

	it('内联 @路径 自动附加；不存在的路径静默忽略', async () => {
		const shot = join(dir, 'inline.png');
		await writeFile(shot, pngBuffer(16, 16));

		const resolved = await manager.resolveInlineImages(`看看 @${shot} 和 @${join(dir, 'missing.png')}`);
		expect(resolved.images).toHaveLength(1);
		expect(resolved.images[0].mime).toBe('image/png');
		expect(resolved.skipped).toEqual([]);
	});

	it('非图片文件不会被内联识别', async () => {
		const txt = join(dir, 'note.png');
		await writeFile(txt, 'plain text');
		const resolved = await manager.resolveInlineImages(`@${txt}`);
		expect(resolved.images).toHaveLength(0);
	});

	it('超过限额的图片在 attach 阶段即报错（不落盘、不发送）', async () => {
		const huge = join(dir, 'huge.png');
		const buf = Buffer.alloc(33 * 1024 * 1024);
		pngBuffer(2, 2).copy(buf);
		await writeFile(huge, buf);

		await expect(manager.attachImage(huge)).rejects.toBeInstanceOf(ImageError);
	});

	it('sendMessage（非流式）同样物化图片并持久化引用', async () => {
		const shot = join(dir, 'nonstream.png');
		await writeFile(shot, pngBuffer(20, 20));
		const att = await manager.attachImage(shot);

		const { turn } = await manager.sendMessage('非流式带图', [att]);
		expect(turnUserImages(turn)).toHaveLength(1);
		const blocks = blocksOf(calls.at(-1)!.find((m: Message) => m.role === 'user')!);
		expect(blocks[1].type).toBe('image_url');
	});
});
