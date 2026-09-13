/**
 * TuiApp — 内联终端 TUI 主应用
 *
 * 不使用 alternate screen。所有对话内容直接输出到终端 scrollback，
 * 输入区域使用光标控制在底部原地刷新（动态高度：1~5 行）。
 * 全程保持 raw mode，Ctrl+C 统一处理。
 */

import type { Session } from '../types/index.js';
import { ScreenBuffer } from './screen-buffer.js';
import { SessionManager } from '../core/session.js';
import type { StreamEvent } from '../types/index.js';
import type { Tool } from '../tools/types.js';
import { ConfigManager } from '../core/config.js';
import { ConversationView, truncateThink } from '../render/conversation.js';
import { DISPLAY_PRESETS, isFileModTool } from '../render/display-mode.js';
import type { DisplayMode, DisplayPreset } from '../render/display-mode.js';
import { SubagentRecordView } from '../render/subagent-record-view.js';
import type { SubagentRecord } from '../types/index.js';
import { turnUserContent, turnAssistantContent, turnAssistantReasoning } from '../utils/turn-utils.js';
import { InputEditor } from '../render/input-editor.js';
import { Throttle } from '../utils/throttle.js';
import { spawn } from 'node:child_process';
import {
	getTermSize,
	enableBracketedPaste,
	disableBracketedPaste,
	showCursor,
	clearLine,
	onResize,
	offResize,
	terminalIO,
} from './terminal.js';
import {
	PINK_BG_START,
	PINK_BG_END,
	cyan,
	dim,
	green,
	yellow,
	red,
	renderDiffLine,
	formatToolCallSummary,
	stripAnsi,
} from '../render/ansi.js';
import { AppState } from '../render/types.js';
import type { ScreenCapture, TurnCaptureInfo, ToolCallCaptureInfo, InputAreaCapture } from '../render/types.js';
import type { TuiConfig } from './types.js';
import { BottomArea } from './bottom-area.js';
import { OverlayPane } from './overlay-pane.js';
import type { OverlayReplayInfo } from './overlay-pane.js';
import { Selector } from '../render/selector.js';
import type { SelectOption } from '../render/selector.js';
import { MarkdownTableRenderer } from '../render/markdown.js';
import { isInteractiveCommand } from '../tools/utils.js';
import { ConversationViewer } from './views/conversation-viewer.js';
import { SubagentsViewer } from './views/subagents-viewer.js';
import type { ViewInputResult } from './views/types.js';

/** 可选模型列表（运行时从配置动态生成，见 TuiApp 构造函数；此为兜底） */
const FALLBACK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

/** 可用命令列表 */
const AVAILABLE_COMMANDS = ['/model', '/provider', '/system', '/help', '/context', '/yolo', '/async', '/subagent', '/subagent_cancel', '/memory', '/compact', '/exit'];

/** 从光标处清除到屏幕底 */
const CLEAR_TO_END = '\x1b[0J';

export class TuiApp {
	/** 屏幕输出缓冲（所有终端输出唯一通道） */
	private out: ScreenBuffer;
	private sessionMgr: SessionManager;
	private config: TuiConfig;
	private configMgr: ConfigManager | null;
	private tools: Tool[];
	private yolo: boolean;
	/** 可选模型列表（从配置 pricing/providers 动态生成） */
	private availableModels: string[] = FALLBACK_MODELS;
	/** 子代理异步模式 */
	private asyncMode = false;
	private conversation: ConversationView;
	private input: InputEditor;
	private state: AppState = AppState.IDLE;
	private abortController: AbortController | null = null;
	private running = false;
	/** 退出时是否丢弃了 0 轮空会话（未产生任何对话轮次 → 不落盘） */
	private emptySessionDiscarded = false;
	/** shell 命令模式 */
	private shellMode = false;
	/** 自我交互模式（可启动子 TUI 实例） */
	private selfInteraction = false;
	/** mock 模式（使用 MockProvider） */
	private mockMode = false;
	/** 待发送的 shell 上下文（[shell_start]...[shell_end] 块） */
	private pendingShellContext: string[] = [];
	/** 上次渲染后的光标所在输入行号（0-based，用于下次回到起点）——已收敛至 BottomArea */
	private bottom: BottomArea;
	/** 双工交互：流式输出期间用户 Enter 排入的待发送消息（中断当前输出后发送） */
	private nextMessage: string | null = null;
	/** 命令结果区：最近一次 / 命令的输出（固定显示在输入区下方，完整保留，发送消息后清空）——已收敛至 BottomArea */
	/** 命令执行期间输出捕获标志（true 时 cmdOut 写入命令结果区而非 scrollback） */
	private commandResultActive = false;
	/** 当前轮完整 think 内容（Ctrl+O 查看完整思考用） */
	private fullThink: string[] = [];
	/** think 是否已折叠（超出可见行数） */
	private thinkFolded = false;
	/** think 折叠省略号动画定时器 */
	private thinkAnimTimer: ReturnType<typeof setInterval> | null = null;
	/** 省略号动画步进 */
	private thinkAnimStep = 0;
	/** 展示模式预设（short/normal/detail，见 render/display-mode.ts） */
	private readonly preset: DisplayPreset;
	/** 当前展示模式名 */
	private readonly displayMode: DisplayMode;
	/** think 最多实时显示行数（超出折叠，随展示模式变化；Ctrl+O 查看完整） */
	private readonly thinkVisibleLines: number;
	/**
	 * scrollback 内容最后一行是否为分隔线（printSeparator 去重用）。
	 * 视图关闭重建底部 / 命令结束收尾时，若上一行已是分隔线且期间无新内容输出，
	 * 不再重复打印，避免「多一道横线」。
	 */
	private outputEndsWithSeparator = false;
	/** 全屏覆盖层（Ctrl+O 对话浏览 / Ctrl+T Subagents 总览）——公共生命周期收敛至 OverlayPane */
	private overlay: OverlayPane;
	/** Ctrl+O 对话浏览视图（方案 A 抽取：原 10 字段 + 12 方法收敛为组件） */
	private conversationViewer: ConversationViewer;
	/** Ctrl+T Subagents 总览视图（方案 A 抽取：原 10 字段 + 9 方法收敛为组件） */
	private subagentsViewer: SubagentsViewer;

	constructor(
		sessionMgr: SessionManager,
		config: TuiConfig,
		tools?: Tool[],
		configMgr?: ConfigManager,
		yolo?: boolean,
		mock?: boolean,
		displayMode: DisplayMode = 'detail',
		displayPreset?: DisplayPreset,
	) {
		this.out = new ScreenBuffer();
		this.sessionMgr = sessionMgr;
		this.config = config;
		this.configMgr = configMgr ?? null;
		this.tools = tools ?? [];
		this.yolo = yolo ?? false;
		this.mockMode = mock ?? false;
		this.displayMode = displayMode;
		this.preset = displayPreset ?? DISPLAY_PRESETS[displayMode];
		this.thinkVisibleLines = this.preset.thinkLiveLines;
		this.asyncMode = sessionMgr.getSubagentAsync();
		this.conversation = new ConversationView();
		this.input = new InputEditor();
		this.bottom = new BottomArea({
			out: this.out,
			input: this.input,
			getCols: () => getTermSize().cols,
		});
		this.conversationViewer = new ConversationViewer({
			out: this.out,
			getTurns: () => this.sessionMgr.getSession()?.turns ?? [],
			conversation: this.conversation,
			getSize: () => getTermSize(),
		});
		this.subagentsViewer = new SubagentsViewer({
			out: this.out,
			listSubagents: () => this.sessionMgr.listSubagents(),
			// source='user'：用户直发 → 完成后向 master 投递通知（需求 2）
			sendToSubagent: (name, text) => this.sessionMgr.sendToSubagent(name, text, 'user').then(() => undefined),
			isStreamActive: () => this.abortController !== null,
			getSize: () => getTermSize(),
		});
		// 记忆：后台归纳写入后给一行提示（不打断流式、不弹层）
		// 可选调用：测试里的 sessionMgr 替身可能没有该方法
		this.sessionMgr.setMemoryNoticeCallback?.((count: number) => {
			this.writeOutputLine(dim(`[memory] 已更新 ${count} 条（/memory show 查看）`));
		});

		this.overlay = new OverlayPane(this.out, {
			getHandler: () => this.stdinHandler,
			setHandler: (h) => { this.stdinHandler = h; },
			isStreamActive: () => this.abortController !== null,
			pauseThink: () => {
				// 暂停 think 折叠动画（其直接写 stdout，会污染主 buffer）
				if (this.thinkAnimTimer) {
					clearInterval(this.thinkAnimTimer);
					this.thinkAnimTimer = null;
				}
			},
			render: () => this.renderActiveOverlay(),
			cleanup: () => this.subagentsViewer.cleanup(),
			replay: (info) => this.replayOverlayOutput(info),
			rebuildBottom: () => {
				// 重建输入区
				this.printSeparator();
				this.bottom.resetPosition();
				this.bottom.drawBase();
				this.out.write('\r');
				this.bottom.renderIdle();
			},
			setIdleIfStreamEnded: () => {
				// 输出已结束：恢复 IDLE 状态（nextMessage 保留，交给主循环 inputCycle 统一发送，避免双流并发）
				if (!this.abortController) {
					this.setState(AppState.IDLE);
				}
			},
		});

		// 模型候选列表：从配置 pricing.<provider> 键动态生成（含当前模型兜底）
		if (this.configMgr) {
			const pricing = this.configMgr.get<Record<string, Record<string, unknown>>>(`pricing.${config.provider}`);
			const configured = pricing ? Object.keys(pricing) : [];
			const merged = [...new Set([...configured, config.model, ...FALLBACK_MODELS])];
			this.availableModels = merged.length > 0 ? merged : FALLBACK_MODELS;
		}
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

		// 0 轮空会话不落盘：未产生任何对话轮次（进入即退出）时删除磁盘目录
		const activeMeta = this.sessionMgr.getSession()?.meta;
		if (activeMeta && activeMeta.turnCount === 0) {
			this.emptySessionDiscarded = await this.sessionMgr.discardEmptySession();
		}

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
		if (this.mockMode) modeTags.push('MOCK');
		const modeStr = modeTags.length > 0 ? `  |  [${modeTags.join(', ')}]` : '';

		this.out.write(
			`deepseek-arch v${this.config.version}  |  Provider: ${this.config.provider}  |  Model: ${this.config.model}${modeStr}\r\n`,
		);

		let infoStr = `Session: ${sessionId.slice(0, 8)}...  |  Turns: ${turnCount}`;
		if (lastUsage && lastUsage.total_tokens > 0) {
			infoStr += `  |  Last tokens: ${lastUsage.prompt_tokens} in + ${lastUsage.completion_tokens} out`;
		}
		this.out.write(dim(infoStr) + '\r\n');
	}

	private printSeparator(): void {
		// 上一行已是分隔线（期间无新内容输出）→ 不重复打印（视图关闭/命令收尾易触发）
		if (this.outputEndsWithSeparator) return;
		const cols = getTermSize().cols;
		// cols-1 避免 auto-wrap，\r\n 确保 raw mode 下正确换行
		this.out.write('─'.repeat(cols - 1) + '\r\n');
		this.outputEndsWithSeparator = true;
	}

	private printConversation(turns: import('../types/index.js').TurnRecord[]): void {
		const cols = getTermSize().cols;
		const lines = this.conversation.render(turns, cols, {
			mode: this.displayMode,
			hideNonFileToolResult: this.preset.hideNonFileToolResult,
		});
		for (const line of lines) {
			this.out.write(line + '\r\n');
		}
		// 内容是普通文本（非分隔线），后续 printSeparator 可正常打印
		if (lines.length > 0) this.outputEndsWithSeparator = false;
	}

	private printExitInfo(): void {
		if (this.emptySessionDiscarded) {
			this.out.write(dim('(空会话未保存：未产生任何对话轮次)\r\n'));
			return;
		}
		const sessionId = this.sessionMgr.getSessionId();
		if (sessionId) {
			this.out.write(`Session saved: ${sessionId}\r\n`);
			this.out.write(`To resume: deepseek-arch chat --resume ${sessionId}\r\n`);
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
		// 上移基准：光标在输入区行（相对区域顶部）；命令结果区在输入区下方
		const upRows = this.bottom.getCursorRow();
		if (upRows > 0) {
			this.out.write(`\x1b[${upRows}A`);
		}
		this.out.write('\r');
		this.out.write(CLEAR_TO_END);
		this.bottom.drawBase();
		this.out.write('\r');
		this.bottom.resetPosition();
		this.bottom.renderIdle();
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
		if (this.overlay.active) {
			await this.overlay.waitForClose();
			return;
		}
		// 视图关闭后残留的排队消息（视图期间/前排队的普通文本）：
		// 由主循环统一发送（closeViewer 不再 fire-and-forget 启动流，避免双流并发）
		if (this.nextMessage) {
			const next = this.nextMessage;
			this.nextMessage = null;
			this.bottom.clearCommandResult(false); // 输入区已重建，不重绘避免错位
			this.bottom.collapse();                // 收起重建的输入区（closeViewer 已重置位置）
			this.out.write(green('[You] ') + next + '\r\n\r\n');
			this.outputEndsWithSeparator = false; // 用户消息行：后续输出非分隔线
			await this.sendMessageStream(next);
			// 视图可能在发送期间打开：跳过 UI 收尾（主循环等待视图关闭后重新进入）
			if (this.overlay.active) return;
			this.printSeparator();
			return;
		}
		this.bottom.resetPosition();

		this.input.clear();
		// 重建底部区域：输入区 + 命令结果区（若仍有内容，如未发送消息的清空场景），
		// 避免输出结束后命令结果区消失（drawBase 只画输入区）
		this.bottom.renderIdle();
		let content = await this.readUserInput();

		// 清除输入区域：回到起点（无历史记录时即当前行），清到屏底
		const upRows = this.bottom.getCursorRow();
		if (upRows > 0) {
			this.out.write(`\x1b[${upRows}A`);
		}
		this.out.write('\r');
		this.out.write(CLEAR_TO_END);
		this.bottom.markBottomCleared();

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
				this.bottom.clearCommandResult(false); // 发送普通消息：清空命令结果区（输入区已清除，不重绘）
				this.out.write(green('[You] ') + sendContent + '\r\n\r\n');
				this.outputEndsWithSeparator = false;
				await this.sendMessageStream(sendContent);
			}
			// 视图可能在命令处理/输出期间打开：跳过 UI 收尾（视图接管）
			if (this.overlay.active) return;
			// 命令执行完毕：清空输入区（命令文本已在 dispatchCommand 提交，避免残留显示/误操作）
			this.input.clear();
			// 命令结果区已渲染在底部：收起 → 写分隔线 → 重画底部（避免覆盖）
			this.printSeparatorKeepBottom();
			return;
		}

		// 打印用户消息（绿色）
		this.bottom.clearCommandResult(false); // 发送普通消息：清空命令结果区（输入区已清除，不重绘）
		this.out.write(green('[You] ') + content + '\r\n\r\n');
		this.outputEndsWithSeparator = false;

		// 拼接待发送的 shell 上下文（仅模型可见）
		if (this.pendingShellContext.length > 0) {
			content = this.pendingShellContext.join('\n') + '\n' + content;
			this.pendingShellContext = [];
		}

		// 发送并流式输出
		await this.sendMessageStream(content);

		// 视图可能在输出期间打开：跳过 UI 收尾（主循环等待视图关闭后重新进入）
		if (this.overlay.active) return;
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

		// 命令输出捕获：命令内的 cmdOut 写入命令结果区（固定底部、替换式刷新）
		this.bottom.clearCommandResult(false);
		this.commandResultActive = true;
		try {
			return await this.dispatchCommand(content);
		} finally {
			this.commandResultActive = false;
			// 渲染由调用方统一处理：
			//  - inputCycle 命令路径 → printSeparatorKeepBottom（收起→分隔线→重画）
			//  - handleCommandDuringStream（流式）→ renderCommandResultBar
		}
	}

	/**
	 * 流式期间执行 / 命令（全双工）：不中断当前输出，命令结果进命令结果区。
	 * /compact 流式期间不可用（上下文状态冲突）；/exit 中断输出并退出。
	 */
	private async handleCommandDuringStream(content: string): Promise<void> {
		if (content === '/compact') {
			this.writeOutputLine(dim('(输出进行中，/compact 不可用，请等待完成后使用)'));
			return;
		}
		if (content === '/exit') {
			this.abortController?.abort();
			this.nextMessage = null;
			this.running = false;
			return;
		}
		const handled = await this.handleCommand(content);
		if (!handled) {
			// // 转义 → 排队发送（输出结束后自动发送）
			this.nextMessage = content.startsWith('//') ? content.slice(1) : content;
		}
		// 流式期间：命令结果区立即渲染（光标在输入区，上移重绘）
		this.bottom.renderCommandBar();
	}

	/** 命令分派（handleCommand 内部：输出经 cmdOut 捕获到命令结果区） */
	private async dispatchCommand(content: string): Promise<boolean> {

		if (content.startsWith('/model')) {
			const arg = content.slice(6).trim();
			if (arg && this.availableModels.includes(arg)) {
				return await this.switchModel(arg);
			}

			// 交互式选择
			const options: SelectOption<string>[] = this.availableModels.map((m) => ({
				label: m,
				value: m,
			}));
			const selector = new Selector(options, terminalIO, 'Select a model (↑↓ navigate, Enter confirm):');
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

		if (content.startsWith('/provider')) {
			return await this.switchProvider(content.slice(9).trim());
		}

		if (content.startsWith('/system')) {
			return await this.switchSystemPrompt(content.slice(7).trim());
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

		if (content.startsWith('/memory')) {
			return await this.handleMemoryCommand(content.slice('/memory'.length).trim());
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
			this.cmdOut(green('Goodbye!'));
			this.running = false;
			return true;
		}

		// 未知命令 — 不再发送给模型，显示错误提示
		const errMsg = `Unknown command: ${content.split(/\s+/)[0]}`;
		this.cmdOut(red(errMsg));
		this.cmdOut(dim(`  Available: ${AVAILABLE_COMMANDS.join(', ')}`));
		return true;
	}

	/** 切换模型 */
	private async switchModel(modelName: string): Promise<boolean> {
		this.config.model = modelName;
		this.sessionMgr.setModel(modelName);

		if (this.configMgr) {
			await this.configMgr.set('defaults.model', modelName);
		}

		this.cmdOut(green(`[Model switched: ${modelName}]`));
		this.printHeader();
		return true;
	}

	/**
	 * /provider [name] — 切换默认供应商（写回 defaults.provider）
	 * 无参数时列出可选供应商并交互选择；不存在的供应商会报错。
	 */
	private async switchProvider(name: string): Promise<boolean> {
		if (!this.configMgr) {
			this.cmdOut(red('[Provider switch unavailable: no config manager]'));
			return true;
		}

		const providers = this.configMgr.get<Record<string, { base_url?: string }>>('providers') ?? {};
		const names = Object.keys(providers);

		if (!name) {
			// 交互式选择
			if (names.length === 0) {
				this.cmdOut(red('No providers configured.'));
				return true;
			}
			const options: SelectOption<string>[] = names.map((n) => ({ label: n, value: n }));
			const selector = new Selector(options, terminalIO, 'Select a provider (↑↓ navigate, Enter confirm):');
			const selected = await selector.select(
				() => this.stdinHandler,
				(h) => { this.stdinHandler = h; },
			);
			if (!selected) return true;
			name = selected;
		}

		if (!providers[name]) {
			this.cmdOut(red(`Provider "${name}" not found. Available: ${names.join(', ') || '(none)'}`));
			return true;
		}

		this.config.provider = name;
		await this.configMgr.set('defaults.provider', name);
		this.cmdOut(green(`[Provider switched: ${name}]`));
		this.printHeader();
		return true;
	}

	/**
	 * /system [name] — 切换 system prompt 模板（写回 defaults.system_prompt）
	 * 无参数时列出模板；/system list 等价。
	 */
	private async switchSystemPrompt(name: string): Promise<boolean> {
		if (!this.configMgr) {
			this.cmdOut(red('[System prompt switch unavailable: no config manager]'));
			return true;
		}

		const prompts = this.configMgr.get<Record<string, unknown>>('systemPrompts') ?? {};
		const names = Object.keys(prompts);

		if (!name || name === 'list') {
			if (names.length === 0) {
				this.cmdOut(dim('No system prompt templates configured.'));
				return true;
			}
			this.cmdOut(yellow('System prompt templates:'));
			for (const n of names) {
				const marker = n === this.config.systemPrompt ? ' *' : '';
				this.cmdOut(`  ${green(n)}${dim(marker)}`);
			}
			return true;
		}

		if (!prompts[name]) {
			this.cmdOut(red(`System prompt "${name}" not found. Available: ${names.join(', ') || '(none)'}`));
			return true;
		}

		this.config.systemPrompt = name;
		await this.configMgr.set('defaults.system_prompt', name);
		this.cmdOut(green(`[System prompt switched: ${name}]`));
		this.printHeader();
		return true;
	}


	/** /help — 显示可用命令列表 */
	private showHelp(): true {
		const cols = getTermSize().cols;
		const w = Math.max(1, cols - 1);
		this.cmdOut(yellow('Commands'));
		this.cmdOut('─'.repeat(w));

		const cmds: [string, string][] = [
			['/model [name]', 'Switch model (interactive picker if no arg)'],
			['/provider [name]', 'Switch provider (interactive picker if no arg)'],
			['/system [name]', 'List/switch system prompt template'],
			['/async',         'Toggle subagent async mode (ON=non-blocking spawn, OFF=blocking)'],
			['/memory',        'Long-term memory: /memory [show|candidates|forget <slug>|on|off|refresh]'],
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
			this.cmdOut(line);
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
		this.cmdOut(yellow('Session Context'));
		this.cmdOut('─'.repeat(w));

		// 基本信息
		this.cmdOut(`  Provider:  ${this.config.provider}`);
		this.cmdOut(`  Model:     ${this.config.model}`);
		this.cmdOut(`  System:    ${this.config.systemPrompt ?? 'default'}`);
		this.cmdOut(`  YOLO mode: ${this.yolo ? green('ON') : dim('OFF')}`);
		this.cmdOut(`  Subagent:  ${this.asyncMode ? green('async') : dim('sync')}`);
		this.cmdOut(`  Session:   ${meta?.id ?? '—'}${meta?.title ? ' "' + dim(meta.title) + '"' : ''}`);
		this.cmdOut(`  Turns:     ${meta?.turnCount ?? turns.length}`);

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
		this.cmdOut('  ── Token Usage ──');
		this.cmdOut(`  Total:       ${grandTotal.toLocaleString()} tokens (${totalPrompt.toLocaleString()} in + ${totalCompletion.toLocaleString()} out)`);
		if (totalCacheHit + totalCacheMiss > 0) {
			const hitRate = totalCacheHit + totalCacheMiss > 0
				? ((totalCacheHit / (totalCacheHit + totalCacheMiss)) * 100).toFixed(1)
				: '0.0';
			this.cmdOut(`  KV Cache:    ${totalCacheHit.toLocaleString()} hit / ${totalCacheMiss.toLocaleString()} miss (${hitRate}%)`);
		}

		// 最后一轮详情
		const lastUsage = meta?.lastUsage;
		if (lastUsage && lastUsage.total_tokens > 0) {
			this.cmdOut(`  Last turn:   ${lastUsage.total_tokens} tokens (${lastUsage.prompt_tokens} in + ${lastUsage.completion_tokens} out)`);
		}

		// 累计费用
		if (meta && meta.totalCost > 0) {
			this.cmdOut(`  Total cost:  ¥${meta.totalCost.toFixed(4)}`);
		}

		return true;
	}

	/** /compact — 压缩会话上下文（摘要 + 文件重注入，开启新分代） */
	private async compactSession(): Promise<boolean> {
		this.cmdOut(dim('Compacting session context...'));
		try {
			const result = await this.sessionMgr.compactContext();
			this.cmdOut(green(`[Compacted] → 新分代 #${result.gen}，压缩 ${result.compressedTurns} 轮，重注入 ${result.restoredFiles} 个文件 (${result.restoredTokens} tokens)`));
			if (result.summaryPreview) {
				this.cmdOut(dim(`  summary: ${result.summaryPreview}`));
			}
			// 刷新对话显示（含摘要轮折叠块）
			const session = this.sessionMgr.getSession();
			if (session) {
				this.printConversation(session.turns);
				this.printSeparator();
			}
		} catch (err) {
			this.out.write(
				red(`[Compact failed] ${err instanceof Error ? err.message : String(err)}`) + '\r\n',
			);
		}
		return true;
	}

	/** /yolo — 切换 YOLO 模式（写回 defaults.yolo） */
	private async toggleYolo(): Promise<boolean> {
		this.yolo = !this.yolo;
		if (this.configMgr) {
			try {
				await this.configMgr.set('defaults.yolo', this.yolo);
			} catch { /* 写回失败不阻塞切换 */ }
		}
		this.cmdOut(green(`[YOLO mode: ${this.yolo ? 'ON' : 'OFF'}]`) + dim(this.yolo ? '  (auto-approve tool executions)' : '  (confirm before tool execution)'));
		return true;
	}

	/** /async — 切换子代理异步模式（写回 defaults.async） */
	private async toggleAsync(): Promise<boolean> {
		this.asyncMode = !this.asyncMode;
		this.sessionMgr.setSubagentAsync(this.asyncMode);
		if (this.configMgr) {
			try {
				await this.configMgr.set('defaults.async', this.asyncMode);
			} catch { /* 写回失败不阻塞切换 */ }
		}
		this.cmdOut(green(`[Subagent async: ${this.asyncMode ? 'ON' : 'OFF'}]`) + dim(this.asyncMode
			? '  (subagent_spawn returns [SPAWNED], use wait/list_subagents)'
			: '  (subagent_spawn blocks until complete)'));
		return true;
	}

	/**
	 * /memory —— 记忆机制命令族。
	 *   /memory                      状态摘要
	 *   /memory show [kw]            列出正式条目（可选关键词过滤）
	 *   /memory candidates           列出模糊条目（confidence 1，仅 memory agent 管理）
	 *   /memory forget <slug>        遗忘某条（写墓碑 + 退出索引）
	 *   /memory on | off             开关（写回 config.toml 的 memory.enabled）
	 *   /memory refresh              重建 system prompt 里的清单并重写会话快照
	 */
	private async handleMemoryCommand(arg: string): Promise<boolean> {
		const mem = this.sessionMgr.getMemory?.() ?? null;
		if (!mem) {
			this.cmdOut(dim('[memory] 未启用（config.toml 的 [memory] enabled=false，或 --no-memory）'));
			return true;
		}
		const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);
		const store = mem.store;

		switch (sub) {
			case undefined:
			case 'status': {
				const entries = await store.listEntries('project');
				const global = await store.listEntries('global');
				const candidates = await store.listCandidates('project');
				this.cmdOut(green('[memory] enabled') + dim(`  project=${entries.length} 条  global=${global.length} 条  candidates(模糊)=${candidates.length} 条`));
				this.cmdOut(dim(`  注入预算 ${mem.config.maxInjectTokens} tokens · 召回/归纳模型 ${mem.config.recallModel}/${mem.config.agentModel}`));
				this.cmdOut(dim(`  项目层目录 ${store.dirOf('project')}`));
				this.cmdOut(dim('  子命令：show [kw] | candidates | forget <slug> | on | off | refresh'));
				return true;
			}
			case 'show': {
				const kw = rest.join(' ').trim().toLowerCase();
				const entries = [...(await store.listEntries('project')), ...(await store.listEntries('global'))];
				const filtered = kw
					? entries.filter((e) => `${e.slug} ${e.subject} ${e.name} ${e.description} ${e.body}`.toLowerCase().includes(kw))
					: entries;
				if (filtered.length === 0) {
					this.cmdOut(dim('(无匹配条目)'));
					return true;
				}
				for (const e of filtered.slice(0, 20)) {
					this.cmdOut(dim(`  ${e.slug}  conf=${e.confidence}  ${e.scope}  ${e.updated.slice(0, 10)}  ${e.description}`));
				}
				if (filtered.length > 20) this.cmdOut(dim(`  …(${filtered.length - 20} more)`));
				return true;
			}
			case 'candidates': {
				const candidates = await store.listCandidates('project');
				if (candidates.length === 0) {
					this.cmdOut(dim('(无模糊条目)'));
					return true;
				}
				this.cmdOut(dim('模糊条目（confidence<2，不注入、由 memory agent 管理）：'));
				for (const e of candidates.slice(0, 20)) {
					this.cmdOut(dim(`  ${e.slug}  conf=${e.confidence}  ${e.description}`));
				}
				return true;
			}
			case 'forget': {
				const slug = rest[0];
				if (!slug) {
					this.cmdOut(red('用法：/memory forget <slug>'));
					return true;
				}
				const scope = (await store.readEntry('project', slug)) ? 'project' : 'global';
				const ok = await store.forget(scope, slug, 'user requested via /memory forget');
				await store.rebuildIndex(scope);
				this.cmdOut(ok ? green(`[memory] 已遗忘 ${slug}`) : red(`[memory] 未找到条目 ${slug}`));
				return true;
			}
			case 'on':
			case 'off': {
				const enabled = sub === 'on';
				if (this.configMgr) {
					try {
						await this.configMgr.set('memory.enabled', enabled);
					} catch { /* 写回失败不阻塞 */ }
				}
				// 立即生效：重新装配（关闭时后续不再注入/归纳；开启时按配置装配）
				if (!enabled) {
					this.sessionMgr.configureMemory({ enabled: false });
				} else {
					const cfg = this.configMgr;
					this.sessionMgr.configureMemory({
						enabled: true,
						maxInjectTokens: cfg?.get<number>('memory.max_inject_tokens') ?? undefined,
						deltaInjectTokens: cfg?.get<number>('memory.delta_inject_tokens') ?? undefined,
						masterMinConfidence: cfg?.get<number>('memory.master_min_confidence') ?? undefined,
						recallModel: cfg?.get<string>('memory.recall_model') ?? undefined,
						agentModel: cfg?.get<string>('memory.agent_model') ?? undefined,
						agentOnTurnEnd: cfg?.get<boolean>('memory.agent_on_turn_end') ?? undefined,
					});
				}
				this.cmdOut(green(`[memory: ${enabled ? 'ON' : 'OFF'}]`) + dim(enabled ? '  下次发言起生效' : '  不再注入/归纳（已存在的记忆保留）'));
				return true;
			}
			case 'refresh': {
				const changed = await this.sessionMgr.refreshMemoryPrompt();
				this.cmdOut(changed
					? green('[memory] system prompt 已重建（含最新清单），会话快照已同步')
					: dim('[memory] 清单无变化（或当前无会话）'));
				return true;
			}
			default:
				this.cmdOut(red(`未知子命令：${sub}`) + dim('  可用：show | candidates | forget | on | off | refresh'));
				return true;
		}
	}

	/** /subagent_cancel — 交互式选择要取消的子代理（含"全部取消"选项） */	private async cancelSubagentInteractive(): Promise<true> {
		const subs = this.sessionMgr.listSubagents();
		if (subs.length === 0) {
			this.cmdOut(dim('No subagents to cancel.'));
			return true;
		}

		const options: SelectOption<string>[] = [
			{ label: `全部取消 (${subs.length} 个)`, value: '__all__' },
			...subs.map((s) => {
				const status = s.status;
				const icon = status === 'running' ? '⏳'
					: status === 'completed' ? '✓'
					: status === 'cancelled' ? '✕'
					: '✗';
				return { label: `${s.name}  (${icon} ${status})`, value: s.name };
			}),
		];

		const selector = new Selector(options, terminalIO, '选择要取消的子代理 (↑↓ 移动, Enter 确认, Ctrl+C 取消):');
		const selected = await selector.select(
			() => this.stdinHandler,
			(h) => {
				this.stdinHandler = h;
			},
		);

		if (selected) {
			const cancelled = this.sessionMgr.cancelSubagent(selected === '__all__' ? 'all' : selected);
			if (cancelled.length > 0) {
				this.cmdOut(green(`[cancelled] ${selected === '__all__' ? `全部 ${cancelled.length} 个子代理` : selected}`));
			} else {
				this.cmdOut(dim(`No running subagent matched.`));
			}
		}
		return true;
	}

	/** /subagent [name] — 显示子代理详情（resume 后历史记录已由 SessionManager 恢复） */
	private async showSubagentDetail(name?: string): Promise<true> {
		const records = this.sessionMgr.listSubagentRecords();

		if (records.length === 0) {
			this.cmdOut(dim('No subagents in current session.'));
			return true;
		}

		if (!name) {
			// 无参数：列出所有子代理
			this.cmdOut(yellow('Subagents'));
			this.cmdOut(dim('─'.repeat(40)));
			for (const record of records) {
				const icon = record.status === 'running' ? '⏳'
					: record.status === 'completed' ? green('✓')
					: red('✗');
				const elapsed = record.endMs
					? `${((record.endMs - record.startMs) / 1000).toFixed(1)}s`
					: `${((Date.now() - record.startMs) / 1000).toFixed(1)}s`;
				this.cmdOut(`  ${icon} ${cyan(record.name)} ${dim(`(${record.status}, ${elapsed})`)}`);
				this.cmdOut(dim(`     ${record.task.slice(0, 80)}${record.task.length > 80 ? '...' : ''}`));
			}
			this.cmdOut(dim('─'.repeat(40)));
			this.cmdOut(dim(`/subagent <name> for full detail  |  ${records.length} total`));
			return true;
		}

		// 指定名称：显示完整输出
		const record = this.sessionMgr.getSubagentRecord(name);
		if (!record) {
			this.cmdOut(red(`Subagent "${name}" not found. Use /subagent (no args) to list.`));
			return true;
		}

		this.printSubagentRecord(record);
		return true;
	}

	/** 打印子代理完整记录 */
	private printSubagentRecord(record: SubagentRecord): void {
		const view = new SubagentRecordView();
		const { cols } = getTermSize();
		for (const line of view.render(record, cols)) {
			this.cmdOut(line);
		}
	}

	// ─── shell 命令模式 ────────────────────────────

	/** 进入 shell 命令模式：切换背景色并显示提示 */
	private enterShellMode(): void {
		this.shellMode = true;
		this.bottom.setShellMode(true);
	}

	/** 执行 shell 命令并收集输出（F-4：异步 spawn，不阻塞事件循环——长命令期间 Ctrl+C 仍可响应） */
	private executeShellCommand(cmd: string): void {
		// 打印命令到 scrollback（cmd 已包含前导 !）
		this.out.write(PINK_BG_START + cmd + PINK_BG_END + '\r\n');
		this.outputEndsWithSeparator = false; // 命令行为内容行

		// 去掉前导 ! 后执行
		const shellCmd = cmd.startsWith('!') ? cmd.slice(1).trimStart() : cmd;

		// ── 交互式命令禁止 ──────────────────────────
		const interactiveBlocked = isInteractiveCommand(shellCmd);
		if (interactiveBlocked) {
			this.out.write(red(`  Blocked: ${interactiveBlocked}`) + '\r\n');
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
				this.out.write(dim(' │ ' + line) + '\r\n');
			}
		}

		// 输出 stderr 到 scrollback
		if (stderr) {
			const lines = stderr.split('\n');
			for (const line of lines) {
				this.out.write(red(' │ ' + line) + '\r\n');
			}
		}
		this.outputEndsWithSeparator = false; // 输出均为内容行（可能为空 → cmd 行已置）

		// 构建隐藏上下文块
		const parts: string[] = ['[shell_start]', cmd];
		if (stdout.trim()) parts.push(stdout.trimEnd());
		if (stderr.trim()) parts.push(stderr.trimEnd());
		parts.push('[shell_end]');
		this.pendingShellContext.push(parts.join('\n'));

		// 退出 shell 模式，回到普通输入
		this.shellMode = false;
		this.bottom.setShellMode(false);
		this.printSeparator();
		this.bottom.resetPosition();
		this.bottom.drawBase();
		this.out.write('\r');
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

		// Ctrl+T: 打开 subagent 总览视图（任意状态可用；流式期间 master 后台静默）
		if (data === '\x14') {
			this.openSubagentsView();
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
				this.bottom.setShellMode(false);
				this.printSeparator();
				this.bottom.resetPosition();
				this.bottom.drawBase();
				this.out.write('\r');
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
				this.bottom.renderIdle();
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
				this.bottom.renderIdle();
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
						this.bottom.clearSuggestions();
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
					this.bottom.renderIdle();
					this.executeShellCommand(cmd);
					return;
				}
				if (this.input.isEmpty()) continue;
				const content = this.input.buildSubmitContent();
				// 双工模式（流式期间提交）：保留 handler 继续监听（否则键盘全部失效）；
				// 主循环模式：置空让 inputCycle 接管
				if (this.state !== AppState.STREAMING && this.state !== AppState.SENDING) {
					this.stdinHandler = null;
				}
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
						this.bottom.clearSuggestions();
						this.bottom.renderIdle();
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
						// 不在此渲染：循环末尾统一 renderInput（避免双重渲染）
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

		this.bottom.renderIdle();
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
			this.bottom.clearSuggestions();
			// 双工模式（流式期间 / 命令）：保留 handler 继续监听；主循环模式：置空让 inputCycle 接管
			if (this.state !== AppState.STREAMING && this.state !== AppState.SENDING) {
				this.stdinHandler = null;
			}
			resolve(content);
		} else {
			// 未知命令：显示错误，不清除输入，让用户继续编辑
			const errMsg = `Unknown command: ${content}`;
			this.out.write(red(errMsg) + '\r\n');
			this.out.write(dim(`  Available: ${AVAILABLE_COMMANDS.join(', ')}`) + '\r\n');
			this.outputEndsWithSeparator = false; // 错误行为内容行（随后正常打分隔线）
			// 不清除输入，不清除 stdinHandler，用户可继续修改/重试
			// 重新渲染输入区域
			this.printSeparator();
			this.bottom.resetPosition();
			this.bottom.drawBase();
			this.bottom.renderIdle();
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
		this.bottom.clearSuggestions();
		this.bottom.renderIdle();
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

	// ─── 底部区域渲染（已收敛至 BottomArea）─────────
	// 原 drawInputArea/renderInput/renderInputDuringStream/drawBottomArea
	// 已迁移至 src/presentation/bottom-area.ts（renderIdle/renderAfterOutput/drawBase/drawBottomArea）


	// ─── 命令结果区（固定底部，替换式刷新）───────────

	/** 命令输出捕获：命令执行期间写入命令结果区（完整保留，不截断），否则写 scrollback */
	private cmdOut(line: string): void {
		if (this.commandResultActive) {
			this.bottom.pushCommandLine(line);
			return;
		}
		this.writeOutputLine(line);
	}

	/** 收起底部 → 写分隔线 → 重画底部（命令执行后使用，避免分隔线覆盖命令结果区/输入区） */
	private printSeparatorKeepBottom(): void {
		this.bottom.collapse();
		this.printSeparator();
		this.bottom.renderAfterOutput();
	}
	// 原 renderCommandResultBar/clearCommandResult/collapseInputArea 已迁移至 BottomArea
	// （renderCommandBar/clearCommandResult/collapse）

	/** 输出一行到 scrollback，并在底部重绘输入区（Bug 1）；视图打开时缓冲（流式静默） */
	private writeOutputLine(line: string): void {
		if (this.overlay.active) {
			// 全屏视图打开：输出静默缓冲（退出视图后补渲染）
			this.overlay.bufferOutput(line);
			return;
		}
		this.bottom.collapse();
		this.out.write(line + '\r\n');
		this.outputEndsWithSeparator = false;
		this.bottom.renderAfterOutput();
	}

	/** 批量输出多行（减少逐行重绘闪烁）；视图打开时缓冲 */
	private writeOutputLines(lines: string[]): void {
		if (lines.length === 0) return;
		if (this.overlay.active) {
			this.overlay.bufferOutputs(lines);
			return;
		}
		this.bottom.collapse();
		for (const l of lines) {
			this.out.write(l + '\r\n');
		}
		this.outputEndsWithSeparator = false;
		this.bottom.renderAfterOutput();
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
		// 光标在输入区，上移到折叠提示行更新后移回（跨过命令结果区）
		const up = this.bottom.getUpRowsForThink();
		this.out.write(`\x1b[${up}A`);
		this.out.write('\r');
		clearLine();
		this.out.write(dim(`[Think] 思考中 ${dots}  (Ctrl+O 查看完整)`));
		this.out.write(`\x1b[${up}B`);
		this.out.write('\r');
	}

	/** 定稿折叠行（think 阶段结束：content 过渡/工具调用/done 时调用） */
	private finalizeThinkCollapse(): void {
		if (!this.thinkFolded) return;
		if (this.thinkAnimTimer) {
			clearInterval(this.thinkAnimTimer);
			this.thinkAnimTimer = null;
		}
		const foldedCount = Math.max(0, this.fullThink.length - this.thinkVisibleLines);
		const up = this.bottom.getUpRowsForThink();
		this.out.write(`\x1b[${up}A`);
		this.out.write('\r');
		clearLine();
		this.out.write(dim(`[Think] 已折叠 ${foldedCount} 行 (Ctrl+O 查看完整)`));
		this.out.write('\r\n');
		this.thinkFolded = false;
		// 光标在折叠行下一行（输出末尾），后续 writeOutputLine 从这继续
		this.bottom.resetPosition();
	}

	// ─── Ctrl+O 全屏对话浏览视图 ─────────────────────

	/** 打开全屏浏览视图（alternate screen；流式期间打开则后台静默输出） */
	private openViewer(): void {
		if (this.overlay.active) return;
		const session = this.sessionMgr.getSession();
		this.overlay.setOpenTurnCount(session?.turns.length ?? 0);
		this.overlay.open(
			'conversation',
			(data: string) => {
				if (this.conversationViewer.handleInput(data) === 'close') this.closeViewer();
			},
			this.state !== AppState.IDLE,
		);
		// 渲染由 OverlayPane.render 钩子（renderActiveOverlay）完成
	}

	/** 退出全屏浏览视图：公共生命周期由 OverlayPane 统一处理 */
	private closeViewer(): void {
		if (this.overlay.currentMode !== 'conversation') return;
		this.overlay.close();
	}

	/**
	 * 补渲染视图期间的静默输出（OverlayPane.replay 钩子）：
	 *  - 完整轮次从 turns 补（resume 式）
	 *  - 打开时进行中的轮补 openedTurnLines + streamLines（视图期间增量）
	 */
	private replayOverlayOutput(info: OverlayReplayInfo): void {
		const session = this.sessionMgr.getSession();
		const turns = session?.turns ?? [];
		let from = info.openTurnCount;
		if (info.openedDuringStream) {
			if (info.openedTurnDone) {
				// 打开时的轮已完成：跳过它（前半已在主 buffer），渲染它之后完成的新轮
				from = info.openTurnCount + 1;
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
		if (info.openedTurnLines.length > 0) {
			this.writeOutputLines(info.openedTurnLines);
		}
		// 最新进行中轮的增量
		if (info.streamLines.length > 0) {
			this.writeOutputLines(info.streamLines);
		}
	}

	/** 渲染当前激活的覆盖层（OverlayPane.render 钩子） */
	private renderActiveOverlay(): void {
		if (this.overlay.currentMode === 'subagents') {
			this.subagentsViewer.render();
		} else {
			this.conversationViewer.render();
		}
	}

	// ─── Ctrl+T Subagents 总览视图（全屏，实时刷新 + 视图内交互）────

	/** 打开 Subagents 总览视图（任意状态可用；流式期间 master 后台静默缓冲） */
	private openSubagentsView(): void {
		if (this.overlay.active) return;
		this.subagentsViewer.reset();
		// 记录打开时状态（退出时据此补渲染 master 输出）
		const session = this.sessionMgr.getSession();
		this.overlay.setOpenTurnCount(session?.turns.length ?? 0);
		this.overlay.open(
			'subagents',
			(data: string) => {
				if (this.subagentsViewer.handleInput(data) === 'close') this.closeSubagentsView();
			},
			this.state !== AppState.IDLE,
		);
		// 渲染由 OverlayPane.render 钩子（renderActiveOverlay）完成；
		// 实时刷新由组件内 syncTimer 按需启停（有 running 或主流程在跑才刷新）
	}

	/** 退出 Subagents 视图：公共生命周期由 OverlayPane 统一处理（timer 清理在 cleanup 钩子） */
	private closeSubagentsView(): void {
		if (this.overlay.currentMode !== 'subagents') return;
		this.overlay.close();
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
			this.out.write(yellow(`\r\n[Confirm] ${command}\r\n`));
			this.out.write(yellow('Execute? [y/N] '));

			const prevHandler = this.stdinHandler;
			this.stdinHandler = (data: string) => {
				this.out.write('\r\n');
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
		this.bottom.collapse();
		this.input.clear();
		this.bottom.renderAfterOutput();
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
						// 实时显示前 thinkVisibleLines 行，超出后折叠（节省显示空间）
						if (this.fullThink.length <= this.thinkVisibleLines) {
							this.writeOutputLine(dim(line));
						}
					}
					// 超过可见行数：进入折叠状态（动态省略号动画）
					if (this.fullThink.length > this.thinkVisibleLines) {
						this.enterThinkCollapse();
					}
				}
				// 非 force 且无完整行且不超长：半行留在 pending（输入区保持可见，不输出）
			} else {
				this.out.write(pending);
				pending = '';
			}
		};

		// 表格渲染器：检测 markdown 表格块并格式化为 box-drawing
		const mdRenderer = new MarkdownTableRenderer();

		// 全双工交互：流式期间输入框始终可编辑
		// - / 命令：立即执行（不中断输出），输出进命令结果区（固定底部）
		// - 普通文本 / !shell：排队（不中断当前输出），输出结束后自动发送
		const prevHandler = this.stdinHandler;
		this.stdinHandler = (data: string) => {
			this.handleInputData(data, (content) => {
				if (content === null) return; // Ctrl+C 已在 handleInputData 内处理（STREAMING 态 abort）
				// 提交成功（Enter / 已知命令）：清空输入区，避免后续输入追加到已排队内容
				this.input.clear();
				if (content.startsWith('/')) {
					// / 命令：内部渲染命令结果区（含输入区重绘）
					void this.handleCommandDuringStream(content);
					return;
				}
				// 排队（不中断当前输出，输出结束后在 finally 中自动发送）
				this.bottom.renderCommandBar();
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

							// 刷出 content 累积缓冲：无换行的正文在 tool_calls 前会堆积在 mdRenderer，
							// 需在工具调用前输出，保持 assistant(content)→tool 的实时交替顺序
							this.writeOutputLines(mdRenderer.flush());

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
							// 实时 shell 输出：逐行渲染（short 模式不展示工具输出内容）
							if (!this.preset.showLiveToolOutput) break;
							const line = event.outputLine ?? '';
							const stream = event.outputStream ?? 'stdout';
							this.writeOutputLine(
								stream === 'stderr'
									? yellow(' │ ') + dim(line)
									: cyan(' │ ') + dim(line),
							);
							break;
						}
						case 'tool_result': {
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							// 记忆写入：额外给一行 dim 提示（「已更新记忆」不打扰）
							if (event.toolName === 'memory_write' && !event.error) {
								this.writeOutputLine(dim('[memory] 已写入/更新 1 条（/memory show 查看）'));
							}
							if (event.toolDenied) {
								this.writeOutputLine(red('[Denied]'));
								break;
							}
							const outLines: string[] = [];
							// short 模式：非文件修改工具不展示结果内容，仅显示成功/失败标记
							const hideResult = this.preset.hideNonFileToolResult
								&& !isFileModTool(event.toolName);
							if (event.error) {
								outLines.push(red(' ✖ ') + event.error.split('\n')[0]);
							} else if (hideResult) {
								outLines.push(green(' ✓'));
								this.writeOutputLines(outLines);
								break;
							}
							// 显示工具执行结果内容（文件修改工具在 short 下同样展示）
							if (!hideResult) {
								const maxLines = this.preset.toolResultMaxLines;
								const resultLines = (event.toolResult ?? '').split('\n');
								for (const line of resultLines.slice(0, maxLines)) {
									outLines.push(cyan(' │ ') + dim(line));
								}
								if (resultLines.length > maxLines) {
									outLines.push(cyan(' │ ') + dim('...'));
								}
							}
							this.writeOutputLines(outLines);
							break;
						}
						case 'subagent_spawned': {
							flush(true);

							// 同 tool_call_start：刷出 content 累积缓冲，保持实时交替
							this.writeOutputLines(mdRenderer.flush());

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
						case 'auto_compact': {
							flush(true);

							this.finalizeThinkCollapse();
							const gen = event.compactGen;
							const n = event.compressedTurns;
							const files = event.restoredFiles;
							const detail = gen !== undefined
								? ` gen=${gen}, 压缩 ${n ?? 0} 轮, 恢复 ${files ?? 0} 个文件`
								: '';
							this.writeOutputLine(dim(`[Auto-compact] ${event.text ?? ''}${detail}`));
							break;
						}
						case 'done':
							flush(true);

							this.finalizeThinkCollapse(); // think 结束：定稿折叠行
							// 视图打开时的轮已完成：归档该轮视图期间增量（退出时补渲染），
							// 之后完成的新轮增量清空（退出时从 turns 补渲染完整轮）
							this.overlay.onTurnDone();
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
			if (!this.overlay.active) {
				// 正常路径（无视图打开）：恢复输入、UI 状态、nextMessage 链
				this.stdinHandler = prevHandler;
				// Bug 1：收起输出期间绘制的输入区，使后续 printSeparator/drawBase 从输出末尾正常开始
				this.bottom.collapse();
				this.bottom.resetPosition();
				this.setState(AppState.IDLE);
				// 全双工：输出结束后自动发送排队消息（普通文本 / !shell / // 转义）
				const next = this.nextMessage;
				this.nextMessage = null;
				if (next) {
					this.bottom.clearCommandResult(false); // 输入区已收起，不重绘
					this.printSeparator();
					this.out.write(green('[You] ') + next + '\r\n\r\n');
					this.outputEndsWithSeparator = false;
					await this.sendMessageStream(next);
				}
			}
			// overlay.active：跳过 UI/输入恢复（避免覆盖视图 handler、污染 alternate screen），
			// 状态与 nextMessage 由 OverlayPane.close 统一处理
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
