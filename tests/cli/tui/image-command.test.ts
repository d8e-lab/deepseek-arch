/**
 * TUI 图片附件命令测试
 *
 * 覆盖 /image 命令的附加/列表/去重/clear/remove 分支、内联引用合并去重、
 * 非视觉模型告警与用户消息回显（[image: ...]）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TuiApp } from '../../../src/presentation/tui-app.js';
import type { SessionManager } from '../../../src/core/session.js';
import type { ImageAttachment } from '../../../src/types/index.js';
import type { TuiConfig } from '../../../src/presentation/types.js';
import { stripAnsi } from '../../../src/render/ansi.js';

function attachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
	return {
		path: 'images/abc.png',
		mime: 'image/png',
		bytes: 2048,
		sha256: 'abc',
		name: 'a.png',
		width: 100,
		height: 50,
		...overrides,
	};
}

interface AppInternals {
	handleImageCommand: (arg: string) => Promise<boolean>;
	prepareImages: (content: string) => Promise<ImageAttachment[]>;
	formatUserEcho: (content: string, images: ImageAttachment[]) => string;
	pendingImages: ImageAttachment[];
}

describe('TUI /image 命令', () => {
	let writes: string[];
	const origWrite = process.stdout.write;
	let attached: ImageAttachment[];
	let inline: ImageAttachment[];
	let attachError: Error | null;

	function makeApp(model = 'deepseek-flash'): { app: TuiApp; internals: AppInternals } {
		const partial = {
			resolveInlineImages: async () => ({ images: inline, skipped: [] }),
			attachImage: async () => {
				if (attachError) throw attachError;
				return attached.shift()!;
			},
			getSession: () => ({
				meta: { id: 'm', title: '', created_at: '', updated_at: '', turnCount: 0, totalCost: 0 },
				turns: [],
				systemPrompt: undefined,
			}),
			getSubagentAsync: () => false,
		} as unknown as Partial<SessionManager>;

		const config: TuiConfig = {
			provider: 'test',
			model,
			baseUrl: 'http://example.com',
			apiKey: 'k',
			version: '2.1.0',
			visionModels: ['deepseek-flash'],
		};
		const app = new TuiApp(partial as SessionManager, config);
		return { app, internals: app as unknown as AppInternals };
	}

	beforeEach(() => {
		writes = [];
		attached = [];
		inline = [];
		attachError = null;
		process.stdout.write = ((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		process.stdout.write = origWrite;
	});

	it('附加图片：写入待发列表并提示摘要', async () => {
		attached = [attachment()];
		const { internals } = makeApp();

		await internals.handleImageCommand('/tmp/a.png');

		expect(internals.pendingImages).toHaveLength(1);
		const out = stripAnsi(writes.join(''));
		expect(out).toContain('[image attached] a.png (2.0 KB, 100×50)');
		expect(out).toContain('Pending: 1 image(s)');
	});

	it('同一张图重复附加只保留一份', async () => {
		attached = [attachment(), attachment({ name: 'copy.png' })];
		const { internals } = makeApp();

		await internals.handleImageCommand('/tmp/a.png');
		await internals.handleImageCommand('/tmp/copy.png');

		expect(internals.pendingImages).toHaveLength(1);
		expect(stripAnsi(writes.join(''))).toContain('[image already attached: copy.png]');
	});

	it('附加失败（格式不支持等）不进入列表并显示原因', async () => {
		const { ImageError } = await import('../../../src/core/image.js');
		attachError = new ImageError('unsupported_format', 'Unsupported image format: x.txt');
		const { internals } = makeApp();

		await internals.handleImageCommand('/tmp/x.txt');

		expect(internals.pendingImages).toHaveLength(0);
		expect(stripAnsi(writes.join(''))).toContain('Image error: Unsupported image format: x.txt');
	});

	it('查看列表与 clear/remove', async () => {
		attached = [attachment(), attachment({ sha256: 'def', name: 'b.png', path: 'images/def.png' })];
		const { internals } = makeApp();
		await internals.handleImageCommand('/tmp/a.png');
		await internals.handleImageCommand('/tmp/b.png');
		writes.length = 0;

		await internals.handleImageCommand('');            // 列表
		const listed = stripAnsi(writes.join(''));
		expect(listed).toContain('Pending images (2)');
		expect(listed).toContain('a.png');
		expect(listed).toContain('b.png');

		await internals.handleImageCommand('remove 1');
		expect(internals.pendingImages.map((a) => a.name)).toEqual(['b.png']);

		await internals.handleImageCommand('remove 9');    // 越界
		expect(stripAnsi(writes.join(''))).toContain('Usage: /image remove <1-1>');

		await internals.handleImageCommand('clear');
		expect(internals.pendingImages).toHaveLength(0);
	});

	it('内联 @路径 与待发列表合并，同一张图只发一次', async () => {
		attached = [attachment()];
		const { internals } = makeApp();
		await internals.handleImageCommand('/tmp/a.png');

		inline = [attachment()]; // 与待发列表同一张（sha256 相同）
		const images = await internals.prepareImages('看看 @/tmp/a.png');

		expect(images).toHaveLength(1);
	});

	it('内联引用的图片按顺序追加到待发列表之后', async () => {
		attached = [attachment({ sha256: 'aaa', name: 'pending.png' })];
		inline = [attachment({ sha256: 'bbb', name: 'inline.png', path: 'images/bbb.png' })];
		const { internals } = makeApp();
		await internals.handleImageCommand('/tmp/pending.png');

		const images = await internals.prepareImages('看看 @/tmp/inline.png');

		expect(images.map((a) => a.name)).toEqual(['pending.png', 'inline.png']);
	});

	it('非视觉模型带图发送时给出告警（不阻断）', async () => {
		attached = [attachment()];
		const { internals } = makeApp('deepseek-v4-pro');

		await internals.handleImageCommand('/tmp/a.png');

		expect(stripAnsi(writes.join(''))).toContain('may not accept image input');
		expect(internals.pendingImages).toHaveLength(1); // 仍然附加成功
	});

	it('用户消息回显包含图片摘要', () => {
		const { internals } = makeApp();
		const echo = internals.formatUserEcho('看这张图', [attachment()]);
		expect(stripAnsi(echo)).toBe('看这张图 [image: a.png]');
		expect(internals.formatUserEcho('无图', [])).not.toContain('[image');
	});
});
