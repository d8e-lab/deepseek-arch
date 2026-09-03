/**
 * 可滚动选择列表渲染（纯计算，无 I/O）
 *
 * 收敛"条目数组 + 选中索引 + 可见窗口 → 高亮行数组"逻辑：
 * - 滚动窗口：保证选中项在窗口内（窗口固定大小，逐条滑动）
 * - 折叠提示：窗口前后被隐藏的条目数以 "... N more" 提示
 * - 选中样式：▸ 前缀 + cyan 高亮 + 宽度填充
 *
 * 此前该逻辑在 BottomArea（补全建议）与 Selector（交互选择器）中
 * 重复实现 2 份，收口至此。
 */

import { cyan, dim, padToWidth } from './ansi.js';

/** 滚动窗口计算结果 */
export interface ListWindow {
	/** 可见窗口起始索引（含） */
	start: number;
	/** 可见窗口结束索引（不含） */
	end: number;
	/** 窗口上方被折叠的条目数 */
	beforeMore: number;
	/** 窗口下方被折叠的条目数 */
	afterMore: number;
}

/**
 * 计算滚动窗口：保证 selectedIndex 始终在可见窗口内。
 * @param total      条目总数
 * @param selected   选中索引（0-based）
 * @param maxVisible 窗口最大可见条数
 */
export function computeListWindow(total: number, selected: number, maxVisible: number): ListWindow {
	const maxDisplay = Math.min(total, maxVisible);
	// 滚动窗口：保证 selectedIdx 始终在可见窗口内（下移时窗口下滑，逐条展开后续项）
	let start = 0;
	if (selected >= maxDisplay) {
		start = selected - maxDisplay + 1;
	}
	const end = Math.min(start + maxDisplay, total);
	return {
		start,
		end,
		beforeMore: start,
		afterMore: total - end,
	};
}

/**
 * 渲染一行列表项（选中高亮 + 宽度填充）
 * @param text       条目文本（不含前缀）
 * @param isSelected 是否选中
 * @param width      目标显示宽度（padToWidth）
 */
export function renderListLine(text: string, isSelected: boolean, width: number): string {
	const prefix = isSelected ? '▸ ' : '  ';
	const padded = padToWidth(prefix + text, width);
	return isSelected ? cyan(padded) : dim(padded);
}

/**
 * 渲染完整可滚动列表（含折叠提示行）。
 * @param labels       条目文本数组
 * @param selectedIndex 选中索引（-1 = 无选中）
 * @param opts.maxVisible 窗口最大可见条数（默认 8）
 * @param opts.width      每行目标显示宽度（padToWidth）
 * @returns 行数组（含折叠提示），调用方负责绘制/清理记账
 */
export function renderSelectList(
	labels: string[],
	selectedIndex: number,
	opts: { maxVisible?: number; width: number },
): string[] {
	if (labels.length === 0) return [];
	const maxVisible = opts.maxVisible ?? 8;
	const win = computeListWindow(labels.length, Math.max(0, selectedIndex), maxVisible);
	const lines: string[] = [];

	// 窗口前有被折叠的项
	if (win.beforeMore > 0) {
		lines.push(dim(`  ... ${win.beforeMore} more`));
	}

	for (let i = win.start; i < win.end; i++) {
		lines.push(renderListLine(labels[i], i === selectedIndex, opts.width));
	}

	// 窗口后还有未显示的项
	if (win.afterMore > 0) {
		lines.push(dim(`  ... and ${win.afterMore} more`));
	}

	return lines;
}
