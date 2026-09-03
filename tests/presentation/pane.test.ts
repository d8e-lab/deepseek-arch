/**
 * CommandResultPane / SuggestionPane 单元测试
 *
 * 描述：直接实例化 Pane（注入 fake out），验证命令结果折行渲染与
 * 建议列表滚动/高亮/折叠（复用 render/list）。
 */
import { describe, it, expect } from 'vitest';
import { CommandResultPane } from '../../src/presentation/views/command-result-pane.js';
import { SuggestionPane } from '../../src/presentation/views/suggestion-pane.js';
import { ScreenBuffer } from '../../src/presentation/screen-buffer.js';
import { stripAnsi } from '../../src/render/ansi.js';

function makeOut(): { out: ScreenBuffer; writes: string[] } {
	const writes: string[] = [];
	const out = new ScreenBuffer({ write: (s: string) => writes.push(s) });
	return { out, writes };
}

describe('CommandResultPane', () => {
	it('空内容渲染 0 行', () => {
		const { out } = makeOut();
		const pane = new CommandResultPane();
		expect(pane.render(out, 80)).toBe(0);
		expect(pane.getLineCount()).toBe(0);
	});

	it('push 后渲染：每行 │ 前缀 + 清行序列 + 物理行数', () => {
		const { out, writes } = makeOut();
		const pane = new CommandResultPane();
		pane.push('hello');
		pane.push('world');
		expect(pane.getLineCount()).toBe(2);
		const rows = pane.render(out, 80);
		expect(rows).toBe(2);
		const text = stripAnsi(writes.join(''));
		expect(text).toContain('│ hello');
		expect(text).toContain('│ world');
		expect(writes.join('')).toContain('\r\n\x1b[2K');
	});

	it('clear 后不再渲染', () => {
		const { out, writes } = makeOut();
		const pane = new CommandResultPane();
		pane.push('x');
		pane.clear();
		expect(pane.render(out, 80)).toBe(0);
		expect(writes.join('')).toBe('');
	});

	it('长行按可用宽度折行（前缀占 2 列）', () => {
		const { out } = makeOut();
		const pane = new CommandResultPane();
		pane.push('a'.repeat(100));
		const rows = pane.render(out, 20);
		// 可用 18 列 → 100 字符折成 6 行
		expect(rows).toBe(6);
	});
});

describe('SuggestionPane', () => {
	it('空建议渲染 0 行', () => {
		const { out } = makeOut();
		const pane = new SuggestionPane();
		expect(pane.render(out, [], 0, 80)).toBe(0);
	});

	it('不超出窗口：全量渲染 + 选中高亮', () => {
		const { out, writes } = makeOut();
		const pane = new SuggestionPane();
		const rows = pane.render(out, ['/model', '/help', '/exit'], 1, 80);
		expect(rows).toBe(3);
		const text = writes.join('');
		expect(text).toContain('▸ /help'); // 选中行 ▸ 前缀
		expect(text).toContain('/model');
	});

	it('超出窗口：折叠提示 + 选中滑窗', () => {
		const items = ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i', '/j'];
		const { out, writes } = makeOut();
		const pane = new SuggestionPane();
		const rows = pane.render(out, items, 0, 80);
		expect(rows).toBe(9); // 8 条 + 1 折叠行
		expect(stripAnsi(writes.join(''))).toContain('... and 2 more');
	});

	it('selectedIdx=-1：无高亮（所有行 dim，无 ▸）', () => {
		const { out, writes } = makeOut();
		const pane = new SuggestionPane();
		pane.render(out, ['/a', '/b'], -1, 80);
		const text = stripAnsi(writes.join(''));
		expect(text).not.toContain('▸');
	});

	it('渲染从输入行下一行开始（先 \\r\\n）', () => {
		const { out, writes } = makeOut();
		const pane = new SuggestionPane();
		pane.render(out, ['/a'], 0, 80);
		expect(writes.join('').startsWith('\r\n')).toBe(true);
	});
});
