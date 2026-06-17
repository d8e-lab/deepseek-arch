/**
 * Markdown 轻量渲染 — 表格
 *
 * 将流式文本中的 markdown 表格转换为终端 box-drawing 格式。
 * 使用行缓冲状态机：收到完整行后判断是否为表格块，是则暂存，
 * 表格块结束时一次性渲染为 box-drawing 行。
 */

import { strDisplayWidth, padToWidth } from './renderer.js';

const TABLE_ROW_RE = /^\s*\|(.+\|)+\s*$/;
const TABLE_SEP_RE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

/** 表格渲染状态 */
enum TableState {
	/** 不在表格中 */
	OUTSIDE = 'OUTSIDE',
	/** 检测到首行（可能是表头） */
	MAYBE_HEADER = 'MAYBE_HEADER',
	/** 已确认进入表格（header + separator 已就），正在收集正文行 */
	INSIDE = 'INSIDE',
}

/**
 * Markdown 表格流式渲染器
 *
 * 用法：
 *   const renderer = new MarkdownTableRenderer();
 *   for (const chunk of stream) {
 *     for (const line of renderer.feed(chunk)) {
 *       process.stdout.write(line + '\r\n');
 *     }
 *   }
 *   for (const line of renderer.flush()) {
 *     process.stdout.write(line + '\r\n');
 *   }
 */
export class MarkdownTableRenderer {
	private buf = '';
	private state: TableState = TableState.OUTSIDE;
	private headerRow: string | null = null;
	private rows: string[] = [];

	/**
	 * 喂入文本块，返回可以立即输出的行。
	 * 表格块内的行会被暂存，直到表格结束才一次渲染。
	 */
	feed(text: string): string[] {
		this.buf += text;
		return this.processLines();
	}

	/** 刷出剩余内容（流结束后调用） */
	flush(): string[] {
		const lines = this.processLines();
		// 如果还在表格内（未关闭），强制渲染
		if (this.state === TableState.INSIDE || this.state === TableState.MAYBE_HEADER) {
			const rendered = this.flushTable();
			if (rendered) lines.push(...rendered);
		}
		// 输出剩余 buffer（非表格纯文本）
		if (this.buf) {
			lines.push(this.buf);
			this.buf = '';
		}
		return lines;
	}

	// ─── 内部 ──────────────────────────────────────

	private processLines(): string[] {
		const output: string[] = [];
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const idx = this.buf.indexOf('\n');
			if (idx === -1) break;

			const line = this.buf.slice(0, idx);
			this.buf = this.buf.slice(idx + 1);

			const emitted = this.handleLine(line);
			if (emitted !== null) output.push(...emitted);
		}
		return output;
	}

	/**
	 * 处理一行完整文本。返回 null 表示暂存，返回 string[] 表示应立即输出的行。
	 */
	private handleLine(line: string): string[] | null {
		const isRow = TABLE_ROW_RE.test(line);
		const isSep = TABLE_SEP_RE.test(line);
		const isEmpty = line.trim() === '';

		if (this.state === TableState.OUTSIDE) {
			if (isRow) {
				this.headerRow = line;
				this.state = TableState.MAYBE_HEADER;
				return null;
			}
			return [line];
		}

		if (this.state === TableState.MAYBE_HEADER) {
			if (isSep) {
				this.rows = [this.headerRow!];
				this.state = TableState.INSIDE;
				return null;
			}
			const flushed = this.headerRow!;
			this.headerRow = null;
			this.state = TableState.OUTSIDE;
			return [flushed, line];
		}

		if (this.state === TableState.INSIDE) {
			if (isRow) {
				this.rows.push(line);
				return null;
			}
			const rendered = this.flushTable() ?? [];
			this.state = TableState.OUTSIDE;
			if (rendered.length > 0) {
				rendered.push(line);
				return rendered;
			}
			return [line];
		}

		return [line];
	}

	/** 将暂存的表格行渲染为 box-drawing 格式。返回行数组，失败返回 null。 */
	private flushTable(): string[] | null {
		if (this.rows.length === 0) {
			this.headerRow = null;
			return null;
		}

		const parsed = this.rows.map(parseRow);
		// 过滤掉完全解析失败的行
		const valid = parsed.filter((cells): cells is string[] => cells !== null);
		if (valid.length === 0) {
			this.rows = [];
			this.headerRow = null;
			return null;
		}

		const colCount = valid[0].length;
		// 确保所有行列数一致（补齐或截断）
		const aligned = valid.map((cells) => {
			if (cells.length < colCount) {
				return cells.concat(Array(colCount - cells.length).fill(''));
			}
			return cells.slice(0, colCount);
		});

		// 计算列宽（基于显示宽度）
		const colWidths: number[] = Array(colCount).fill(3); // 最小 3
		for (const row of aligned) {
			for (let c = 0; c < colCount; c++) {
				const w = strDisplayWidth(row[c]);
				if (w > colWidths[c]) colWidths[c] = w;
			}
		}

		const result: string[] = [];
		const header = aligned[0];
		const data = aligned.slice(1);

		result.push(drawTopBorder(colWidths));
		result.push(drawRow(header, colWidths));
		if (data.length > 0) {
			result.push(drawSeparator(colWidths));
			for (const row of data) {
				result.push(drawRow(row, colWidths));
			}
		}
		result.push(drawBottomBorder(colWidths));

		this.rows = [];
		this.headerRow = null;
		return result;
	}
}

// ─── 表格解析与渲染 ───────────────────────────────

/** 解析一行 `| a | b | c |`，返回去除首尾空格的 cell 数组 */
function parseRow(line: string): string[] | null {
	const trimmed = line.trim();
	// 去除首尾的 |
	if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
	const inner = trimmed.slice(1, -1);
	return inner.split('|').map((c) => c.trim());
}

/** 绘制表格顶边框：┌──┬──┐ */
function drawTopBorder(widths: number[]): string {
	return '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
}

/** 绘制分隔行：├──┼──┤ */
function drawSeparator(widths: number[]): string {
	return '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
}

/** 绘制底边框：└──┴──┘ */
function drawBottomBorder(widths: number[]): string {
	return '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
}

/** 绘制数据行：│ a  │ bb │ */
function drawRow(cells: string[], widths: number[]): string {
	return '│ ' + cells.map((c, i) => padToWidth(c, widths[i])).join(' │ ') + ' │';
}
