/**
 * ChatState — TUI 流式状态机
 *
 * 从 chat-ui.ts 剥离的独立模块。
 * 管理 UI 状态 (IDLE/SENDING/STREAMING)、流式累积内容、AbortController。
 */

/** UI 状态 */
export type UIState = 'idle' | 'sending' | 'streaming';

/** 流式累积内容 */
export interface LiveStreamState {
	reasoning: string;
	content: string;
	/** 当前输出阶段 */
	phase: 'sending' | 'reasoning' | 'content';
}

/**
 * ChatUI 状态机
 *
 * 状态转换：
 *   IDLE ──Enter──► SENDING ──content_delta──► STREAMING ──done/error──► IDLE
 *                      │                                              ▲
 *                      └─────────── ESC/Ctrl+C ────────────────────────┘
 */
export class ChatState {
	private _uiState: UIState = 'idle';
	private _liveStream: LiveStreamState | null = null;
	private _streamAbort: AbortController | null = null;

	// ─── UI 状态 ──────────────────────────────────

	get uiState(): UIState {
		return this._uiState;
	}

	isIdle(): boolean {
		return this._uiState === 'idle';
	}

	isSending(): boolean {
		return this._uiState === 'sending';
	}

	isStreaming(): boolean {
		return this._uiState === 'streaming';
	}

	/** 进入 SENDING 状态，初始化 LiveStream */
	startSending(): void {
		this._uiState = 'sending';
		this._liveStream = {
			reasoning: '',
			content: '',
			phase: 'sending',
		};
	}

	/** 切换到 STREAMING 状态 */
	startStreaming(): void {
		this._uiState = 'streaming';
		if (this._liveStream) {
			this._liveStream.phase = 'content';
		}
	}

	/** 回到 IDLE 状态，清除 LiveStream */
	resetToIdle(): void {
		this._uiState = 'idle';
		this._liveStream = null;
	}

	// ─── 流式累积内容 ─────────────────────────────

	get liveStream(): LiveStreamState | null {
		return this._liveStream;
	}

	/** 追加 reasoning 增量 */
	addReasoningDelta(text: string): void {
		if (this._liveStream && this._liveStream.phase === 'sending') {
			this._liveStream.phase = 'reasoning';
		}
		if (this._liveStream) {
			this._liveStream.reasoning += text;
		}
	}

	/** 追加 content 增量 */
	addContentDelta(text: string): void {
		if (this._liveStream) {
			this._liveStream.content += text;
		}
	}

	// ─── 中断控制 ─────────────────────────────────

	get streamAbort(): AbortController | null {
		return this._streamAbort;
	}

	createAbortController(): AbortController {
		this._streamAbort = new AbortController();
		return this._streamAbort;
	}

	/** 触发中断 */
	abortStream(): void {
		this._streamAbort?.abort();
	}

	/** 释放 AbortController */
	releaseAbortController(): void {
		this._streamAbort = null;
	}
}
