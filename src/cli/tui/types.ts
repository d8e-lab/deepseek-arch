/**
 * TUI 内部类型
 */

/** TUI 应用状态 */
export enum AppState {
	IDLE = 'IDLE',
	SENDING = 'SENDING',
	STREAMING = 'STREAMING',
	/** 等待用户确认 tool call 执行 */
	CONFIRMING = 'CONFIRMING',
	ERROR = 'ERROR',
}

/** 从 ResolvedConfig 提取的 TUI 所需配置 */
export interface TuiConfig {
	provider: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	version: string;
	/** YOLO 模式下审查模型名（默认同主模型） */
	reviewModel?: string;
}

// ─── Screen Capture（供模型调试工具使用）───────────

/** 一轮对话的捕获信息 */
export interface TurnCaptureInfo {
	/** 轮次序号（0-based） */
	index: number;
	/** 用户消息纯文本 */
	userText: string;
	/** think 区域行数 */
	thinkLines: number;
	/** think 内容是否被截断 */
	thinkTruncated: boolean;
	/** 模型回复纯文本行数 */
	contentLines: number;
	/** 工具调用记录 */
	toolCalls: ToolCallCaptureInfo[];
	/** token 用量摘要 */
	usage: string;
}

/** 工具调用捕获信息 */
export interface ToolCallCaptureInfo {
	name: string;
	args: string;
	durationMs: number;
	error?: string;
	/** 结果预览（最多 3 行） */
	resultPreview: string;
}

/** 输入区域捕获信息 */
export interface InputAreaCapture {
	shellMode: boolean;
	lineCount: number;
	maxVisibleLines: number;
	cursorRow: number;
	cursorCol: number;
	/** 前 200 字符 */
	textPreview: string;
}

/** 屏幕捕获完整结构 */
export interface ScreenCapture {
	terminal: { rows: number; cols: number };
	appState: AppState;
	/** Header 行纯文本 */
	header: string;
	/** 对话轮次数 */
	turnCount: number;
	/** 每轮捕获信息 */
	turns: TurnCaptureInfo[];
	/** 输入区域状态 */
	inputArea: InputAreaCapture;
	/** 诊断警告（如截断、溢出） */
	warnings: string[];
}

/** TuiApp 屏幕捕获函数类型（由 TuiApp 注册，供 tool 调用） */
export type CaptureScreenFn = () => ScreenCapture | null;
