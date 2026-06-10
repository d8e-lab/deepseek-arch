/**
 * TuiApp — 内联终端 TUI 主应用
 *
 * 不使用 alternate screen。所有对话内容直接输出到终端 scrollback，
 * 输入区域使用光标控制在底部原地刷新（动态高度：1~5 行）。
 * 全程保持 raw mode，Ctrl+C 统一处理。
 */

import type { Session } from '../../types/index.js';
import { SessionManager } from '../../core/session.js';
import type { StreamEvent } from '../../types/index.js';
import type { Tool } from '../../tools/types.js';
import { ConversationView } from './conversation.js';
import { InputEditor } from './input-editor.js';
import {
	getTermSize,
	enableBracketedPaste,
	disableBracketedPaste,
	hideCursor,
	showCursor,
	clearLine,
	GRAY_BG_START,
	GRAY_BG_END,
	cyan,
	dim,
	green,
	yellow,
	red,
	padToWidth,
	renderDiffLine,
} from './renderer.js';
import { AppState } from './types.js';
import type { TuiConfig } from './types.js';

/** 输入框最大可见行数 */
const MAX_INPUT_ROWS = 5;

/** ANSI 光标保存/恢复 */
const SAVE_CURSOR = '\x1b[s';
const RESTORE_CURSOR = '\x1b[u';
/** 从光标处清除到屏幕底 */
const CLEAR_TO_END = '\x1b[0J';

export class TuiApp {
	private sessionMgr: SessionManager;
	private config: TuiConfig;
	private tools: Tool[];
	private conversation: ConversationView;
	private input: InputEditor;
	private state: AppState = AppState.IDLE;
	private abortController: AbortController | null = null;
	private running = false;
	/** 上次渲染的可见行数（用于缩小时清理残留行） */
	private lastVisibleInputRows = 1;

	constructor(sessionMgr: SessionManager, config: TuiConfig, tools?: Tool[]) {
		this.sessionMgr = sessionMgr;
		this.config = config;
		this.tools = tools ?? [];
		this.conversation = new ConversationView();
		this.input = new InputEditor();
	}

	// ─── 生命周期 ──────────────────────────────────

	async start(session?: Session): Promise<void> {
		if (!session) {
			await this.sessionMgr.startNewSession();
		}

		this.running = true;
		this.setupRawMode();

		this.printHeader();
		this.printSeparator();

		if (session && session.turns.length > 0) {
			this.printConversation(session.turns);
			this.printSeparator();
		}

		while (this.running) {
			await this.inputCycle();
		}

		this.cleanupRawMode();
		this.printExitInfo();
	}

	// ─── 输出（进入 scrollback）────────────────────

	private printHeader(): void {
		const session = this.sessionMgr.getSession();
		const sessionId = session?.meta.id ?? '';
		const turnCount = session?.meta.turnCount ?? 0;
		const lastUsage = session?.meta.lastUsage;

		process.stdout.write(
			`deepseek-arch v${this.config.version}  |  Provider: ${this.config.provider}  |  Model: ${this.config.model}\n`,
		);

		let infoStr = `Session: ${sessionId.slice(0, 8)}...  |  Turns: ${turnCount}`;
		if (lastUsage && lastUsage.total_tokens > 0) {
			infoStr += `  |  Last tokens: ${lastUsage.prompt_tokens} in + ${lastUsage.completion_tokens} out`;
		}
		process.stdout.write(dim(infoStr) + '\n');
	}

	private printSeparator(): void {
		const cols = getTermSize().cols;
		process.stdout.write('─'.repeat(cols) + '\n');
	}

	private printConversation(turns: import('../../types/index.js').TurnRecord[]): void {
		const cols = getTermSize().cols;
		const lines = this.conversation.render(turns, cols);
		for (const line of lines) {
			process.stdout.write(line + '\n');
		}
	}

	private printExitInfo(): void {
		const sessionId = this.sessionMgr.getSessionId();
		if (sessionId) {
			process.stdout.write(`Session saved: ${sessionId}\n`);
			process.stdout.write(`To resume: deepseek-arch chat --resume ${sessionId}\n`);
		}
	}

	// ─── 终端设置（全程 raw mode）──────────────────

	private setupRawMode(): void {
		enableBracketedPaste();
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding('utf8');

		// 全局 stdin 监听：根据当前 stdinHandler 分发
		process.stdin.on('data', this.onStdinData);
	}

	private onStdinData = (data: string): void => {
		if (this.stdinHandler) this.stdinHandler(data);
	};

	private cleanupRawMode(): void {
		process.stdin.off('data', this.onStdinData);
		disableBracketedPaste();
		showCursor();
		process.stdin.setRawMode(false);
		process.stdin.pause();
	}

	// ─── 输入循环（单轮对话）───────────────────────

	private async inputCycle(): Promise<void> {
		this.lastVisibleInputRows = 1;

		// 画输入区域
		process.stdout.write(SAVE_CURSOR);
		this.drawInputArea();
		// drawInputArea 写入 1 行灰底（无 \n），光标在行末
		// \r 回到第一个输入行的列 0
		process.stdout.write('\r');

		this.input.clear();
		const content = await this.readUserInput();

		// 清除输入区域
		process.stdout.write(RESTORE_CURSOR);
		process.stdout.write(CLEAR_TO_END);

		if (content === null) {
			this.running = false;
			return;
		}

		// 打印用户消息（绿色）
		process.stdout.write(green('[You] ') + content + '\n\n');

		// 发送并流式输出
		await this.sendMessageStream(content);

		this.printSeparator();
	}

	// ─── raw mode 输入读取 ─────────────────────────

	private readUserInput(): Promise<string | null> {
		return new Promise((resolve) => {
			this.stdinHandler = (data: string) => {
				this.handleInputData(data, resolve);
			};
		});
	}

	/** 当前 stdin 数据处理器（raw mode 全程复用） */
	private stdinHandler: ((data: string) => void) | null = null;

	// ─── stdin 数据解析 ─────────────────────────────

	private pasteMode = false;
	private pasteBuffer = '';

	private handleInputData(data: string, resolve: (value: string | null) => void): void {
		// Ctrl+C 优先处理（可能在 data 中的任何位置）
		if (data.includes('\x03')) {
			if (this.state === AppState.STREAMING || this.state === AppState.SENDING) {
				this.abortController?.abort();
				return;
			}
			this.stdinHandler = null;
			resolve(null);
			return;
		}

		// 粘贴开始
		if (data.includes('\x1b[200~')) {
			this.pasteMode = true;
			this.pasteBuffer = '';
			const parts = data.split('\x1b[200~');
			if (parts[0]) this.processChars(parts[0], resolve);
			const rest = parts.slice(1).join('\x1b[200~');
			if (rest.includes('\x1b[201~')) {
				const [pasteContent, after] = rest.split('\x1b[201~');
				this.pasteBuffer = pasteContent;
				this.pasteMode = false;
				if (this.pasteBuffer.trim()) this.input.handlePaste(this.pasteBuffer);
				this.pasteBuffer = '';
				this.renderInput();
				if (after) this.processChars(after, resolve);
			} else {
				this.pasteBuffer = rest;
			}
			return;
		}

		if (this.pasteMode) {
			if (data.includes('\x1b[201~')) {
				const parts = data.split('\x1b[201~');
				this.pasteBuffer += parts[0];
				this.pasteMode = false;
				if (this.pasteBuffer.trim()) this.input.handlePaste(this.pasteBuffer);
				this.pasteBuffer = '';
				this.renderInput();
				if (parts[1]) this.processChars(parts[1], resolve);
				return;
			}
			this.pasteBuffer += data;
			return;
		}

		// 普通按键处理（Enter 和 Ctrl+J 逐字符处理）
		this.processChars(data, resolve);
	}

	/**
	 * 逐字符处理输入：可打印字符、Enter(\x0d)、Ctrl+J(\x0a)、Backspace(\x7f/\x08)、Tab(\x09)、escape 序列
	 */
	private processChars(data: string, resolve: (value: string | null) => void): void {
		for (let i = 0; i < data.length; i++) {
			const ch = data[i];

			if (ch === '\x1b') {
				i++;
				if (i >= data.length) return;
				if (data[i] === '[') {
					i++;
					let seq = '';
					while (i < data.length) {
						const sc = data.charCodeAt(i);
						if (sc >= 0x40 && sc <= 0x7e) { seq += data[i]; i++; break; }
						seq += data[i];
						i++;
					}
					this.handleEscapeSeq(seq);
				}
				continue;
			}

			if (ch === '\x0d') {
				// Enter：提交
				if (this.input.isEmpty()) continue;
				const content = this.input.buildSubmitContent();
				this.stdinHandler = null;
				resolve(content);
				return;
			}

			if (ch === '\x0a') { this.input.insertNewline(); continue; }       // Ctrl+J
			if (ch === '\x7f' || ch === '\x08') { this.input.deleteBeforeCursor(); continue; } // Backspace
			if (ch === '\x09') { this.input.insertChar(' '); this.input.insertChar(' '); continue; } // Tab

			if (ch >= ' ') this.input.insertChar(ch);
		}

		this.renderInput();
	}

	private handleEscapeSeq(seq: string): void {
		switch (seq) {
			case 'A': this.input.navigateHistory(-1) || this.input.moveCursor(-1, 0); break;
			case 'B': this.input.navigateHistory(1) || this.input.moveCursor(1, 0); break;
			case 'C': this.input.moveCursor(0, 1); break;
			case 'D': this.input.moveCursor(0, -1); break;
			case 'H': this.input.moveToLineStart(); break;
			case 'F': this.input.moveToLineEnd(); break;
			case '3~': this.input.deleteAfterCursor(); break;
		}
	}

	// ─── 输入区域渲染（动态高度）───────────────────

	private drawInputArea(): void {
		const cols = getTermSize().cols;
		const empty = ' '.repeat(cols);
		// 初始只画 1 行
		process.stdout.write(GRAY_BG_START + empty + GRAY_BG_END);
	}

	/** 原地刷新输入区域 */
	private renderInput(): void {
		const cols = getTermSize().cols;
		hideCursor();

		const inputLines = this.input.getDisplayLines();
		const cursorPos = this.input.getCursorDisplayPos();
		const visibleLines = Math.max(1, Math.min(inputLines.length, MAX_INPUT_ROWS));
		const linesToDraw = Math.max(visibleLines, this.lastVisibleInputRows);

		// 回到输入区域起始行
		process.stdout.write(RESTORE_CURSOR);

		// 绘制每一行
		for (let r = 0; r < linesToDraw; r++) {
			clearLine();
			if (r < inputLines.length && r < MAX_INPUT_ROWS) {
				const text = padToWidth(inputLines[r].slice(0, cols - 2), cols);
				process.stdout.write(GRAY_BG_START + text + GRAY_BG_END);
			}
			// r >= inputLines.length: 清除残留行（不用灰底）
			if (r < linesToDraw - 1) process.stdout.write('\n');
		}
		this.lastVisibleInputRows = visibleLines;

		// 定位光标：
		// for 循环结束后，光标在最后一行行末。
		// saved_row=0, 循环画了 N 行后, 光标在 row=N-1。
		// 需要三个步骤回到正确位置：
		//   1. \r 归零列
		//   2. 上移 N-1 行回到第一个输入行 (row=0)
		//   3. 下移 cursorPos.row，右移 cursorPos.col
		process.stdout.write('\r');
		if (linesToDraw > 1) process.stdout.write(`\x1b[${linesToDraw - 1}A`);
		if (cursorPos.row > 0) process.stdout.write(`\x1b[${cursorPos.row}B`);
		if (cursorPos.col > 0) process.stdout.write(`\x1b[${cursorPos.col}C`);

		showCursor();
	}

	// ─── 流式发送 ──────────────────────────────────

	/** 工具执行确认：在流式期间切换到 y/n 输入 */
	private requestToolConfirm(
		toolName: string,
		params: Record<string, unknown>,
	): Promise<boolean> {
		return new Promise((resolve) => {
			const command = String(params.command ?? '');
			process.stdout.write(yellow(`\n[Confirm] ${command}\n`));
			process.stdout.write(yellow('Execute? [y/N] '));

			const prevHandler = this.stdinHandler;
			this.stdinHandler = (data: string) => {
				process.stdout.write('\n');
				this.stdinHandler = prevHandler;
				if (data === '\x03') {
					// Ctrl+C = deny + abort
					this.abortController?.abort();
					resolve(false);
					return;
				}
				const ch = data.length > 0 ? data[0] : '';
				resolve(ch.toLowerCase() === 'y');
			};
		});
	}

	private async sendMessageStream(content: string): Promise<void> {
		this.setState(AppState.SENDING);
		this.abortController = new AbortController();

		let reasoningStarted = false;
		let contentStarted = false;

		// 流式期间的数据处理：只处理 Ctrl+C
		const prevHandler = this.stdinHandler;
		this.stdinHandler = (data: string) => {
			if (data === '\x03') {
				this.abortController?.abort();
			}
		};

		try {
			await this.sessionMgr.sendMessageStream(
				content,
				(event: StreamEvent) => {
					switch (event.type) {
						case 'reasoning_delta':
							this.setState(AppState.STREAMING);
							if (!reasoningStarted) {
								process.stdout.write(dim('[Think] '));
								reasoningStarted = true;
							}
							process.stdout.write(dim(event.text ?? ''));
							break;
						case 'content_delta':
							this.setState(AppState.STREAMING);
							if (reasoningStarted && !contentStarted) {
								contentStarted = true;
							}
							if (!contentStarted) {
								process.stdout.write('\n\n');
								contentStarted = true;
							}
							process.stdout.write(event.text ?? '');
							break;
						case 'tool_call_start': {
							const shortName = (event.toolName ?? '?').replace('execute_', '');
							process.stdout.write(
								cyan(`\n[T: ${shortName}] `) + dim(JSON.stringify(event.toolArgs ?? {})) + '\n',
							);
							break;
						}
						case 'tool_call_delta':
							// tool call 参数增量（不渲染，静默累积）
							break;
						case 'tool_preview': {
							// diff 预览 — 原生格式，仅着色，不加额外前缀
							const preview = event.toolPreview ?? '';
							if (preview) {
								for (const line of preview.split('\n')) {
									process.stdout.write(renderDiffLine(line, '') + '\n');
								}
							}
							break;
						}
						case 'tool_result':
							if (event.toolDenied) {
								process.stdout.write(red('\n[Denied]\n'));
							} else {
								const lines = (event.toolResult ?? '').split('\n').slice(0, 12);
								for (const line of lines) {
									process.stdout.write(cyan(' │ ') + dim(line) + '\n');
								}
								if ((event.toolResult ?? '').split('\n').length > 12) {
									process.stdout.write(cyan(' │ ') + dim('...') + '\n');
								}
							}
							break;
						case 'done':
							process.stdout.write('\n');
							this.printUsage(event);
							break;
						case 'error':
							process.stdout.write('\n');
							process.stdout.write(red(`Error: ${event.error ?? 'unknown'}`) + '\n');
							break;
					}
				},
				this.abortController.signal,
				this.tools.length > 0
					? (toolName, params) => this.requestToolConfirm(toolName, params)
					: undefined,
			);
		} catch (err: any) {
			if (err?.name === 'AbortError') {
				process.stdout.write(dim('\n[interrupted]\n'));
			} else {
				process.stdout.write(red(`\nError: ${err?.message ?? err}`) + '\n');
			}
		} finally {
			this.stdinHandler = prevHandler;
			this.abortController = null;
			this.setState(AppState.IDLE);
		}
	}

	private printUsage(event: StreamEvent): void {
		if (!event.usage) return;
		const u = event.usage;
		const parts: string[] = [];
		if (u.prompt_tokens > 0) parts.push(`${u.prompt_tokens} in`);
		if (u.completion_tokens > 0) parts.push(`${u.completion_tokens} out`);
		if (parts.length > 0) {
			process.stdout.write(dim(`--- token: ${parts.join(' + ')} ---`) + '\n');
		}
	}

	private setState(newState: AppState): void {
		this.state = newState;
	}
}
