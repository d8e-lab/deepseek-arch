/**
 * InputPanel — 输入面板组件
 *
 * 从 chat-ui.ts 剥离的独立模块。
 * 管理输入文本、光标位置、发送历史、输入队列，以及 CJK 显示宽度计算。
 */

/** 输入面板最大行数 */
const MAX_INPUT_HEIGHT = 10;

/**
 * 字符显示宽度
 * CJK / 全角 = 2，ASCII = 1
 */
export function charDisplayWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0x2e80 && code <= 0x2eff) ||
		(code >= 0x3000 && code <= 0x303f) ||
		(code >= 0xff00 && code <= 0xffef) ||
		(code >= 0x20000 && code <= 0x2ffff)
	) {
		return 2;
	}
	return 1;
}

/** 字符串显示宽度 */
export function strDisplayWidth(s: string): number {
	let w = 0;
	for (const char of s) {
		w += charDisplayWidth(char);
	}
	return w;
}

/** 按显示宽度换行（CJK 字符占 2 列） */
export function wrapTextForInput(text: string, width: number): string[] {
	if (width <= 0 || text.length === 0) return [''];
	const result: string[] = [];
	let line = '';
	let lineWidth = 0;

	for (const char of text) {
		if (char === '\n') {
			result.push(line);
			line = '';
			lineWidth = 0;
			continue;
		}
		const cw = charDisplayWidth(char);
		if (lineWidth + cw > width) {
			result.push(line);
			line = char;
			lineWidth = cw;
		} else {
			line += char;
			lineWidth += cw;
		}
	}
	if (line.length > 0 || result.length === 0) {
		result.push(line);
	}
	return result;
}

/**
 * 输入面板
 */
export class InputPanel {
	private _text = '';
	private _cursorPos = 0;
	private _history: string[] = [];
	private _historyIndex = -1;
	private _queue: string[] = [];

	// ─── 文本操作 ────────────────────────────────

	get text(): string {
		return this._text;
	}

	get cursorPos(): number {
		return this._cursorPos;
	}

	clear(): void {
		this._text = '';
		this._cursorPos = 0;
	}

	setText(text: string): void {
		this._text = text;
		this._cursorPos = text.length;
	}

	insertChar(ch: string): void {
		this._text = this._text.slice(0, this._cursorPos) + ch + this._text.slice(this._cursorPos);
		this._cursorPos += ch.length;
	}

	deleteChar(): void {
		if (this._cursorPos <= 0) return;
		this._text = this._text.slice(0, this._cursorPos - 1) + this._text.slice(this._cursorPos);
		this._cursorPos--;
	}

	deleteForward(): void {
		if (this._cursorPos >= this._text.length) return;
		this._text = this._text.slice(0, this._cursorPos) + this._text.slice(this._cursorPos + 1);
	}

	moveCursor(delta: number): void {
		const newPos = this._cursorPos + delta;
		if (newPos >= 0 && newPos <= this._text.length) {
			this._cursorPos = newPos;
		}
	}

	insertNewline(): void {
		this.insertChar('\n');
	}

	// ─── 提交与历史 ─────────────────────────────

	/** 提交当前输入并保存到历史 */
	submit(): string {
		const content = this._text;
		if (content.trim() === '') return '';

		this._history.push(content);
		this._historyIndex = -1;
		this.clear();
		return content;
	}

	/**
	 * 浏览输入历史
	 * @param direction -1=上（旧）, 1=下（新）
	 */
	navigateHistory(direction: -1 | 1): void {
		if (this._history.length === 0) return;

		if (direction === -1) {
			// 上：回到更旧的消息
			if (this._historyIndex === -1) {
				// 首次按上：保存当前输入
				this._historyIndex = this._history.length - 1;
			} else if (this._historyIndex > 0) {
				this._historyIndex--;
			}
		} else {
			// 下：回到更新的消息
			if (this._historyIndex >= 0) {
				this._historyIndex--;
			}
		}

		if (this._historyIndex >= 0) {
			this._text = this._history[this._historyIndex];
			this._cursorPos = this._text.length;
		} else {
			this.clear();
		}
	}

	// ─── 输入队列（流式期间暂存） ───────────────

	get hasQueue(): boolean {
		return this._queue.length > 0;
	}

	get queueLength(): number {
		return this._queue.length;
	}

	enqueue(text: string): void {
		this._queue.push(text);
	}

	dequeue(): string | null {
		return this._queue.shift() ?? null;
	}

	clearQueue(): void {
		this._queue = [];
	}

	// ─── 布局计算 ───────────────────────────────

	/** 计算输入面板实际行数 */
	calcHeight(termWidth: number): number {
		const promptLen = 2; // "> "
		const availableWidth = Math.max(1, termWidth - promptLen);
		if (this._text.length === 0) return 1;
		const wrapped = wrapTextForInput(this._text, availableWidth);
		return Math.min(MAX_INPUT_HEIGHT, wrapped.length);
	}

	/** 计算光标在输入面板中的行列位置 */
	calcCursor(inputHeight: number, termWidth: number): { cursorRow: number; cursorCol: number } {
		const promptLen = 2;
		const availableWidth = Math.max(1, termWidth - promptLen);
		let row = 0;
		let lineWidth = 0;
		for (let i = 0; i < this._cursorPos; i++) {
			const ch = this._text[i];
			if (ch === '\n') {
				row++;
				lineWidth = 0;
				continue;
			}
			const cw = charDisplayWidth(ch);
			if (lineWidth + cw > availableWidth) {
				row++;
				lineWidth = cw;
			} else {
				lineWidth += cw;
			}
		}
		return { cursorRow: Math.min(row, inputHeight - 1), cursorCol: promptLen + lineWidth };
	}
}
