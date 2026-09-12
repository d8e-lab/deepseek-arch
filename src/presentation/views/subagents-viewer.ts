/**
 * SubagentsViewer — Ctrl+T Subagents 总览视图（presentation 视图组件）
 *
 * 方案 A 抽取：原为 TuiApp 内嵌的 10 字段 + 9 方法（renderSubagentsView /
 * handleSubagentsViewInput / syncSubagentViewTimer / subagentScroll* /
 * sendToSubagentFromView），现为独立组件类：自带选中/输入/滚动/定时器状态，
 * 通过 ViewComponent 契约接入 OverlayPane。
 *
 * 职责：全屏展示 subagent 列表与选中轨迹，支持轨迹滚动、视图内输入发送、
 * 500ms 实时刷新（全部结束后自动停表）。
 * 轨迹渲染复用 render SDK 的 SubagentRecordView，底部列表选中行高亮。
 *
 * 依赖注入：输出经 ScreenBuffer，数据源经 listSubagents / sendToSubagent 回调
 * （组件不直接依赖 SessionManager），是否可能继续 spawn 经 isStreamActive。
 */

import type { ScreenBuffer } from '../screen-buffer.js';
import { dim, cyan, green, yellow, red } from '../../render/ansi.js';
import { SubagentRecordView } from '../../render/subagent-record-view.js';
import type { SubagentRecord } from '../../types/subagent.js';
import type { ViewComponent, ViewInputResult } from './types.js';

/** 数据源：与 TuiApp 交互的最小面（listSubagents 返回可 toRecord 的会话对象） */
export interface SubagentViewSession {
	name: string;
	status: 'running' | 'completed' | 'failed' | 'cancelled' | string;
	startMs: number;
	endMs?: number;
	toRecord(): SubagentRecord;
}

export interface SubagentsViewerOptions {
	out: ScreenBuffer;
	/** 数据源：当前会话 subagent 列表（组合根注入） */
	listSubagents: () => SubagentViewSession[];
	/** 副作用：向指定 subagent 追加指令续跑（组合根注入） */
	sendToSubagent: (name: string, text: string) => Promise<void>;
	/** 主流程是否仍可能 spawn 新 subagent（定时器启停用） */
	isStreamActive: () => boolean;
	/** 终端尺寸 */
	getSize: () => { rows: number; cols: number };
}

export class SubagentsViewer implements ViewComponent {
	private out: ScreenBuffer;
	private listSubagents: () => SubagentViewSession[];
	private sendToSubagent: (name: string, text: string) => Promise<void>;
	private isStreamActive: () => boolean;
	private getSize: () => { rows: number; cols: number };

	// ─── 视图状态（原 TuiApp subagentView* / viewerSubagentIndex 字段）──
	/** 当前选中 subagent 索引 */
	private selectedIndex = 0;
	/** 底部输入缓冲（发送给选中 subagent） */
	private inputText = '';
	/** 实时刷新定时器 */
	private timer: ReturnType<typeof setInterval> | null = null;
	/** 发送中标志（阻止并发 send） */
	private busy = false;
	/** 最近一次发送错误（显示在底部） */
	private error: string | null = null;
	/** vim 式输入模式（false=命令模式；true=insert） */
	private insertMode = false;
	/** 轨迹滚动偏移（相对选中 subagent 完整记录行数组） */
	private scrollOffset = 0;
	/** 是否跟随最新输出（贴底；上滚后关闭，切 subagent/滚到底恢复） */
	private followTail = true;
	/** 上次渲染的轨迹总行数（滚动 clamp 用） */
	private totalLines = 0;
	/** 上次渲染的选中索引（切换 subagent 时回到最新） */
	private renderedIndex = -1;

	constructor(opts: SubagentsViewerOptions) {
		this.out = opts.out;
		this.listSubagents = opts.listSubagents;
		this.sendToSubagent = opts.sendToSubagent;
		this.isStreamActive = opts.isStreamActive;
		this.getSize = opts.getSize;
	}

	// ─── ViewComponent ──────────────────────────────

	/** 打开视图：重置导航/输入状态（OverlayPane.open 前由组合根调用） */
	reset(): void {
		this.selectedIndex = 0;
		this.inputText = '';
		this.busy = false;
		this.error = null;
		this.insertMode = false;
		this.scrollOffset = 0;
		this.followTail = true;
		this.totalLines = 0;
		this.renderedIndex = -1;
	}

	/** 渲染视图（OverlayPane.render 钩子；内部同步定时器启停） */
	render(): void {
		// 同步刷新定时器（全部结束后停止，避免 completed 列表仍在每 500ms 刷新/耗秒跳动）
		this.syncTimer();
		const { rows, cols } = this.getSize();
		const subs = this.listSubagents();

		this.out.write('\x1b[2J\x1b[H');

		if (subs.length === 0) {
			this.out.write(yellow('═══ Subagents ═══') + '\r\n');
			this.out.write(dim('(当前会话没有 subagent。master agent 可通过 subagent_spawn 创建。)') + '\r\n');
			this.out.write('\r\n');
			this.out.write(dim('  [q] 返回 master') + '\r\n');
			return;
		}

		// 校正选中索引（subagent 可能被取消/移除）
		if (this.selectedIndex >= subs.length) this.selectedIndex = 0;
		const current = subs[this.selectedIndex];
		const record = current.toRecord();

		// ── 顶部标题（仅一行，其余空间留给选中 subagent 输出）──
		const curIcon = current.status === 'running' ? '⏳'
			: current.status === 'completed' ? '✓' : '✗';
		this.out.write(yellow(`═══ Subagents (${subs.length}) — 选中: ${current.name} ${curIcon} ═══`) + '\r\n');

		// 底部列表高度（预留标题 1 + 输出 ≥3 + 分隔线 1 + 提示/输入 2 行）
		const maxListRows = Math.max(1, Math.min(subs.length, rows - 8));

		// ── 选中 subagent 轨迹（完整渲染；默认贴底显示最新，可 ↑↓/PgUp/PgDn 滚动）──
		const view = new SubagentRecordView();
		const outLines = view.render(record, cols);
		this.totalLines = outLines.length;
		const visible = this.outputRows();
		const maxOffset = Math.max(0, this.totalLines - visible);
		// 跟随末尾或切换了 subagent：回到最新；否则维持用户滚动位置（仅 clamp）
		if (this.followTail || this.renderedIndex !== this.selectedIndex) {
			this.scrollOffset = maxOffset;
			this.followTail = true;
		}
		this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxOffset);
		if (this.scrollOffset >= maxOffset) this.followTail = true;
		this.renderedIndex = this.selectedIndex;
		this.out.renderViewportLines(outLines, this.scrollOffset, visible, cols);

		// ── 底部：分隔线 + subagent 列表（状态栏，选中高亮）──
		this.out.write('\r\n');
		this.out.write(dim('─'.repeat(Math.max(20, cols - 2))) + '\r\n');
		const listLines = subs.map((s, i) => {
			const icon = s.status === 'running' ? '●'
				: s.status === 'completed' ? green('✓')
				: red('✗');
			// 已结束的 subagent：耗时固定到 endMs（不再随 now 增长）
			const endTs = s.endMs ?? Date.now();
			const elapsed = ((endTs - s.startMs) / 1000).toFixed(1);
			const marker = i === this.selectedIndex ? green('▸') : ' ';
			const name = i === this.selectedIndex ? cyan(s.name) : s.name;
			return `  ${marker} ${icon} ${name} ${dim(`(${s.status}, ${elapsed}s)`)}`;
		});
		const shown = listLines.slice(0, maxListRows);
		shown.forEach((l, i) => {
			this.out.write('\r\x1b[2K');
			this.out.write(l);
			if (i < shown.length - 1) this.out.write('\r\n');
		});
		if (listLines.length > shown.length) {
			this.out.write('\r\n\x1b[2K');
			this.out.write(dim(`  … 还有 ${listLines.length - shown.length} 个 subagent`));
		}

		// ── 最底部：快捷键提示 + 输入区 ──
		this.out.write('\r\n\x1b[2K');
		if (this.insertMode) {
			this.out.write(dim(`  [Enter] 发送  [ESC] 退出输入`) + '\r\n');
		} else {
			// 命令模式提示：切换 + 轨迹滚动 + 输入/返回（保留 '[n] next' 兼容旧提示）
			let hint = `  [n] next  [p] prev  [1-${Math.min(subs.length, 9)}] 跳转`;
			if (this.totalLines > visible) {
				hint += `  [↑↓/PgUp/PgDn] 滚动`;
				const endIdx = Math.min(this.scrollOffset + visible, this.totalLines);
				hint += `  ${this.scrollOffset + 1}-${endIdx}/${this.totalLines}`;
			}
			hint += `  [i] 输入  [q] 返回`;
			this.out.write(dim(hint.slice(0, Math.max(1, cols - 1))));
		}
		this.out.write('\r\n');
		this.out.write('\x1b[2K');
		if (this.busy) {
			this.out.write(dim(`  ⏳ 正在发送给 ${current.name}... (ESC 中断)`));
		} else if (this.insertMode) {
			const prefix = `  > ${this.inputText}`;
			this.out.write(green(prefix) + dim('  [Enter] 发送  [ESC] 退出'));
			if (this.error) {
				this.out.write(red(`  ⚠ ${this.error}`));
			}
		} else {
			const prefix = `  > ${this.inputText}`;
			this.out.write(dim(prefix) + dim('  按 [i] 进入输入模式'));
			if (this.error) {
				this.out.write(red(`  ⚠ ${this.error}`));
			}
		}
	}

	/**
	 * 视图输入处理：vim 式双模式
	 *  - 命令模式（默认）：n/p/数字 切换、i 进入 insert、q/ESC 返回 master
	 *  - insert 模式（按 i 进入）：字符进输入缓冲（n/p 等不再被捕捉），
	 *    Enter 发送、ESC 退出到命令模式
	 * 返回 'close' 表示请求关闭视图。
	 */
	handleInput(data: string): ViewInputResult {
		const subs = this.listSubagents();
		for (let i = 0; i < data.length; i++) {
			const ch = data[i];

			// ESC 序列：↑↓ 单行滚动、PgUp/PgDn 翻页（命令模式与输入模式均可用）
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
					if (this.busy) continue; // 发送中忽略
					if (seq === 'A') this.scrollBy(-1);
					else if (seq === 'B') this.scrollBy(1);
					else if (seq === '5~') this.scrollPage(-1);
					else if (seq === '6~') this.scrollPage(1);
					continue;
				}
				// 单独 ESC：insert → 退出到命令模式；命令模式 → 关闭视图
				if (this.busy) {
					return 'close';
				} else if (this.insertMode) {
					this.insertMode = false;
					this.render();
				} else {
					return 'close';
				}
				return 'handled';
			}

			// 发送中：忽略其他输入（ESC 已处理）
			if (this.busy) continue;

			if (this.insertMode) {
				// ── insert 模式：所有字符进输入缓冲，n/p 等不解释为命令 ──
				if (ch === '\x0d' || ch === '\x0a') {
					// Enter 发送给当前选中 subagent（发送后回命令模式，vim 式）
					const text = this.inputText.trim();
					this.inputText = '';
					this.insertMode = false;
					if (text) {
						void this.sendToCurrent(text);
					} else {
						this.render();
					}
					continue;
				}
				if (ch === '\x7f' || ch === '\x08') {
					// Backspace
					this.inputText = this.inputText.slice(0, -1);
					this.render();
					continue;
				}
				// 可打印字符（含中文等单码元字符）追加到输入缓冲
				if (ch >= ' ') {
					this.inputText += ch;
					this.render();
					continue;
				}
				continue;
			}

			// ── 命令模式：导航键 + i 进入 insert ──
			if (ch === 'q' || ch === 'Q') return 'close';
			if (ch === 'i' || ch === 'I') {
				this.insertMode = true;
				this.error = null;
				this.render();
				continue;
			}
			if (ch === 'n') {
				if (subs.length > 0) {
					this.selectedIndex = (this.selectedIndex + 1) % subs.length;
					this.error = null;
					this.followTail = true; // 切换 subagent：从最新输出看起
					this.render();
				}
				continue;
			}
			if (ch === 'p') {
				if (subs.length > 0) {
					this.selectedIndex = (this.selectedIndex - 1 + subs.length) % subs.length;
					this.error = null;
					this.followTail = true;
					this.render();
				}
				continue;
			}
			if (ch >= '1' && ch <= '9') {
				const idx = Number(ch) - 1;
				if (idx < subs.length) {
					this.selectedIndex = idx;
					this.error = null;
					this.followTail = true;
					this.render();
				}
				continue;
			}
			// 命令模式：其他字符忽略（不进入输入缓冲）
		}
		return 'handled';
	}

	/** 视图关闭清理（OverlayPane.cleanup 钩子）：停止刷新定时器 */
	cleanup(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	// ─── 内部 ──────────────────────────────────────

	/** 输出窗口可见行数（与底部标题/列表/提示/输入行高联动） */
	private outputRows(): number {
		const { rows } = this.getSize();
		const subs = this.listSubagents();
		const maxListRows = Math.max(1, Math.min(subs.length, rows - 8));
		return Math.max(1, rows - 1 - (1 + maxListRows + 2));
	}

	/**
	 * 同步视图刷新定时器（500ms）：
	 * - 存在 running subagent，或主流程仍非 IDLE（后台可能 spawn 新 subagent）→ 保持刷新；
	 * - 全部 subagent 已结束（completed/failed/cancelled）且主流程 IDLE → 停止刷新，
	 *   视图画面保留最后状态，耗时不再跳动（cleanup 在视图关闭时兜底清除）。
	 */
	private syncTimer(): void {
		const subs = this.listSubagents();
		const hasRunning = subs.some((s) => s.status === 'running');
		// 主流程仍持有流（abortController 非空）：后台可能继续输出/spawn 新 subagent
		const maySpawnMore = this.isStreamActive();
		if (hasRunning || maySpawnMore) {
			if (!this.timer) {
				this.timer = setInterval(() => {
					this.render();
				}, 500);
			}
		} else if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** 滚动选中 subagent 轨迹（±delta 行）；贴底时恢复跟随最新 */
	private scrollBy(delta: number): void {
		const subs = this.listSubagents();
		if (subs.length === 0) return;
		const visible = this.outputRows();
		const maxOffset = Math.max(0, this.totalLines - visible);
		this.followTail = false;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxOffset));
		if (this.scrollOffset >= maxOffset) this.followTail = true;
		this.render();
	}

	/** 翻页滚动轨迹（PgUp/PgDn） */
	private scrollPage(dir: 1 | -1): void {
		const subs = this.listSubagents();
		if (subs.length === 0) return;
		const visible = this.outputRows();
		this.scrollBy(dir * Math.max(1, visible - 1));
	}

	/** 视图内：向选中 subagent 发送消息（同步等待续跑，期间视图显示发送中） */
	private async sendToCurrent(text: string): Promise<void> {
		const subs = this.listSubagents();
		const current = subs[this.selectedIndex];
		if (!current) { this.render(); return; }
		this.busy = true;
		this.error = null;
		this.render();
		try {
			await this.sendToSubagent(current.name, text);
			// 输出已追加到会话对象的 entries（按 run 分组），重渲染显示最新输出
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.busy = false;
			this.render();
		}
	}
}
