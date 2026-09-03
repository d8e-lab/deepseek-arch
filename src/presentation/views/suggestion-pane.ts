/**
 * SuggestionPane — 命令补全建议窗格（presentation 子窗格组件）
 *
 * 方案 A 抽取：原为 BottomArea.renderSuggestions（滚动窗口 + ▸ 高亮 +
 * 折叠提示），现为独立组件并复用 render SDK 的 renderSelectList——
 * 窗口滑动 / 高亮样式 / "... N more" 折叠全部收口至 list.ts，本体只负责
 * "从数据渲染 + 绘制到输出通道"。
 *
 * 输出经注入的 ScreenBuffer（不再直写 process.stdout/clearLine）。
 */

import type { ScreenBuffer } from '../screen-buffer.js';
import { renderSelectList } from '../../render/list.js';

/** 建议列表最大可见条数 */
const MAX_VISIBLE = 8;

export class SuggestionPane {
	/**
	 * 渲染命令补全建议列表（输入框下方，从当前行的下一行开始）。
	 * @param out        输出通道
	 * @param suggestions 建议文本数组
	 * @param selectedIdx 当前高亮索引（-1 = 无选中）
	 * @param availWidth 可用显示宽度（行 padToWidth 目标）
	 * @returns 绘制的行数（供容器清理记账）
	 */
	render(out: ScreenBuffer, suggestions: string[], selectedIdx: number, availWidth: number): number {
		if (suggestions.length === 0) return 0;

		const lines = renderSelectList(suggestions, selectedIdx, {
			maxVisible: MAX_VISIBLE,
			width: availWidth,
		});
		if (lines.length === 0) return 0;

		// 从输入行的下一行开始绘制（避免 \r+clearLine 覆盖输入行）
		out.write('\r\n');

		// 绘制每一行
		for (let i = 0; i < lines.length; i++) {
			const isLast = i === lines.length - 1;
			out.write('\r');
			out.write('\x1b[2K');
			out.write(lines[i]);
			if (!isLast) out.write('\r\n');
		}

		return lines.length;
	}
}
