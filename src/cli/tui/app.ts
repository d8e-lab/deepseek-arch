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
import { ConversationView, truncateThink, wrapText } from './conversation.js';
import { turnUserContent, turnAssistantContent, turnAssistantReasoning } from '../../utils/turn-utils.js';
import { InputEditor } from './input-editor.js';
import { Throttle } from '../../utils/throttle.js';
import { spawn } from 'node:child_process';
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
	formatToolCallSummary,
	stripAnsi,
} from './renderer.js';
import { AppState } from './types.js';
import type { TuiConfig, ScreenCapture, TurnCaptureInfo, ToolCallCaptureInfo, InputAreaCapture } from './types.js';
import { Selector } from './selector.js';
import type { SelectOption } from './selector.js';
import { MarkdownTableRenderer } from './markdown.js';
import { isInteractiveCommand } from '../../tools/utils.js';

/** 输入框最大可见行数 */
const MAX_INPUT_ROWS = 5;

/** 可选模型列表 */
const AVAILABLE_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

/** 可用命令列表 */
const AVAILABLE_COMMANDS = ['/model', '/help', '/context', '/yolo', '/async', '/subagent', '/subagent_cancel', '/compact', '/exit'];

/** 从光标处清除到屏幕底 */
const CLEAR_TO_END = '\x1b[0J';

export class TuiApp {
	private sessionMgr: SessionManager;
	private config: TuiConfig;
	private configMgr: ConfigManager | null;
	private tools: Tool[];
	private yolo: boolean;
	private reviewModel?: string;
	/** 子代理异步模式 */
	private asyncMode = false;
	private conversation: ConversationView;
	private input: InputEditor;
	private state: AppState = AppState.IDLE;
	private abortController: AbortController | null = null;
	private running = false;
	/** shell 命令模式 */
	private shellMode = false;
	/** 自我交互模式（可启动子 TUI 实例） */
	private selfInteraction = false;
	/** 待发送的 shell 上下文（[shell_start]...[shell_end] 块） */
	private pendingShellContext: string[] = [];
	/** 上次渲染的可见行数（用于缩小时清理残留行） */
	private lastVisibleInputRows = 1;
	/** 上次渲染后的光标所在输入行号（0-based，用于下次回到起点） */
	private lastCursorDisplayRow = 0;
	/** 命令补全建议列表的行数（用于清理） */
	private suggestionLinesCount = 0;
	/** 双工交互：流式输出期间用户 Enter 排入的待发送消息（中断当前输出后发送） */
	private nextMessage: string | null = null;
	/** 当前轮完整 think 内容（Ctrl+O 查看完整思考用） */
	private fullThink: string[] = [];
	/** think 是否已折叠（超出可见行数） */
	private thinkFolded = false;
	/** think 折叠省略号动画定时器 */
	private thinkAnimTimer: ReturnType<typeof setInterval> | null = null;
	/** 省略号动画步进 */
	private thinkAnimStep = 0;
	/** think 最多实时显示行数（超出折叠） */
	private readonly MAX_VISIBLE_THINK = 5;
	/** 全屏浏览视图是否激活（Ctrl+O） */
	private viewerActive = false;
	/** 视图滚动偏移（行） */
	private viewerScrollOffset = 0;
	/** 视图预渲染行 */
	private viewerLines: string[] = [];
	/** 每轮起始行号（左右键跳转用） */
	private viewerTurnStartLines: number[] = [];
	/** 搜索关键词 */
	private viewerSearchQuery = '';
	/** 搜索匹配行号 */
	private viewerSearchMatches: number[] = [];
	/** 当前搜索匹配索引 */
	private viewerSearchIndex = -1;
	/** 是否处于搜索输入模式 */
	private viewerSearchActive = false;
	/** 搜索输入缓冲 */
	private viewerSearchInput = '';
	/** 打开视图前的 stdinHandler（退出时恢复） */
	private viewerPrevHandler: ((data: string) => void) | null = null;
	/** 当前视图 handler 引用（退出时判断主循环是否已接管输入） */
	private viewerHandler: ((data: string) => void) | null = null;
	/** 视图关闭等待（inputCycle 在视图打开时等待，避免接管输入） */
	private viewerClosedPromise: Promise<void> | null = null;
	private viewerClosedResolve: (() => void) | null = null;
	/** 打开视图时的 turns.length（退出时据此补渲染） */
	private viewerOpenTurnCount = 0;
	/** 打开视图时是否处于流式输出中 */
	private viewerOpenedDuringStream = false;
	/** 打开时的进行中轮是否已完成（done） */
	private viewerOpenedTurnDone = false;
	/** 打开时的进行中轮在视图期间的输出行（done 时归档） */
	private viewerOpenedTurnLines: string[] = [];
	/** 视图期间当前轮的输出行缓冲（流式静默用） */
	private streamLines: string[] = [];

	constructor(sessionMgr: SessionManager, config: TuiConfig, tools?: Tool[], configMgr?: ConfigManager, yolo?: boolean) {
		this.sessionMgr = sessionMgr;
		this.config = config;
		this.configMgr = configMgr ?? null;
		this.tools = tools ?? [];
		this.yolo = yolo ?? false;
		this.reviewModel = config.reviewModel;
		this.asyncMode = sessionMgr.getSubagentAsync();
		this.conversation = new ConversationView();
		this.input = new InputEditor();
	}

	/** 设置自我交互模式（在 start() 之前调用） */
	setSelfInteraction(enabled: boolean): void {
		this.selfInteraction = enabled;
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

		const modeTags: string[] = [];
		if (this.selfInteraction) modeTags.push('SELF-INTERACTION');
		const modeStr = modeTags.length > 0 ? `  |  [${modeTags.join(', ')}]` : '';

		process.stdout.write(
			`deepseek-arch v${this.config.version}  |  Provider: ${this.config.provider}  |  Model: ${this.config.model}${modeStr}\r\n`,
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

	// ─── 屏幕捕获（供模型调试工具使用）───────────────

	/**
	 * 捕获当前 TUI 屏幕状态，返回结构化信息供模型了解渲染情况
	 *
	 * 调用时机：仅在 IDLE 状态下有效（流式/sending 时返回 null）
	 */
	captureScreen(): ScreenCapture | null {
		if (this.state !== AppState.IDLE) return null;

		const term = getTermSize();
		const session = this.sessionMgr.getSession();
		const turns = session?.turns ?? [];
		const meta = session?.meta;

		// Header 纯文本
		const header = `deepseek-arch v${this.config.version} | Provider: ${this.config.provider} | Model: ${this.config.model}`;

		// 对话轮次捕获
		const turnCaptures: TurnCaptureInfo[] = [];
		const warnings: string[] = [];

		for (let ti = 0; ti < turns.length; ti++) {
			const turn = turns[ti];
			// F-2：v2 顶层无 assistant.content/reasoning（方案 C 后恒 undefined），统一走 turn-utils 推导
			const thinkText = turnAssistantReasoning(turn);
			const thinkLines = thinkText ? thinkText.split('\n').length : 0;
			const { isTruncated } = thinkText ? truncateThink(thinkText) : { isTruncated: false };

			if (isTruncated) {
				warnings.push(`Turn #${ti + 1}: think content truncated (${thinkLines} lines, max 4 displayed)`);
			}

			const contentText = turnAssistantContent(turn);
			const contentLines = contentText ? contentText.split('\n').length : 0;

			// 工具调用
			const tcRecords = turn.tool_calls;
			const toolCalls: ToolCallCaptureInfo[] = [];
			if (tcRecords && Array.isArray(tcRecords)) {
				for (const tcr of tcRecords) {
					toolCalls.push({
						name: tcr.name,
						args: JSON.stringify(tcr.arguments),
						durationMs: tcr.duration_ms ?? 0,
						error: tcr.error,
						resultPreview: tcr.result
							? tcr.result.split('\n').slice(0, 3).join('\n')
							: '',
					});
				}
			}

			// Usage
			const usageParts: string[] = [];
			if (turn.usage) {
				if (turn.usage.prompt_tokens > 0) usageParts.push(`${turn.usage.prompt_tokens} in`);
				if (turn.usage.completion_tokens > 0) usageParts.push(`${turn.usage.completion_tokens} out`);
			}
			const usageStr = usageParts.length > 0 ? usageParts.join(' + ') : '';
			const costStr = turn.cost_rmb && turn.cost_rmb > 0 ? `¥${turn.cost_rmb.toFixed(4)}` : '';

			turnCaptures.push({
				index: ti,
				userText: turnUserContent(turn),
				thinkLines,
				thinkTruncated: isTruncated,
				contentLines,
				toolCalls,
				usage: [usageStr, costStr].filter(Boolean).join(', '),
			});
		}

		// 输入区域捕获
		const inputLines = this.input.getDisplayLines();
		const cursorPos = this.input.getCursorDisplayPos();
		const inputCapture: InputAreaCapture = {
			shellMode: this.shellMode,
			lineCount: inputLines.length,
			maxVisibleLines: 5,
			cursorRow: cursorPos.row,
			cursorCol: cursorPos.col,
			textPreview: inputLines.join('\n').slice(0, 200),
		};

		// 输入区域接近最大高度的警告
		if (inputLines.length >= 5) {
			warnings.push('Input area at max height (5 lines)');
		}

		// 对话历史行数警告（如果超过终端高度）
		const convLines = this.conversation.getLineCount(turns, term.cols);
		if (convLines > term.rows - 3) {
			warnings.push(`Conversation (${convLines} lines) exceeds terminal height (${term.rows - 3} visible), scrollback only`);
		}

		return {
			terminal: { rows: term.rows, cols: term.cols },
			appState: this.state,
			header,
			turnCount: turns.length,
			turns: turnCaptures,
			inputArea: inputCapture,
			warnings,
		};
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
		// 视图打开中：等待视图关闭（不接管输入，避免覆盖 viewer handler）
		if (this.viewerActive) {
			await this.waitForViewerClose();
			return;
		}
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

		// / 命令分派：handleCommand 返回 false（// 转义为普通文本）→ 作为普通消息发送
		if (content.startsWith('/')) {
			const handled = await this.handleCommand(content);
			if (!handled) {
				// F-9：// 前缀转义——去掉一个 / 后按普通消息发送（如 "//usr/bin 在哪" → "/usr/bin 在哪"）
				const sendContent = content.startsWith('//') ? content.slice(1) : content;
				process.stdout.write(green('[You] ') + sendContent + '\r\n\r\n');
				await this.sendMessageStream(sendContent);
			}
			// 视图可能在命令处理/输出期间打开：跳过 UI 收尾（视图接管）
			if (this.viewerActive) return;
			this.printSeparator();
			return;
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

		// 视图可能在输出期间打开：跳过 UI 收尾（主循环等待视图关闭后重新进入）
		if (this.viewerActive) return;
		this.printSeparator();
	}

	// ─── 命令处理 ──────────────────────────────────

	/**
	 * 处理 / 命令。返回 true 表示已处理，回到输入循环；
	 * 返回 false 表示未识别，作为普通消息发送。
	 */
	private async handleCommand(content: string): Promise<boolean> {
		// F-9：// 前缀转义——以 // 开头的文本作为普通消息发送（调用方去掉一个 /）
		if (content.startsWith('//')) {
			return false;
		}

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

		if (content.startsWith('/async')) {
			return await this.toggleAsync();
		}

		if (content.startsWith('/subagent_cancel')) {
			// 注意：必须以 /subagent_cancel 精确前缀匹配，且放在 /subagent 之前（二者同前缀）
			return await this.cancelSubagentInteractive();
		}

		if (content.startsWith('/subagent')) {
			const arg = content.slice(9).trim();
			return this.showSubagentDetail(arg);
		}

		if (content === '/compact') {
			return await this.compactSession();
		}

		if (content === '/exit') {
			process.stdout.write(green('Goodbye!') + '\r\n');
			this.running = false;
			return true;
		}

		// 未知命令 — 不再发送给模型，显示错误提示
		const errMsg = `Unknown command: ${content.split(/\s+/)[0]}`;
		process.stdout.write(red(errMsg) + '\r\n');
		process.stdout.write(dim(`  Available: ${AVAILABLE_COMMANDS.join(', ')}`) + '\r\n');
		return true;
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
			['/async',         'Toggle subagent async mode (ON=non-blocking spawn, OFF=blocking)'],
			['/yolo',          'Toggle YOLO mode (auto-approve tool execution)'],
			['/subagent [name]','Show subagent details (Ctrl+T for list)'],
			['/subagent_cancel','Cancel subagent(s) via interactive list'],
			['/compact',       'Compact session context (summarize + restore read files)'],
			['/help',          'Show this command list'],
			['/context',       'Show session context & token usage'],
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
		process.stdout.write(`  Subagent:  ${this.asyncMode ? green('async') : dim('sync')}\r\n`);
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

	/** /compact — 压缩会话上下文（摘要 + 文件重注入，开启新分代） */
	private async compactSession(): Promise<boolean> {
		process.stdout.write(dim('Compacting session context...') + '\r\n');
		try {
			const result = await this.sessionMgr.compactContext();
			process.stdout.write(
				green(`[Compacted] → 新分代 #${result.gen}，压缩 ${result.compressedTurns} 轮，重注入 ${result.restoredFiles} 个文件 (${result.restoredTokens} tokens)`) + '\r\n',
			);
			if (result.summaryPreview) {
				process.stdout.write(dim(`  summary: ${result.summaryPreview}`) + '\r\n');
			}
			// 刷新对话显示（含摘要轮折叠块）
			const session = this.sessionMgr.getSession();
			if (session) {
				this.printConversation(session.turns);
				this.printSeparator();
			}
		} catch (err) {
			process.stdout.write(
				red(`[Compact failed] ${err instanceof Error ? err.message : String(err)}`) + '\r\n',
			);
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

	/** /async — 切换子代理异步模式 */
	private async toggleAsync(): Promise<boolean> {
		this.asyncMode = !this.asyncMode;
		this.sessionMgr.setSubagentAsync(this.asyncMode);
		process.stdout.write(
			green(`[Subagent async: ${this.asyncMode ? 'ON' : 'OFF'}]`) +
			dim(this.asyncMode
				? '  (subagent_spawn returns [SPAWNED], use wait/list_subagents)'
				: '  (subagent_spawn blocks until complete)') +
			'\r\n',
		);
		return true;
	}

	/** /subagent_cancel — 交互式选择要取消的子代理（含"全部取消"选项） */
	private async cancelSubagentInteractive(): Promise<true> {
		const store = this.sessionMgr.getSubagentStore();
		const names = store.list();
		if (names.length === 0) {
			process.stdout.write(dim('No subagents to cancel.') + '\r\n');
			return true;
		}

		const options: SelectOption<string>[] = [
			{ label: `全部取消 (${names.length} 个)`, value: '__all__' },
			...names.map((n) => {
				const rec = store.get(n);
				const status = rec?.status ?? 'running';
				const icon = status === 'running' ? '⏳'
					: status === 'completed' ? '✓'
					: status === 'cancelled' ? '✕'
					: '✗';
				return { label: `${n}  (${icon} ${status})`, value: n };
			}),
		];

		const selector = new Selector(options, '选择要取消的子代理 (↑↓ 移动, Enter 确认, Ctrl+C 取消):');
		const selected = await selector.select(
			() => this.stdinHandler,
			(h) => {
				this.stdinHandler = h;
			},
		);

		if (selected) {
			const cancelled = this.sessionMgr.cancelSubagent(selected === '__all__' ? 'all' : selected);
			if (cancelled.length > 0) {
				process.stdout.write(
					green(`[cancelled] ${selected === '__all__' ? `全部 ${cancelled.length} 个子代理` : selected}`) + '\r\n',
				);
			} else {
				process.stdout.write(dim(`No running subagent matched.`) + '\r\n');
			}
		}
		return true;
	}

	/** /subagent [name] — 显示子代理详情 */
	private async showSubagentDetail(name?: string): Promise<true> {
		const store = this.sessionMgr.getSubagentStore();
		let names = store.list();

		// 如果内存中没有，尝试从存储加载历史记录
		if (names.length === 0) {
			const sessionId = this.sessionMgr.getSessionId();
			if (sessionId && this.configMgr) {
				try {
					const { Storage } = await import('../../core/storage.js');
					const sessionsDir = this.configMgr.getSessionsDir();
					if (sessionsDir) {
						const storage = new Storage(sessionsDir);
						names = await storage.listSubagentRecords(sessionId);
						// 加载到内存 store 以便后续 get()
						for (const n of names) {
							const record = await storage.loadSubagentRecord(sessionId, n);
							if (record) {
								store.start(n, record.task);
								for (const entry of record.entries) {
									store.push(n, entry);
								}
								store.finish(n, record.result ?? '', record.status === 'cancelled' ? 'cancelled' : record.status === 'failed' ? 'failed' : 'completed');
							}
						}
					}
				} catch { /* 存储不可用，忽略 */ }
			}
		}

		if (names.length === 0) {
			process.stdout.write(dim('No subagents in current session.\r\n'));
			return true;
		}

		if (!name) {
			// 无参数：列出所有子代理
			process.stdout.write(yellow('Subagents') + '\r\n');
			process.stdout.write(dim('─'.repeat(40)) + '\r\n');
			for (const n of names) {
				const record = store.get(n);
				if (!record) continue;
				const icon = record.status === 'running' ? '⏳'
					: record.status === 'completed' ? green('✓')
					: red('✗');
				const elapsed = record.endMs
					? `${((record.endMs - record.startMs) / 1000).toFixed(1)}s`
					: `${((Date.now() - record.startMs) / 1000).toFixed(1)}s`;
				process.stdout.write(
					`  ${icon} ${cyan(n)} ${dim(`(${record.status}, ${elapsed})`)}\r\n`,
				);
				process.stdout.write(dim(`     ${record.task.slice(0, 80)}${record.task.length > 80 ? '...' : ''}`) + '\r\n');
			}
			process.stdout.write(dim('─'.repeat(40)) + '\r\n');
			process.stdout.write(dim(`/subagent <name> for full detail  |  ${names.length} total`) + '\r\n');
			return true;
		}

		// 指定名称：显示完整输出
		const record = store.get(name);
		if (!record) {
			process.stdout.write(red(`Subagent "${name}" not found. Use /subagent (no args) to list.`) + '\r\n');
			return true;
		}

		this.printSubagentRecord(record);
		return true;
	}

	/** 打印子代理完整记录 */
	private printSubagentRecord(record: import('../../core/subagent-store.js').SubagentRecord): void {
		const icon = record.status === 'running' ? '⏳'
			: record.status === 'completed' ? '✓'
			: '✗';
		const elapsed = record.endMs
			? `${((record.endMs - record.startMs) / 1000).toFixed(1)}s`
			: `${((Date.now() - record.startMs) / 1000).toFixed(1)}s`;

		process.stdout.write(yellow(`\r\n═══ Subagent: ${record.name} ${icon} ${dim(elapsed)} ═══`) + '\r\n');
		process.stdout.write(dim(`Task: ${record.task}`) + '\r\n');
		process.stdout.write(dim('─'.repeat(60)) + '\r\n');

		for (const entry of record.entries) {
			switch (entry.type) {
				case 'thinking':
					// thinking 不渲染（太冗长），跳过
					break;
				case 'content': {
					const lines = entry.content.split('\n');
					for (const line of lines) {
						process.stdout.write('  ' + line + '\r\n');
					}
					break;
				}
				case 'tool_call':
					process.stdout.write(
						cyan(`\r\n  [T: ${entry.toolName ?? '?'}] `) + dim(JSON.stringify(entry.toolArgs ?? {})) + '\r\n',
					);
					break;
				case 'tool_result': {
					const lines = entry.content.split('\n');
					for (const line of lines) {
						process.stdout.write(cyan('  │ ') + dim(line) + '\r\n');
					}
					if (entry.toolError) {
						process.stdout.write(red(`  ✖ ${entry.toolError}`) + '\r\n');
					}
					break;
				}
				case 'tool_output': {
					const stream = entry.outputStream ?? 'stdout';
					if (stream === 'stderr') {
						process.stdout.write(yellow('  │ ') + dim(entry.content) + '\r\n');
					} else {
						process.stdout.write(cyan('  │ ') + dim(entry.content) + '\r\n');
					}
					break;
				}
			}
		}

		if (record.result) {
			process.stdout.write(dim('\r\n── Final Result ──') + '\r\n');
			process.stdout.write(record.result + '\r\n');
		}

		process.stdout.write(dim('─'.repeat(60)) + '\r\n');
	}

	// ─── shell 命令模式 ────────────────────────────

	/** 进入 shell 命令模式：切换背景色并显示提示 */
	private enterShellMode(): void {
		this.shellMode = true;
	}

	/** 执行 shell 命令并收集输出（F-4：异步 spawn，不阻塞事件循环——长命令期间 Ctrl+C 仍可响应） */
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
		let timedOut = false;

		// 使用系统默认 shell（与 execSync 行为一致，跨平台）
		const child = spawn(shellCmd, {
			cwd: process.cwd(),
			shell: true,
			stdio: ['ignore', 'pipe', 'pipe'] as const,
		});

		child.stdout?.on('data', (buf: Buffer) => { stdout += buf.toString(); });
		child.stderr?.on('data', (buf: Buffer) => { stderr += buf.toString(); });

		// 30s 超时（与原 execSync timeout 一致）
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 30000);

		child.on('error', (err: Error) => {
			if (!stdout && !stderr) stderr = err.message;
		});

		child.on('close', () => {
			clearTimeout(timeout);
			if (timedOut && !stderr) stderr = '(timed out after 30s)';
			this.finishShellCommand(cmd, stdout, stderr);
		});
	}

	/** 收集 shell 输出完成：打印结果 + 构造隐藏上下文块 + 退出 shell 模式 */
	private finishShellCommand(cmd: string, stdout: string, stderr: string): void {
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
		// Ctrl+O: 打开全屏对话浏览视图（流式期间和 IDLE 都可用；流式时后台静默）
		if (data.includes('\x0f')) {
			this.openViewer();
			return;
		}

		// Ctrl+T: toggle subagent detail view
		if (data === '\x14') {
			if (this.state === AppState.IDLE) {
				this.showSubagentDetail();
				this.printSeparator();
				this.lastVisibleInputRows = 1;
				this.lastCursorDisplayRow = 0;
				this.drawInputArea();
				process.stdout.write('\r');
			}
			return;
		}

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
				if (i >= data.length) {
					// 单独的 ESC 键：在命令模式下退出命令模式
					if (this.input.isInCommandMode()) {
						// 删除 / 并退出命令模式
						while (this.input.getCommandPrefix().length > 0) {
							this.input.deleteBeforeCursor();
						}
						this.input.exitCommandMode();
						this.clearSuggestions();
					}
					continue;
				}
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
				// 命令模式下 Enter：检查命令有效性
				if (this.input.isInCommandMode()) {
					this.handleCommandModeEnter(resolve);
					return;
				}
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
				// 命令模式下 Backspace：如果只剩 / 则退出命令模式
				if (this.input.isInCommandMode()) {
					const prefix = this.input.getCommandPrefix();
					if (prefix.length <= 0) {
						// 删除 /，退出命令模式
						this.input.deleteBeforeCursor();
						this.input.exitCommandMode();
						this.clearSuggestions();
						this.renderInput();
						continue;
					}
				}
				this.input.deleteBeforeCursor();
				if (this.shellMode && this.input.isEmpty()) {
					this.shellMode = false;
				}
				if (this.input.isInCommandMode()) {
					const prefix = this.input.getCommandPrefix();
					this.input.updateSuggestions(prefix);
				}
				continue;
			} // Backspace
			if (ch === '\x09') {
				// 命令模式下 Tab：补全选中建议
				if (this.input.isInCommandMode()) {
					this.completeCommandSuggestion();
					continue;
				}
				this.input.insertChar(' '); this.input.insertChar(' '); continue;
			} // Tab

			if (ch >= ' ') {
				// 空输入时检测特殊前缀
				if (this.input.isEmpty() && !this.shellMode) {
					if (ch === '!') {
						this.input.insertChar(ch);
						this.enterShellMode();
						continue;
					}
					if (ch === '/') {
						this.input.insertChar(ch);
						this.input.enterCommandMode(AVAILABLE_COMMANDS);
						this.renderInput();
						continue;
					}
				}
				this.input.insertChar(ch);
				// 命令模式下输入字符后更新建议
				if (this.input.isInCommandMode()) {
					const prefix = this.input.getCommandPrefix();
					this.input.updateSuggestions(prefix);
				}
			}
		}

		this.renderInput();
	}

	/** 处理命令模式下按 Enter */
	private handleCommandModeEnter(resolve: (value: string | null) => void): void {
		const content = this.input.buildSubmitContent();

		// 检查命令是否已知
		const cmdName = content.split(/\s+/)[0]; // 取第一个单词（命令名）
		const isKnown = AVAILABLE_COMMANDS.some((c) => c === cmdName);

		if (isKnown) {
			// 已知命令：退出命令模式并提交
			this.input.exitCommandMode();
			this.clearSuggestions();
			this.stdinHandler = null;
			resolve(content);
		} else {
			// 未知命令：显示错误，不清除输入，让用户继续编辑
			const errMsg = `Unknown command: ${content}`;
			process.stdout.write(red(errMsg) + '\r\n');
			process.stdout.write(dim(`  Available: ${AVAILABLE_COMMANDS.join(', ')}`) + '\r\n');
			// 不清除输入，不清除 stdinHandler，用户可继续修改/重试
			// 重新渲染输入区域
			this.printSeparator();
			this.lastVisibleInputRows = 1;
			this.lastCursorDisplayRow = 0;
			this.drawInputArea();
			this.renderInput();
		}
	}

	/** 命令模式下 Tab：补全当前选中的建议 */
	private completeCommandSuggestion(): void {
		const suggestion = this.input.getCurrentSuggestion();
		if (!suggestion) return;

		// 替换第一行为选中的命令
		const currentLine = this.input.getCommandPrefix();
		// 删除当前命令文本（从 / 之后到行尾）
		while (this.input.getCommandPrefix().length > 0) {
			this.input.deleteBeforeCursor();
		}
		// 插入补全的命令文本（不含 /）
		const cmdText = suggestion.startsWith('/') ? suggestion.slice(1) : suggestion;
		for (const ch of cmdText) {
			this.input.insertChar(ch);
		}
		// 退出命令模式，不再显示建议
		this.input.exitCommandMode();
		this.clearSuggestions();
		this.renderInput();
	}

	/** 清除建议列表显示（从当前光标位置清到屏幕底部） */
	private clearSuggestions(): void {
		if (this.suggestionLinesCount > 0) {
			process.stdout.write(CLEAR_TO_END);
			this.suggestionLinesCount = 0;
		}
	}

	private handleEscapeSeq(seq: string): void {
		switch (seq) {
			case 'A':
				// 命令模式下 ↑↓ 导航建议列表
				if (this.input.isInCommandMode()) {
					this.input.navigateSuggestion(-1);
				} else {
					this.input.navigateHistory(-1) || this.input.moveCursor(-1, 0);
				}
				break;
			case 'B':
				if (this.input.isInCommandMode()) {
					this.input.navigateSuggestion(1);
				} else {
					this.input.navigateHistory(1) || this.input.moveCursor(1, 0);
				}
				break;
			case 'C': this.input.moveCursorRight(); break;
			case 'D': this.input.moveCursorLeft(); break;
			case 'H':
			case '1~': this.input.moveToLineStart(); break;
			case 'F':
			case '4~': this.input.moveToLineEnd(); break;
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
	private renderInput(): void {		const cols = getTermSize().cols;
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

		// 绘制建议列表（在输入区域下方）
		if (this.input.isInCommandMode()) {
			const suggestIdx = this.input.getSuggestionIndex();
			const suggestions = this.input.getSuggestions();
			const oldSuggCount = this.suggestionLinesCount;
			const totalSuggestLines = this.renderSuggestions(suggestions, suggestIdx, availWidth);
			// 清除旧建议的残留行（新列表变短时）
			if (totalSuggestLines < oldSuggCount) {
				for (let r = totalSuggestLines; r < oldSuggCount; r++) {
					process.stdout.write('\r\n');
					clearLine();
				}
				// 回到新建议的最后一行
				if (oldSuggCount - totalSuggestLines > 0) {
					process.stdout.write(`\x1b[${oldSuggCount - totalSuggestLines}A`);
				}
			}
			this.suggestionLinesCount = totalSuggestLines;
		} else if (this.suggestionLinesCount > 0) {
			// 非命令模式：清除旧的建议列表（光标当前在输入区末尾，清到屏底即可）
			process.stdout.write(CLEAR_TO_END);
			this.suggestionLinesCount = 0;
		}

		// 定位光标：
		// for 循环结束后，光标在最后一行行首（每行末 \r\n 回到下行行首）。
		// 如果有建议列表，光标在建议列表之后，需先上移建议行数回到输入区
		//   1. \r 归零列
		//   2. 上移 linesToDraw-1 行回到第一个输入行
		//   3. 如果绘制了建议，上移建议行数回到输入区域下方
		//   4. 下移 cursorPos.row，右移 cursorPos.col
		process.stdout.write('\r');
		const totalUp = (linesToDraw - 1) + this.suggestionLinesCount;
		if (totalUp > 0) process.stdout.write(`\x1b[${totalUp}A`);
		if (cursorPos.row > 0) process.stdout.write(`\x1b[${cursorPos.row}B`);
		if (cursorPos.col > 0) process.stdout.write(`\x1b[${cursorPos.col}C`);

		this.lastCursorDisplayRow = cursorPos.row;
		showCursor();
	}

	// ─── Bug 1：流式输出期间输入区固定在底部 ──────

	/**
	 * 收起输入区：光标移到输入区起点，清到屏底。
	 * 输出开始前/每条输出行前调用，使输出从原输入区位置开始写。
	 */
	private collapseInputArea(): void {
		if (this.lastCursorDisplayRow > 0) {
			process.stdout.write(`\x1b[${this.lastCursorDisplayRow}A`);
		}
		process.stdout.write('\r');
		process.stdout.write(CLEAR_TO_END);
		this.lastVisibleInputRows = 1;
		this.lastCursorDisplayRow = 0;
	}

	/**
	 * 输出期间：从当前光标位置（输出区末尾）重绘输入区。
	 * 与 IDLE 态 renderInput 不同：强制 lastCursorDisplayRow=0，不做上移回退，
	 * 直接在光标下方绘制输入区，使其视觉上固定在屏幕底部。
	 */
	private renderInputDuringStream(): void {
		this.lastCursorDisplayRow = 0;
		this.renderInput();
	}

	/** 输出一行到 scrollback，并在底部重绘输入区（Bug 1）；视图打开时缓冲（流式静默） */
	private writeOutputLine(line: string): void {
		if (this.viewerActive) {
			// 全屏视图打开：输出静默缓冲（退出视图后补渲染）
			this.streamLines.push(line);
			return;
		}
		this.collapseInputArea();
		process.stdout.write(line + '\r\n');
		this.renderInputDuringStream();
	}

	/** 批量输出多行（减少逐行重绘闪烁）；视图打开时缓冲 */
	private writeOutputLines(lines: string[]): void {
		if (lines.length === 0) return;
		if (this.viewerActive) {
			this.streamLines.push(...lines);
			return;
		}
		this.collapseInputArea();
		for (const l of lines) {
			process.stdout.write(l + '\r\n');
		}
		this.renderInputDuringStream();
	}

	// ─── think 折叠（节省显示空间，Ctrl+O 查看完整）──

	/** 进入 think 折叠：显示折叠提示行 + 启动动态省略号动画 */
	private enterThinkCollapse(): void {
		if (this.thinkFolded) return;
		this.thinkFolded = true;
		this.thinkAnimStep = 0;
		this.writeOutputLine(dim('[Think] 思考中 ·  (Ctrl+O 查看完整)'));
		this.thinkAnimTimer = setInterval(() => {
			this.thinkAnimStep = (this.thinkAnimStep % 3) + 1;
			this.updateThinkCollapseLine();
		}, 400);
	}

	/** 原地更新折叠提示行的省略号（动画） */
	private updateThinkCollapseLine(): void {
		if (!this.thinkFolded) return;
		const dots = '·'.repeat(this.thinkAnimStep);
		// 光标在输入区，上移到折叠提示行更新后移回
		const up = (this.lastCursorDisplayRow ?? 0) + 1;
		process.stdout.write(`\x1b[${up}A`);
		process.stdout.write('\r');
		clearLine();
		process.stdout.write(dim(`[Think] 思考中 ${dots}  (Ctrl+O 查看完整)`));
		process.stdout.write(`\x1b[${up}B`);
		process.stdout.write('\r');
	}

	/** 定稿折叠行（think 阶段结束：content 过渡/工具调用/done 时调用） */
	private finalizeThinkCollapse(): void {
		if (!this.thinkFolded) return;
		if (this.thinkAnimTimer) {
			clearInterval(this.thinkAnimTimer);
			this.thinkAnimTimer = null;
		}
		const foldedCount = Math.max(0, this.fullThink.length - this.MAX_VISIBLE_THINK);
		const up = (this.lastCursorDisplayRow ?? 0) + 1;
		process.stdout.write(`\x1b[${up}A`);
		process.stdout.write('\r');
		clearLine();
		process.stdout.write(dim(`[Think] 已折叠 ${foldedCount} 行 (Ctrl+O 查看完整)`));
		process.stdout.write('\r\n');
		this.thinkFolded = false;
		// 光标在折叠行下一行（输出末尾），后续 writeOutputLine 从这继续
		this.lastVisibleInputRows = 1;
		this.lastCursorDisplayRow = 0;
	}

	// ─── Ctrl+O 全屏对话浏览视图 ─────────────────────

	/** 打开全屏浏览视图（alternate screen；流式期间打开则后台静默输出） */
	private openViewer(): void {
		if (this.viewerActive) return;
		this.viewerActive = true;
		// 记录打开时状态（退出时据此补渲染）
		const session = this.sessionMgr.getSession();
		this.viewerOpenTurnCount = session?.turns.length ?? 0;
		this.viewerOpenedDuringStream = this.state !== AppState.IDLE;
		this.viewerOpenedTurnDone = false;
		this.viewerOpenedTurnLines = [];
		this.streamLines = [];
		// 暂停 think 折叠动画（其直接写 stdout，会污染主 buffer）
		if (this.thinkAnimTimer) {
			clearInterval(this.thinkAnimTimer);
			this.thinkAnimTimer = null;
		}
		// 保存当前 stdinHandler，切换为视图 handler
		this.viewerPrevHandler = this.stdinHandler;
		this.viewerHandler = (data: string) => this.handleViewerInput(data);
		this.stdinHandler = this.viewerHandler;
		// 建立视图关闭等待（inputCycle 在视图打开时等待）
		this.viewerClosedPromise = new Promise<void>((r) => { this.viewerClosedResolve = r; });
		// 切换 alternate screen 并渲染
		process.stdout.write('\x1b[?1049h');
		this.buildViewerLines();
		this.viewerScrollOffset = 0;
		this.renderViewer();
	}

	/** 退出全屏浏览视图：恢复主 buffer + 补渲染静默期输出 + 恢复输入 */
	private closeViewer(): void {
		if (!this.viewerActive) return;
		this.viewerActive = false;
		// 恢复 stdinHandler：
		// - 若主循环已接管（readUserInput 设置了新 handler），保持不变
		// - 若仍持有视图 handler，按打开场景区分：
		//   * IDLE 打开（无流式）：恢复 readUserInput 的 handler（inputCycle 仍在 await 它）
		//   * 流式打开：输出还在跑 → 恢复双工 handler（流式继续）；
		//               已结束 → 置空让主循环 inputCycle 接管
		if (this.stdinHandler === this.viewerHandler) {
			if (!this.viewerOpenedDuringStream) {
				this.stdinHandler = this.viewerPrevHandler;
			} else if (this.abortController) {
				this.stdinHandler = this.viewerPrevHandler;
			} else {
				this.stdinHandler = null;
			}
		}
		this.viewerHandler = null;
		this.viewerPrevHandler = null;
		// 恢复主 buffer（alternate screen 保存的主 TUI 内容还原）
		process.stdout.write('\x1b[?1049l');
		// 补渲染视图期间的静默输出
		this.replayViewerOutput();
		// 重建输入区
		this.printSeparator();
		this.lastVisibleInputRows = 1;
		this.lastCursorDisplayRow = 0;
		this.drawInputArea();
		process.stdout.write('\r');
		this.renderInput();
		// 输出已结束：恢复 IDLE 状态并发送视图期间/前排队的消息
		if (!this.abortController) {
			this.setState(AppState.IDLE);
			const next = this.nextMessage;
			this.nextMessage = null;
			if (next) {
				this.printSeparator();
				process.stdout.write(green('[You] ') + next + '\r\n\r\n');
				// fire-and-forget：sendMessageStream 内部处理异常与后续状态
				void this.sendMessageStream(next);
			}
		}
		// 通知等待中的 inputCycle：视图已关闭
		this.viewerClosedResolve?.();
		this.viewerClosedResolve = null;
		this.viewerClosedPromise = null;
	}

	/** 等待视图关闭（inputCycle 在视图打开时调用，避免接管输入） */
	private async waitForViewerClose(): Promise<void> {
		if (this.viewerClosedPromise) {
			await this.viewerClosedPromise;
		}
	}

	/**
	 * 补渲染视图期间的静默输出：
	 *  - 完整轮次从 turns 补（resume 式）
	 *  - 打开时进行中的轮补 viewerOpenedTurnLines + streamLines（视图期间增量）
	 */
	private replayViewerOutput(): void {
		const session = this.sessionMgr.getSession();
		const turns = session?.turns ?? [];
		let from = this.viewerOpenTurnCount;
		if (this.viewerOpenedDuringStream) {
			if (this.viewerOpenedTurnDone) {
				// 打开时的轮已完成：跳过它（前半已在主 buffer），渲染它之后完成的新轮
				from = this.viewerOpenTurnCount + 1;
			} else {
				// 打开时的轮未完成：无新完成轮（turns 不含它），仅补增量
				from = turns.length;
			}
		}
		const newTurns = turns.slice(from);
		if (newTurns.length > 0) {
			const lines = this.conversation.render(newTurns, getTermSize().cols);
			this.writeOutputLines(lines);
		}
		// 打开时进行中轮的视图期间增量
		if (this.viewerOpenedTurnLines.length > 0) {
			this.writeOutputLines(this.viewerOpenedTurnLines);
			this.viewerOpenedTurnLines = [];
		}
		// 最新进行中轮的增量
		if (this.streamLines.length > 0) {
			this.writeOutputLines(this.streamLines);
			this.streamLines = [];
		}
	}

	/** 构建视图行（每轮：用户/think/工具/回复 + 轮次起始行记录） */
	private buildViewerLines(): void {
		this.viewerLines = [];
		this.viewerTurnStartLines = [];
		const session = this.sessionMgr.getSession();
		const turns = session?.turns ?? [];
		const { cols } = getTermSize();
		const wrapWidth = Math.max(10, cols - 8);

		turns.forEach((turn, i) => {
			this.viewerTurnStartLines.push(this.viewerLines.length);
			this.viewerLines.push(dim(`── 第 ${i + 1} 轮 ────────────────────────`));
			// 用户提问（绿色）
			const userText = turnUserContent(turn);
			for (const l of wrapText(userText, wrapWidth)) {
				this.viewerLines.push(green(`[You] ${l}`));
			}
			// think（灰色，完整显示）
			const thinkText = turnAssistantReasoning(turn);
			if (thinkText) {
				for (const l of thinkText.split('\n')) {
					this.viewerLines.push(dim(`[Think] ${l}`));
				}
			}
			// 工具调用（● run + 摘要）
			if (turn.tool_calls && turn.tool_calls.length > 0) {
				for (const tcr of turn.tool_calls) {
					const shortName = tcr.name.replace('execute_', '');
					const summary = formatToolCallSummary(tcr.name, tcr.arguments ?? {});
					this.viewerLines.push(cyan(`● run ${shortName} ${summary}`));
				}
			}
			// 回复
			const contentText = turnAssistantContent(turn);
			if (contentText) {
				for (const l of contentText.split('\n')) {
					for (const w of wrapText(l, cols - 2)) {
						this.viewerLines.push(w);
					}
				}
			}
			this.viewerLines.push('');
		});
		if (this.viewerLines.length === 0) {
			this.viewerLines.push(dim('(暂无对话)'));
		}
	}

	/** 渲染视图当前视口（顶部提示 + 内容窗口 + 底部状态） */
	private renderViewer(): void {
		const { rows, cols } = getTermSize();
		const visible = Math.max(1, rows - 2);
		process.stdout.write('\x1b[2J\x1b[H');
		process.stdout.write(dim(` 对话浏览  ←→ 轮次  |  ↑↓ 滚动  |  PgUp/PgDn 翻页  |  / 搜索  |  q 退出`) + '\r\n');
		for (let r = 0; r < visible; r++) {
			const idx = this.viewerScrollOffset + r;
			process.stdout.write('\r\x1b[2K');
			if (idx < this.viewerLines.length) {
				let line = this.viewerLines[idx];
				// 搜索匹配行高亮（反转色）
				if (this.viewerSearchQuery && this.viewerSearchMatches.includes(idx)) {
					line = `\x1b[7m${stripAnsi(line)}\x1b[0m`;
				}
				process.stdout.write(line.slice(0, cols - 1));
			}
			if (r < visible - 1) process.stdout.write('\r\n');
		}
		// 底部状态行
		process.stdout.write('\r\n\x1b[2K');
		const total = this.viewerLines.length;
		const pct = total > 0 ? Math.round(((this.viewerScrollOffset + visible) / total) * 100) : 0;
		let status = dim(` ${Math.min(this.viewerScrollOffset + 1, total)}/${total} 行 (${pct}%)`);
		if (this.viewerSearchQuery) {
			const matchInfo = this.viewerSearchMatches.length > 0
				? ` 匹配 ${this.viewerSearchIndex + 1}/${this.viewerSearchMatches.length}: "${this.viewerSearchQuery}" (n/N 下一个)`
				: `  无匹配: "${this.viewerSearchQuery}"`;
			status += dim(matchInfo);
		} else if (this.viewerSearchActive) {
			status += dim(`  搜索: ${this.viewerSearchInput}▌`);
		}
		process.stdout.write(status);
	}

	/** 视图输入处理（逐字符：方向键/翻页/搜索/退出） */
	private handleViewerInput(data: string): void {
		// 已在搜索输入模式：剩余字符全部交给搜索处理
		if (this.viewerSearchActive) {
			this.handleViewerSearchInput(data);
			return;
		}
		for (let i = 0; i < data.length; i++) {
			const ch = data[i];
			// ESC 序列（方向键/PgUp/PgDn）
			if (ch === '\x1b') {
				if (data[i + 1] === '[') {
					i += 2;
					let seq = '';
					while (i < data.length) {
						const sc = data.charCodeAt(i);
						if (sc >= 0x40 && sc <= 0x7e) { seq += data[i]; i++; break; }
						seq += data[i];
						i++;
					}
					i--;
					this.handleViewerEscapeSeq(seq);
				} else {
					this.closeViewer(); // 单独 ESC 退出
					return;
				}
				continue;
			}
			if (ch === 'q' || ch === 'Q') { this.closeViewer(); return; }
			if (ch === '/') {
				this.viewerSearchActive = true;
				this.viewerSearchInput = '';
				this.renderViewer();
				// 同批到达的剩余字符（如 '/reply\r'）交给搜索输入处理
				if (i + 1 < data.length) {
					this.handleViewerSearchInput(data.slice(i + 1));
				}
				return;
			}
			if (ch === 'n') this.viewerJumpSearch(1);
			if (ch === 'N') this.viewerJumpSearch(-1);
		}
	}

	/** 视图 ESC 序列处理 */
	private handleViewerEscapeSeq(seq: string): void {
		if (seq === 'A') this.viewerScroll(-1);
		else if (seq === 'B') this.viewerScroll(1);
		else if (seq === 'C') this.viewerJumpTurn(1);
		else if (seq === 'D') this.viewerJumpTurn(-1);
		else if (seq === '5~') this.viewerPageScroll(-1);
		else if (seq === '6~') this.viewerPageScroll(1);
	}

	/** 视图搜索输入模式（逐字符） */
	private handleViewerSearchInput(data: string): void {
		for (let i = 0; i < data.length; i++) {
			const ch = data[i];
			if (ch === '\x0d') {
				// Enter 执行搜索
				if (this.viewerSearchInput) this.viewerDoSearch(this.viewerSearchInput);
				this.viewerSearchActive = false;
				this.renderViewer();
				continue;
			}
			if (ch === '\x1b') {
				// Esc 取消搜索
				this.viewerSearchInput = '';
				this.viewerSearchActive = false;
				this.renderViewer();
				return;
			}
			if (ch === '\x7f' || ch === '\x08') {
				this.viewerSearchInput = this.viewerSearchInput.slice(0, -1);
				this.renderViewer();
				continue;
			}
			// 普通字符追加（忽略控制字符）
			if (ch >= ' ') {
				this.viewerSearchInput += ch;
				this.renderViewer();
			}
		}
	}

	/** 执行搜索：在视图行（纯文本）中查找匹配行 */
	private viewerDoSearch(query: string): void {
		this.viewerSearchQuery = query;
		this.viewerSearchMatches = [];
		this.viewerLines.forEach((line, i) => {
			if (stripAnsi(line).toLowerCase().includes(query.toLowerCase())) {
				this.viewerSearchMatches.push(i);
			}
		});
		this.viewerSearchIndex = -1;
		this.viewerJumpSearch(1);
	}

	/** 跳转到下一个/上一个搜索匹配（循环） */
	private viewerJumpSearch(dir: 1 | -1): void {
		if (this.viewerSearchMatches.length === 0) return;
		this.viewerSearchIndex = (this.viewerSearchIndex + dir + this.viewerSearchMatches.length) % this.viewerSearchMatches.length;
		const target = this.viewerSearchMatches[this.viewerSearchIndex];
		this.viewerScrollTo(target);
	}

	/** 滚动视口到指定行 */
	private viewerScrollTo(line: number): void {
		const { rows } = getTermSize();
		const visible = Math.max(1, rows - 2);
		this.viewerScrollOffset = Math.max(0, Math.min(line, this.viewerLines.length - 1));
		// 若目标行不在视口内，滚动到目标行
		if (line < this.viewerScrollOffset || line >= this.viewerScrollOffset + visible) {
			this.viewerScrollOffset = Math.max(0, line);
		}
		this.renderViewer();
	}

	/** 逐行滚动 */
	private viewerScroll(dir: 1 | -1): void {
		this.viewerScrollOffset = Math.max(0, Math.min(this.viewerScrollOffset + dir, this.viewerLines.length - 1));
		this.renderViewer();
	}

	/** 翻页 */
	private viewerPageScroll(dir: 1 | -1): void {
		const { rows } = getTermSize();
		const visible = Math.max(1, rows - 2);
		this.viewerScrollOffset = Math.max(0, Math.min(this.viewerScrollOffset + dir * (visible - 1), this.viewerLines.length - 1));
		this.renderViewer();
	}

	/** 左右键切换轮次（跳转到该轮顶部） */
	private viewerJumpTurn(dir: 1 | -1): void {
		if (this.viewerTurnStartLines.length === 0) return;
		// 找到当前所在轮索引
		let cur = this.viewerTurnStartLines.length - 1;
		for (let i = 0; i < this.viewerTurnStartLines.length; i++) {
			if (this.viewerScrollOffset < this.viewerTurnStartLines[i]) { cur = i - 1; break; }
		}
		const target = Math.max(0, Math.min(cur + dir, this.viewerTurnStartLines.length - 1));
		this.viewerScrollTo(this.viewerTurnStartLines[target]);
	}

	/**
	 * 渲染命令补全建议列表
	 * @returns 绘制的行数
	 */
	private renderSuggestions(suggestions: string[], selectedIdx: number, availWidth: number): number {
		if (suggestions.length === 0) return 0;

		const maxDisplay = Math.min(suggestions.length, 8); // 最多显示 8 条
		const lines: string[] = [];

		for (let i = 0; i < maxDisplay; i++) {
			const isSelected = i === selectedIdx;
			const prefix = isSelected ? '▸ ' : '  ';
			const text = prefix + suggestions[i];
			const padded = padToWidth(text, availWidth);
			lines.push(isSelected ? cyan(padded) : dim(padded));
		}
		if (suggestions.length > maxDisplay) {
			lines.push(dim(`  ... and ${suggestions.length - maxDisplay} more`));
		}

		// 从输入行的下一行开始绘制（避免 \r+clearLine 覆盖输入行）
		process.stdout.write('\r\n');

		// 绘制每一行
		for (let i = 0; i < lines.length; i++) {
			const isLast = i === lines.length - 1;
			process.stdout.write('\r');
			clearLine();
			process.stdout.write(lines[i]);
			if (!isLast) process.stdout.write('\r\n');
		}

		return lines.length;
	}

	// ─── 流式发送 ──────────────────────────────────

	/** 工具执行确认：在流式期间切换到 y/n 输入（F-5：进入 CONFIRMING 状态） */
	private requestToolConfirm(
		toolName: string,
		params: Record<string, unknown>,
	): Promise<boolean> {
		this.setState(AppState.CONFIRMING);
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
		// Bug 1+2：输出开始前收起输入区；清空输入框（发送后显示空的可编辑输入框，而非上一轮内容）
		this.collapseInputArea();
		this.input.clear();
		this.renderInputDuringStream();
		// 重置 think 折叠状态（新一轮完整思考缓冲）
		this.fullThink = [];
		this.thinkFolded = false;
		if (this.thinkAnimTimer) {
			clearInterval(this.thinkAnimTimer);
			this.thinkAnimTimer = null;
		}

		let reasoningStarted = false;
		let contentStarted = false;
		/** 追踪 reasoning 末尾是否有换行，用于 reasoning→content 过渡时决定是否加 \r\n */
		let reasoningEndsWithNewline = true;

		// 流式输出节流：累积 delta，30fps 批量写出（仅 reasoning 走 pending；content 走 mdRenderer 逐行）
		const renderThrottle = new Throttle(30);
		let pending = '';
		let pendingIsReasoning = false;
		/**
		 * 写出累积的 pending。
		 * reasoning 按完整行输出（每行后重绘输入区——think 期间输入框可见），
		 * 半行（无 \n 结尾）留在 pending 续写；force=true 时输出全部剩余（结束/过渡）。
		 * 半行超过 60 字符时强制输出（防止超长思考段落长时间不可见）。
		 */
		const flush = (force = false): void => {
			if (!pending) return;
			if (pendingIsReasoning) {
				const nlIdx = pending.lastIndexOf('\n');
				const isLongHalfLine = !force && nlIdx < 0 && pending.length > 60;
				const complete = (force || nlIdx >= 0 || isLongHalfLine) ? pending : '';
				if (complete) {
					pending = (force || nlIdx < 0) ? '' : pending.slice(nlIdx + 1);
					// 去掉 split 产生的尾部伪空行（pending 以 \n 结尾时必有），保留中间真实空行
					const lines = complete.split('\n');
					if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
					for (const line of lines) {
						// 累积完整 think 行（Ctrl+O 查看完整思考用）
						this.fullThink.push(line);
						// 实时显示前 MAX_VISIBLE_THINK 行，超出后折叠（节省显示空间）
						if (this.fullThink.length <= this.MAX_VISIBLE_THINK) {
							this.writeOutputLine(dim(line));
						}
					}
					// 超过可见行数：进入折叠状态（动态省略号动画）
					if (this.fullThink.length > this.MAX_VISIBLE_THINK) {
						this.enterThinkCollapse();
					}
				}
				// 非 force 且无完整行且不超长：半行留在 pending（输入区保持可见，不输出）
			} else {
				process.stdout.write(pending);
				pending = '';
			}
		};

		// 表格渲染器：检测 markdown 表格块并格式化为 box-drawing
		const mdRenderer = new MarkdownTableRenderer();

		// 双工交互：流式期间支持编辑输入框，Enter 中断当前输出并排队新消息（Bug 3）
		const prevHandler = this.stdinHandler;
		this.stdinHandler = (data: string) => {
			this.handleInputData(data, (content) => {
				if (content === null) return; // Ctrl+C 已在 handleInputData 内处理（STREAMING 态 abort）
				// 流式期间 Enter：/ 命令不可用（UI 状态冲突），普通文本排队发送
				if (content.startsWith('/')) {
					this.writeOutputLine(dim('(输出进行中，命令不可用，请等待完成后使用)'));
					return;
				}
				// 中断当前输出，新消息在 finally 中发送
				this.abortController?.abort();
				this.nextMessage = content;
			});
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
								flush(true); // reasoning → content 过渡，写出剩余 reasoning

								this.finalizeThinkCollapse(); // think 结束：定稿折叠行
								if (!reasoningEndsWithNewline) {
									this.writeOutputLine(''); // 空行过渡（Bug 1：保持输入区在底部）
								}
								contentStarted = true;
							}
							if (!contentStarted && !reasoningStarted) {
								this.writeOutputLine('');
								this.writeOutputLine('');
								contentStarted = true;
							}
							// 喂入表格渲染器，逐行写出（表格块内部行被暂存，结束时一次性渲染）
							// Bug 1：每行输出后重绘输入区，输入框在回复期间保持可见
							for (const line of mdRenderer.feed(event.text ?? '')) {
								this.writeOutputLine(line);
							}
							break;
						case 'tool_call_start': {
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							// 重置 reasoning/content 追踪，使下一轮 agent loop 独立处理
							reasoningStarted = false;
							contentStarted = false;
							reasoningEndsWithNewline = true;
							// 紧凑展示：● run <tool> <摘要>（shell 显示命令、文件工具显示路径）
							const toolName = event.toolName ?? '?';
							const shortName = toolName.replace('execute_', '');
							const summary = formatToolCallSummary(toolName, event.toolArgs ?? {});
							this.writeOutputLine(
								cyan(`● run ${shortName}`) + (summary ? dim(` ${summary}`) : ''),
							);
							break;
						}
						case 'tool_call_delta':
							// tool call 参数增量（不渲染，静默累积）
							break;
						case 'tool_preview': {
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							// diff 预览 — 原生格式，仅着色，不加额外前缀
							const preview = event.toolPreview ?? '';
							if (preview) {
								this.writeOutputLines(preview.split('\n').map((l) => renderDiffLine(l, '')));
							}
							break;
						}
						case 'tool_output': {
							// 实时 shell 输出：逐行渲染
							const line = event.outputLine ?? '';
							const stream = event.outputStream ?? 'stdout';
							this.writeOutputLine(
								stream === 'stderr'
									? yellow(' │ ') + dim(line)
									: cyan(' │ ') + dim(line),
							);
							break;
						}
						case 'tool_result':
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							if (event.toolDenied) {
								this.writeOutputLine(red('[Denied]'));
							} else {
								const outLines: string[] = [];
								// 显示错误信息（如果有）
								if (event.error) {
									outLines.push(red(' ✖ ') + event.error.split('\n')[0]);
								}
								// 显示工具执行结果内容
								const lines = (event.toolResult ?? '').split('\n').slice(0, 12);
								for (const line of lines) {
									outLines.push(cyan(' │ ') + dim(line));
								}
								if ((event.toolResult ?? '').split('\n').length > 12) {
									outLines.push(cyan(' │ ') + dim('...'));
								}
								this.writeOutputLines(outLines);
							}
							break;
						case 'review_verdict': {
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							const v = event.verdict ?? 'completed';
							const r = event.reviewReason ?? '';
							if (event.autoContinue) {
								this.writeOutputLine(dim(`[审查: ${v}] ${r}`));
								this.writeOutputLine(dim('[审查: 自动续期继续执行...]'));
								// 重置 reasoning/content 追踪，使续期后的输出独立渲染
								reasoningStarted = false;
								contentStarted = false;
								reasoningEndsWithNewline = true;
							} else if (v === 'asking_user') {
								this.writeOutputLine(dim('[审查: 模型在询问用户，等待输入]'));
							}
							break;
						}
						case 'subagent_spawned': {
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							// tool_call_start 已输出 [T: subagent_spawn] 行，此处直接输出状态行
							const name = event.subagentName ?? '?';
							const task = (event.subagentTask ?? '').slice(0, 60);
							this.writeOutputLine(
								cyan(`[Sub: ${name}] `) + dim(`⏳ ${task}${(event.subagentTask ?? '').length > 60 ? '...' : ''}`),
							);
							break;
						}
						case 'subagent_finished': {
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							// 重置 reasoning 追踪（内容已 flush），
							// 保持 contentStarted 不让流式重起产生多余空行
							reasoningStarted = false;
							if (!contentStarted) contentStarted = true;
							reasoningEndsWithNewline = true;
							const name = event.subagentName ?? '?';
							const ok = event.subagentStatus === 'completed';
							const icon = ok ? green('✓') : red('✗');
							const elapsed = event.subagentElapsedMs ?? 0;
							const elapsedStr = elapsed < 1000
								? `${elapsed}ms`
								: elapsed < 60000
									? `${(elapsed / 1000).toFixed(1)}s`
									: `${Math.floor(elapsed / 60000)}m ${Math.round((elapsed % 60000) / 1000)}s`;
							this.writeOutputLine(
								cyan(`[Sub: ${name}] `) + icon + dim(` ${elapsedStr}`),
							);
							break;
						}
						case 'subagent_update':
							// 增量更新（detail view 通过 store 自行拉取，此处不渲染）
							break;
						case 'done':
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							// 视图打开时的轮已完成：归档该轮视图期间增量（退出时补渲染），
							// 之后完成的新轮增量清空（退出时从 turns 补渲染完整轮）
							if (this.viewerActive && this.viewerOpenedDuringStream && !this.viewerOpenedTurnDone) {
								this.viewerOpenedTurnDone = true;
								this.viewerOpenedTurnLines = this.streamLines;
							}
							this.streamLines = [];
							// 刷出表格渲染器中暂存的剩余内容（Bug 1：走统一输出收口）
							this.writeOutputLines(mdRenderer.flush());
							this.printUsage(event);
							break;
						case 'error':
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							this.writeOutputLine(red(`Error: ${event.error ?? 'unknown'}`));
							break;
					}
				},
				this.abortController.signal,
				this.tools.length > 0 && !this.yolo
					? (toolName, params) => this.requestToolConfirm(toolName, params)
					: undefined,
				this.yolo ? this.reviewModel : undefined,
			);
		} catch (err: any) {
			// F-5：catch 时进入 ERROR 状态（finally 恢复 IDLE）
			this.setState(AppState.ERROR);
			if (err?.name === 'AbortError') {
				this.writeOutputLine(dim('[interrupted]'));
			} else {
				this.writeOutputLine(red(`Error: ${err?.message ?? err}`));
			}
		} finally {
			this.abortController = null;
			if (!this.viewerActive) {
				// 正常路径（无视图打开）：恢复输入、UI 状态、nextMessage 链
				this.stdinHandler = prevHandler;
				// Bug 1：收起输出期间绘制的输入区，使后续 printSeparator/drawInputArea 从输出末尾正常开始
				this.collapseInputArea();
				this.lastVisibleInputRows = 1;
				this.lastCursorDisplayRow = 0;
				this.setState(AppState.IDLE);
				// 双工交互（Bug 3）：输出期间用户 Enter 排入的新消息 → 中断后继续发送
				const next = this.nextMessage;
				this.nextMessage = null;
				if (next) {
					this.printSeparator();
					process.stdout.write(green('[You] ') + next + '\r\n\r\n');
					await this.sendMessageStream(next);
				}
			}
			// viewerActive：跳过 UI/输入恢复（避免覆盖视图 handler、污染 alternate screen），
			// 状态与 nextMessage 由 closeViewer 统一处理
		}
	}

	private printUsage(event: StreamEvent): void {
		if (!event.usage) return;
		const u = event.usage;
		const parts: string[] = [];
		if (u.prompt_tokens > 0) parts.push(`${u.prompt_tokens} in`);
		if (u.completion_tokens > 0) parts.push(`${u.completion_tokens} out`);
		if (parts.length > 0) {
			this.writeOutputLine(dim(`--- token: ${parts.join(' + ')} ---`));
		}
	}

	private setState(newState: AppState): void {
		this.state = newState;
	}
}
