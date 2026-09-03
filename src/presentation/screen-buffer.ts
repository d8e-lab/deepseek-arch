/**
 * ScreenBuffer — 屏幕输出缓冲
 *
 * 所有终端输出唯一通道。默认写 process.stdout，测试时可注入 fake io。
 * 注意：io 必须用箭头函数延迟绑定 process.stdout.write，
 * 保证现有测试「mock process.stdout.write」的方式仍然有效。
 */
export interface ScreenIO {
	write(s: string): void;
}

/** 视口渲染选项 */
export interface ViewportRenderOptions {
	/**
	 * 行变换（如搜索匹配高亮）。
	 * 返回处理后的行；transform 在裁剪到 cols-1 前调用。
	 */
	transform?: (line: string, index: number) => string;
}

export class ScreenBuffer {
	private io: ScreenIO;
	constructor(io?: ScreenIO) {
		this.io = io ?? {
			// 箭头函数延迟绑定：每次调用时动态读 process.stdout.write（测试可 mock）
			write: (s: string) => process.stdout.write(s),
		};
	}
	write(s: string): void {
		this.io.write(s);
	}

	/**
	 * 全屏视图内容窗口渲染循环：
	 * 从 start 行开始渲染 visible 行——每行先清行（\r\x1b[2K）再写内容
	 * （按显示宽度裁剪到 cols-1，避免 auto-wrap），行间以 \r\n 分隔。
	 *
	 * 公共循环此前在 Ctrl+O viewer 与 Ctrl+T subagents 视图中重复实现 2 份，
	 * 收口至此。调用方负责：顶部清屏/标题、底部状态行、结尾换行。
	 *
	 * @param lines   待渲染行数组（可能短于 visible，空行留白）
	 * @param start   视口起始行索引
	 * @param visible 视口可见行数
	 * @param cols    终端列数（内容裁剪到 cols-1）
	 * @param opts    可选行变换
	 */
	renderViewportLines(
		lines: string[],
		start: number,
		visible: number,
		cols: number,
		opts?: ViewportRenderOptions,
	): void {
		for (let r = 0; r < visible; r++) {
			const idx = start + r;
			this.io.write('\r\x1b[2K');
			if (idx < lines.length) {
				let line = lines[idx];
				if (opts?.transform) line = opts.transform(line, idx);
				this.io.write(line.slice(0, cols - 1));
			}
			if (r < visible - 1) this.io.write('\r\n');
		}
	}
}
