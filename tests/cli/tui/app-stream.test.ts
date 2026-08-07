/**
 * app-stream.test.ts — Bug 1 回归测试
 *
 * 验证流式输出期间输入区固定在屏幕底部：
 *   - writeOutputLine 输出行后重绘输入区（灰底背景出现）
 *   - collapseInputArea 先清屏再输出（光标/清屏序列正确）
 *   - 连续多行输出时每行后都重绘输入区
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TuiApp } from '../../../src/cli/tui/app.js';
import type { SessionManager } from '../../../src/core/session.js';
import type { TuiConfig } from '../../../src/cli/tui/types.js';
import { GRAY_BG_START } from '../../../src/cli/tui/renderer.js';

/** 与 app.ts 中定义的 CLEAR_TO_END 一致（从光标处清除到屏幕底） */
const CLEAR_TO_END = '\x1b[0J';

/** 构造最小可用的 TuiApp（mock sessionMgr，不启动真实会话） */
function makeApp(): TuiApp {
	const sessionMgr = { getSubagentAsync: () => false } as unknown as SessionManager;
	const config: TuiConfig = {
		provider: 'test',
		model: 'test',
		baseUrl: 'http://example.com',
		apiKey: 'k',
		version: '1.3.8',
	};
	return new TuiApp(sessionMgr, config);
}

describe('Bug 1: 流式输出期间输入区固定在底部', () => {
	let writes: string[];
	const origWrite = process.stdout.write;

	beforeEach(() => {
		writes = [];
		// mock stdout：捕获所有 ANSI 输出
		process.stdout.write = ((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		process.stdout.write = origWrite;
	});

	it('writeOutputLine 在输出行后重绘输入区（灰底背景出现）', () => {
		const app = makeApp();
		(app as unknown as { writeOutputLine: (l: string) => void }).writeOutputLine('hello world');
		const out = writes.join('');
		expect(out).toContain('hello world');
		// 输出行之后重绘了输入区（灰底背景 + 输入内容区域）
		expect(out).toContain(GRAY_BG_START);
		// 重绘发生在输出行之后
		expect(out.indexOf(GRAY_BG_START)).toBeGreaterThan(out.indexOf('hello world'));
	});

	it('collapseInputArea 先清屏再输出（CLEAR_TO_END 序列）', () => {
		const app = makeApp();
		const anyApp = app as unknown as { collapseInputArea: () => void };
		// 首次：lastCursorDisplayRow=0，直接 \r + 清屏
		anyApp.collapseInputArea();
		const first = writes.join('');
		expect(first).toContain(CLEAR_TO_END);
	});

	it('连续多行输出：每行后输入区都重绘（不消失）', () => {
		const app = makeApp();
		const anyApp = app as unknown as { writeOutputLine: (l: string) => void };
		anyApp.writeOutputLine('line1');
		anyApp.writeOutputLine('line2');
		anyApp.writeOutputLine('line3');
		const out = writes.join('');
		// 三行输出都在
		expect(out).toContain('line1');
		expect(out).toContain('line2');
		expect(out).toContain('line3');
		// 输入区重绘次数 ≥ 输出行数（每行后都重绘）
		const bgCount = out.split(GRAY_BG_START).length - 1;
		expect(bgCount).toBeGreaterThanOrEqual(3);
		// 最后一行输出后仍有输入区重绘（输入框不消失）
		expect(out.lastIndexOf(GRAY_BG_START)).toBeGreaterThan(out.lastIndexOf('line3'));
	});
});
