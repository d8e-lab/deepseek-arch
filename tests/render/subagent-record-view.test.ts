/**
 * SubagentRecordView 单元测试
 */
import { describe, it, expect } from 'vitest';
import { SubagentRecordView, isWordFragmentRun } from '../../src/render/subagent-record-view.js';
import { stripAnsi } from '../../src/render/ansi.js';
import type { SubagentRecord } from '../../src/types/index.js';

function makeRecord(entries: SubagentRecord['entries'] = [], status: SubagentRecord['status'] = 'completed'): SubagentRecord {
	return {
		name: 'sub-test',
		task: '测试任务',
		status,
		startMs: 1000,
		endMs: status === 'running' ? undefined : 2000,
		entries,
		result: status === 'completed' ? '最终结果' : undefined,
	};
}

describe('SubagentRecordView', () => {
	const view = new SubagentRecordView();

	it('渲染头部（名称/任务/图标）', () => {
		const lines = view.renderToText(makeRecord(), 80);
		const head = lines.join('\n');
		expect(head).toContain('═══ Subagent: sub-test');
		expect(head).toContain('Task: 测试任务');
	});

	it('running 状态显示 ⏳ 图标', () => {
		const lines = view.renderToText(makeRecord([], 'running'), 80);
		expect(lines.join('\n')).toContain('⏳');
	});

	it('completed 状态显示 ✓ 图标', () => {
		const lines = view.renderToText(makeRecord([], 'completed'), 80);
		expect(lines.join('\n')).toContain('✓');
	});

	it('thinking 条目不渲染', () => {
		const lines = view.renderToText(makeRecord([
			{ type: 'thinking', content: '深思中', timestamp: 1 },
		]), 80);
		expect(lines.join('\n')).not.toContain('深思中');
	});

	it('content 条目渲染（缩进 2 空格）', () => {
		const lines = view.renderToText(makeRecord([
			{ type: 'content', content: '这是子代理的回复', timestamp: 1 },
		]), 80);
		expect(lines.some(l => l.includes('  这是子代理的回复'))).toBe(true);
	});

	it('连续 content 条目合并渲染（不逐条拆行）', () => {
		// 流式按行记录的碎条目：合并成完整段落渲染
		const lines = view.renderToText(makeRecord([
			{ type: 'content', content: '第一行', timestamp: 1 },
			{ type: 'content', content: '第二行', timestamp: 2 },
			{ type: 'content', content: '第三行', timestamp: 3 },
		]), 80);
		const text = lines.join('\n');
		expect(text).toContain('  第一行');
		expect(text).toContain('  第二行');
		expect(text).toContain('  第三行');
	});

	it('旧版词碎片记录：连续 content 直接拼接还原原文（不逐词成行）', () => {
		// 1b9c1d7 之前的历史记录：每条 = 一个流式 token
		const words = '以下是按严重度分组的真实缺陷（均有文件:行号证据，已交叉验证）。'.split(/(?<=。|（|）|，|:|)/).filter(Boolean);
		const frags = words.length > 0 ? words : ['碎片1', '碎片2', '碎片3', '碎片4', '碎片5', '碎片6'];
		const entries = frags.map((w, i) => ({ type: 'content' as const, content: w, timestamp: i }));
		const lines = view.renderToText(makeRecord(entries), 80);
		const text = lines.join('\n');
		// 词流被拼接成连续文本（同一行/连续 wrap 行内包含前后词），而非每个词单独成行
		const flat = stripAnsi(text).replace(/\s+/g, '');
		expect(flat).toContain('以下是按严重度分组的真实缺陷');
	});

	it('isWordFragmentRun 判定：短碎词流为 true，正常行/过短为 false', () => {
		expect(isWordFragmentRun(['已', '完成', '排', '查', '。', '以', '下', '是'])).toBe(true);
		// 不足 5 条 → false（按行处理）
		expect(isWordFragmentRun(['第一行', '第二行'])).toBe(false);
		// 含长 token（>40）→ false
		const longTok = ['x'.repeat(50)];
		expect(isWordFragmentRun(['短', '词', '流', '但', ...longTok, 'a', 'b', 'c', 'd', 'e'])).toBe(false);
		// 正常长行（平均 >10）→ false
		expect(isWordFragmentRun([
			'这是一个正常长度的文本行内容用于测试',
			'这是另一行正常长度的文本行内容测试',
			'第三行也是正常长度的内容用于测试判断',
			'第四行依旧正常长度的文本内容用于测试',
			'第五行正常长度的文本内容用于判定函数',
		])).toBe(false);
	});

	it('markdown 表格跨 content 条目渲染完整', () => {
		// 表格行被拆成多条 entry（流式按行记录）：合并后表格完整渲染
		const lines = view.renderToText(makeRecord([
			{ type: 'content', content: '| A | B |', timestamp: 1 },
			{ type: 'content', content: '|---|---|', timestamp: 2 },
			{ type: 'content', content: '| 1 | 2 |', timestamp: 3 },
		]), 80);
		const text = lines.join('\n');
		// 表格渲染为 box-drawing 行（含 │ 与 ─）
		expect(text).toContain('│');
		expect(text).toContain('─');
	});

	it('tool_call 复用 ● run 格式', () => {
		const lines = view.renderToText(makeRecord([
			{ type: 'tool_call', content: '', toolName: 'shell', toolArgs: { command: 'ls' }, timestamp: 1 },
		]), 80);
		expect(lines.join('\n')).toContain('● run shell');
	});

	it('tool_result 复用 │ 竖线格式', () => {
		const lines = view.renderToText(makeRecord([
			{ type: 'tool_result', content: 'result-line', timestamp: 1 },
		]), 80);
		expect(lines.some(l => l.includes('│') && l.includes('result-line'))).toBe(true);
	});

	it('tool_result 错误渲染', () => {
		const lines = view.renderToText(makeRecord([
			{ type: 'tool_result', content: '', toolError: 'boom', timestamp: 1 },
		]), 80);
		expect(lines.join('\n')).toContain('Error: boom');
	});

	it('tool_output stderr 与 stdout 区分', () => {
		const stderrLines = view.renderToText(makeRecord([
			{ type: 'tool_output', content: 'err', outputStream: 'stderr', timestamp: 1 },
		]), 80);
		expect(stderrLines.some(l => l.includes('err'))).toBe(true);

		const stdoutLines = view.renderToText(makeRecord([
			{ type: 'tool_output', content: 'out', outputStream: 'stdout', timestamp: 1 },
		]), 80);
		expect(stdoutLines.some(l => l.includes('out'))).toBe(true);
	});

	it('渲染最终结果', () => {
		const lines = view.renderToText(makeRecord(), 80);
		expect(lines.join('\n')).toContain('── Final Result ──');
		expect(lines.join('\n')).toContain('最终结果');
	});

	it('render 返回带 ANSI 的行，renderToText 返回纯文本', () => {
		const ansi = view.render(makeRecord(), 80);
		const plain = view.renderToText(makeRecord(), 80);
		expect(ansi.some(l => l.includes('\x1b['))).toBe(true);
		for (const l of plain) {
			expect(l).not.toMatch(/\x1b\[/);
		}
	});
});
