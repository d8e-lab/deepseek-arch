/**
 * app-stream.test.ts — Bug 1/2/3 回归测试
 *
 * 验证流式输出期间输入区固定在屏幕底部且可交互：
 *   - writeOutputLine 输出行后重绘输入区（灰底背景出现）
 *   - collapseInputArea 先清屏再输出（光标/清屏序列正确）
 *   - 连续多行输出时每行后都重绘输入区
 *   - think（reasoning）期间输入区也可见（逐行输出）
 *   - 发送消息后输入框清空（不显示上一轮内容）
 *   - 双工交互：输出期间可编辑输入框、Enter 排队新消息
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TuiApp } from '../../../src/cli/tui/app.js';
import type { SessionManager } from '../../../src/core/session.js';
import type { StreamEvent } from '../../../src/types/index.js';
import type { TuiConfig } from '../../../src/cli/tui/types.js';
import { GRAY_BG_START } from '../../../src/cli/tui/renderer.js';

/** 与 app.ts 中定义的 CLEAR_TO_END 一致（从光标处清除到屏幕底） */
const CLEAR_TO_END = '\x1b[0J';

/** 构造最小可用的 TuiApp（mock sessionMgr，不启动真实会话） */
function makeApp(sessionMgr?: Partial<SessionManager>): TuiApp {
	const mgr = {
		getSubagentAsync: () => false,
		...sessionMgr,
	} as unknown as SessionManager;
	const config: TuiConfig = {
		provider: 'test',
		model: 'test',
		baseUrl: 'http://example.com',
		apiKey: 'k',
		version: '1.3.8',
	};
	return new TuiApp(mgr, config);
}

/** mock 输出事件序列的 sessionMgr */
function mockStreamSession(events: StreamEvent[]): Partial<SessionManager> {
	return {
		sendMessageStream: vi.fn(async (_content: string, onEvent: (e: StreamEvent) => void) => {
			for (const e of events) onEvent(e);
			return null;
		}) as unknown as SessionManager['sendMessageStream'],
	};
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

	it('think（reasoning）期间输入区也可见：逐行输出后重绘', async () => {
		const app = makeApp(mockStreamSession([
			{ type: 'reasoning_delta', text: '第一行思考\n' },
			{ type: 'reasoning_delta', text: '第二行思考' }, // 半行，暂留 pending
			{ type: 'content_delta', text: '回复内容\n' },   // 触发 flush(true) 输出剩余半行
			{ type: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
		]));
		await (app as unknown as { sendMessageStream: (c: string) => Promise<void> }).sendMessageStream('test');
		const out = writes.join('');
		// 两行思考都输出了
		expect(out).toContain('第一行思考');
		expect(out).toContain('第二行思考');
		// think 行之后有输入区重绘（≥2 次：两行思考各一次，不含开头空输入框那次）
		const bgCount = out.split(GRAY_BG_START).length - 1;
		expect(bgCount).toBeGreaterThanOrEqual(2);
		// 第一行思考之后有输入区重绘（think 期间输入框不消失）
		const firstLineIdx = out.indexOf('第一行思考');
		const bgAfterFirst = out.indexOf(GRAY_BG_START, firstLineIdx);
		expect(bgAfterFirst).toBeGreaterThan(firstLineIdx);
		// 第二行思考在第一行重绘之后（输入框持续可见）
		expect(out.indexOf('第二行思考')).toBeGreaterThan(bgAfterFirst);
	});

	it('发送消息后输入框清空（不显示上一轮内容）', async () => {
		const app = makeApp(mockStreamSession([
			{ type: 'content_delta', text: '回复\n' },
			{ type: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
		]));
		// 模拟用户先输入了一些内容
		const anyApp = app as unknown as { input: { insertChar: (c: string) => void } };
		anyApp.input.insertChar('旧输入内容');
		await (app as unknown as { sendMessageStream: (c: string) => Promise<void> }).sendMessageStream('旧输入内容');
		// 发送后输入框已清空（InputEditor 空状态）
		const input = anyApp.input as unknown as { getDisplayLines: () => string[] };
		expect(input.getDisplayLines().join('').trim()).toBe('');
	});

	it('双工交互：输出期间 Enter 排队新消息，当前输出中断后发送', async () => {
		let callCount = 0;
		const sendSpy = vi.fn(async (_content: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal) => {
			callCount++;
			if (callCount === 1) {
				// 第一轮：输出一半，等待 abort
				onEvent({ type: 'content_delta', text: '第一轮输出' });
				await new Promise<void>((resolve) => {
					if (signal?.aborted) return resolve();
					signal?.addEventListener('abort', () => resolve(), { once: true });
					setTimeout(resolve, 200);
				});
				if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
			} else {
				// 第二轮：正常完成
				onEvent({ type: 'content_delta', text: '第二轮输出' });
				onEvent({ type: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			}
			return null;
		}) as unknown as SessionManager['sendMessageStream'];

		const app = makeApp({ sendMessageStream: sendSpy });
		const anyApp = app as unknown as {
			sendMessageStream: (c: string) => Promise<void>;
			stdinHandler: ((data: string) => void) | null;
		};

		// 启动第一轮输出（不 await）
		const first = anyApp.sendMessageStream('第一条');
		// 模拟用户在输出期间通过 stdinHandler 输入并 Enter（双工 handler 包装了排队逻辑）
		await new Promise((r) => setTimeout(r, 10)); // 等 stdinHandler 被设置为双工 handler
		anyApp.stdinHandler?.('第二条');
		anyApp.stdinHandler?.('\x0d'); // Enter 提交
		await first;

		// 第二轮被发送（nextMessage 排队生效）
		expect(sendSpy).toHaveBeenCalledTimes(2);
		expect(sendSpy.mock.calls[1][0]).toBe('第二条');
		const out = writes.join('');
		expect(out).toContain('第二轮输出');
	});
});
