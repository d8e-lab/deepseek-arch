/**
 * ConversationViewer — Ctrl+O 全屏对话浏览视图（presentation 视图组件）
 *
 * 方案 A 抽取：原为 TuiApp 内嵌的 10 字段 + 12 方法（buildViewerLines /
 * renderViewer / handleViewerInput / viewer* 搜索与滚动组），现为独立组件类：
 * 自带滚动/搜索/轮次跳转状态，通过 ViewComponent 契约接入 OverlayPane。
 *
 * 职责：把会话 turns 渲染为可滚动、可搜索、可左右跳转轮次的全屏页面。
 * 渲染复用 render SDK 的 ConversationView（每轮 + fullThink），
 * 视口行循环复用 ScreenBuffer.renderViewportLines。
 *
 * 无直接 process.* 引用：输出经注入的 ScreenBuffer，尺寸经注入的 getSize。
 */

import type { ScreenBuffer } from '../screen-buffer.js';
import type { ConversationView } from '../../render/index.js';
import type { TurnRecord } from '../../types/index.js';
import { dim, stripAnsi } from '../../render/ansi.js';
import type { ViewComponent, ViewInputResult } from './types.js';

export interface ConversationViewerOptions {
	out: ScreenBuffer;
	/** 数据源：返回当前会话 turns（组合根注入，组件不依赖 SessionManager） */
	getTurns: () => TurnRecord[];
	/** 对话渲染器（复用主会话格式；每轮 fullThink） */
	conversation: ConversationView;
	/** 终端尺寸 */
	getSize: () => { rows: number; cols: number };
}

export class ConversationViewer implements ViewComponent {
	private out: ScreenBuffer;
	private getTurns: () => TurnRecord[];
	private conversation: ConversationView;
	private getSize: () => { rows: number; cols: number };

	// ─── 视图状态（原 TuiApp viewer* 字段）──────────
	private scrollOffset = 0;
	private lines: string[] = [];
	private turnStartLines: number[] = [];
	private searchQuery = '';
	private searchMatches: number[] = [];
	private searchIndex = -1;
	private searchActive = false;
	private searchInput = '';

	constructor(opts: ConversationViewerOptions) {
		this.out = opts.out;
		this.getTurns = opts.getTurns;
		this.conversation = opts.conversation;
		this.getSize = opts.getSize;
	}

	// ─── ViewComponent ──────────────────────────────

	/** 打开视图：重建行（数据快照）→ 重置滚动 → 全屏渲染（OverlayPane.render 钩子） */
	render(): void {
		this.buildLines();
		this.scrollOffset = 0;
		this.draw();
	}

	/** 视图输入处理；返回 'close' 请求关闭（由组合根执行 OverlayPane.close） */
	handleInput(data: string): ViewInputResult {
		// 已在搜索输入模式：剩余字符全部交给搜索处理
		if (this.searchActive) {
			this.handleSearchInput(data);
			return 'handled';
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
					this.handleEscapeSeq(seq);
				} else {
					return 'close'; // 单独 ESC 退出
				}
				continue;
			}
			if (ch === 'q' || ch === 'Q') return 'close';
			if (ch === '/') {
				this.searchActive = true;
				this.searchInput = '';
				this.draw();
				// 同批到达的剩余字符（如 '/reply\r'）交给搜索输入处理
				if (i + 1 < data.length) {
					this.handleSearchInput(data.slice(i + 1));
				}
				return 'handled';
			}
			if (ch === 'n') this.jumpSearch(1);
			if (ch === 'N') this.jumpSearch(-1);
		}
		return 'handled';
	}

	/** 视图关闭清理（无定时器，空实现） */
	cleanup(): void {
		// ConversationViewer 无刷新定时器，无需清理
	}

	// ─── 内部 ──────────────────────────────────────

	/** 构建视图行（每轮复用 ConversationView 渲染 + 轮次起始行记录） */
	private buildLines(): void {
		this.lines = [];
		this.turnStartLines = [];
		const turns = this.getTurns();
		const { cols } = this.getSize();

		turns.forEach((turn, i) => {
			this.turnStartLines.push(this.lines.length);
			// 轮次标题（保留左右键跳转标记）
			this.lines.push(dim(`── 第 ${i + 1} 轮 ────────────────────────`));
			// 复用 ConversationView 渲染单轮（与主会话对话格式一致，think 完整显示）
			this.lines.push(...this.conversation.render([turn], cols, { fullThink: true }));
		});
		if (this.lines.length === 0) {
			this.lines.push(dim('(暂无对话)'));
		}
	}

	/** 渲染视图当前视口（顶部提示 + 内容窗口 + 底部状态） */
	private draw(): void {
		const { rows, cols } = this.getSize();
		const visible = Math.max(1, rows - 2);
		this.out.write('\x1b[2J\x1b[H');
		this.out.write(dim(` 对话浏览  ←→ 轮次  |  ↑↓ 滚动  |  PgUp/PgDn 翻页  |  / 搜索  |  q 退出`) + '\r\n');
		// 搜索匹配行高亮（反转色）；视口行循环统一由 ScreenBuffer 处理
		this.out.renderViewportLines(this.lines, this.scrollOffset, visible, cols, {
			transform: (line, idx) => {
				if (this.searchQuery && this.searchMatches.includes(idx)) {
					return `\x1b[7m${stripAnsi(line)}\x1b[0m`;
				}
				return line;
			},
		});
		// 底部状态行
		this.out.write('\r\n\x1b[2K');
		const total = this.lines.length;
		const pct = total > 0 ? Math.round(((this.scrollOffset + visible) / total) * 100) : 0;
		let status = dim(` ${Math.min(this.scrollOffset + 1, total)}/${total} 行 (${pct}%)`);
		if (this.searchQuery) {
			const matchInfo = this.searchMatches.length > 0
				? ` 匹配 ${this.searchIndex + 1}/${this.searchMatches.length}: "${this.searchQuery}" (n/N 下一个)`
				: `  无匹配: "${this.searchQuery}"`;
			status += dim(matchInfo);
		} else if (this.searchActive) {
			status += dim(`  搜索: ${this.searchInput}▌`);
		}
		this.out.write(status);
	}

	/** ESC 序列处理 */
	private handleEscapeSeq(seq: string): void {
		if (seq === 'A') this.scroll(-1);
		else if (seq === 'B') this.scroll(1);
		else if (seq === 'C') this.jumpTurn(1);
		else if (seq === 'D') this.jumpTurn(-1);
		else if (seq === '5~') this.pageScroll(-1);
		else if (seq === '6~') this.pageScroll(1);
	}

	/** 视图搜索输入模式（逐字符） */
	private handleSearchInput(data: string): void {
		for (let i = 0; i < data.length; i++) {
			const ch = data[i];
			if (ch === '\x0d') {
				// Enter 执行搜索
				if (this.searchInput) this.doSearch(this.searchInput);
				this.searchActive = false;
				this.draw();
				continue;
			}
			if (ch === '\x1b') {
				// Esc 取消搜索
				this.searchInput = '';
				this.searchActive = false;
				this.draw();
				return;
			}
			if (ch === '\x7f' || ch === '\x08') {
				this.searchInput = this.searchInput.slice(0, -1);
				this.draw();
				continue;
			}
			// 普通字符追加（忽略控制字符）
			if (ch >= ' ') {
				this.searchInput += ch;
				this.draw();
			}
		}
	}

	/** 执行搜索：在视图行（纯文本）中查找匹配行 */
	private doSearch(query: string): void {
		this.searchQuery = query;
		this.searchMatches = [];
		this.lines.forEach((line, i) => {
			if (stripAnsi(line).toLowerCase().includes(query.toLowerCase())) {
				this.searchMatches.push(i);
			}
		});
		this.searchIndex = -1;
		this.jumpSearch(1);
	}

	/** 跳转到下一个/上一个搜索匹配（循环） */
	private jumpSearch(dir: 1 | -1): void {
		if (this.searchMatches.length === 0) return;
		this.searchIndex = (this.searchIndex + dir + this.searchMatches.length) % this.searchMatches.length;
		const target = this.searchMatches[this.searchIndex];
		this.scrollTo(target);
	}

	/** 滚动视口到指定行 */
	private scrollTo(line: number): void {
		const { rows } = this.getSize();
		const visible = Math.max(1, rows - 2);
		this.scrollOffset = Math.max(0, Math.min(line, this.lines.length - 1));
		// 若目标行不在视口内，滚动到目标行
		if (line < this.scrollOffset || line >= this.scrollOffset + visible) {
			this.scrollOffset = Math.max(0, line);
		}
		this.draw();
	}

	/** 逐行滚动 */
	private scroll(dir: 1 | -1): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + dir, this.lines.length - 1));
		this.draw();
	}

	/** 翻页 */
	private pageScroll(dir: 1 | -1): void {
		const { rows } = this.getSize();
		const visible = Math.max(1, rows - 2);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + dir * (visible - 1), this.lines.length - 1));
		this.draw();
	}

	/** 左右键切换轮次（跳转到该轮顶部） */
	private jumpTurn(dir: 1 | -1): void {
		if (this.turnStartLines.length === 0) return;
		// 找到当前所在轮索引
		let cur = this.turnStartLines.length - 1;
		for (let i = 0; i < this.turnStartLines.length; i++) {
			if (this.scrollOffset < this.turnStartLines[i]) { cur = i - 1; break; }
		}
		const target = Math.max(0, Math.min(cur + dir, this.turnStartLines.length - 1));
		this.scrollTo(this.turnStartLines[target]);
	}
}
