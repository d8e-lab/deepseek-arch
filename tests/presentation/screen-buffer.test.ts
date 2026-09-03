/**
 * ScreenBuffer.renderViewportLines 单元测试
 *
 * 描述：视口行渲染循环——清行、内容裁剪到 cols-1、行间换行、transform 钩子、空行留白。
 */
import { describe, it, expect } from 'vitest';
import { ScreenBuffer } from '../../src/presentation/screen-buffer.js';

function makeBuffer(): { buf: ScreenBuffer; writes: string[] } {
	const writes: string[] = [];
	const buf = new ScreenBuffer({ write: (s: string) => writes.push(s) });
	return { buf, writes };
}

describe('ScreenBuffer.renderViewportLines', () => {
	it('渲染可见行：每行先清行（\\r ESC[2K）再写内容，行间 \\r\\n', () => {
		const { buf, writes } = makeBuffer();
		buf.renderViewportLines(['aaa', 'bbb', 'ccc'], 0, 3, 20);
		expect(writes.join('')).toBe('\r\x1b[2Kaaa\r\n\r\x1b[2Kbbb\r\n\r\x1b[2Kccc');
	});

	it('内容裁剪到 cols-1（避免 auto-wrap）', () => {
		const { buf, writes } = makeBuffer();
		buf.renderViewportLines(['a'.repeat(50)], 0, 1, 10);
		expect(writes.join('')).toBe('\r\x1b[2K' + 'a'.repeat(9));
	});

	it('行数不足视口：空行留白（清行后不写内容）', () => {
		const { buf, writes } = makeBuffer();
		buf.renderViewportLines(['only'], 0, 3, 20);
		expect(writes.join('')).toBe('\r\x1b[2Konly\r\n\r\x1b[2K\r\n\r\x1b[2K');
	});

	it('从指定 offset 开始渲染', () => {
		const { buf, writes } = makeBuffer();
		buf.renderViewportLines(['a', 'b', 'c', 'd'], 2, 2, 20);
		expect(writes.join('')).toBe('\r\x1b[2Kc\r\n\r\x1b[2Kd');
	});

	it('transform 钩子在裁剪前生效', () => {
		const { buf, writes } = makeBuffer();
		buf.renderViewportLines(['abc'], 0, 1, 20, {
			transform: (line) => line.toUpperCase(),
		});
		expect(writes.join('')).toBe('\r\x1b[2KABC');
	});

	it('visible=0 不输出', () => {
		const { buf, writes } = makeBuffer();
		buf.renderViewportLines(['a'], 0, 0, 20);
		expect(writes.join('')).toBe('');
	});
});
