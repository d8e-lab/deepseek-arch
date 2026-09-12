/**
 * subagent_trace 工具 — 查看子代理的执行轨迹（工具调用与文本输出）
 *
 * 回答「这个子代理到底干了什么」：按运行分组列出 tool_call(name + args) 与 content。
 * 不含思维链（thinking）与工具结果（tool_result）——避免上下文膨胀；
 * 「谁跟它说了什么」的对话视角请用 wait（返回对话投影）。
 *
 * Agent Loop 拦截此工具做特殊处理（读取内部会话状态）。
 * 此文件中的 execute 仅为 fallback（返回占位错误）。
 */

import type { SubagentRoundEntry } from '../types/subagent.js';
import type { Tool, ToolResult } from './types.js';

/** 轨迹渲染所需的最小会话视图（结构化类型，避免 tools → core 反向依赖） */
export interface TraceableSubagent {
	runs: {
		userText: string;
		source: string;
		status: string;
		entries: SubagentRoundEntry[];
	}[];
}

/** 单条参数/文本的展示上限 */
const MAX_ARG_CHARS = 200;
const MAX_TEXT_CHARS = 300;
const MAX_INPUT_CHARS = 80;

/** 轨迹条目：tool_call 与 content（thinking / tool_result / tool_output 一律丢弃） */
interface TraceItem {
	run: number;
	kind: 'tool' | 'text';
	text: string;
}

/** 收集轨迹条目（保持时间序；run 从 1 开始编号） */
function collectTrace(sub: TraceableSubagent): TraceItem[] {
	const items: TraceItem[] = [];
	sub.runs.forEach((run, idx) => {
		for (const entry of run.entries) {
			if (entry.type === 'tool_call') {
				const args = entry.toolArgs ? truncate(JSON.stringify(entry.toolArgs), MAX_ARG_CHARS) : '{}';
				items.push({ run: idx + 1, kind: 'tool', text: `${entry.toolName ?? '?'} ${args}` });
			} else if (entry.type === 'content' && entry.content.trim()) {
				items.push({ run: idx + 1, kind: 'text', text: truncate(entry.content.trim(), MAX_TEXT_CHARS) });
			}
		}
	});
	return items;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 渲染子代理轨迹文本。
 * @param limit 最多返回多少条轨迹条目（0 = 全部）；超出时保留最近的部分并标注省略数
 */
export function formatSubagentTrace(name: string, sub: TraceableSubagent, limit = 0): string {
	const all = collectTrace(sub);
	const omitted = limit > 0 && all.length > limit ? all.length - limit : 0;
	const items = omitted > 0 ? all.slice(omitted) : all;

	const lines: string[] = [
		`Subagent "${name}" — execution trace (${sub.runs.length} run${sub.runs.length === 1 ? '' : 's'}, ` +
		`${items.length} of ${all.length} entr${all.length === 1 ? 'y' : 'ies'}${omitted > 0 ? `, ${omitted} older omitted` : ''})`,
		'',
	];

	sub.runs.forEach((run, idx) => {
		const label = run.source === 'task' ? 'task' : run.source === 'user' ? 'user' : 'master';
		lines.push(`[run ${idx + 1}] ${label}: ${truncate(run.userText, MAX_INPUT_CHARS)}  (${run.status})`);
		const runItems = items.filter((i) => i.run === idx + 1);
		if (runItems.length === 0) {
			lines.push('  (no tool calls or text in this run)');
		} else {
			for (const item of runItems) {
				lines.push(item.kind === 'tool' ? `  - tool: ${item.text}` : `  - text: ${item.text}`);
			}
		}
		lines.push('');
	});

	lines.push('(thinking and tool results are omitted on purpose — use wait("<name>") for the user ↔ subagent dialogue)');
	return lines.join('\n').trimEnd();
}

export const subagentTraceTool: Tool = {
	name: 'subagent_trace',
	description:
		'Inspect what a subagent actually did — the tools it called (name + arguments) and the text it produced, ' +
		'grouped by run. Thinking and tool results are omitted on purpose. ' +
		'Use this to audit a long-running subagent, or to see what a cancelled/failed one had done before it stopped. ' +
		'Read-only: it does not acknowledge or consume anything (use wait for the user ↔ subagent dialogue).',
	parameters: {
		type: 'object',
		properties: {
			subagent_name: {
				type: 'string',
				description: 'Name of the subagent (from subagent_spawn).',
			},
			limit: {
				type: 'number',
				description:
					'Optional cap on how many trace entries to return (most recent kept). ' +
					'Omit to get the full run history.',
			},
		},
		required: ['subagent_name'],
	},
	requiresConfirm: false,

	async execute(_params, _signal): Promise<ToolResult> {
		return {
			content: 'subagent_trace must be called from within an active agent loop. No subagent context available.',
			error: 'not_in_loop',
		};
	},
};
