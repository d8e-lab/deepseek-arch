/**
 * render/csi 单元测试
 *
 * 描述：parseCsiSequence 解析方向键/PgUp/Home/粘贴标记；非 CSI 返回 null。
 */
import { describe, it, expect } from 'vitest';
import { parseCsiSequence } from '../../src/render/csi.js';

describe('parseCsiSequence', () => {
	it('非 ESC 开头返回 null', () => {
		expect(parseCsiSequence('abc', 0)).toBeNull();
	});

	it('独立 ESC（后非 [）返回 null', () => {
		expect(parseCsiSequence('\x1b', 0)).toBeNull();
		expect(parseCsiSequence('\x1bX', 0)).toBeNull();
	});

	it('方向键 ↑：\x1b[A → seq A', () => {
		const r = parseCsiSequence('\x1b[A', 0);
		expect(r).toEqual({ seq: 'A', next: 3 });
	});

	it('多键同批：从中间位置解析', () => {
		const data = 'ab\x1b[Ccd';
		const r = parseCsiSequence(data, 2);
		expect(r).toEqual({ seq: 'C', next: 5 });
	});

	it('PgUp：\x1b[5~ → seq 5~', () => {
		const r = parseCsiSequence('\x1b[5~', 0);
		expect(r).toEqual({ seq: '5~', next: 4 });
	});

	it('粘贴开始标记：\x1b[200~ → seq 200~', () => {
		const r = parseCsiSequence('\x1b[200~hello', 0);
		expect(r).toEqual({ seq: '200~', next: 6 });
	});

	it('中间参数保留（如 1;5A = Ctrl+↑）', () => {
		const r = parseCsiSequence('\x1b[1;5A', 0);
		expect(r).toEqual({ seq: '1;5A', next: 6 });
	});
});
