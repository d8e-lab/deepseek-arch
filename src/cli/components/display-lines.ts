/**
 * DisplayLines — 对话渲染行缓冲区
 *
 * 从 chat-ui.ts 剥离的独立模块。
 * 管理历史对话行的追加、截取、清空。
 */

/** 行颜色类型 */
export type LineColor = 'green' | 'gray' | 'white';

/** 一行经过颜色标记的渲染内容 */
export interface RenderedLine {
	/** 不含 ANSI 的纯文本 */
	text: string;
	/** 颜色类型 */
	color: LineColor;
}

/**
 * 对话渲染行缓冲区（无上限的 FIFO 追加器）
 */
export class DisplayLines {
	private lines: RenderedLine[] = [];

	/** 追加一行 */
	append(text: string, color: LineColor): void {
		this.lines.push({ text, color });
	}

	/** 清空所有行 */
	clear(): void {
		this.lines = [];
	}

	/** 获取最近 visibleCount 行（从末尾截取） */
	getVisible(visibleCount: number): RenderedLine[] {
		if (visibleCount <= 0) return [];
		if (this.lines.length <= visibleCount) return [...this.lines];
		return this.lines.slice(this.lines.length - visibleCount);
	}

	/** 获取全部行 */
	getAll(): RenderedLine[] {
		return [...this.lines];
	}

	/** 当前行数 */
	get length(): number {
		return this.lines.length;
	}
}
