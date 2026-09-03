/**
 * CommandResultPane — 命令结果窗格（presentation 子窗格组件）
 *
 * 方案 A 抽取：原为 BottomArea 内嵌的 cmdLines 数据与折行渲染逻辑，
 * 现为独立组件：持有命令结果行，负责"测量 + 渲染到输出通道"。
 *
 * 职责：完整保留 / 命令输出（不截断），每行按可用宽度折行（ANSI-aware）
 * 并以 '│ ' 前缀渲染在输入区下方；物理行数返回给容器做光标定位记账。
 *
 * 输出经注入的 ScreenBuffer（不再直写 process.stdout/clearLine）。
 */

import type { ScreenBuffer } from '../screen-buffer.js';
import { dim } from '../../render/ansi.js';
import { wrapText } from '../../render/conversation.js';

export class CommandResultPane {
	/** 命令结果区内容（完整保留，不截断） */
	private lines: string[] = [];

	/** 追加一行命令输出 */
	push(line: string): void {
		this.lines.push(line);
	}

	/** 清空命令结果 */
	clear(): void {
		this.lines = [];
	}

	/** 当前命令结果原始行数 */
	getLineCount(): number {
		return this.lines.length;
	}

	/**
	 * 渲染命令结果区到输出通道（调用方保证光标位于输入区下方起始处）。
	 * @param out        输出通道
	 * @param availWidth 可用显示宽度（'│ ' 前缀占 2 列）
	 * @returns 绘制的物理行数（供容器光标定位记账）
	 */
	render(out: ScreenBuffer, availWidth: number): number {
		let physicalRows = 0;
		for (const line of this.lines) {
			const wrapped = wrapText(line, Math.max(1, availWidth - 2)); // '│ ' 前缀占 2 列
			for (const wl of wrapped) {
				out.write('\r\n');
				out.write('\x1b[2K');
				out.write(dim('│ ') + wl);
				physicalRows++;
			}
		}
		return physicalRows;
	}
}
