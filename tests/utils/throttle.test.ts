/**
 * Throttle 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Throttle } from '../../src/utils/throttle.js';

describe('Throttle', () => {
	let throttle: Throttle;

	beforeEach(() => {
		vi.useFakeTimers();
		throttle = new Throttle(60); // 16ms interval
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('首次调用 run() 应该执行回调', () => {
		const fn = vi.fn();
		const executed = throttle.run(fn);
		expect(executed).toBe(true);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('间隔时间内第二次调用 run() 应该被跳过', () => {
		const fn = vi.fn();
		throttle.run(fn);
		expect(fn).toHaveBeenCalledTimes(1);

		// 仅过了 8ms，未满 16ms 间隔
		vi.advanceTimersByTime(8);
		const executed = throttle.run(fn);
		expect(executed).toBe(false);
		expect(fn).toHaveBeenCalledTimes(1); // 未被再次调用
	});

	it('超过间隔时间后 run() 应该再次执行', () => {
		const fn = vi.fn();
		throttle.run(fn);
		expect(fn).toHaveBeenCalledTimes(1);

		// 过了 16ms
		vi.advanceTimersByTime(16);
		const executed = throttle.run(fn);
		expect(executed).toBe(true);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('长时间后 run() 应该执行', () => {
		const fn = vi.fn();
		throttle.run(fn);
		vi.advanceTimersByTime(100); // 远远超过间隔
		const executed = throttle.run(fn);
		expect(executed).toBe(true);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('reset() 后 run() 应该立即执行', () => {
		const fn = vi.fn();
		throttle.run(fn);
		expect(fn).toHaveBeenCalledTimes(1);

		// 未满间隔
		vi.advanceTimersByTime(5);
		throttle.run(fn);
		expect(fn).toHaveBeenCalledTimes(1); // 被跳过

		// reset
		throttle.reset();
		const executed = throttle.run(fn);
		expect(executed).toBe(true);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('默认 60fps 间隔为 16ms', () => {
		const t = new Throttle(); // 默认 60
		const fn = vi.fn();
		t.run(fn);
		vi.advanceTimersByTime(15);
		expect(t.run(fn)).toBe(false);
		vi.advanceTimersByTime(1); // 总共 16ms
		expect(t.run(fn)).toBe(true);
	});

	it('自定义 fps 计算正确', () => {
		const t30 = new Throttle(30); // ~33ms
		const fn = vi.fn();
		t30.run(fn);
		vi.advanceTimersByTime(32);
		expect(t30.run(fn)).toBe(false);
		vi.advanceTimersByTime(1); // 总共 33ms
		expect(t30.run(fn)).toBe(true);
	});

	it('不同 fps 互不影响', () => {
		const t1 = new Throttle(60);
		const t2 = new Throttle(10); // 100ms
		const fn1 = vi.fn();
		const fn2 = vi.fn();

		t1.run(fn1);
		t2.run(fn2);
		expect(fn1).toHaveBeenCalledTimes(1);
		expect(fn2).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(20);
		expect(t1.run(fn1)).toBe(true);  // 过了 16ms
		expect(t2.run(fn2)).toBe(false); // 未满 100ms

		vi.advanceTimersByTime(80);
		expect(t2.run(fn2)).toBe(true);  // 过了 100ms
	});
});
