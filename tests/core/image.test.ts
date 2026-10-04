/**
 * image.ts 单元测试
 *
 * 覆盖：格式嗅探（按内容）、尺寸解析、限额校验、ImageStore 落盘/去重、
 * materializeMessages 内容块构造与整包预算、视觉模型判定。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	ImageError,
	ImageStore,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_DIMENSION,
	MAX_IMAGE_DIMENSION_MANY,
	MANY_IMAGES_THRESHOLD,
	MAX_IMAGES_PER_REQUEST,
	describeAttachment,
	formatBytes,
	isVisionModel,
	materializeMessages,
	readImageSize,
	sniffImageMime,
	toDataUrl,
} from '../../src/core/image.js';
import type { ImageAttachment, Message } from '../../src/types/index.js';

// ─── 测试用最小图片字节 ─────────────────────────────

/** PNG：签名 + IHDR（宽高在偏移 16/20，大端） */
function pngBuffer(width = 2, height = 3): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(8);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	const chunk = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'ascii'), ihdr, Buffer.alloc(4)]);
	return Buffer.concat([signature, chunk, Buffer.alloc(8)]);
}

/** GIF：GIF89a + 逻辑屏幕描述符（宽高在偏移 6/8，小端） */
function gifBuffer(width = 4, height = 5): Buffer {
	const buf = Buffer.alloc(20);
	buf.write('GIF89a', 0, 'ascii');
	buf.writeUInt16LE(width, 6);
	buf.writeUInt16LE(height, 8);
	return buf;
}

/** JPEG：SOI + APP0 + SOF0（高/宽跟在精度字节之后） */
function jpegBuffer(width = 6, height = 7): Buffer {
	const app0 = Buffer.alloc(2 + 16);
	app0[0] = 0xff;
	app0[1] = 0xe0;
	app0.writeUInt16BE(16, 2);

	const sof = Buffer.alloc(2 + 17);
	sof[0] = 0xff;
	sof[1] = 0xc0;
	sof.writeUInt16BE(17, 2);
	sof[4] = 8;
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);

	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** WebP（VP8X 扩展格式：canvas width-1 / height-1 为 3 字节小端） */
function webpBuffer(width = 8, height = 9): Buffer {
	const buf = Buffer.alloc(40);
	buf.write('RIFF', 0, 'ascii');
	buf.writeUInt32LE(32, 4);
	buf.write('WEBP', 8, 'ascii');
	buf.write('VP8X', 12, 'ascii');
	buf.writeUInt32LE(10, 16);
	buf.writeUIntLE(width - 1, 24, 3);
	buf.writeUIntLE(height - 1, 27, 3);
	return buf;
}

describe('sniffImageMime（按内容判定格式）', () => {
	it('识别四种支持格式', () => {
		expect(sniffImageMime(pngBuffer())).toBe('image/png');
		expect(sniffImageMime(jpegBuffer())).toBe('image/jpeg');
		expect(sniffImageMime(gifBuffer())).toBe('image/gif');
		expect(sniffImageMime(webpBuffer())).toBe('image/webp');
	});

	it('拒绝非图片内容与伪装扩展名（扩展名不参与判定）', () => {
		expect(sniffImageMime(Buffer.from('plain text, definitely not an image'))).toBeNull();
		expect(sniffImageMime(Buffer.from('%PDF-1.7\n...'))).toBeNull();
		expect(sniffImageMime(Buffer.alloc(4))).toBeNull();
	});
});

describe('readImageSize', () => {
	it('解析各格式像素尺寸', () => {
		expect(readImageSize(pngBuffer(1280, 720), 'image/png')).toEqual({ width: 1280, height: 720 });
		expect(readImageSize(gifBuffer(320, 240), 'image/gif')).toEqual({ width: 320, height: 240 });
		expect(readImageSize(jpegBuffer(1920, 1080), 'image/jpeg')).toEqual({ width: 1920, height: 1080 });
		expect(readImageSize(webpBuffer(800, 600), 'image/webp')).toEqual({ width: 800, height: 600 });
	});

	it('结构异常时返回 null（不阻断附加）', () => {
		expect(readImageSize(Buffer.alloc(8), 'image/png')).toBeNull();
		expect(readImageSize(Buffer.alloc(40), 'image/jpeg')).toBeNull();
	});
});

describe('toDataUrl / formatBytes / describeAttachment', () => {
	it('构造 base64 data URL', () => {
		const url = toDataUrl('image/png', Buffer.from('abc'));
		expect(url).toBe(`data:image/png;base64,${Buffer.from('abc').toString('base64')}`);
	});

	it('体积格式化', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
	});

	it('附件摘要包含名称/体积/尺寸', () => {
		const att: ImageAttachment = {
			path: 'images/x.png', mime: 'image/png', bytes: 2048, sha256: 'x', name: 'shot.png',
			width: 100, height: 50,
		};
		expect(describeAttachment(att)).toBe('shot.png (2.0 KB, 100×50)');
	});
});

describe('isVisionModel', () => {
	it('默认视觉模型中包含 deepseek-flash', () => {
		expect(isVisionModel('deepseek-flash')).toBe(true);
		expect(isVisionModel('DeepSeek-Flash')).toBe(true);
		expect(isVisionModel('deepseek-v4-flash-vision-exp')).toBe(true);
	});

	it('非视觉模型返回 false（含空值）', () => {
		expect(isVisionModel('deepseek-v4-pro')).toBe(false);
		expect(isVisionModel(undefined)).toBe(false);
		expect(isVisionModel('')).toBe(false);
	});

	it('接受额外配置的名单与 vision 命名兜底', () => {
		expect(isVisionModel('my-vl-model', ['my-vl-model'])).toBe(true);
		expect(isVisionModel('acme-vision-1')).toBe(true);
	});
});

describe('ImageStore', () => {
	let dir: string;
	let store: ImageStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'deepseek-image-test-'));
		store = new ImageStore(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('附加图片：复制到 images/<sha256>.<ext> 并解析元数据', async () => {
		const att = await store.attach(pngBuffer(100, 200), 'shot.png');

		expect(att.mime).toBe('image/png');
		expect(att.name).toBe('shot.png');
		expect(att.bytes).toBe(pngBuffer(100, 200).byteLength);
		expect(att.width).toBe(100);
		expect(att.height).toBe(200);
		expect(att.path).toBe(`images/${att.sha256}.png`);

		const onDisk = await readFile(join(dir, att.path));
		expect(onDisk.equals(pngBuffer(100, 200))).toBe(true);
	});

	it('内容寻址去重：同一张图只占一份资产', async () => {
		const a = await store.attach(pngBuffer(10, 10), 'a.png');
		const b = await store.attach(pngBuffer(10, 10), 'b.png');
		expect(a.path).toBe(b.path);
		expect((await store.load(a))?.byteLength).toBe(a.bytes);
	});

	it('同一份字节但不同格式文件名 → 仍按内容判定 MIME', async () => {
		const att = await store.attach(gifBuffer(3, 3), 'misleading.png');
		expect(att.mime).toBe('image/gif');
		expect(att.path.endsWith('.gif')).toBe(true);
	});

	it('拒绝不支持的格式', async () => {
		await expect(store.attach(Buffer.from('not an image at all'))).rejects.toBeInstanceOf(ImageError);
		await expect(store.attach(Buffer.from('not an image at all'))).rejects.toMatchObject({
			code: 'unsupported_format',
		});
	});

	it('拒绝超过 32 MiB 的单图', async () => {
		const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
		pngBuffer().copy(huge);
		await expect(store.attach(huge)).rejects.toMatchObject({ code: 'too_large' });
	});

	it('拒绝单边超过 8192 px 的图片', async () => {
		await expect(store.attach(pngBuffer(MAX_IMAGE_DIMENSION + 1, 10))).rejects.toMatchObject({
			code: 'dimension_exceeded',
		});
	});

	it('toDataUrl 返回可上线内容；资产缺失时返回 null', async () => {
		const att = await store.attach(pngBuffer(5, 5), 'x.png');
		expect(await store.toDataUrl(att)).toMatch(/^data:image\/png;base64,/);

		await store.remove(att);
		expect(await store.toDataUrl(att)).toBeNull();
	});

	it('文件名净化：去掉目录与超长部分', async () => {
		const att = await store.attach(pngBuffer(), `/tmp/${'x'.repeat(300)}.png`);
		expect(att.name.length).toBeLessThanOrEqual(120);
		expect(att.name).not.toContain('/');
	});
});

describe('materializeMessages', () => {
	let dir: string;
	let store: ImageStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'deepseek-materialize-test-'));
		await mkdir(join(dir, 'images'), { recursive: true });
		store = new ImageStore(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('无图片时零 I/O：原样返回（保持引用）', async () => {
		const messages: Message[] = [{ role: 'user', content: '你好' }];
		const result = await materializeMessages(messages, dir);
		expect(result).toBe(messages);
	});

	it('用户消息的图片引用 → base64 内容块（文本块在前）', async () => {
		const att = await store.attach(pngBuffer(4, 4), 'a.png');
		const result = await materializeMessages(
			[{ role: 'user', content: '这张图里有什么？', images: [att] }],
			dir,
		);

		const content = result[0].content;
		expect(Array.isArray(content)).toBe(true);
		const blocks = content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
		expect(blocks[0]).toEqual({ type: 'text', text: '这张图里有什么？' });
		expect(blocks[1].type).toBe('image_url');
		expect(blocks[1].image_url?.url).toMatch(/^data:image\/png;base64,/);
		// 引用字段不外泄到上线报文
		expect((result[0] as Record<string, unknown>).images).toBeUndefined();
	});

	it('无文本时只发送图片块', async () => {
		const att = await store.attach(pngBuffer(4, 4), 'a.png');
		const result = await materializeMessages([{ role: 'user', content: '', images: [att] }], dir);
		const blocks = result[0].content as Array<{ type: string }>;
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe('image_url');
	});

	it('detail 透传到 image_url', async () => {
		const att = { ...(await store.attach(pngBuffer(4, 4), 'a.png')), detail: 'low' as const };
		const result = await materializeMessages([{ role: 'user', content: 'x', images: [att] }], dir);
		const blocks = result[0].content as Array<{ image_url?: { detail?: string } }>;
		expect(blocks[1].image_url?.detail).toBe('low');
	});

	it('保留 tool_calls / reasoning_content 等字段', async () => {
		const result = await materializeMessages(
			[{
				role: 'assistant',
				content: 'ok',
				reasoning_content: 'think',
				tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
			}],
			dir,
		);
		expect(result[0].reasoning_content).toBe('think');
		expect(result[0].tool_calls?.[0].id).toBe('t1');
	});

	it('资产缺失 → 降级为 unavailable 文本块，不阻断整轮', async () => {
		const att = await store.attach(pngBuffer(4, 4), 'gone.png');
		await rm(join(dir, att.path));

		const result = await materializeMessages([{ role: 'user', content: '看图', images: [att] }], dir);
		const blocks = result[0].content as Array<{ type: string; text?: string }>;
		expect(blocks).toHaveLength(2);
		expect(blocks[1].text).toContain('[image unavailable: gone.png]');
	});

	it('超过 600 张 → too_many', async () => {
		const att = await store.attach(pngBuffer(4, 4), 'a.png');
		const images = Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, () => att);
		await expect(
			materializeMessages([{ role: 'user', content: 'x', images }], dir),
		).rejects.toMatchObject({ code: 'too_many' });
	});

	it('单请求图片总量超过 64 MiB → request_too_large', async () => {
		const att = await store.attach(pngBuffer(4, 4), 'a.png');
		const heavy = Array.from({ length: 4 }, (_, i) => ({ ...att, sha256: `h${i}`, bytes: 20 * 1024 * 1024 }));
		await expect(
			materializeMessages([{ role: 'user', content: 'x', images: heavy }], dir),
		).rejects.toMatchObject({ code: 'request_too_large' });
	});

	it('base64 膨胀后超过 48 MiB 请求体 → request_too_large', async () => {
		const att = await store.attach(pngBuffer(4, 4), 'a.png');
		// 3 × 20 MiB 原始字节未超 64 MiB 图片总量，但 base64 后 ≈80 MiB > 48 MiB
		const heavy = Array.from({ length: 3 }, (_, i) => ({ ...att, sha256: `h${i}`, bytes: 20 * 1024 * 1024 }));
		await expect(
			materializeMessages([{ role: 'user', content: 'x', images: heavy }], dir),
		).rejects.toMatchObject({ code: 'request_too_large' });
	});

	it('单张超过 8192 px → dimension_exceeded', async () => {
		const att = await store.attach(pngBuffer(4, 4), 'a.png');
		const big = { ...att, width: MAX_IMAGE_DIMENSION + 1, height: 100 };
		await expect(
			materializeMessages([{ role: 'user', content: 'x', images: [big] }], dir),
		).rejects.toMatchObject({ code: 'dimension_exceeded' });
	});

	it(`≥${MANY_IMAGES_THRESHOLD} 张时像素上限收紧到 ${MAX_IMAGE_DIMENSION_MANY}`, async () => {
		const att = await store.attach(pngBuffer(4, 4), 'a.png');
		const many = Array.from({ length: MANY_IMAGES_THRESHOLD }, () => ({
			...att,
			width: MAX_IMAGE_DIMENSION_MANY + 1,
			height: 10,
		}));
		await expect(
			materializeMessages([{ role: 'user', content: 'x', images: many }], dir),
		).rejects.toMatchObject({ code: 'dimension_exceeded' });
	});

	it('历史轮次的图片同样被物化（跨轮次上下文）', async () => {
		const att = await store.attach(pngBuffer(4, 4), 'old.png');
		const messages: Message[] = [
			{ role: 'user', content: '第一轮', images: [att] },
			{ role: 'assistant', content: '看到了' },
			{ role: 'user', content: '第二轮' },
		];
		const result = await materializeMessages(messages, dir);
		expect(Array.isArray(result[0].content)).toBe(true);
		expect(result[2].content).toBe('第二轮');
	});
});
