/**
 * deriveSessionTitle — 会话标题派生单元测试
 */
import { describe, it, expect } from 'vitest';
import { deriveSessionTitle, SESSION_TITLE_MAX_CHARS } from '../../src/core/session.js';

describe('deriveSessionTitle', () => {
	it('普通单行消息直接作为标题', () => {
		expect(deriveSessionTitle('帮我重构 session 模块')).toBe('帮我重构 session 模块');
	});

	it('多行消息取第一条非空行', () => {
		expect(deriveSessionTitle('\n\n第一句话\n第二句话')).toBe('第一句话');
	});

	it('剥离 [shell_start]...[shell_end] 上下文块', () => {
		const content = '[shell_start]\nls -la\nfile1.txt\n[shell_end]\n请分析这个目录';
		expect(deriveSessionTitle(content)).toBe('请分析这个目录');
	});

	it('压缩连续空白为单空格', () => {
		expect(deriveSessionTitle('  你好    世界  ')).toBe('你好 世界');
	});

	it('超过 20 字符截断（按码点，中文计数）', () => {
		const long = '一二三四五六七八九十一二三四五六七八九十一二三四五'; // 25 字
		const title = deriveSessionTitle(long);
		expect(Array.from(title)).toHaveLength(SESSION_TITLE_MAX_CHARS);
		expect(title).toBe('一二三四五六七八九十一二三四五六七八九十');
	});

	it('空内容返回空串', () => {
		expect(deriveSessionTitle('')).toBe('');
		expect(deriveSessionTitle('   \n  ')).toBe('');
	});
});
