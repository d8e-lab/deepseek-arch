/**
 * render/scroll 单元测试
 *
 * 描述：ScrollState 滚动 clamp、followTail 吸附、逐行/翻页/跳转。
 */
import { describe, it, expect } from 'vitest';
import { ScrollState } from '../../src/render/scroll.js';

function makeScroll(total: number, visible: number): ScrollState {
	return new ScrollState({
		getTotal: () => total,
		getVisible: () => visible,
	});
}

describe('ScrollState', () => {
	it('初始状态：offset 0 + followTail true', () => {
		const s = makeScroll(100, 10);
		expect(s.offset).toBe(0);
		expect(s.followTail).toBe(true);
	});

	it('maxOffset = total - visible（不小于 0）', () => {
		expect(makeScroll(100, 10).maxOffset).toBe(90);
		expect(makeScroll(5, 10).maxOffset).toBe(0);
	});

	it('reconcile 强制贴底', () => {
		const s = makeScroll(100, 10);
		s.by(-1); // 无效（已在顶）
		s.by(1); // offset 1
		s.reconcile(true);
		expect(s.offset).toBe(90);
		expect(s.followTail).toBe(true);
	});

	it('reconcile 保持用户滚动位置（仅 clamp）', () => {
		const s = makeScroll(100, 10);
		s.by(1);
		s.by(1);
		s.reconcile(false);
		expect(s.offset).toBe(2);
		expect(s.followTail).toBe(false);
	});

	it('reconcile 在贴底后自动 followTail', () => {
		const s = makeScroll(100, 10);
		s.by(1);
		s.to(100); // clamp 到 90
		expect(s.offset).toBe(90);
		expect(s.followTail).toBe(true);
		s.reconcile(false);
		expect(s.offset).toBe(90);
	});

	it('by：逐行滚动并停在边界', () => {
		const s = makeScroll(100, 10);
		s.by(-1); // 顶部不能上移
		expect(s.offset).toBe(0);
		s.by(1);
		expect(s.offset).toBe(1);
		s.by(-1);
		expect(s.offset).toBe(0);
		expect(s.followTail).toBe(false); // 上移脱离末尾
	});

	it('by 在末尾时不再下移', () => {
		const s = makeScroll(100, 10);
		s.to(90);
		const moved = s.by(1);
		expect(moved).toBe(false);
		expect(s.offset).toBe(90);
	});

	it('page：按 visible-1 翻页并 clamp', () => {
		const s = makeScroll(100, 10);
		s.page(1);
		expect(s.offset).toBe(9); // visible-1 = 9
		s.page(1);
		expect(s.offset).toBe(18);
		s.page(-1);
		expect(s.offset).toBe(9);
	});

	it('page 超界 clamp 到 maxOffset', () => {
		const s = makeScroll(100, 10);
		s.page(1); // 9
		s.page(1); // 18
		s.page(1); // 27
		s.page(1); // 36
		s.page(1); // 45
		s.page(1); // 54
		s.page(1); // 63
		s.page(1); // 72
		s.page(1); // 81
		s.page(1); // 90
		s.page(1); // clamp 90
		expect(s.offset).toBe(90);
	});

	it('to：clamp 负数与超界', () => {
		const s = makeScroll(100, 10);
		expect(s.to(-5)).toBe(true);
		expect(s.offset).toBe(0);
		expect(s.to(1000)).toBe(true);
		expect(s.offset).toBe(90);
	});
});
