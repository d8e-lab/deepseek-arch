/**
 * image-refs.ts 单元测试
 *
 * 覆盖：`@路径` 显式引用、拖拽绝对路径、引号/转义空格、`~/`、`file://`、
 * 标点剥离、相对裸路径不识别、扩展名预筛、去重。
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractImageRefs, resolveUserPath } from '../../src/core/image-refs.js';

const CWD = '/work/project';

describe('extractImageRefs', () => {
	it('识别 @ 显式引用的相对与绝对路径', () => {
		expect(extractImageRefs('看看 @./shot.png', CWD).map((h) => h.path))
			.toEqual([resolve(CWD, './shot.png')]);
		expect(extractImageRefs('看看 @/tmp/a.jpg', CWD).map((h) => h.path))
			.toEqual(['/tmp/a.jpg']);
		expect(extractImageRefs('@images/b.webp 是啥', CWD).map((h) => h.path))
			.toEqual([resolve(CWD, 'images/b.webp')]);
	});

	it('识别拖拽产生的绝对路径裸文本', () => {
		const hits = extractImageRefs('这张图 /tmp/drag/drop.gif 里有什么', CWD);
		expect(hits).toEqual([{ raw: '/tmp/drag/drop.gif', path: '/tmp/drag/drop.gif', explicit: false }]);
	});

	it('识别引号包裹与反斜杠转义空格的路径', () => {
		expect(extractImageRefs('@"my shot.png"', CWD)[0].path).toBe(resolve(CWD, 'my shot.png'));
		expect(extractImageRefs('"/tmp/my shot.png"', CWD)[0].path).toBe('/tmp/my shot.png');
		expect(extractImageRefs('/tmp/my\\ shot.png', CWD)[0].path).toBe('/tmp/my shot.png');
	});

	it('展开 ~/ 与 file:// 前缀', () => {
		expect(extractImageRefs('@~/pic.png', CWD)[0].path).toBe(join(homedir(), 'pic.png'));
		expect(extractImageRefs('file:///tmp/x.png', CWD)[0].path).toBe('/tmp/x.png');
		expect(extractImageRefs('@file:///tmp/with%20space.png', CWD)[0].path).toBe('/tmp/with space.png');
	});

	it('剥离紧贴路径的英文/中文标点', () => {
		expect(extractImageRefs('look at @/tmp/a.png, please', CWD)[0].path).toBe('/tmp/a.png');
		expect(extractImageRefs('看这张@/tmp/a.png。', CWD)[0].path).toBe('/tmp/a.png');
		expect(extractImageRefs('[/tmp/a.png]', CWD)[0].path).toBe('/tmp/a.png');
	});

	it('相对裸路径不识别（避免正文提及仓库文件被误判）', () => {
		expect(extractImageRefs('改一下 assets/logo.png 的尺寸', CWD)).toEqual([]);
		expect(extractImageRefs('src/render/a.jpeg', CWD)).toEqual([]);
	});

	it('非图片扩展名不进入候选（含 @ 引用）', () => {
		expect(extractImageRefs('@notes.txt', CWD)).toEqual([]);
		expect(extractImageRefs('/tmp/archive.tar.gz', CWD)).toEqual([]);
	});

	it('忽略 URL 中的路径段', () => {
		expect(extractImageRefs('https://example.com/a.png', CWD)).toEqual([]);
	});

	it('同一路径只返回一次', () => {
		const hits = extractImageRefs('@/tmp/a.png 和 /tmp/a.png', CWD);
		expect(hits).toHaveLength(1);
	});

	it('空文本与无引用文本返回空数组', () => {
		expect(extractImageRefs('', CWD)).toEqual([]);
		expect(extractImageRefs('普通的一句话，没有图片', CWD)).toEqual([]);
	});

	it('多个引用保持出现顺序', () => {
		const hits = extractImageRefs('@/tmp/a.png 然后 /tmp/b.jpg', CWD);
		expect(hits.map((h) => h.path)).toEqual(['/tmp/a.png', '/tmp/b.jpg']);
	});
});

describe('resolveUserPath', () => {
	it('归一化各类写法', () => {
		expect(resolveUserPath('/abs/a.png', CWD)).toBe('/abs/a.png');
		expect(resolveUserPath('rel/a.png', CWD)).toBe(resolve(CWD, 'rel/a.png'));
		expect(resolveUserPath('~/a.png', CWD)).toBe(join(homedir(), 'a.png'));
		expect(resolveUserPath('"quoted a.png"', CWD)).toBe(resolve(CWD, 'quoted a.png'));
		expect(resolveUserPath('file:///tmp/a.png', CWD)).toBe('/tmp/a.png');
	});
});
