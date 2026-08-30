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
}
