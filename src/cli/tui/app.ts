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
import { ConfigManager } from '../../core/config.js';
import { ConversationView } from './conversation.js';
import { InputEditor } from './input-editor.js';
import { Throttle } from '../../utils/throttle.js';
import { execSync } from 'node:child_process';
import {
	getTermSize,
	enableBracketedPaste,
	disableBracketedPaste,
	hideCursor,
	showCursor,
	clearLine,
	onResize,
	offResize,
	GRAY_BG_START,
	GRAY_BG_END,
	PINK_BG_START,
	PINK_BG_END,
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
import { Selector } from './selector.js';
import type { SelectOption } from './selector.js';
import { MarkdownTableRenderer } from './markdown.js';
import { isInteractiveCommand } from '../../tools/utils.js';

/** 输入框最大可见行数 */
const MAX_INPUT_ROWS = 5;

/** 可选模型列表 */
const AVAILABLE_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

/** 从光标处清除到屏幕底 */
const CLEAR_TO_END = '\x1b[0J';

export class TuiApp {
	private sessionMgr: SessionManager;
	private config: TuiConfig;
	private configMgr: ConfigManager | null;
	private tools: Tool[];
	private yolo: boolean;
	private conversation: ConversationView;
	private input: InputEditor;
	private state: AppState = AppState.IDLE;
	private abortController: AbortController | null = null;
	private running = false;
	/** shell 命令模式 */
	private shellMode = false;
	/** 待发送的 shell 上下文（[shell_start]...[shell_end] 块） */
	private pendingShellContext: string[] = [];
	/** 上次渲染的可见行数（用于缩小时清理残留行） */
	private lastVisibleInputRows = 1;
	/** 上次渲染后的光标所在输入行号（0-based，用于下次回到起点） */
	private lastCursorDisplayRow = 0;

	constructor(sessionMgr: SessionManager, config: TuiConfig, tools?: Tool[], configMgr?: ConfigManager, yolo?: boolean) {
		this.sessionMgr = sessionMgr;
		this.config = config;
		this.configMgr = configMgr ?? null;
		this.tools = tools ?? [];
		this.yolo = yolo ?? false;
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
			`deepseek-arch v${this.config.version}  |  Provider: ${this.config.provider}  |  Model: ${this.config.model}\r\n`,
		);

		let infoStr = `Session: ${sessionId.slice(0, 8)}...  |  Turns: ${turnCount}`;
		if (lastUsage && lastUsage.total_tokens > 0) {
			infoStr += `  |  Last tokens: ${lastUsage.prompt_tokens} in + ${lastUsage.completion_tokens} out`;
		}
		process.stdout.write(dim(infoStr) + '\r\n');
	}

	private printSeparator(): void {
		const cols = getTermSize().cols;
		// cols-1 避免 auto-wrap，\r\n 确保 raw mode 下正确换行
		process.stdout.write('─'.repeat(cols - 1) + '\r\n');
	}

	private printConversation(turns: import('../../types/index.js').TurnRecord[]): void {
		const cols = getTermSize().cols;
		const lines = this.conversation.render(turns, cols);
		for (const line of lines) {
			process.stdout.write(line + '\r\n');
		}
	}

	private printExitInfo(): void {
		const sessionId = this.sessionMgr.getSessionId();
		if (sessionId) {
			process.stdout.write(`Session saved: ${sessionId}\r\n`);
			process.stdout.write(`To resume: deepseek-arch chat --resume ${sessionId}\r\n`);
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

		// 终端 resize 监听
		onResize(this.onTermResize);
	}

	private onStdinData = (data: string): void => {
		if (this.stdinHandler) this.stdinHandler(data);
	};

	private onTermResize = (): void => {
		// 仅空闲态重绘输入区域（流式/确认态的输出已在 scrollback 中）
		if (this.state !== AppState.IDLE) return;
		// 回到输入区域起点 → 清到屏底 → 重画 → 重渲染
		if (this.lastCursorDisplayRow > 0) {
			process.stdout.write(`\x1b[${this.lastCursorDisplayRow}A`);
		}
		process.stdout.write('\r');
		process.stdout.write(CLEAR_TO_END);
		this.drawInputArea();
		process.stdout.write('\r');
		this.lastCursorDisplayRow = 0;
		this.renderInput();
	};

	private cleanupRawMode(): void {
		offResize(this.onTermResize);
		process.stdin.off('data', this.onStdinData);
		disableBracketedPaste();
		showCursor();
		process.stdin.setRawMode(false);
		process.stdin.pause();
	}

	// ─── 输入循环（单轮对话）───────────────────────

	private async inputCycle(): Promise<void> {
		this.lastVisibleInputRows = 1;
		this.lastCursorDisplayRow = 0;

		// 画输入区域
		this.drawInputArea();
		process.stdout.write('\r');

		this.input.clear();
		let content = await this.readUserInput();

		// 清除输入区域：回到起点（无历史记录时即当前行），清到屏底
		if (this.lastCursorDisplayRow > 0) {
			process.stdout.write(`\x1b[${this.lastCursorDisplayRow}A`);
		}
		process.stdout.write('\r');
		process.stdout.write(CLEAR_TO_END);

		if (content === null) {
			this.running = false;
			return;
		}

		// / 命令分派
		if (content.startsWith('/')) {
			const handled = await this.handleCommand(content);
			if (handled) {
				this.printSeparator();
				return;
			}
			// 未识别的命令 → 作为普通消息发送
		}

		// 打印用户消息（绿色）
		process.stdout.write(green('[You] ') + content + '\r\n\r\n');

		// 拼接待发送的 shell 上下文（仅模型可见）
		if (this.pendingShellContext.length > 0) {
			content = this.pendingShellContext.join('\n') + '\n' + content;
			this.pendingShellContext = [];
		}

		// 发送并流式输出
		await this.sendMessageStream(content);

		this.printSeparator();
	}

	// ─── 命令处理 ──────────────────────────────────

	/**
	 * 处理 / 命令。返回 true 表示已处理，回到输入循环；
	 * 返回 false 表示未识别，作为普通消息发送。
	 */
	private async handleCommand(content: string): Promise<boolean> {
		if (content.startsWith('/model')) {
			const arg = content.slice(6).trim();
			if (arg && AVAILABLE_MODELS.includes(arg)) {
				return await this.switchModel(arg);
			}

			// 交互式选择
			const options: SelectOption<string>[] = AVAILABLE_MODELS.map((m) => ({
				label: m,
				value: m,
			}));
			const selector = new Selector(options, 'Select a model (↑↓ navigate, Enter confirm):');
			const selected = await selector.select(
				() => this.stdinHandler,
				(h) => {
					this.stdinHandler = h;
				},
			);
			if (selected) {
				return await this.switchModel(selected);
			}
			return true;
		}

		if (content.startsWith('/help')) {
			return this.showHelp();
		}

		if (content.startsWith('/context')) {
			return this.showContext();
		}

		if (content.startsWith('/yolo')) {
			return await this.toggleYolo();
		}

		return false;
	}

	/** 切换模型 */
	private async switchModel(modelName: string): Promise<boolean> {
		this.config.model = modelName;
		this.sessionMgr.setModel(modelName);

		if (this.configMgr) {
			await this.configMgr.set('defaults.model', modelName);
		}

		process.stdout.write(green(`[Model switched: ${modelName}]`) + '\r\n');
		this.printHeader();
		return true;
	}

	/** /help — 显示可用命令列表 */
	private showHelp(): true {
		const cols = getTermSize().cols;
		const w = Math.max(1, cols - 1);
		process.stdout.write(yellow('Commands') + '\r\n');
		process.stdout.write('─'.repeat(w) + '\r\n');

		const cmds: [string, string][] = [
			['/model [name]', 'Switch model (interactive picker if no arg)'],
			['/help',          'Show this command list'],
			['/context',       'Show session context & token usage'],
			['/yolo',          'Toggle YOLO mode (auto-approve tool execution)'],
			['/exit  |  Ctrl+C', 'Exit the session'],
			['!<shell cmd>',   'Execute a shell command (output hidden from model)'],
		];

		for (const [cmd, desc] of cmds) {
			const line = `  ${green(cmd.padEnd(24))} ${dim(desc)}`;
			// 截断到终端宽度避免 auto-wrap
			process.stdout.write(line + '\r\n');
		}
		return true;
	}

	/** /context — 显示当前会话的上下文使用情况 */
	private showContext(): true {
		const session = this.sessionMgr.getSession();
		const meta = session?.meta;
		const turns = session?.turns ?? [];

		const cols = getTermSize().cols;
		const w = Math.max(1, cols - 1);
		process.stdout.write(yellow('Session Context') + '\r\n');
		process.stdout.write('─'.repeat(w) + '\r\n');

		// 基本信息
		process.stdout.write(`  Provider:  ${this.config.provider}\r\n`);
		process.stdout.write(`  Model:     ${this.config.model}\r\n`);
		process.stdout.write(`  YOLO mode: ${this.yolo ? green('ON') : dim('OFF')}\r\n`);
		process.stdout.write(`  Session:   ${meta?.id ?? '—'}${meta?.title ? ' "' + dim(meta.title) + '"' : ''}\r\n`);
		process.stdout.write(`  Turns:     ${meta?.turnCount ?? turns.length}\r\n`);

		// Token 汇总
		let totalPrompt = 0;
		let totalCompletion = 0;
		let totalCacheHit = 0;
		let totalCacheMiss = 0;
		for (const t of turns) {
			if (t.usage) {
				totalPrompt += t.usage.prompt_tokens;
				totalCompletion += t.usage.completion_tokens;
			}
			if (t.round_usage) {
				for (const ru of t.round_usage) {
					totalCacheHit += ru.cache_hit_tokens;
					totalCacheMiss += ru.cache_miss_tokens;
				}
			}
		}
		const grandTotal = totalPrompt + totalCompletion;
		process.stdout.write('  ── Token Usage ──\r\n');
		process.stdout.write(`  Total:       ${grandTotal.toLocaleString()} tokens (${totalPrompt.toLocaleString()} in + ${totalCompletion.toLocaleString()} out)\r\n`);
		if (totalCacheHit + totalCacheMiss > 0) {
			const hitRate = totalCacheHit + totalCacheMiss > 0
				? ((totalCacheHit / (totalCacheHit + totalCacheMiss)) * 100).toFixed(1)
				: '0.0';
			process.stdout.write(`  KV Cache:    ${totalCacheHit.toLocaleString()} hit / ${totalCacheMiss.toLocaleString()} miss (${hitRate}%)\r\n`);
		}

		// 最后一轮详情
		const lastUsage = meta?.lastUsage;
		if (lastUsage && lastUsage.total_tokens > 0) {
			process.stdout.write(`  Last turn:   ${lastUsage.total_tokens} tokens (${lastUsage.prompt_tokens} in + ${lastUsage.completion_tokens} out)\r\n`);
		}

		// 累计费用
		if (meta && meta.totalCost > 0) {
			process.stdout.write(`  Total cost:  ¥${meta.totalCost.toFixed(4)}\r\n`);
		}

		return true;
	}

	/** /yolo — 切换 YOLO 模式 */
	private async toggleYolo(): Promise<boolean> {
		this.yolo = !this.yolo;
		process.stdout.write(
			green(`[YOLO mode: ${this.yolo ? 'ON' : 'OFF'}]`) +
			dim(this.yolo ? '  (auto-approve tool executions)' : '  (confirm before tool execution)') +
			'\r\n',
		);
		return true;
	}

	// ─── shell 命令模式 ────────────────────────────

	/** 进入 shell 命令模式：切换背景色并显示提示 */
	private enterShellMode(): void {
		this.shellMode = true;
	}

	/** 执行 shell 命令并收集输出 */
	private executeShellCommand(cmd: string): void {
		// 打印命令到 scrollback（cmd 已包含前导 !）
		process.stdout.write(PINK_BG_START + cmd + PINK_BG_END + '\r\n');

		// 去掉前导 ! 后执行
		const shellCmd = cmd.startsWith('!') ? cmd.slice(1).trimStart() : cmd;

		// ── 交互式命令禁止 ──────────────────────────
		const interactiveBlocked = isInteractiveCommand(shellCmd);
		if (interactiveBlocked) {
			process.stdout.write(red(`  Blocked: ${interactiveBlocked}`) + '\r\n');
			return;
		}

		let stdout = '';
		let stderr = '';
		try {
			stdout = execSync(shellCmd, {
				cwd: process.cwd(),
				encoding: 'utf-8',
				timeout: 30000,
				maxBuffer: 1024 * 1024,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (err: any) {
			stdout = err.stdout?.toString() ?? '';
			stderr = err.stderr?.toString() ?? '';
			if (!stdout && !stderr) {
				stderr = err.message ?? String(err);
			}
		}

		// 输出 stdout 到 scrollback
		if (stdout) {
			const lines = stdout.split('\n');
			for (const line of lines) {
				process.stdout.write(dim(' │ ' + line) + '\r\n');
			}
		}

		// 输出 stderr 到 scrollback
		if (stderr) {
			const lines = stderr.split('\n');
			for (const line of lines) {
				process.stdout.write(red(' │ ' + line) + '\r\n');
			}
		}

		// 构建隐藏上下文块
		const parts: string[] = ['[shell_start]', cmd];
		if (stdout.trim()) parts.push(stdout.trimEnd());
		if (stderr.trim()) parts.push(stderr.trimEnd());
		parts.push('[shell_end]');
		this.pendingShellContext.push(parts.join('\n'));

		// 退出 shell 模式，回到普通输入
		this.shellMode = false;
		this.printSeparator();
		this.lastVisibleInputRows = 1;
		this.lastCursorDisplayRow = 0;
		this.drawInputArea();
		process.stdout.write('\r');
	}

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
			if (this.shellMode) {
				// shell 模式下 Ctrl+C 退出 shell 模式
				this.shellMode = false;
				this.printSeparator();
				this.lastVisibleInputRows = 1;
				this.lastCursorDisplayRow = 0;
				this.drawInputArea();
				process.stdout.write('\r');
				this.input.clear();
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
				// \r\n（Windows 换行格式的粘贴）→ 视为换行
				if (i + 1 < data.length && data[i + 1] === '\x0a') {
					if (this.shellMode) { i++; continue; } // shell 模式忽略粘贴换行
					this.input.insertNewline();
					i++; // 跳过 \n
					continue;
				}
				// 独立 \r → Enter 提交
				if (this.shellMode) {
					// shell 模式：执行命令
					const cmd = this.input.buildSubmitContent();
					this.input.clear();
					this.renderInput();
					this.executeShellCommand(cmd);
					return;
				}
				if (this.input.isEmpty()) continue;
				const content = this.input.buildSubmitContent();
				this.stdinHandler = null;
				resolve(content);
				return;
			}

			if (ch === '\x0a') { this.input.insertNewline(); continue; }       // Ctrl+J
			if (ch === '\x7f' || ch === '\x08') {
				this.input.deleteBeforeCursor();
				if (this.shellMode && this.input.isEmpty()) {
					this.shellMode = false;
				}
				continue;
			} // Backspace
			if (ch === '\x09') { this.input.insertChar(' '); this.input.insertChar(' '); continue; } // Tab

			if (ch >= ' ') {
				// 空输入时输入 ! 进入 shell 命令模式（! 保留在输入框）
				if (!this.shellMode && ch === '!' && this.input.isEmpty()) {
					this.input.insertChar(ch);
					this.enterShellMode();
					continue;
				}
				this.input.insertChar(ch);
			}
		}

		this.renderInput();
	}

	private handleEscapeSeq(seq: string): void {
		switch (seq) {
			case 'A': this.input.navigateHistory(-1) || this.input.moveCursor(-1, 0); break;
			case 'B': this.input.navigateHistory(1) || this.input.moveCursor(1, 0); break;
			case 'C': this.input.moveCursorRight(); break;
			case 'D': this.input.moveCursorLeft(); break;
			case 'H': this.input.moveToLineStart(); break;
			case 'F': this.input.moveToLineEnd(); break;
			case '3~': this.input.deleteAfterCursor(); break;
		}
	}

	// ─── 输入区域渲染（动态高度）───────────────────

	private drawInputArea(): void {
		const cols = getTermSize().cols;
		const bgStart = this.shellMode ? PINK_BG_START : GRAY_BG_START;
		const bgEnd = this.shellMode ? PINK_BG_END : GRAY_BG_END;
		const empty = ' '.repeat(cols - 1);
		process.stdout.write(bgStart + empty + bgEnd);
	}

	/** 原地刷新输入区域 */
	private renderInput(): void {
		const cols = getTermSize().cols;
		// cols-1 为可用显示宽度（避免 auto-wrap），留 1 列余量给换行光标
		const availWidth = cols - 1;
		this.input.setWrapWidth(availWidth);
		hideCursor();

		const inputLines = this.input.getDisplayLines();
		const cursorPos = this.input.getCursorDisplayPos();
		const visibleLines = Math.max(1, Math.min(inputLines.length, MAX_INPUT_ROWS));
		const linesToDraw = Math.max(visibleLines, this.lastVisibleInputRows);

		// 回到输入区域起始行：从上次光标位置向上移动
		if (this.lastCursorDisplayRow > 0) {
			process.stdout.write(`\x1b[${this.lastCursorDisplayRow}A`);
		}
		process.stdout.write('\r');

		const bgStart = this.shellMode ? PINK_BG_START : GRAY_BG_START;
		const bgEnd = this.shellMode ? PINK_BG_END : GRAY_BG_END;

		// 绘制每一行
		for (let r = 0; r < linesToDraw; r++) {
			clearLine();
			if (r < inputLines.length && r < MAX_INPUT_ROWS) {
				// 软换行后的段已由 InputEditor 截断，只做右侧填充
				const text = padToWidth(inputLines[r], availWidth);
				process.stdout.write(bgStart + text + bgEnd);
			}
			// r >= inputLines.length: 清除残留行（不用灰底）
			if (r < linesToDraw - 1) process.stdout.write('\r\n');
		}
		this.lastVisibleInputRows = visibleLines;

		// 定位光标：
		// for 循环结束后，光标在最后一行行首（每行末 \r\n 回到下行行首）。
		//   1. \r 归零列
		//   2. 上移 linesToDraw-1 行回到第一个输入行
		//   3. 下移 cursorPos.row，右移 cursorPos.col
		process.stdout.write('\r');
		if (linesToDraw > 1) process.stdout.write(`\x1b[${linesToDraw - 1}A`);
		if (cursorPos.row > 0) process.stdout.write(`\x1b[${cursorPos.row}B`);
		if (cursorPos.col > 0) process.stdout.write(`\x1b[${cursorPos.col}C`);

		this.lastCursorDisplayRow = cursorPos.row;
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
			process.stdout.write(yellow(`\r\n[Confirm] ${command}\r\n`));
			process.stdout.write(yellow('Execute? [y/N] '));

			const prevHandler = this.stdinHandler;
			this.stdinHandler = (data: string) => {
				process.stdout.write('\r\n');
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
		/** 追踪 reasoning 末尾是否有换行，用于 reasoning→content 过渡时决定是否加 \r\n */
		let reasoningEndsWithNewline = true;

		// 流式输出节流：累积 delta，30fps 批量写出
		const renderThrottle = new Throttle(30);
		let pending = '';
		let pendingIsReasoning = false;
		const flush = (): void => {
			if (!pending) return;
			process.stdout.write(pendingIsReasoning ? dim(pending) : pending);
			pending = '';
		};

		// 表格渲染器：检测 markdown 表格块并格式化为 box-drawing
		const mdRenderer = new MarkdownTableRenderer();

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
								pending += '[Think] ';
								reasoningStarted = true;
							}
							if (event.text) {
								pending += event.text;
								reasoningEndsWithNewline = event.text.endsWith('\n');
							}
							pendingIsReasoning = true;
							renderThrottle.run(flush);
							break;
						case 'content_delta':
							this.setState(AppState.STREAMING);
							if (reasoningStarted && !contentStarted) {
								flush(); // reasoning → content 过渡，写出剩余 reasoning
								if (!reasoningEndsWithNewline) {
									process.stdout.write('\r\n');
								}
								contentStarted = true;
							}
							if (!contentStarted && !reasoningStarted) {
								process.stdout.write('\r\n\r\n');
								contentStarted = true;
							}
							// 喂入表格渲染器，逐行写出（表格块内部行被暂存，结束时一次性渲染）
							for (const line of mdRenderer.feed(event.text ?? '')) {
								process.stdout.write(line + '\r\n');
							}
							break;
						case 'tool_call_start': {
							flush();
							// 重置 reasoning/content 追踪，使下一轮 agent loop 独立处理
							reasoningStarted = false;
							contentStarted = false;
							reasoningEndsWithNewline = true;
							const shortName = (event.toolName ?? '?').replace('execute_', '');
							process.stdout.write(
								cyan(`\r\n[T: ${shortName}] `) + dim(JSON.stringify(event.toolArgs ?? {})) + '\r\n',
							);
							break;
						}
						case 'tool_call_delta':
							// tool call 参数增量（不渲染，静默累积）
							break;
						case 'tool_preview': {
							flush();
							// diff 预览 — 原生格式，仅着色，不加额外前缀
							const preview = event.toolPreview ?? '';
							if (preview) {
								for (const line of preview.split('\n')) {
									process.stdout.write(renderDiffLine(line, '') + '\r\n');
								}
							}
							break;
						}
						case 'tool_output': {
							// 实时 shell 输出：逐行渲染
							const line = event.outputLine ?? '';
							const stream = event.outputStream ?? 'stdout';
							if (stream === 'stderr') {
								process.stdout.write(yellow(' │ ') + dim(line) + '\r\n');
							} else {
								process.stdout.write(cyan(' │ ') + dim(line) + '\r\n');
							}
							break;
						}
						case 'tool_result':
							flush();
							if (event.toolDenied) {
								process.stdout.write(red('\r\n[Denied]\r\n'));
							} else {
								// 显示错误信息（如果有）
								if (event.error) {
									process.stdout.write(red(' ✖ ') + event.error.split('\n')[0] + '\r\n');
								}
								// 显示工具执行结果内容
								const lines = (event.toolResult ?? '').split('\n').slice(0, 12);
								for (const line of lines) {
									process.stdout.write(cyan(' │ ') + dim(line) + '\r\n');
								}
								if ((event.toolResult ?? '').split('\n').length > 12) {
									process.stdout.write(cyan(' │ ') + dim('...') + '\r\n');
								}
							}
							break;
						case 'done':
							flush();
							// 刷出表格渲染器中暂存的剩余内容
							for (const line of mdRenderer.flush()) {
								process.stdout.write(line + '\r\n');
							}
							this.printUsage(event);
							break;
						case 'error':
							flush();
							process.stdout.write('\r\n');
							process.stdout.write(red(`Error: ${event.error ?? 'unknown'}`) + '\r\n');
							break;
					}
				},
				this.abortController.signal,
				this.tools.length > 0 && !this.yolo
					? (toolName, params) => this.requestToolConfirm(toolName, params)
					: undefined,
			);
		} catch (err: any) {
			if (err?.name === 'AbortError') {
				process.stdout.write(dim('\r\n[interrupted]\r\n'));
			} else {
				process.stdout.write(red(`\r\nError: ${err?.message ?? err}`) + '\r\n');
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
			process.stdout.write(dim(`--- token: ${parts.join(' + ')} ---`) + '\r\n');
		}
	}

	private setState(newState: AppState): void {
		this.state = newState;
	}
}
