/**
 * ConversationView — 对话历史渲染
 *
 * 职责：
 *   1. 按轮次渲染对话历史（user → think → reply）
 *   2. think 内容最多显示 4 行，超出截断并显示 "..."
 *   3. 长文本自动换行（基于终端宽度）
 */

import type { TurnRecord, TokenUsage } from '../../types/index.js';
import { strDisplayWidth, cyan, dim, green, red, renderDiffLine, stripAnsi } from './renderer.js';
import { MarkdownTableRenderer } from './markdown.js';

/** think 最大显示行数 */
const THINK_MAX_LINES = 4;

/**
 * 将长文本按显示宽度折行
 */
export function wrapText(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	const lines: string[] = [];
	for (const rawLine of text.split('\n')) {
		if (rawLine === '') {
			lines.push('');
			continue;
		}
		let current = '';
		let currentWidth = 0;
		for (const ch of rawLine) {
			const cw = strDisplayWidth(ch);
			if (currentWidth + cw > maxWidth) {
				lines.push(current);
				current = ch;
				currentWidth = cw;
			} else {
				current += ch;
				currentWidth += cw;
			}
		}
		if (current) lines.push(current);
	}
	return lines;
}

/**
 * 截断 think 内容到指定行数
 * @returns {display, isTruncated}
 */
export function truncateThink(
	content: string,
	maxLines: number = THINK_MAX_LINES,
): { display: string; isTruncated: boolean } {
	const lines = content.split('\n');
	if (lines.length <= maxLines) {
		return { display: content, isTruncated: false };
	}
	return { display: lines.slice(0, maxLines).join('\n'), isTruncated: true };
}

/** 格式化 token 用量信息 */
function formatUsage(usage?: TokenUsage): string {
	if (!usage) return '';
	const parts: string[] = [];
	if (usage.prompt_tokens > 0) parts.push(`${usage.prompt_tokens} in`);
	if (usage.completion_tokens > 0) parts.push(`${usage.completion_tokens} out`);
	if (usage.total_tokens > 0) parts.push(`${usage.total_tokens} total`);
	if (parts.length === 0) return '';
	return `token: ${parts.join(' + ')}`;
}

/** 格式化为 CNY */
function formatCost(costRmb: number): string {
	if (costRmb === 0) return '';
	return `CNY ${costRmb.toFixed(4)}`;
}

export class ConversationView {
	/**
	 * 渲染全部对话轮次为行数组
	 * 调用方负责根据终端高度决定显示哪些行（从底部截取）
	 */
	render(turns: TurnRecord[], termWidth: number): string[] {
		const lines: string[] = [];

		for (let ti = 0; ti < turns.length; ti++) {
			const turn = turns[ti];
			if (ti > 0) lines.push('');

			// 用户消息（绿色）
			const userLabel = green('[You] ');
			const userLabelWidth = strDisplayWidth('[You] ');
			const userWrapped = wrapText(turn.user.content, termWidth - userLabelWidth);
			for (let i = 0; i < userWrapped.length; i++) {
				if (i === 0) {
					lines.push(userLabel + green(userWrapped[i]));
				} else {
					lines.push(' '.repeat(userLabelWidth) + green(userWrapped[i]));
				}
			}

			lines.push('');

			// Think 区域（灰色）
			if (turn.assistant.reasoning_content) {
				const { display, isTruncated } = truncateThink(turn.assistant.reasoning_content);
				const thinkLabel = dim('[Think] ');
				const thinkLabelWidth = strDisplayWidth('[Think] ');
				const thinkLines = display.split('\n');

				for (let i = 0; i < thinkLines.length; i++) {
					const wrapped = wrapText(thinkLines[i], termWidth - thinkLabelWidth);
					for (let j = 0; j < wrapped.length; j++) {
						if (i === 0 && j === 0) {
							lines.push(thinkLabel + dim(wrapped[j]));
						} else {
							lines.push(' '.repeat(thinkLabelWidth) + dim(wrapped[j]));
						}
					}
				}

				if (isTruncated) {
					lines.push(' '.repeat(thinkLabelWidth) + dim('...'));
				}

				lines.push('');
			}

			// 工具调用记录
			const tcRecords = (turn as any).tool_calls;
			if (tcRecords && Array.isArray(tcRecords) && tcRecords.length > 0) {
				for (const tcr of tcRecords) {
					const shortName = tcr.name.replace('execute_', '');
					const label = cyan(`[T: ${shortName}] `);
					const labelWidth = strDisplayWidth(`[T: ${shortName}] `);
					const argsStr = JSON.stringify(tcr.arguments);
					lines.push(label + dim(`${argsStr}  (${tcr.duration_ms}ms)`));

					if (tcr.preview) {
						for (const line of tcr.preview.split('\n')) {
							lines.push(renderDiffLine(line, ''));
						}
					}
					if (tcr.error) {
						const errLabel = tcr.error === 'denied' ? '[Denied]' : `Error: ${tcr.error}`;
						lines.push(' '.repeat(labelWidth) + red(errLabel));
					}
					if (tcr.result) {
						const resultLines = tcr.result.split('\n').slice(0, 6);
						for (const rl of resultLines) {
							lines.push(cyan(' │ ') + dim(rl));
						}
						if (tcr.result.split('\n').length > 6) {
							lines.push(cyan(' │ ') + dim('...'));
						}
					}
				}
				lines.push('');
			}

			// 模型回复（默认颜色，表格渲染）
			const mdRenderer = new MarkdownTableRenderer();
			const rendered = mdRenderer.feed(turn.assistant.content) ?? [];
			rendered.push(...(mdRenderer.flush() ?? []));
			for (const rline of rendered) {
				for (const wline of wrapText(rline, termWidth)) {
					lines.push(wline);
				}
			}

			// 用量信息
			const usageStr = formatUsage(turn.usage);
			const costStr = formatCost(turn.cost_rmb);
			const footer: string[] = [];
			if (usageStr) footer.push(usageStr);
			if (costStr) footer.push(costStr);
			if (turn.interrupted) footer.push('[interrupted]');
			if (footer.length > 0) {
				lines.push('');
				lines.push(dim('--- ' + footer.join(', ') + ' ---'));
			}
		}

		return lines;
	}

	/**
	 * 计算对话历史总行数
	 */
	getLineCount(turns: TurnRecord[], termWidth: number): number {
		return this.render(turns, termWidth).length;
	}

	/**
	 * 渲染对话历史为纯文本（剥离 ANSI 颜色码）
	 * 供 tui_capture / tui_render_preview 工具使用，让模型看到结构化渲染结果
	 */
	renderToText(turns: TurnRecord[], termWidth: number): string[] {
		return this.render(turns, termWidth).map(line => stripAnsi(line));
	}
}
