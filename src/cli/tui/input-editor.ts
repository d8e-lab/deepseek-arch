/**
 * InputEditor — 多行输入编辑器
 *
 * 职责：
 *   1. 管理多行文本缓冲区（最多 5 行可见，超出滚动）
 *   2. 光标导航（方向键、Home/End）
 *   3. 历史记录（空输入时上下键遍历）
 *   4. 粘贴处理（临时保存 + [paste +N lines] 标记）
 *   5. CJK 宽字符光标处理
 *   6. Ctrl+J 换行，Enter 提交
 */

import { charDisplayWidth, strDisplayWidth } from './renderer.js';

export class InputEditor {
	/** 当前输入的文本行 */
	private lines: string[] = [''];
	/** 光标行（0-based，在 lines 内） */
	private cursorRow: number = 0;
	/** 光标列（显示宽度列，0-based） */
	private cursorCol: number = 0;
	/** 滚动偏移（第一可见行的索引） */
	private scrollOffset: number = 0;
	/** 历史输入 */
	private history: string[] = [];
	/** 历史浏览位置（-1 = 编辑当前） */
	private historyIndex: number = -1;
	/** 浏览历史前保存的当前输入 */
	private savedInput: string[] | null = null;
	/** 粘贴内容存储 */
	private pasteContents: string[] = [];
	/** 最大可见行数 */
	readonly maxVisibleLines: number = 5;

	// ─── 查询 ──────────────────────────────────────

	isEmpty(): boolean {
		return this.lines.length === 1 && this.lines[0] === '' && this.pasteContents.length === 0;
	}

	hasPaste(): boolean {
		return this.pasteContents.length > 0;
	}

	// ─── 字符插入 ──────────────────────────────────

	insertChar(ch: string): void {
		this.exitHistory();
		const line = this.lines[this.cursorRow];
		const idx = this.displayColToIndex(line, this.cursorCol);
		this.lines[this.cursorRow] = line.slice(0, idx) + ch + line.slice(idx);
		this.cursorCol += charDisplayWidth(ch);
	}

	/** Ctrl+J：在光标处换行 */
	insertNewline(): void {
		this.exitHistory();
		const line = this.lines[this.cursorRow];
		const idx = this.displayColToIndex(line, this.cursorCol);
		const before = line.slice(0, idx);
		const after = line.slice(idx);
		this.lines[this.cursorRow] = before;
		this.lines.splice(this.cursorRow + 1, 0, after);
		this.cursorRow++;
		this.cursorCol = 0;
		this.clampScroll();
	}

	/** Backspace */
	deleteBeforeCursor(): void {
		this.exitHistory();
		if (this.cursorCol === 0) {
			// 合并到上一行
			if (this.cursorRow === 0) return;
			const current = this.lines[this.cursorRow];
			const prevLen = strDisplayWidth(this.lines[this.cursorRow - 1]);
			this.lines[this.cursorRow - 1] += current;
			this.lines.splice(this.cursorRow, 1);
			this.cursorRow--;
			this.cursorCol = prevLen;
			this.clampScroll();
			return;
		}

		const line = this.lines[this.cursorRow];
		const idx = this.displayColToIndex(line, this.cursorCol);
		// 删除光标前一个字符（正确处理 surrogate pairs）
		if (idx === 0) return;
		let prevIdx = idx - 1;
		// 如果 prevIdx 是 low surrogate (0xDC00-0xDFFF)，回退到 surrogate pair 开头
		if (prevIdx > 0 && (line.charCodeAt(prevIdx) & 0xfc00) === 0xdc00) {
			prevIdx--;
		}
		const code = line.codePointAt(prevIdx);
		if (code === undefined) return;
		const removedWidth = charDisplayWidth(String.fromCodePoint(code));
		this.lines[this.cursorRow] = line.slice(0, prevIdx) + line.slice(idx);
		this.cursorCol -= removedWidth;
	}

	/** Delete */
	deleteAfterCursor(): void {
		this.exitHistory();
		const line = this.lines[this.cursorRow];
		const idx = this.displayColToIndex(line, this.cursorCol);
		if (idx >= line.length) {
			// 合并下一行
			if (this.cursorRow >= this.lines.length - 1) return;
			this.lines[this.cursorRow] += this.lines[this.cursorRow + 1];
			this.lines.splice(this.cursorRow + 1, 1);
			return;
		}
		const code = line.codePointAt(idx);
		if (code === undefined) return;
		const nextIdx = idx + String.fromCodePoint(code).length;
		this.lines[this.cursorRow] = line.slice(0, idx) + line.slice(nextIdx);
	}

	// ─── 光标移动 ──────────────────────────────────

	moveCursor(dRow: number, dCol: number): void {
		this.exitHistory();
		const newRow = this.clamp(this.cursorRow + dRow, 0, this.lines.length - 1);
		const newCol = this.cursorCol + dCol;

		if (newRow !== this.cursorRow) {
			this.cursorRow = newRow;
			// 竖移时限制列不超过该行长度
			this.cursorCol = Math.min(Math.max(0, newCol), strDisplayWidth(this.lines[newRow]));
		} else {
			this.cursorCol = this.clamp(newCol, 0, strDisplayWidth(this.lines[this.cursorRow]));
		}

		this.clampScroll();
	}

	/** 左移一个字符（CJK 宽字符一次跳过 2 列） */
	moveCursorLeft(): void {
		this.exitHistory();
		if (this.cursorCol === 0) {
			if (this.cursorRow === 0) return;
			this.cursorRow--;
			this.cursorCol = strDisplayWidth(this.lines[this.cursorRow]);
			this.clampScroll();
			return;
		}
		this.cursorCol = this.prevCharBoundary(this.lines[this.cursorRow], this.cursorCol);
	}

	/** 右移一个字符（CJK 宽字符一次跳过 2 列） */
	moveCursorRight(): void {
		this.exitHistory();
		const line = this.lines[this.cursorRow];
		if (this.cursorCol >= strDisplayWidth(line)) {
			if (this.cursorRow >= this.lines.length - 1) return;
			this.cursorRow++;
			this.cursorCol = 0;
			this.clampScroll();
			return;
		}
		this.cursorCol = this.nextCharBoundary(line, this.cursorCol);
	}

	moveToLineStart(): void {
		this.exitHistory();
		this.cursorCol = 0;
	}

	moveToLineEnd(): void {
		this.exitHistory();
		this.cursorCol = strDisplayWidth(this.lines[this.cursorRow]);
	}

	// ─── 历史导航 ──────────────────────────────────

	/** 空输入时上下键浏览历史；-1 = 上一页，+1 = 下一页 */
	navigateHistory(direction: -1 | 1): boolean {
		if (this.history.length === 0) return false;
		if (!this.isEmpty() && this.historyIndex < 0) return false;

		if (this.historyIndex < 0) {
			// 保存当前输入
			this.savedInput = [...this.lines];
			this.historyIndex = 0;
		} else {
			this.historyIndex += direction;
			if (direction === -1) {
				this.historyIndex = Math.max(0, this.historyIndex);
			} else {
				if (this.historyIndex >= this.history.length) {
					this.historyIndex = -1;
					this.lines = this.savedInput ?? [''];
					this.savedInput = null;
					this.cursorRow = this.lines.length - 1;
					this.cursorCol = strDisplayWidth(this.lines[this.cursorRow]);
					this.scrollOffset = 0;
					this.clampScroll();
					return true;
				}
			}
		}

		const line = this.history[this.historyIndex];
		this.lines = line.split('\n');
		this.cursorRow = this.lines.length - 1;
		this.cursorCol = strDisplayWidth(this.lines[this.cursorRow]);
		this.scrollOffset = 0;
		this.clampScroll();
		return true;
	}

	private exitHistory(): void {
		if (this.historyIndex < 0) return;
		this.historyIndex = -1;
		this.savedInput = null;
	}

	// ─── 粘贴处理 ──────────────────────────────────

	handlePaste(text: string): void {
		this.exitHistory();
		const lineCount = text.split('\n').length;
		this.pasteContents.push(text);
		const marker = `[paste +${lineCount} lines]`;
		const line = this.lines[this.cursorRow];
		const idx = this.displayColToIndex(line, this.cursorCol);
		this.lines[this.cursorRow] = line.slice(0, idx) + marker + line.slice(idx);
		this.cursorCol += strDisplayWidth(marker);
	}

	// ─── 提交 ──────────────────────────────────────

	/** 构建最终发送内容：替换所有 [paste +N lines] 为实际粘贴文本 */
	buildSubmitContent(): string {
		let pasteIdx = 0;
		const pasteMarkerRegex = /\[paste \+(\d+) lines\]/g;
		const parts = this.lines.map((line) => {
			return line.replace(pasteMarkerRegex, () => {
				return this.pasteContents[pasteIdx++] ?? '';
			});
		});
		// 添加到历史
		const content = parts.join('\n');
		if (content.trim()) {
			this.history.push(content);
		}
		return content;
	}

	// ─── 清除 ──────────────────────────────────────

	clear(): void {
		this.lines = [''];
		this.cursorRow = 0;
		this.cursorCol = 0;
		this.scrollOffset = 0;
		this.historyIndex = -1;
		this.savedInput = null;
		this.pasteContents = [];
	}

	// ─── 显示输出 ──────────────────────────────────

	/** 获取用于渲染的可见行（受 scrollOffset 和 maxVisibleLines 限制） */
	getDisplayLines(): string[] {
		const max = Math.min(this.lines.length, this.scrollOffset + this.maxVisibleLines);
		const visible = this.lines.slice(this.scrollOffset, max);
		// 右侧截断以适应终端宽度（由渲染层处理）
		return visible;
	}

	/** 获取光标在显示区域中的位置 */
	getCursorDisplayPos(): { row: number; col: number } {
		return {
			row: this.cursorRow - this.scrollOffset,
			col: this.cursorCol,
		};
	}

	/** 总有内容需要渲染 */
	getLineCount(): number {
		return Math.min(this.lines.length, this.maxVisibleLines);
	}

	// ─── 私有方法 ──────────────────────────────────

	/** 找到光标左侧最近的字边界显示列位置 */
	private prevCharBoundary(line: string, col: number): number {
		let width = 0;
		for (const ch of line) {
			const cw = charDisplayWidth(ch);
			if (width + cw >= col) return width;
			width += cw;
		}
		return width;
	}

	/** 找到光标右侧最近的字边界显示列位置 */
	private nextCharBoundary(line: string, col: number): number {
		let width = 0;
		for (const ch of line) {
			const cw = charDisplayWidth(ch);
			if (width + cw > col) return width + cw;
			width += cw;
		}
		return width;
	}

	/** 显示列位置 → 行内字符串下标 */
	private displayColToIndex(line: string, displayCol: number): number {
		let width = 0;
		let i = 0;
		for (const ch of line) {
			const cw = charDisplayWidth(ch);
			if (width + cw > displayCol) break;
			width += cw;
			i += ch.length;
		}
		return i;
	}

	/** 更新 scrollOffset，确保光标在可见区域内 */
	private clampScroll(): void {
		if (this.cursorRow < this.scrollOffset) {
			this.scrollOffset = this.cursorRow;
		} else if (this.cursorRow >= this.scrollOffset + this.maxVisibleLines) {
			this.scrollOffset = this.cursorRow - this.maxVisibleLines + 1;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.lines.length - 1));
	}

	private clamp(val: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, val));
	}
}
