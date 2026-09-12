/**
 * subagent-trace.test.ts — formatSubagentTrace 单元测试
 *
 * 覆盖：只含 tool_call 与 content（排除 thinking/tool_result/tool_output）、
 * 按 run 分组标注来源与状态、limit 截断保留最近条目、超长截断。
 */
import { describe, it, expect } from 'vitest';
import { formatSubagentTrace } from '../../src/tools/subagent-trace.js';
import type { SubagentRoundEntry } from '../../src/types/index.js';

function run(
	userText: string,
	source: 'task' | 'user' | 'master',
	status: string,
	entries: SubagentRoundEntry[],
) {
	return { userText, source, status, entries };
}

describe('formatSubagentTrace', () => {
	it('只保留 tool_call 与 content：thinking / tool_result / tool_output 一律排除', () => {
		const trace = formatSubagentTrace('sub1', {
			runs: [
				run('任务A', 'task', 'completed', [
					{ type: 'thinking', content: '内部推理不该出现', timestamp: 1 },
					{ type: 'content', content: '我要先看看文件', timestamp: 2 },
					{ type: 'tool_call', content: 'read_file', toolName: 'read_file', toolArgs: { path: 'src/a.ts' }, timestamp: 3 },
					{ type: 'tool_result', content: '文件内容不该出现', timestamp: 4 },
					{ type: 'tool_output', content: 'stdout 不该出现', outputStream: 'stdout', timestamp: 5 },
					{ type: 'content', content: '看完了', timestamp: 6 },
				]),
			],
		});

		expect(trace).toContain('tool: read_file {"path":"src/a.ts"}');
		expect(trace).toContain('text: 我要先看看文件');
		expect(trace).toContain('text: 看完了');
		expect(trace).not.toContain('内部推理不该出现');
		expect(trace).not.toContain('文件内容不该出现');
		expect(trace).not.toContain('stdout 不该出现');
	});

	it('按 run 分组，标注来源（task/user/master）与状态', () => {
		const trace = formatSubagentTrace('sub1', {
			runs: [
				run('最初任务', 'task', 'completed', [
					{ type: 'content', content: '第一轮结论', timestamp: 1 },
				]),
				run('用户追问', 'user', 'cancelled', [
					{ type: 'tool_call', content: 'shell', toolName: 'shell', toolArgs: { command: 'ls' }, timestamp: 2 },
				]),
			],
		});

		expect(trace).toContain('[run 1] task: 最初任务  (completed)');
		expect(trace).toContain('[run 2] user: 用户追问  (cancelled)');
		expect(trace).toContain('- text: 第一轮结论');
		expect(trace).toContain('- tool: shell {"command":"ls"}');
		expect(trace).toContain('2 runs');
	});

	it('limit 保留最近条目并标注省略数量', () => {
		const entries: SubagentRoundEntry[] = Array.from({ length: 10 }, (_, i) => ({
			type: 'content' as const,
			content: `输出${i}`,
			timestamp: i,
		}));
		const trace = formatSubagentTrace('sub1', { runs: [run('任务', 'task', 'completed', entries)] }, 3);

		expect(trace).toContain('3 of 10 entries');
		expect(trace).toContain('7 older omitted');
		// 保留最近 3 条（输出7/8/9），较早的被省略
		expect(trace).toContain('text: 输出9');
		expect(trace).not.toContain('text: 输出0');
	});

	it('空轨迹与超长内容都能安全渲染', () => {
		const empty = formatSubagentTrace('sub1', { runs: [] });
		expect(empty).toContain('0 runs');

		const long = formatSubagentTrace('sub1', {
			runs: [
				run('任务', 'task', 'completed', [
					{ type: 'tool_call', content: 'shell', toolName: 'shell', toolArgs: { command: 'x'.repeat(500) }, timestamp: 1 },
				]),
			],
		});
		expect(long).toContain('…'); // 超长参数被截断
		expect(long.length).toBeLessThan(1000);
	});
});
