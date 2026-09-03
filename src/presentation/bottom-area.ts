/**
 * BottomArea — 底部区域容器（输入区 + 命令结果区/建议列表）
 *
 * 职责：
 *   1. 布局：输入区在上；命令模式下输入区下方为建议列表，否则为命令结果区
 *   2. 测量：根据内容实时计算各子区高度（动态自适应）
 *   3. 渲染：整体重绘到 ScreenBuffer（IDLE 上移重绘 / 输出后直接绘制两种模式）
 *   4. 收起：输出开始时收起底部区域（光标回起点 + 清屏）
 *
 * 设计原则：高度是「测量」出来的，不是「记账」出来的。
 * 光标行数记账收敛在本容器内，TuiApp 不感知（正交模块边界）。
 */

import { InputEditor } from '../render/input-editor.js';
import { dim, GRAY_BG_START, GRAY_BG_END, PINK_BG_START, PINK_BG_END, padToWidth } from '../render/ansi.js';
import type { ScreenBuffer } from './screen-buffer.js';
import { clearLine, hideCursor, showCursor } from './terminal.js';
import { CommandResultPane } from './views/command-result-pane.js';
import { SuggestionPane } from './views/suggestion-pane.js';

/** 输入框最大可见行数 */
const MAX_INPUT_ROWS = 5;
/** 从光标处清除到屏幕底 */
const CLEAR_TO_END = '\x1b[0J';

export interface BottomAreaOptions {
	out: ScreenBuffer;
	input: InputEditor;
	getCols: () => number;
}

export class BottomArea {
	private out: ScreenBuffer;
	private input: InputEditor;
	private getCols: () => number;
	/** 命令结果窗格（方案 A 抽取：原 cmdLines 数据 + 渲染逻辑） */
	private cmdPane: CommandResultPane;
	/** 建议窗格（方案 A 抽取：原 renderSuggestions，复用 render/list） */
	private suggestionPane: SuggestionPane;

	/** 上次渲染的输入可见行数（用于缩小时清理残留行） */
	private lastVisibleInputRows = 1;
	/** 上次渲染后的光标所在输入行号（0-based，用于下次回到起点） */
	private lastCursorDisplayRow = 0;
	/** 上次渲染的底部区域总行数（命令结果区 + 输入区）；用于判断区域是否在屏 */
	private lastBottomRows = 0;
	/** 命令补全建议列表的行数（用于清理） */
	private suggestionLinesCount = 0;
	/** shell 命令模式（输入框背景色切换） */
	private shellMode = false;

	constructor(opts: BottomAreaOptions) {
		this.out = opts.out;
		this.input = opts.input;
		this.getCols = opts.getCols;
		this.cmdPane = new CommandResultPane();
		this.suggestionPane = new SuggestionPane();
	}

	// ─── 状态查询（TuiApp 用）───────────────────────

	/** 光标所在输入行偏移（TuiApp 上移基准） */
	getCursorRow(): number {
		return this.lastCursorDisplayRow;
	}

	/** 底部区域是否在屏（流式命令判断用） */
	isOnScreen(): boolean {
		return this.lastBottomRows > 0;
	}

	/** 命令结果区行数 */
	getCommandLineCount(): number {
		return this.cmdPane.getLineCount();
	}

	/** think 折叠行上移基准：光标行偏移 + 1 + 命令结果区行数 */
	getUpRowsForThink(): number {
		return this.lastCursorDisplayRow + 1 + this.cmdPane.getLineCount();
	}

	/** 设置 shell 模式（输入框背景色） */
	setShellMode(b: boolean): void {
		this.shellMode = b;
	}

	// ─── 命令结果区（委托 CommandResultPane）──────

	/** 命令输出捕获：追加到命令结果区（完整保留） */
	pushCommandLine(line: string): void {
		this.cmdPane.push(line);
	}

	/** 清空命令结果区（发送普通消息后调用；redraw=false 时输入区已清除，避免错位重绘） */
	clearCommandResult(redraw = true): void {
		if (this.cmdPane.getLineCount() === 0) return;
		this.cmdPane.clear();
		if (redraw) this.renderIdle();
	}

	/** 清除建议列表显示（从当前光标位置清到屏幕底部） */
	clearSuggestions(): void {
		if (this.suggestionLinesCount > 0) {
			this.out.write(CLEAR_TO_END);
			this.suggestionLinesCount = 0;
		}
	}

	// ─── 渲染 ──────────────────────────────────────

	/** IDLE 态重绘：上移光标到输入区顶部 → 清屏 → 画底部区域 → 定位光标 */
	renderIdle(): void {
		const cols = this.getCols();
		// cols-1 为可用显示宽度（避免 auto-wrap），留 1 列余量给换行光标
		const availWidth = cols - 1;
		this.input.setWrapWidth(availWidth);
		hideCursor();

		// 回到底部区域起始行（输入区顶部）：上移光标所在输入行偏移。
		// 命令结果区/建议列表在输入区下方，被 CLEAR_TO_END 从输入区顶部清掉。
		const upRows = this.lastCursorDisplayRow;
		if (upRows > 0) {
			this.out.write(`\x1b[${upRows}A`);
		}
		this.out.write('\r');
		// 清除旧底部区域（输入区 + 命令结果区/建议列表：从区域顶部清到屏底）
		this.out.write(CLEAR_TO_END);

		this.drawBottomArea(cols, availWidth);
	}

	/**
	 * 输出后重绘：光标已在输出末尾（底部区域已收起），直接绘制底部区域。
	 * 与 IDLE 态 renderIdle 不同：不做上移（上移会跑到输出区里），
	 * 从当前光标位置画命令结果区 + 输入区，使其视觉上固定在屏幕底部。
	 */
	renderAfterOutput(): void {
		this.lastCursorDisplayRow = 0;
		const cols = this.getCols();
		const availWidth = cols - 1;
		this.input.setWrapWidth(availWidth);
		hideCursor();
		this.out.write(CLEAR_TO_END);
		this.drawBottomArea(cols, availWidth);
	}

	/** 仅画输入区单行（resize / 退出 shell 模式后） */
	drawBase(): void {
		const cols = this.getCols();
		const bgStart = this.shellMode ? PINK_BG_START : GRAY_BG_START;
		const bgEnd = this.shellMode ? PINK_BG_END : GRAY_BG_END;
		const empty = ' '.repeat(cols - 1);
		this.out.write(bgStart + empty + bgEnd);
	}

	/** 收起底部区域：光标回起点（输入区顶部）→ 清到屏底 */
	collapse(): void {
		const upRows = this.lastCursorDisplayRow;
		if (upRows > 0) {
			this.out.write(`\x1b[${upRows}A`);
		}
		this.out.write('\r');
		this.out.write(CLEAR_TO_END);
		this.lastVisibleInputRows = 1;
		this.lastCursorDisplayRow = 0;
		this.lastBottomRows = 0;
	}

	/** 重绘命令结果区 + 输入区（命令执行后调用）：
	 *  - 底部区域已收起（IDLE 命令，光标在输出末尾）→ 直接画
	 *  - 底部区域在屏（流式命令，光标在输入区）→ 上移旧高度重绘 */
	renderCommandBar(): void {
		if (this.lastBottomRows > 0) {
			this.renderIdle();
		} else {
			this.renderAfterOutput();
		}
	}

	/** 重置位置记账（输出结束/视图关闭/提交输入后） */
	resetPosition(): void {
		this.lastVisibleInputRows = 1;
		this.lastCursorDisplayRow = 0;
		this.lastBottomRows = 0;
	}

	/** 标记底部区域已清屏（输入提交后，区域不再在屏） */
	markBottomCleared(): void {
		this.lastBottomRows = 0;
	}

	// ─── 内部 ──────────────────────────────────────

	/**
	 * 绘制底部区域：输入区 + 命令结果区/建议列表（均固定在输入区下方，类似建议列表），
	 * 不随对话滚动、不截断；结束后更新 lastBottomRows。
	 * 命令模式：输入区下方显示建议列表（命令结果区暂隐藏，避免两者抢占空间）；
	 * 非命令模式：输入区下方显示命令结果区（完整内容）。
	 */
	private drawBottomArea(cols: number, availWidth: number): void {
		const inputLines = this.input.getDisplayLines();
		const cursorPos = this.input.getCursorDisplayPos();
		const visibleLines = Math.max(1, Math.min(inputLines.length, MAX_INPUT_ROWS));
		const linesToDraw = Math.max(visibleLines, this.lastVisibleInputRows);

		const bgStart = this.shellMode ? PINK_BG_START : GRAY_BG_START;
		const bgEnd = this.shellMode ? PINK_BG_END : GRAY_BG_END;

		// 1. 输入区（区域顶部）
		for (let r = 0; r < linesToDraw; r++) {
			clearLine();
			if (r < inputLines.length && r < MAX_INPUT_ROWS) {
				// 软换行后的段已由 InputEditor 截断，只做右侧填充
				const text = padToWidth(inputLines[r], availWidth);
				this.out.write(bgStart + text + bgEnd);
			}
			// r >= inputLines.length: 清除残留行（不用灰底）
			if (r < linesToDraw - 1) this.out.write('\r\n');
		}
		this.lastVisibleInputRows = visibleLines;

		// 2. 输入区下方：命令模式 → 建议列表；否则 → 命令结果区（完整，不截断）
		let belowRows = 0;
		if (this.input.isInCommandMode()) {
			const suggestIdx = this.input.getSuggestionIndex();
			const suggestions = this.input.getSuggestions();
			// 旧建议列表已被上移后的 CLEAR_TO_END 清除，无需残留清理（\r\n 在屏底会触发滚动）
			this.suggestionLinesCount = this.suggestionPane.render(this.out, suggestions, suggestIdx, availWidth);
			belowRows = this.suggestionLinesCount;
		} else {
			// 命令结果区：委托 CommandResultPane（折行 + '│ ' 前缀 + 物理行数）
			this.suggestionLinesCount = 0;
			belowRows = this.cmdPane.render(this.out, availWidth);
		}

		// 定位光标：
		// 绘制结束后光标在最后一行行首（下方区域最后一行不换行 → 光标在最后一行行尾，
		// \r 归零列）。上移 (linesToDraw-1) + belowRows 回到输入区第一行，
		// 再下移 cursorPos.row、右移 cursorPos.col 到输入区光标位置。
		this.out.write('\r');
		const cursorUp = (linesToDraw - 1) + belowRows;
		if (cursorUp > 0) this.out.write(`\x1b[${cursorUp}A`);
		if (cursorPos.row > 0) this.out.write(`\x1b[${cursorPos.row}B`);
		if (cursorPos.col > 0) this.out.write(`\x1b[${cursorPos.col}C`);

		this.lastCursorDisplayRow = cursorPos.row;
		// 记录底部区域总高度（输入区 + 下方区域），供区域是否在屏判断
		this.lastBottomRows = linesToDraw + belowRows;
		showCursor();
	}
}
