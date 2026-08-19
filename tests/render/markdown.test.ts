/**
 * MarkdownTableRenderer 单元测试
 *
 * 重点覆盖"无换行的流式文本堆积在缓冲、直到 flush 才输出"的机制，
 * 该机制是 agent loop 中 content 正文实时渲染（tool_call_start 时 flush）的基础。
 */
import { describe, it, expect } from 'vitest';
import { MarkdownTableRenderer } from '../../src/render/markdown.js';

describe('MarkdownTableRenderer', () => {
	it('完整行（含换行）立即输出', () => {
		const r = new MarkdownTableRenderer();
		expect(r.feed('第一行\n')).toEqual(['第一行']);
	});

	it('无换行的流式文本堆积在缓冲，直到 flush 才输出', () => {
		const r = new MarkdownTableRenderer();
		expect(r.feed('你好')).toEqual([]);
		expect(r.feed('，我是')).toEqual([]);
		expect(r.feed('测试内容')).toEqual([]);
		// flush 输出全部堆积内容
		expect(r.flush()).toEqual(['你好，我是测试内容']);
	});

	it('flush 后缓冲清空，可继续复用', () => {
		const r = new MarkdownTableRenderer();
		expect(r.feed('第一段')).toEqual([]);
		expect(r.flush()).toEqual(['第一段']);
		expect(r.feed('第二段\n')).toEqual(['第二段']);
	});

	it('多行文本逐行输出（中间无堆积）', () => {
		const r = new MarkdownTableRenderer();
		expect(r.feed('行1\n行2\n')).toEqual(['行1', '行2']);
	});

	it('markdown 表格块暂存，结束后一次性渲染为 box-drawing', () => {
		const r = new MarkdownTableRenderer();
		// 表头 + 分隔行：暂存（不输出）
		expect(r.feed('| a | b |\n')).toEqual([]);
		expect(r.feed('| --- | --- |\n')).toEqual([]);
		// 表格正文行：暂存
		expect(r.feed('| 1 | 2 |\n')).toEqual([]);
		// 表格结束（非表格行）：一次性渲染
		const out = r.feed('之后的内容\n');
		expect(out.length).toBeGreaterThanOrEqual(4); // 边框 + 表头 + 分隔 + 数据 + 底边框
		expect(out.join('\n')).toContain('┌');
		expect(out.join('\n')).toContain('│');
		expect(out[out.length - 1]).toBe('之后的内容');
	});
});
