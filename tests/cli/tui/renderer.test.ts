/**
 * renderer 纯函数测试
 */
import { describe, it, expect } from 'vitest';
import { stripAnsi, strDisplayWidth, isWideChar, charDisplayWidth, truncateByWidth, formatToolCallSummary } from '../../../src/cli/tui/renderer.js';

describe('stripAnsi', () => {
	it('should strip simple color codes', () => {
		expect(stripAnsi('\x1b[36mcyan\x1b[0m')).toBe('cyan');
	});

	it('should strip multiple codes', () => {
		expect(stripAnsi('\x1b[1mBold\x1b[0m and \x1b[2mdim\x1b[0m')).toBe('Bold and dim');
	});

	it('should strip background color codes', () => {
		expect(stripAnsi('\x1b[48;5;238mgray bg\x1b[0m')).toBe('gray bg');
	});

	it('should handle empty string', () => {
		expect(stripAnsi('')).toBe('');
	});

	it('should handle string without ANSI codes', () => {
		expect(stripAnsi('plain text')).toBe('plain text');
	});

	it('should strip cursor movement codes', () => {
		expect(stripAnsi('\x1b[2K\x1b[0J')).toBe('');
	});

	it('should strip complex sequences like clear line', () => {
		expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden');
	});
});

describe('strDisplayWidth', () => {
	it('should count ASCII characters as 1', () => {
		expect(strDisplayWidth('hello')).toBe(5);
	});

	it('should count CJK characters as 2', () => {
		expect(strDisplayWidth('你好')).toBe(4);
	});

	it('should handle mixed content', () => {
		expect(strDisplayWidth('hello世界')).toBe(9);
	});

	it('should handle empty string', () => {
		expect(strDisplayWidth('')).toBe(0);
	});
});

describe('truncateByWidth', () => {
	it('should not truncate short strings', () => {
		expect(truncateByWidth('hello', 10)).toBe('hello');
	});

	it('should truncate and add ellipsis', () => {
		const result = truncateByWidth('hello world', 5);
		expect(result).toBe('hello…');
		expect(strDisplayWidth(result)).toBeLessThanOrEqual(6); // 5 + ellipsis
	});
});

describe('formatToolCallSummary', () => {
	it('execute_command 只显示命令本身（多行合并、超长截断）', () => {
		expect(formatToolCallSummary('execute_command', { command: 'git status', cwd: '/x' }))
			.toBe('git status');
		expect(formatToolCallSummary('execute_command', { command: 'echo a\n echo b' }))
			.toBe('echo a echo b');
		const long = 'x'.repeat(150);
		expect(formatToolCallSummary('execute_command', { command: long }).length).toBe(100);
	});

	it('文件工具显示路径（write/edit/read）', () => {
		expect(formatToolCallSummary('write_file', { path: '/tmp/a.ts', content: '...' })).toBe('/tmp/a.ts');
		expect(formatToolCallSummary('edit_file', { path: 'src/x.ts', old_string: 'a', new_string: 'b' })).toBe('src/x.ts');
		expect(formatToolCallSummary('read_file', { path: './y.ts', offset: 1 })).toBe('./y.ts');
	});

	it('browser_navigate 显示 URL，search_content 显示 pattern', () => {
		expect(formatToolCallSummary('browser_navigate', { url: 'https://example.com' })).toBe('https://example.com');
		expect(formatToolCallSummary('search_content', { pattern: 'foo|bar', path: '.' })).toBe('foo|bar');
	});

	it('其他工具显示 JSON 摘要（超长截断）', () => {
		expect(formatToolCallSummary('browser_click', { text: 'button', role: 'button' }))
			.toBe(JSON.stringify({ text: 'button', role: 'button' }));
		const big = JSON.stringify({ data: 'y'.repeat(200) });
		expect(formatToolCallSummary('tui_capture', { data: 'y'.repeat(200) }).length).toBe(80);
	});
});
