/**
 * ConversationView / wrapText / truncateThink 单元测试
 */
import { describe, it, expect } from 'vitest';
import { ConversationView, wrapText, truncateThink } from '../../src/render/conversation.js';
import { stripAnsi } from '../../src/render/ansi.js';
import type { TurnRecord } from '../../src/types/index.js';

/** 构造最小 TurnRecord */
function makeTurn(user: string, reply = 'reply', reasoning?: string): TurnRecord {
	return {
		version: 2,
		messages: [
			{ role: 'user', content: user },
			{ role: 'assistant', content: reply, reasoning_content: reasoning },
		],
		cost_rmb: 0,
		created_at: new Date().toISOString(),
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

describe('wrapText', () => {
	it('短文本不折行', () => {
		expect(wrapText('hello', 10)).toEqual(['hello']);
	});

	it('超宽文本按显示宽度折行', () => {
		expect(wrapText('hello world', 5)).toEqual(['hello', ' worl', 'd']);
	});

	it('CJK 宽字符按 2 列计算', () => {
		const lines = wrapText('你好世界', 4);
		expect(lines).toEqual(['你好', '世界']);
	});

	it('空行保留', () => {
		expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
	});
});

describe('truncateThink', () => {
	it('不超行数不截断', () => {
		const r = truncateThink('line1\nline2', 5);
		expect(r.isTruncated).toBe(false);
		expect(r.display).toBe('line1\nline2');
	});

	it('超行数截断并标记', () => {
		const r = truncateThink('l1\nl2\nl3\nl4\nl5\nl6', 4);
		expect(r.isTruncated).toBe(true);
		expect(r.display).toBe('l1\nl2\nl3\nl4');
	});
});

describe('ConversationView', () => {
	it('渲染用户消息（[You] 标签）', () => {
		const view = new ConversationView();
		const lines = view.render([makeTurn('hello')], 80);
		const plain = lines.map(stripAnsi);
		expect(plain.some(l => l.includes('[You]') && l.includes('hello'))).toBe(true);
	});

	it('渲染回复内容', () => {
		const view = new ConversationView();
		const lines = view.render([makeTurn('hi', 'world reply')], 80);
		const plain = lines.map(stripAnsi);
		expect(plain.some(l => l.includes('world reply'))).toBe(true);
	});

	it('渲染 think 内容（[Think] 标签）', () => {
		const view = new ConversationView();
		const lines = view.render([makeTurn('hi', 'reply', 'deep thinking')], 80);
		const plain = lines.map(stripAnsi);
		expect(plain.some(l => l.includes('deep thinking'))).toBe(true);
	});

	it('renderToText 返回无 ANSI 的纯文本行', () => {
		const view = new ConversationView();
		const lines = view.renderToText([makeTurn('hello', 'reply')], 80);
		for (const line of lines) {
			expect(line).not.toMatch(/\x1b\[/);
		}
	});

	it('多轮渲染顺序：用户在前、回复在后', () => {
		const view = new ConversationView();
		const lines = view.renderToText([makeTurn('first', 'first-reply'), makeTurn('second', 'second-reply')], 80);
		const firstIdx = lines.findIndex(l => l.includes('first-reply'));
		const secondIdx = lines.findIndex(l => l.includes('second-reply'));
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeGreaterThan(firstIdx);
	});
});
