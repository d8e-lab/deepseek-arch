/**
 * ChatUI — 全屏终端对话界面（组合者模式）
 *
 * 组合以下组件：
 *   - ChatState: 流式状态机
 *   - DisplayLines: 对话渲染缓冲区
 *   - InputPanel: 输入面板
 *   - Spinner: 等待动画
 *   - Throttle: 渲染帧率节流
 *
 * 布局：
 *   ┌─ 顶部信息栏 ──────────────────────────────┐
 *   │  DeepSeek Arch v0.4.0                      │
 *   │  Provider: deepseek | Model: deepseek-v4-pro│
 *   ├────────────────────────────────────────────┤
 *   │  [绿色] 用户输入                            │
 *   │  [灰色] 模型思考                            │
 *   │  [白色] 模型回复                            │
 *   │  ...（滚动区域）                            │
 *   ├────────────────────────────────────────────┤
 *   │  [灰底] 多行输入面板（Enter 发送）          │
 *   └────────────────────────────────────────────┘
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import { writeSync } from 'node:fs';
import { ConfigManager } from '../core/config.js';
import { ApiClient } from '../core/api.js';
import { Storage } from '../core/storage.js';
import { SessionManager, type StreamEvent } from '../core/session.js';
import { Throttle } from '../utils/throttle.js';
import type { Message, ChatCompletionResponse } from '../types/index.js';

// ─── 组件导入 ─────────────────────────────────────────

import {
	CSI, CURSOR_HOME, CLEAR_SCREEN, HIDE_CURSOR, SHOW_CURSOR,
	ERASE_LINE, ERASE_SCREEN_BELOW, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN,
	BG_GRAY, RESET_BG, cursorTo, cursorUp,
} from './components/ansi.js';

import { Spinner } from './components/spinner.js';

import { DisplayLines, type LineColor } from './components/display-lines.js';

import { ChatState } from './state/chat-state.js';

import {
	InputPanel,
	charDisplayWidth,
	strDisplayWidth,
} from './components/input-panel.js';

// ─── keypress 类型扩展 ───────────────────────────────

interface KeyPress {
	sequence: string;
	name: string;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
}

// ─── 常量 ────────────────────────────────────────────

const VERSION = '0.4.0';

// ─── ChatUI ──────────────────────────────────────────

export class ChatUI {
	// 依赖
	private config: ConfigManager;
	private sessionManager: SessionManager | null = null;

	// 组件
	private state = new ChatState();
	private display = new DisplayLines();
	private input = new InputPanel();
	private spinner = new Spinner();
	private renderThrottle = new Throttle(60);

	// 终端状态
	private termWidth = 80;
	private termHeight = 24;
	private running = false;
	private rawMode = false;
	private lastInputHeight = 1;
	private stdinIsTTY = false;

	constructor(config: ConfigManager, sessionManager?: SessionManager) {
		this.config = config;
		if (sessionManager) this.sessionManager = sessionManager;
	}

	// ─── 生命周期 ──────────────────────────────────

	async start(): Promise<void> {
		this.stdinIsTTY = process.stdin.isTTY ?? false;
		if (!this.stdinIsTTY) {
			console.error('错误: 需要交互式终端');
			process.exit(1);
		}

		this.updateTermSize();

		if (this.sessionManager) {
			// 恢复会话：加载历史回合
			const session = this.sessionManager.getSession();
			if (session) {
				for (const turn of session.turns) {
					this.display.append(turn.user.content, 'green');
					if (turn.assistant.content) {
						this.display.append(turn.assistant.content, 'white');
					}
				}
			}
		} else {
			// 新会话：初始化 SessionManager
			const provider = this.config.get<string>('defaults.provider') ?? 'deepseek';
			const model = this.config.get<string>('defaults.model') ?? 'deepseek-v4-pro';
			const baseUrl = this.config.get<string>(`providers.${provider}.base_url`) ?? '';
			const apiKey = this.config.get<string>(`providers.${provider}.api_key`) ?? '';

			if (!apiKey) {
				console.error(chalk.red('错误: 未配置 API Key'));
				console.error(chalk.dim(`  请在 ~/.deepseek-arch/providers.toml 中设置 [${provider}].api_key`));
				process.exit(1);
			}

			const client = new ApiClient(baseUrl, apiKey, model);
			const sessionsDir = this.config.getSessionsDir();
			const storage = new Storage(sessionsDir);
			this.sessionManager = new SessionManager(storage, client);

			await this.sessionManager.startNewSession();

			// 加载 system prompt
			const sysPromptName = this.config.get<string>('defaults.system_prompt') ?? 'default';
			const sysPromptContent = this.config.get<string>(`systemPrompts.${sysPromptName}.content`);
			if (sysPromptContent) {
				this.sessionManager.setSystemPrompt({ role: 'system', content: sysPromptContent });
			}
		}

		this.enterAltScreen();
		this.startRawMode();
		this.fullDraw();

		readline.emitKeypressEvents(process.stdin);
		(process.stdin as any).on('keypress', (str: string, key: KeyPress) => {
			this.handleKeyPress(str, key);
		});

		process.on('SIGWINCH', () => this.handleResize());
	}

	private cleanup(): void {
		process.removeListener('SIGWINCH', () => this.handleResize());
		if (this.rawMode) {
			try { process.stdin.setRawMode(false); } catch { /* ignore */ }
		}
		process.stdin.pause();
		this.exitAltScreen();
		writeSync(1, SHOW_CURSOR);
	}

	// ─── 终端控制 ──────────────────────────────────

	private enterAltScreen(): void {
		writeSync(1, HIDE_CURSOR);
		writeSync(1, ENTER_ALT_SCREEN);
	}

	private exitAltScreen(): void {
		writeSync(1, EXIT_ALT_SCREEN);
	}

	private startRawMode(): void {
		this.rawMode = true;
		process.stdin.setRawMode(true);
		process.stdin.resume();
	}

	private updateTermSize(): void {
		this.termWidth = process.stdout.columns ?? 80;
		this.termHeight = process.stdout.rows ?? 24;
	}

	private handleResize(): void {
		this.updateTermSize();
		this.fullDraw();
	}

	// ─── 键盘事件 ──────────────────────────────────

	private handleKeyPress(str: string, key: KeyPress): void {
		if (this.state.isIdle()) {
			this.handleIdleKeyPress(str, key);
		} else {
			this.handleStreamingKeyPress(str, key);
		}
	}

	private handleIdleKeyPress(str: string, key: KeyPress): void {
		const { name, ctrl, meta, shift } = key;

		// Ctrl+C / /exit 命令 → 退出
		if ((ctrl && name === 'c') || this.input.text === '/exit') {
			this.input.clear();
			this.printExitSummary();
			this.cleanup();
			process.exit(0);
		}

		// Ctrl+L / /clear 命令 → 清屏
		if ((ctrl && name === 'l') || this.input.text === '/clear') {
			this.input.clear();
			this.display.clear();
			this.fullDraw();
			return;
		}

		// Ctrl+Enter / Ctrl+J → 换行 (必须在 Enter 前面检查)
		if (str === '\n' || (ctrl && name === 'return')) {
			this.input.insertNewline();
			this.fullDraw();
			return;
		}

		// Enter → 发送
		if (name === 'return') {
			this.handleEnter();
			return;
		}

		// Backspace
		if (name === 'backspace') {
			this.input.deleteChar();
			this.fullDraw();
			return;
		}

		// Delete
		if (name === 'delete' || name === 'del') {
			this.input.deleteForward();
			this.fullDraw();
			return;
		}

		// ← / →
		if (name === 'left') {
			this.input.moveCursor(-1);
			this.fullDraw();
			return;
		}
		if (name === 'right') {
			this.input.moveCursor(1);
			this.fullDraw();
			return;
		}

		// ↑ / ↓ → 输入历史
		if (name === 'up') {
			this.input.navigateHistory(-1);
			this.fullDraw();
			return;
		}
		if (name === 'down') {
			this.input.navigateHistory(1);
			this.fullDraw();
			return;
		}

		// Home / End
		if (name === 'home') {
			this.input.moveCursor(-this.input.cursorPos);
			this.fullDraw();
			return;
		}
		if (name === 'end') {
			this.input.moveCursor(this.input.text.length - this.input.cursorPos);
			this.fullDraw();
			return;
		}

		// /title <name> 命令
		if (this.input.text.startsWith('/title ')) {
			const title = this.input.text.slice(7).trim();
			if (title) {
				this.sessionManager?.setTitle(title);
			}
			this.input.clear();
			this.display.append(`[标题已设为: ${title}]`, 'gray');
			this.fullDraw();
			return;
		}

		// 普通字符
		if (str && !ctrl && !meta && str.length === 1 && str.charCodeAt(0) >= 32) {
			this.input.insertChar(str);
			this.fullDraw();
		}
	}

	private handleStreamingKeyPress(str: string, key: KeyPress): void {
		const { name, ctrl } = key;

		// ESC 或 Ctrl+C → 中断流式
		if (name === 'escape' || (ctrl && name === 'c')) {
			this.interruptStream();
			return;
		}

		// Ctrl+Enter / Ctrl+J → 换行 (必须在 Enter 前面检查)
		if (str === '\n' || (ctrl && name === 'return')) {
			this.input.insertNewline();
			this.drawStreamUpdate();
			return;
		}

		// Enter → 暂存到输入队列
		if (name === 'return' && this.input.text.trim()) {
			const text = this.input.text;
			this.input.clear();
			this.input.enqueue(text);
			this.drawStreamUpdate();
			return;
		}

		// Backspace / Delete
		if (name === 'backspace') {
			this.input.deleteChar();
			this.drawStreamUpdate();
			return;
		}
		if (name === 'delete' || name === 'del') {
			this.input.deleteForward();
			this.drawStreamUpdate();
			return;
		}

		// ← / →
		if (name === 'left') {
			this.input.moveCursor(-1);
			this.drawStreamUpdate();
			return;
		}
		if (name === 'right') {
			this.input.moveCursor(1);
			this.drawStreamUpdate();
			return;
		}

		// 普通字符（流式期间仍可编辑输入框）
		if (str && !ctrl && str.length === 1 && str.charCodeAt(0) >= 32) {
			this.input.insertChar(str);
			this.drawStreamUpdate();
		}
	}

	// ─── 发送消息 ──────────────────────────────────

	private async handleEnter(): Promise<void> {
		const content = this.input.submit();
		if (!content) return;

		this.display.append(content, 'green');

		// 检查命令
		if (content.startsWith('/')) {
			this.fullDraw();
			return;
		}

		// 启动流式发送
		this.state.startSending();
		this.renderThrottle.reset();
		this.spinner.start((frame) => {
			this.drawStreamUpdate();
		});

		const signal = this.state.createAbortController().signal;

		try {
			await this.sessionManager!.sendMessageStream(
				content,
				(event) => this.handleStreamEvent(event),
				signal,
			);
		} catch {
			// sendMessageStream 内部已通过 onEvent 报告错误
		}

		this.spinner.stop();
		this.state.resetToIdle();
		this.state.releaseAbortController();

		// 处理输入队列
		this.processInputQueue();
	}

	private processInputQueue(): void {
		if (!this.input.hasQueue) {
			this.fullDraw();
			return;
		}
		const next = this.input.dequeue();
		if (next) {
			this.input.setText(next);
			this.handleEnter();
		}
	}

	// ─── 流式事件 ──────────────────────────────────

	private handleStreamEvent(event: StreamEvent): void {
		switch (event.type) {
			case 'reasoning_delta':
				this.state.addReasoningDelta(event.text!);
				this.renderThrottle.run(() => this.drawStreamUpdate());
				break;

			case 'content_delta':
				if (!this.state.isStreaming()) {
					// 首次 content_delta：streaming 阶段
					this.state.startStreaming();
					this.spinner.stop();
				}
				this.state.addContentDelta(event.text!);
				this.renderThrottle.run(() => this.drawStreamUpdate());
				break;

			case 'done': {
				const ls = this.state.liveStream;
				if (ls) {
					if (ls.reasoning) {
						this.display.append(ls.reasoning, 'gray');
					}
					this.display.append(ls.content || '(空回复)', 'white');
				}
				// 立即清空 liveStream，避免 fullDraw 重复渲染流式内容
				this.state.resetToIdle();
				this.fullDraw();
				break;
			}

			case 'error':
				if (event.error === '已中断') {
					this.display.append('[已中断]', 'gray');
				} else {
					this.display.append(`[错误: ${event.error}]`, 'gray');
				}
				this.drawStreamUpdate();
				break;
		}
	}

	// ─── 流式中断 ──────────────────────────────────

	private interruptStream(): void {
		this.spinner.stop();
		this.state.abortStream();

		const ls = this.state.liveStream;
		if (ls) {
			if (ls.reasoning) {
				this.display.append(ls.reasoning, 'gray');
			}
			if (ls.content) {
				this.display.append(ls.content, 'white');
			}
			this.display.append('[已中断]', 'gray');
		}

		this.state.releaseAbortController();
		this.drawStreamUpdate();
	}

	// ─── 渲染 ──────────────────────────────────────

	/** 全屏重绘 */
	private fullDraw(): void {
		writeSync(1, CURSOR_HOME + CLEAR_SCREEN);

		// 顶部信息栏
		const provider = this.config.get<string>('defaults.provider') ?? 'deepseek';
		const model = this.config.get<string>('defaults.model') ?? 'deepseek-v4-pro';
		const header = chalk.bold(` DeepSeek Arch v${VERSION}`);
		const info = chalk.dim(`  Provider: ${provider} | Model: ${model}`);

		writeSync(1, header + '\n');
		writeSync(1, info + '\n');

		writeSync(1, '─'.repeat(this.termWidth) + '\n');

		// 对话区域
		const visibleLines = this.getVisibleLines();
		for (const line of visibleLines) {
			const colored = this.colorize(line.text, line.color);
			const dw = strDisplayWidth(line.text);
			const padding = Math.max(0, this.termWidth - dw);
			writeSync(1, colored + ' '.repeat(padding) + '\n');
		}

		// 流式内容（如果在发送中）
		if (this.state.liveStream) {
			const ls = this.state.liveStream;
			if (ls.phase === 'reasoning' && ls.reasoning) {
				writeSync(1, chalk.gray(ls.reasoning) + '\n');
			} else if (ls.phase === 'content') {
				if (ls.reasoning) {
					writeSync(1, chalk.gray(ls.reasoning) + '\n');
				}
				writeSync(1, chalk.white(ls.content));
			}
		}

		// 输入面板（锚定到底部）
		const inputHeight = this.input.calcHeight(this.termWidth);
		this.lastInputHeight = inputHeight;

		// 分隔线（锚定到输入面板上方一行）
		writeSync(1, cursorTo(this.termHeight - inputHeight - 1, 0));
		writeSync(1, ERASE_SCREEN_BELOW);
		writeSync(1, '─'.repeat(this.termWidth) + '\n');

		this.renderInputPanel(inputHeight);

		// 队列提示
		if (this.input.hasQueue) {
			writeSync(1, chalk.dim(`\n⏳ 等待中 (${this.input.queueLength} 条)...`));
		}

		// 光标定位
		const cursor = this.input.calcCursor(inputHeight, this.termWidth);
		const cursorRow = this.termHeight - inputHeight + cursor.cursorRow;
		writeSync(1, cursorTo(cursorRow, cursor.cursorCol));
	}

	/** 流式增量重绘 */
	private drawStreamUpdate(): void {
		if (!this.state.liveStream) {
			this.fullDraw();
			return;
		}

		const ls = this.state.liveStream;
		const sepLine = this.termHeight - this.lastInputHeight - 1;

		// 定位到对话区域末尾
		writeSync(1, cursorTo(sepLine));
		writeSync(1, ERASE_SCREEN_BELOW);

		// 流式内容
		if (ls.phase === 'sending') {
			// spinner
			writeSync(1, cursorTo(sepLine));
			writeSync(1, this.spinner.getFrame());
		} else if (ls.phase === 'reasoning') {
			writeSync(1, chalk.gray(ls.reasoning));
		} else if (ls.phase === 'content') {
			if (ls.reasoning) {
				writeSync(1, chalk.gray(ls.reasoning) + '\n');
			}
			writeSync(1, chalk.white(ls.content));
		}

		// 分隔线
		writeSync(1, '\n' + '─'.repeat(this.termWidth) + '\n');

		// 输入面板
		const inputHeight = this.input.calcHeight(this.termWidth);
		this.lastInputHeight = inputHeight;
		this.renderInputPanel(inputHeight);

		// 队列提示
		if (this.input.hasQueue) {
			writeSync(1, chalk.dim(`\n⏳ 等待中 (${this.input.queueLength} 条)...`));
		}

		// 光标定位
		const cursor = this.input.calcCursor(inputHeight, this.termWidth);
		const cursorRow = this.termHeight - inputHeight + cursor.cursorRow;
		writeSync(1, cursorTo(cursorRow, cursor.cursorCol));
	}

	// ─── 辅助渲染 ──────────────────────────────────

	private renderInputPanel(inputHeight: number): void {
		const prompt = '> ';
		const availableWidth = this.termWidth - prompt.length;
		const wrappedInput = this.input.text.length > 0
			? this.input.text.split('\n').flatMap(line => {
				if (availableWidth <= 0) return [''];
				const result: string[] = [];
				let cur = '';
				let curW = 0;
				for (const ch of line) {
					const cw = charDisplayWidth(ch);
					if (curW + cw > availableWidth) {
						result.push(cur);
						cur = ch;
						curW = cw;
					} else {
						cur += ch;
						curW += cw;
					}
				}
				result.push(cur || '');
				return result;
			})
			: [''];

		for (let i = 0; i < inputHeight; i++) {
			if (i < wrappedInput.length) {
				const line = prompt + wrappedInput[i];
				const lineDisplayWidth = prompt.length + strDisplayWidth(wrappedInput[i]);
				const padded = line + ' '.repeat(Math.max(0, this.termWidth - lineDisplayWidth));
				writeSync(1, BG_GRAY + padded + RESET_BG + '\n');
			} else {
				writeSync(1, BG_GRAY + ' '.repeat(this.termWidth) + RESET_BG + '\n');
			}
		}
	}

	private getVisibleLines(): { text: string; color: LineColor }[] {
		// 顶部 2 行信息栏 + 1 分隔线 + 底部 1 分隔线 + 输入面板行 + 1 空行
		const reservedLines = 5 + this.lastInputHeight;
		const maxLines = Math.max(1, this.termHeight - reservedLines);
		return this.display.getVisible(maxLines);
	}

	private colorize(text: string, color: LineColor): string {
		switch (color) {
			case 'green': return chalk.green(text);
			case 'gray': return chalk.gray(text);
			case 'white':
			default: return chalk.white(text);
		}
	}

	// ─── 退出汇总 ──────────────────────────────────

	private printExitSummary(): void {
		this.exitAltScreen();
		this.fullDraw();
		writeSync(1, CURSOR_HOME);

		const sessionId = this.sessionManager?.getSessionId();
		if (sessionId) {
			console.log(`\n会话已保存 (id: ${sessionId})`);
			console.log(`恢复此会话:`);
			console.log(`  deepseek-arch resume --id ${sessionId}`);
		}

		// Token 摘要（Phase 7 扩展为详细输出）
		console.log('');
	}
}
