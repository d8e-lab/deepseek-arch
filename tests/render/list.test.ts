/**
 * render/list 单元测试
 *
 * 描述：computeListWindow 滚动窗口边界；renderListLine 选中样式；
 * renderSelectList 折叠提示与窗口滑动。
 */
import { describe, it, expect } from 'vitest';
import { computeListWindow, renderListLine, renderSelectList } from '../../src/render/list.js';
import { stripAnsi } from '../../src/render/ansi.js';

describe('computeListWindow', () => {
	it('总数不超过窗口：全量显示，无折叠', () => {
		expect(computeListWindow(5, 0, 8)).toEqual({ start: 0, end: 5, beforeMore: 0, afterMore: 0 });
		expect(computeListWindow(5, 4, 8)).toEqual({ start: 0, end: 5, beforeMore: 0, afterMore: 0 });
	});

	it('选中在窗口内（前部）：窗口固定从 0 开始', () => {
		const win = computeListWindow(20, 2, 8);
		expect(win).toEqual({ start: 0, end: 8, beforeMore: 0, afterMore: 12 });
	});

	it('选中超过窗口：窗口下滑保证选中可见', () => {
		const win = computeListWindow(20, 10, 8);
		expect(win.start).toBe(10 - 8 + 1); // 3
		expect(win.end).toBe(11);
		expect(win.beforeMore).toBe(3);
		expect(win.afterMore).toBe(9);
	});

	it('选中在末尾：窗口贴底', () => {
		const win = computeListWindow(20, 19, 8);
		expect(win).toEqual({ start: 12, end: 20, beforeMore: 12, afterMore: 0 });
	});
});

describe('renderListLine', () => {
	it('选中项带 ▸ 前缀与 cyan 高亮', () => {
		const line = renderListLine('hello', true, 20);
		expect(line).toContain('\x1b[36m'); // cyan
		expect(stripAnsi(line)).toContain('▸ hello');
	});

	it('未选中项带缩进前缀与 dim', () => {
		const line = renderListLine('hello', false, 20);
		expect(line).toContain('\x1b[2m'); // dim
		expect(stripAnsi(line)).toContain('  hello');
	});

	it('宽度填充到目标宽度', () => {
		const line = stripAnsi(renderListLine('ab', true, 10));
		expect(line.length).toBe(10); // '▸ ' 占 2 显示宽度 + 'ab' + 6 空格
	});
});

describe('renderSelectList', () => {
	const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

	it('空列表返回空数组', () => {
		expect(renderSelectList([], 0, { width: 20 })).toEqual([]);
	});

	it('不超出窗口：全量渲染无折叠提示', () => {
		const lines = renderSelectList(['a', 'b'], 0, { width: 20 });
		expect(lines.length).toBe(2);
		expect(lines.every((l) => !l.includes('more'))).toBe(true);
	});

	it('超出窗口：尾部折叠提示', () => {
		const lines = renderSelectList(items, 0, { maxVisible: 8, width: 20 });
		expect(lines.length).toBe(9); // 8 条 + 1 折叠行
		expect(stripAnsi(lines[8])).toContain('... and 2 more');
	});

	it('选中滑出窗口：前部折叠提示出现、贴底无尾部折叠', () => {
		const lines = renderSelectList(items, 9, { maxVisible: 8, width: 20 });
		const plain = lines.map(stripAnsi);
		expect(plain[0]).toContain('... 2 more');
		expect(lines.some((l) => l.includes('and '))).toBe(false); // 贴底无尾部折叠
		expect(lines.length).toBe(9); // 1 折叠 + 8 条
	});

	it('选中高亮仅作用于选中行', () => {
		const lines = renderSelectList(items, 5, { maxVisible: 8, width: 20 });
		const highlighted = lines.filter((l) => l.includes('\x1b[36m'));
		expect(highlighted.length).toBe(1);
		expect(stripAnsi(highlighted[0])).toContain('f');
	});
});
