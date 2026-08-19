/**
 * SubagentRecordView 单元测试
 */
import { describe, it, expect } from 'vitest';
import { SubagentRecordView } from '../../src/render/subagent-record-view.js';
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
