/**
 * Selector — 通用交互式选择器
 *
 * 职责：
 *   1. 在输入框下方内联显示可选项列表
 *   2. 支持 ↑↓ 键移动光标，Enter 确认选中
 *   3. 可被 /model 等命令复用
 *
 * 使用方式：
 *   const sel = new Selector(
 *     [{ label: 'Option A', value: 'a' }, { label: 'Option B', value: 'b' }],
 *     'Choose:',
 *   );
 *   const result = await sel.select(
 *     () => this.stdinHandler,
 *     (h) => { this.stdinHandler = h; },
 *   );
 */

import { getTermSize, dim, cyan, clearLine, padToWidth } from './renderer.js';

/** 选择器选项 */
export interface SelectOption<T> {
	label: string;
	value: T;
}

export class Selector<T> {
	private items: SelectOption<T>[];
	private prompt: string;
	private selectedIndex: number = 0;
	/** 总显示行数（prompt + 所有选项） */
	private totalLines: number;
	/** 渲染次数（0 = 尚未渲染过），用于区分首次绘制与重绘 */
	private renderCount: number = 0;

	constructor(items: SelectOption<T>[], prompt?: string) {
		if (items.length === 0) {
			throw new Error('Selector requires at least one item');
		}
		this.items = items;
		this.prompt = prompt ?? 'Select an option:';
		this.totalLines = 1 + items.length;
	}

	/** 重置内部状态（select() 入 口） */
	private reset(): void {
		this.selectedIndex = 0;
		this.renderCount = 0;
	}

	/**
	 * 启动交互式选择
	 *
	 * @param getHandler  获取当前 stdinHandler 的函数
	 * @param setHandler  设置 stdinHandler 的函数
	 * @returns 选中的 value，若取消（Ctrl+C）则返回 null
	 */
	select(
		getHandler: () => ((data: string) => void) | null,
		setHandler: (handler: ((data: string) => void) | null) => void,
	): Promise<T | null> {
		this.reset();
		this.render();

		return new Promise<T | null>((resolve) => {
			const prevHandler = getHandler();

			const handler = (data: string) => {
				for (let i = 0; i < data.length; i++) {
					const ch = data[i];

					// ESC 序列（方向键）
					if (ch === '\x1b') {
						i++;
						if (i >= data.length) return;
						if (data[i] === '[') {
							i++;
							let seq = '';
							while (i < data.length) {
								const sc = data.charCodeAt(i);
								if (sc >= 0x40 && sc <= 0x7e) {
									seq += data[i];
									i++;
									break;
								}
								seq += data[i];
								i++;
							}
							i--; // for 循环会 +1

							if (seq === 'A') {
								// ↑ 上移
								if (this.selectedIndex > 0) {
									this.selectedIndex--;
									this.render();
								}
							} else if (seq === 'B') {
								// ↓ 下移
								if (this.selectedIndex < this.items.length - 1) {
									this.selectedIndex++;
									this.render();
								}
							}
						}
						continue;
					}

					if (ch === '\x0d') {
						// Enter — 确认选择
						this.clearDisplay();
						setHandler(prevHandler);
						resolve(this.items[this.selectedIndex].value);
						return;
					}

					if (ch === '\x03') {
						// Ctrl+C — 取消
						this.clearDisplay();
						setHandler(prevHandler);
						resolve(null);
						return;
					}

					// 数字快捷键：1~9 直接选中对应项
					const num = parseInt(ch, 10);
					if (num >= 1 && num <= this.items.length) {
						this.selectedIndex = num - 1;
						this.clearDisplay();
						setHandler(prevHandler);
						resolve(this.items[this.selectedIndex].value);
						return;
					}
				}
			};

			setHandler(handler);
		});
	}

	// ─── 渲染 ──────────────────────────────────────

	/** 绘制/重绘所有行 */
	private render(): void {
		const cols = getTermSize().cols;
		// cols-1 留 1 列避免 auto-wrap
		const availWidth = Math.max(1, cols - 1);

		// 首次渲染不用上移光标（从当前位置开始画）
		// 重绘时：光标在最后一行（选项末），上移 totalLines-1 回到 prompt 行
		if (this.renderCount > 0) {
			process.stdout.write(`\x1b[${this.totalLines - 1}A`);
		}
		this.renderCount++;

		// 第 0 行：提示文字
		process.stdout.write('\r');
		clearLine();
		process.stdout.write(dim(this.prompt) + '\r\n');

		// 第 1..N 行：选项
		for (let i = 0; i < this.items.length; i++) {
			process.stdout.write('\r');
			clearLine();
			const cursor = i === this.selectedIndex ? '▸ ' : '  ';
			const text = `${cursor}${i + 1}) ${this.items[i].label}`;
			const padded = padToWidth(text, availWidth);
			process.stdout.write(i === this.selectedIndex ? cyan(padded) : dim(padded));
			if (i < this.items.length - 1) {
				process.stdout.write('\r\n');
			}
		}
	}

	/** 清除所有显示行，将光标留到起始行 */
	private clearDisplay(): void {
		if (this.totalLines <= 0) return;
		// 光标在最后一行（选项末），上移 totalLines-1 回到 prompt 行
		process.stdout.write(`\x1b[${this.totalLines - 1}A`);
		// 从光标处清到屏幕末尾
		process.stdout.write('\r');
		process.stdout.write('\x1b[0J');
	}
}
