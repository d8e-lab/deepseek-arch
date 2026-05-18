/**
 * Throttle — 帧率节流工具
 *
 * 确保回调函数在指定时间间隔内最多执行一次。
 * 用于流式渲染场景，防止过高频率的终端重绘消耗 CPU。
 */

export class Throttle {
	private lastTime = 0;
	private readonly intervalMs: number;

	/**
	 * @param fps  目标帧率（frames per second），默认 60
	 */
	constructor(fps = 60) {
		this.intervalMs = Math.floor(1000 / fps);
	}

	/**
	 * 如果距离上一次执行已超过间隔时间，则执行回调。
	 *
	 * @returns true 表示本次执行了回调，false 表示被跳过
	 */
	run(fn: () => void): boolean {
		const now = Date.now();
		if (now - this.lastTime >= this.intervalMs) {
			this.lastTime = now;
			fn();
			return true;
		}
		return false;
	}

	/** 重置节流计时器，下一次 run() 必定执行 */
	reset(): void {
		this.lastTime = 0;
	}
}
