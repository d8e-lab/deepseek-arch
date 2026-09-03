/**
 * Markdown 段落渲染（纯计算，无 I/O）
 *
 * 收敛"完整文本 → markdown 表格渲染 → 折行 → 可选缩进"逻辑。
 * 适用于一次性渲染完整内容块（历史对话、子代理记录）；
 * 流式逐段喂入场景仍直接用 MarkdownTableRenderer（见表示层）。
 *
 * 此前该逻辑在 ConversationView 与 SubagentRecordView 中重复实现 3 份
 * （含 SubagentRecordView 内部 2 份），收口至此。
 */

import { MarkdownTableRenderer } from './markdown.js';
import { wrapText } from './conversation.js';

/**
 * 渲染一段完整 markdown 文本为行数组。
 *
 * @param text      完整文本（可含 markdown 表格块）
 * @param wrapWidth 折行宽度（建议调用方自行扣除缩进占宽，如 termWidth - indent）
 * @param prefix    每行前缀（缩进等，默认无）
 * @returns 渲染后的行数组（含表格 box-drawing 与折行）
 */
export function renderMarkdownText(text: string, wrapWidth: number, prefix = ''): string[] {
	const lines: string[] = [];
	if (!text) return lines;

	const md = new MarkdownTableRenderer();
	const rendered = md.feed(text) ?? [];
	rendered.push(...(md.flush() ?? []));

	for (const rline of rendered) {
		for (const wline of wrapText(rline, Math.max(1, wrapWidth))) {
			lines.push(prefix + wline);
		}
	}
	return lines;
}
