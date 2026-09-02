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
		// 合并连续 content 条目：流式输出被按 chunk/行拆成多条碎 entry，
		// 合并成完整段落再渲染（markdown 表格跨条目也完整）。
		//
		// 兼容两种 entry 形态：
		//  1. 按行记录（1b9c1d7 起）：每条 = 一行文本（行尾无 \n）→ 用 '\n' 连接还原行
		//  2. 词碎片记录（1b9c1d7 之前的历史记录）：每条 = 一个流式 token（如 '已完成'/'排查'/'。'）
		//     → 用 '' 直接拼接还原原文（token 序列无损；换行也是单独 token，拼回后自然保留）
		let contentBuffer: string[] = [];
		const flushContentBuffer = (): void => {
			if (contentBuffer.length === 0) return;
			const joined = isWordFragmentRun(contentBuffer)
				? contentBuffer.join('')
				: contentBuffer.join('\n');
			const md = new MarkdownTableRenderer();
			const rendered = md.feed(joined) ?? [];
			rendered.push(...(md.flush() ?? []));
			for (const rline of rendered) {
				for (const wline of wrapText(rline, Math.max(1, termWidth - 2))) {
					lines.push('  ' + wline);
				}
			}
			contentBuffer = [];
		};

		for (const entry of record.entries) {
			if (entry.type === 'content') {
				contentBuffer.push(entry.content);
				continue;
			}
			flushContentBuffer();
			this.renderEntry(lines, entry, termWidth);
		}
		flushContentBuffer();

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

/**
 * 判断连续 content 条目是否为「词碎片流」——1b9c1d7 之前的历史记录格式：
 * 每条 = 一个流式 token（如 '已完成'/'排查'/'。'，极短且海量）。
 * 词碎片需用 '' 直接拼接还原原文（token 序列无损，换行也是单独 token）；
 * 按行记录（每条一行、有正常长度/长行）用 '\n' 连接还原行。
 *
 * 判定保守：不足 5 条、平均 >10 字符或出现 >40 字符的 token 均视为按行，
 * 避免误伤正常段落（短列表/短句正文仍按行展示）。
 */
export function isWordFragmentRun(parts: string[]): boolean {
	if (parts.length < 5) return false;
	let total = 0;
	let max = 0;
	for (const p of parts) {
		total += p.length;
		if (p.length > max) max = p.length;
	}
	const avg = total / parts.length;
	return avg <= 10 && max <= 40;
}
