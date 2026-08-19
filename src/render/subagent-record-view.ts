/**
 * SubagentRecordView — 子代理执行记录渲染（render SDK 组件）
 *
 * 渲染 SubagentRecord（task/entries/result）为 ANSI 行数组。
 * 工具调用 / 结果 / 错误复用主会话对话的渲染格式
 * （renderToolCallLine / renderToolResultLines / renderToolError），
 * 使「切换查看子代理」与主会话对话展示保持同一套渲染。
 *
 * 无 I/O：输出行数组，终端写入由表示层负责。
 */

import type { SubagentRecord, SubagentRoundEntry } from '../types/subagent.js';
import { cyan, dim, yellow, stripAnsi } from './ansi.js';
import { MarkdownTableRenderer } from './markdown.js';
import { renderToolCallLine, renderToolResultLines, renderToolError, wrapText } from './conversation.js';

export class SubagentRecordView {
	/**
	 * 渲染子代理记录为 ANSI 行数组
	 */
	render(record: SubagentRecord, termWidth: number): string[] {
		const lines: string[] = [];

		// ─── 头部 ──────────────────────────────
		const icon = record.status === 'running' ? '⏳'
			: record.status === 'completed' ? '✓'
			: '✗';
		const elapsedMs = (record.endMs ?? Date.now()) - record.startMs;
		const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;
		lines.push(yellow(`═══ Subagent: ${record.name} ${icon} ${dim(elapsed)} ═══`));
		lines.push(dim(`Task: ${record.task}`));
		const sepWidth = Math.max(20, Math.min(60, Math.max(1, termWidth - 2)));
		lines.push(dim('─'.repeat(sepWidth)));

		// ─── 输出条目 ──────────────────────────
		for (const entry of record.entries) {
			this.renderEntry(lines, entry, termWidth);
		}

		// ─── 最终结果 ──────────────────────────
		if (record.result) {
			lines.push(dim('── Final Result ──'));
			for (const line of record.result.split('\n')) {
				for (const wline of wrapText(line, Math.max(1, termWidth - 2))) {
					lines.push('  ' + wline);
				}
			}
		}

		lines.push(dim('─'.repeat(sepWidth)));
		return lines;
	}

	/** 渲染单个输出条目（追加到 lines） */
	private renderEntry(lines: string[], entry: SubagentRoundEntry, termWidth: number): void {
		switch (entry.type) {
			case 'thinking':
				// thinking 不渲染（太冗长），跳过
				break;
			case 'content': {
				// 复用主会话回复渲染：markdown 表格 + 折行，缩进 2 空格（子代理特有）
				const md = new MarkdownTableRenderer();
				const rendered = md.feed(entry.content) ?? [];
				rendered.push(...(md.flush() ?? []));
				for (const rline of rendered) {
					for (const wline of wrapText(rline, Math.max(1, termWidth - 2))) {
						lines.push('  ' + wline);
					}
				}
				break;
			}
			case 'tool_call':
				// 复用主会话工具调用格式：● run <name> <摘要>
				lines.push(renderToolCallLine(entry.toolName ?? '?', entry.toolArgs ?? {}));
				break;
			case 'tool_result': {
				lines.push(...renderToolResultLines(entry.content));
				if (entry.toolError) {
					lines.push(renderToolError(entry.toolError));
				}
				break;
			}
			case 'tool_output': {
				const isStderr = (entry.outputStream ?? 'stdout') === 'stderr';
				const prefix = isStderr ? yellow(' │ ') : cyan(' │ ');
				for (const line of entry.content.split('\n')) {
					lines.push(prefix + dim(line));
				}
				break;
			}
		}
	}

	/**
	 * 渲染为纯文本（剥离 ANSI 颜色码），供调试工具使用
	 */
	renderToText(record: SubagentRecord, termWidth: number): string[] {
		return this.render(record, termWidth).map(stripAnsi);
	}
}
