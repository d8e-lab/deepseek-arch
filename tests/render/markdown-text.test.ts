/**
 * render/markdown-text 单元测试
 *
 * 描述：renderMarkdownText 渲染纯文本/表格/折行/缩进；空文本返回空。
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdownText } from '../../src/render/markdown-text.js';
import { stripAnsi } from '../../src/render/ansi.js';

describe('renderMarkdownText', () => {
	it('空文本返回空数组', () => {
		expect(renderMarkdownText('', 80)).toEqual([]);
	});

	it('纯文本原样输出（折行）', () => {
		const lines = renderMarkdownText('hello world', 80);
		expect(lines).toEqual(['hello world']);
	});

	it('多行文本逐行输出', () => {
		const lines = renderMarkdownText('line1\nline2\nline3', 80);
		expect(lines).toEqual(['line1', 'line2', 'line3']);
	});

	it('长文本按宽度折行', () => {
		const text = 'a'.repeat(100);
		const lines = renderMarkdownText(text, 30);
		expect(lines.length).toBe(4); // 30*3 + 10
		expect(lines.every((l) => l.length <= 30)).toBe(true);
	});

	it('markdown 表格渲染为 box-drawing', () => {
		const md = '| a | b |\n|---|--:|\n| 1 | 2 |';
		const lines = renderMarkdownText(md, 80);
		const plain = lines.map(stripAnsi).join('\n');
		expect(plain).toContain('┌');
		expect(plain).toContain('a');
		expect(plain).toContain('b');
	});

	it('prefix 缩进应用到每一行', () => {
		const lines = renderMarkdownText('hello\nworld', 80, '  ');
		expect(lines).toEqual(['  hello', '  world']);
	});

	it('表格行也带前缀', () => {
		const lines = renderMarkdownText('| a |\n|---|\n| 1 |', 80, '  ');
		expect(lines.every((l) => l.startsWith('  '))).toBe(true);
	});
});
