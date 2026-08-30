/**
 * OverlayPane — 全屏覆盖层基类（Ctrl+O 对话浏览 / Ctrl+T Subagents 总览）
 *
 * 封装两个全屏视图的公共生命周期与状态：
 *   - 打开：记录状态 → 暂停 think 动画 → 接管 stdinHandler → 进入 alt screen
 *   - 关闭：清理（子视图 timer）→ 恢复 stdinHandler（三段式）→ 退出 alt screen
 *           → 补渲染静默输出 → 重建底部 → 恢复 IDLE
 *   - 静默缓冲：视图打开期间主流程输出进入缓冲，关闭时统一回放
 *
 * 子视图特有逻辑（渲染、输入处理、刷新定时器）通过 hooks 注入，
 * TuiApp 只保留组合与子视图差异逻辑（正交模块边界）。
 */

import type { ScreenBuffer } from './screen-buffer.js';

export type OverlayMode = 'conversation' | 'subagents';

/** 视图期间静默输出回放所需的状态快照 */
export interface OverlayReplayInfo {
	/** 打开视图时的 turns.length（退出时据此补渲染） */
	openTurnCount: number;
	/** 打开视图时是否处于流式输出中 */
	openedDuringStream: boolean;
	/** 打开时的进行中轮是否已完成（done） */
	openedTurnDone: boolean;
	/** 打开时的进行中轮在视图期间的输出行（done 时归档） */
	openedTurnLines: string[];
	/** 视图期间当前轮的输出行缓冲（流式静默用） */
	streamLines: string[];
}

export interface OverlayHooks {
	/** 获取当前 stdinHandler */
	getHandler(): ((data: string) => void) | null;
	/** 设置 stdinHandler */
	setHandler(h: ((data: string) => void) | null): void;
	/** 当前是否有流式输出（abortController 非空） */
	isStreamActive(): boolean;
	/** 暂停 think 折叠动画（打开视图前；其直接写 stdout，会污染主 buffer） */
	pauseThink(): void;
	/** 渲染视图内容（已进入 alt screen） */
	render(): void;
	/** 子视图关闭清理（如清除刷新定时器） */
	cleanup(): void;
	/** 补渲染视图期间的静默输出（由使用方按 turns + 增量行组装） */
	replay(info: OverlayReplayInfo): void;
	/** 重建底部区域（关闭后） */
	rebuildBottom(): void;
	/** 输出已结束时恢复 IDLE 状态（由使用方判断 abortController 是否已清空） */
	setIdleIfStreamEnded(): void;
}

export class OverlayPane {
	private out: ScreenBuffer;
	private hooks: OverlayHooks;

	private _active = false;
	private mode: OverlayMode | null = null;
	private openTurnCount = 0;
	private openedDuringStream = false;
	private openedTurnDone = false;
	private openedTurnLines: string[] = [];
	private streamLines: string[] = [];
	private prevHandler: ((data: string) => void) | null = null;
	private handler: ((data: string) => void) | null = null;
	private closedPromise: Promise<void> | null = null;
	private closedResolve: (() => void) | null = null;

	constructor(out: ScreenBuffer, hooks: OverlayHooks) {
		this.out = out;
		this.hooks = hooks;
	}

	// ─── 状态查询 ──────────────────────────────────

	get active(): boolean {
		return this._active;
	}

	get currentMode(): OverlayMode | null {
		return this.mode;
	}

	// ─── 生命周期 ──────────────────────────────────

	/**
	 * 打开覆盖层
	 * @param mode 视图模式
	 * @param handler 视图输入处理函数
	 * @param streamActive 打开时是否处于流式输出中（决定关闭时的 handler 恢复）
	 */
	open(mode: OverlayMode, handler: (data: string) => void, streamActive: boolean): void {
		if (this._active) return;
		this._active = true;
		this.mode = mode;
		// 记录打开时状态（退出时据此补渲染）
		this.openedDuringStream = streamActive;
		this.openedTurnDone = false;
		this.openedTurnLines = [];
		this.streamLines = [];
		// 暂停 think 折叠动画
		this.hooks.pauseThink();
		// 保存当前 stdinHandler，切换为视图 handler
		this.prevHandler = this.hooks.getHandler();
		this.handler = handler;
		this.hooks.setHandler(handler);
		// 建立视图关闭等待（inputCycle 在视图打开时等待，避免接管输入）
		this.closedPromise = new Promise<void>((r) => { this.closedResolve = r; });
		// 切换 alternate screen 并渲染
		this.out.write('\x1b[?1049h');
		this.hooks.render();
	}

	/** 关闭覆盖层：恢复主 buffer + 补渲染静默期输出 + 恢复输入 */
	close(): void {
		if (!this._active) return;
		this.hooks.cleanup(); // 子视图 timer 等
		this._active = false;
		this.mode = null;
		// 恢复 stdinHandler：
		// - 若主循环已接管（readUserInput 设置了新 handler），保持不变
		// - 若仍持有视图 handler，按打开场景区分：
		//   * IDLE 打开（无流式）：恢复 readUserInput 的 handler（inputCycle 仍在 await 它）
		//   * 流式打开：输出还在跑 → 恢复双工 handler（流式继续）；
		//               已结束 → 置空让主循环 inputCycle 接管
		if (this.hooks.getHandler() === this.handler) {
			if (!this.openedDuringStream) {
				this.hooks.setHandler(this.prevHandler);
			} else if (this.hooks.isStreamActive()) {
				this.hooks.setHandler(this.prevHandler);
			} else {
				this.hooks.setHandler(null);
			}
		}
		this.handler = null;
		this.prevHandler = null;
		// 恢复主 buffer（alternate screen 保存的主 TUI 内容还原）
		this.out.write('\x1b[?1049l');
		// 补渲染视图期间的静默输出
		this.hooks.replay(this.collectReplayInfo());
		this.openedTurnLines = [];
		this.streamLines = [];
		// 重建输入区
		this.hooks.rebuildBottom();
		// 输出已结束：恢复 IDLE 状态（nextMessage 保留，交给主循环 inputCycle 统一发送，避免双流并发）
		this.hooks.setIdleIfStreamEnded();
		// 通知等待中的 inputCycle：视图已关闭
		this.closedResolve?.();
		this.closedResolve = null;
		this.closedPromise = null;
	}

	/** 等待视图关闭（inputCycle 在视图打开时调用，避免接管输入） */
	async waitForClose(): Promise<void> {
		if (this.closedPromise) {
			await this.closedPromise;
		}
	}

	// ─── 静默缓冲 ──────────────────────────────────

	/** 视图打开时缓冲单行输出（主流程静默，关闭时回放） */
	bufferOutput(line: string): void {
		this.streamLines.push(line);
	}

	/** 视图打开时缓冲多行输出 */
	bufferOutputs(lines: string[]): void {
		this.streamLines.push(...lines);
	}

	/** 当前轮完成（done 事件）：归档打开时进行中轮的增量（退出时补渲染） */
	onTurnDone(): void {
		if (this._active && this.openedDuringStream && !this.openedTurnDone) {
			this.openedTurnDone = true;
			this.openedTurnLines = this.streamLines;
		}
		this.streamLines = [];
	}

	/** 设置打开视图时的 turns.length（供 replay 判断补渲染起点；须在 open() 前调用） */
	setOpenTurnCount(n: number): void {
		this.openTurnCount = n;
	}

	// ─── 内部 ──────────────────────────────────────

	private collectReplayInfo(): OverlayReplayInfo {
		return {
			openTurnCount: this.openTurnCount,
			openedDuringStream: this.openedDuringStream,
			openedTurnDone: this.openedTurnDone,
			openedTurnLines: this.openedTurnLines,
			streamLines: this.streamLines,
		};
	}
}
