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
	/** 当前输入的文本行（硬行，\n 分隔） */
	private lines: string[] = [''];
	/** 光标行（0-based，在 lines 内） */
	private cursorRow: number = 0;
	/** 光标列（显示宽度列，0-based，从硬行首计） */
	private cursorCol: number = 0;
	/** 滚动偏移（显示行索引，非硬行索引） */
	private scrollOffset: number = 0;
	/** 历史输入 */
	private history: string[] = [];
	/** 历史浏览位置（-1 = 编辑当前） */
	private historyIndex: number = -1;
	/** 浏览历史前保存的当前输入 */
	private savedInput: string[] | null = null;
	/** 粘贴内容存储 */
	private pasteContents: string[] = [];
	/** 粘贴序号（用于多次粘贴的 #N 标识） */
	private pasteSeq: number = 0;
	/** 最大可见行数 */
	readonly maxVisibleLines: number = 5;
	/** 软换行宽度（0 = 不自动换行） */
	private wrapWidth: number = 0;

	/** 设置软换行宽度 */
	setWrapWidth(width: number): void {
		this.wrapWidth = Math.max(0, width);
	}

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
			// 若上一行末尾是粘贴标记 → 删除整个标记而非合并行
			const prevLine = this.lines[this.cursorRow - 1];
			const marker = this.findPasteMarkerAt(prevLine, prevLine.length, 'left');
			if (marker) {
				this.lines[this.cursorRow - 1] = prevLine.slice(0, marker.start);
				this.cursorCol = strDisplayWidth(prevLine.slice(0, marker.start));
				this.pasteContents.splice(marker.order - 1, 1);
				return;
			}
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
		if (idx === 0) return;

		// 若光标在粘贴标记内或紧邻标记右侧 → 删除整个标记
		const marker = this.findPasteMarkerAt(line, idx, 'left');
		if (marker) {
			this.lines[this.cursorRow] = line.slice(0, marker.start) + line.slice(marker.end);
			this.cursorCol -= strDisplayWidth(line.slice(marker.start, marker.end));
			this.pasteContents.splice(marker.order - 1, 1);
			return;
		}

		// 删除光标前一个字符（正确处理 surrogate pairs）
		let prevIdx = idx - 1;
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

		// 若光标在粘贴标记内或紧邻标记左侧 → 删除整个标记
		const marker = this.findPasteMarkerAt(line, idx, 'right');
		if (marker) {
			this.lines[this.cursorRow] = line.slice(0, marker.start) + line.slice(marker.end);
			this.pasteContents.splice(marker.order - 1, 1);
			return;
		}

		if (idx >= line.length) {
			// 合并下一行
			if (this.cursorRow >= this.lines.length - 1) return;
			// 若下一行开头是粘贴标记 → 删除标记而非合并行
			const nextLine = this.lines[this.cursorRow + 1];
			const nextMarker = this.findPasteMarkerAt(nextLine, 0, 'right');
			if (nextMarker) {
				this.lines[this.cursorRow + 1] = nextLine.slice(nextMarker.end);
				this.pasteContents.splice(nextMarker.order - 1, 1);
				return;
			}
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
		// 归一化换行符：\r\n → \n，孤立 \r → \n（跨平台兼容 Linux/Windows/WSL）
		text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		// 去除末尾换行再数行，避免尾行空串导致行数 +1
		const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
		const lineCount = trimmed.split('\n').length;

		if (lineCount === 0) return;

		// 少于 5 行：直接展开到输入区域，用户可见可编辑
		if (lineCount < 5) {
			const pasteLines = trimmed.split('\n');
			const line = this.lines[this.cursorRow];
			const idx = this.displayColToIndex(line, this.cursorCol);
			const before = line.slice(0, idx);
			const after = line.slice(idx);

			// 首行：光标前文本 + 粘贴第一行
			this.lines[this.cursorRow] = before + pasteLines[0];

			// 中间行：直接插入
			for (let i = 1; i < pasteLines.length - 1; i++) {
				this.lines.splice(this.cursorRow + i, 0, pasteLines[i]);
			}

			// 末行：粘贴最后一行 + 光标后文本
			if (pasteLines.length > 1) {
				this.lines.splice(
					this.cursorRow + pasteLines.length - 1,
					0,
					pasteLines[pasteLines.length - 1] + after,
				);
				this.cursorRow += pasteLines.length - 1;
				this.cursorCol = strDisplayWidth(pasteLines[pasteLines.length - 1]);
			} else {
				this.lines[this.cursorRow] += after;
				this.cursorCol = strDisplayWidth(before + pasteLines[0]);
			}
			this.clampScroll();
			return;
		}

		// ≥ 5 行：使用占位标记，提交时替换还原
		this.pasteSeq++;
		this.pasteContents.push(text);
		const marker = `[paste #${this.pasteSeq} +${lineCount} lines]`;
		const line = this.lines[this.cursorRow];
		const idx = this.displayColToIndex(line, this.cursorCol);
		this.lines[this.cursorRow] = line.slice(0, idx) + marker + line.slice(idx);
		this.cursorCol += strDisplayWidth(marker);
	}

	// ─── 提交 ──────────────────────────────────────

	/** 构建最终发送内容：替换所有 [paste #N +M lines] 为实际粘贴文本 */
	buildSubmitContent(): string {
		let pasteIdx = 0;
		const pasteMarkerRegex = /\[paste #\d+ \+(\d+) lines\]/g;
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
		this.pasteSeq = 0;
	}

	// ─── 显示输出 ──────────────────────────────────

	/** 获取用于渲染的可见行（软换行后，受 scrollOffset 和 maxVisibleLines 限制） */
	getDisplayLines(): string[] {
		if (this.wrapWidth <= 0) {
			const max = Math.min(this.lines.length, this.scrollOffset + this.maxVisibleLines);
			return this.lines.slice(this.scrollOffset, max);
		}
		const result: string[] = [];
		let displayIdx = 0;
		for (let li = 0; li < this.lines.length && result.length < this.maxVisibleLines; li++) {
			for (const seg of this.softWrap(this.lines[li])) {
				if (displayIdx >= this.scrollOffset) {
					result.push(seg);
					if (result.length >= this.maxVisibleLines) break;
				}
				displayIdx++;
			}
		}
		return result;
	}

	/** 获取光标在显示区域中的位置（软换行感知） */
	getCursorDisplayPos(): { row: number; col: number } {
		if (this.wrapWidth <= 0) {
			return { row: this.cursorRow - this.scrollOffset, col: this.cursorCol };
		}
		// 累计 cursorRow 之前硬行的显示行数
		let globalRow = 0;
		for (let li = 0; li < this.cursorRow; li++) {
			globalRow += this.softWrap(this.lines[li]).length;
		}
		// 在 cursorRow 硬行内找光标所在的软换行段
		const line = this.lines[this.cursorRow];
		let segStartCol = 0;
		for (const w of this.softWrap(line)) {
			const segEndCol = segStartCol + strDisplayWidth(w);
			if (this.cursorCol <= segEndCol) {
				return {
					row: globalRow - this.scrollOffset,
					col: this.cursorCol - segStartCol,
				};
			}
			segStartCol = segEndCol;
			globalRow++;
		}
		// 光标在最后一行的末尾
		return {
			row: globalRow - this.scrollOffset,
			col: this.cursorCol - segStartCol,
		};
	}

	/** 计算总显示行数 */
	getLineCount(): number {
		return this.countDisplayRows();
	}

	// ─── 私有方法 ──────────────────────────────────

	/** 按显示宽度软换行 */
	private softWrap(line: string): string[] {
		const width = this.wrapWidth;
		if (width <= 0 || line.length === 0) return [line || ''];
		const result: string[] = [];
		let cur = '';
		let curW = 0;
		for (const ch of line) {
			const cw = charDisplayWidth(ch);
			if (curW + cw > width) {
				result.push(cur);
				cur = ch;
				curW = cw;
			} else {
				cur += ch;
				curW += cw;
			}
		}
		if (cur || result.length === 0) result.push(cur);
		return result;
	}

	/** 计算所有行的总显示行数 */
	private countDisplayRows(): number {
		if (this.wrapWidth <= 0) return this.lines.length;
		let count = 0;
		for (const line of this.lines) {
			count += this.softWrap(line).length;
		}
		return Math.max(1, count);
	}

	/** 计算光标所在全局显示行号（不受 scrollOffset 影响） */
	private getCursorDisplayRow(): number {
		if (this.wrapWidth <= 0) return this.cursorRow;
		let row = 0;
		for (let li = 0; li < this.cursorRow; li++) {
			row += this.softWrap(this.lines[li]).length;
		}
		const line = this.lines[this.cursorRow];
		let segStart = 0;
		for (const w of this.softWrap(line)) {
			if (segStart + strDisplayWidth(w) > this.cursorCol) break;
			segStart += strDisplayWidth(w);
			row++;
		}
		return row;
	}

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

	/**
	 * 在行内查找光标所在位置的粘贴标记。
	 * @param side 'left' 用于 Backspace（检查 idx 是否在 (start, end] 范围内）
	 *             'right' 用于 Delete（检查 idx 是否在 [start, end) 范围内）
	 * @returns 标记的起止字符串下标及其出现序号（1-based），未找到返回 null
	 */
	private findPasteMarkerAt(
		line: string,
		idx: number,
		side: 'left' | 'right',
	): { start: number; end: number; order: number } | null {
		const regex = /\[paste #\d+ \+(\d+) lines\]/g;
		let match: RegExpExecArray | null;
		let order = 0;
		while ((match = regex.exec(line)) !== null) {
			order++;
			const s = match.index;
			const e = s + match[0].length;
			const hit = side === 'left' ? idx > s && idx <= e : idx >= s && idx < e;
			if (hit) {
				return { start: s, end: e, order };
			}
		}
		return null;
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

	/** 更新 scrollOffset（显示行偏移），确保光标在可见区域内 */
	private clampScroll(): void {
		const cursorRow = this.getCursorDisplayRow();
		const totalRows = this.countDisplayRows();

		if (cursorRow < this.scrollOffset) {
			this.scrollOffset = cursorRow;
		} else if (cursorRow >= this.scrollOffset + this.maxVisibleLines) {
			this.scrollOffset = cursorRow - this.maxVisibleLines + 1;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, totalRows - 1)));
	}

	private clamp(val: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, val));
	}
}
