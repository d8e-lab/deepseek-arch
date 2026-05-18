/**
 * Spinner — 终端等待动画
 *
 * 从 chat-ui.ts 剥离的独立模块。
 * 使用 braille 字符序列，80ms 间隔。
 */

/** Braille 动画帧 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 帧间隔（毫秒） */
const DEFAULT_INTERVAL = 80;

/**
 * Spinner 动画控制器
 *
 * @example
 *   const spinner = new Spinner();
 *   spinner.start((frame) => writeSync(1, frame));
 *   // ... 操作完成后
 *   spinner.stop();
 */
export class Spinner {
	private timer: ReturnType<typeof setInterval> | null = null;
	private frameIdx = 0;
	private frames = FRAMES;
	private interval = DEFAULT_INTERVAL;

	/**
	 * 启动 spinner 动画
	 *
	 * @param onTick 每帧回调，接收当前帧字符
	 */
	start(onTick: (frame: string) => void): void {
		if (this.timer) return;
		this.frameIdx = 0;
		this.timer = setInterval(() => {
			this.frameIdx = (this.frameIdx + 1) % this.frames.length;
			onTick(this.getFrame());
		}, this.interval);
	}

	/** 停止 spinner 动画 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** 获取当前帧字符 */
	getFrame(): string {
		return this.frames[this.frameIdx];
	}

	/** spinner 是否运行中 */
	isRunning(): boolean {
		return this.timer !== null;
	}
}
