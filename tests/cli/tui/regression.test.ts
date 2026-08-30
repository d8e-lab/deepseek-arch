/**
 * regression.test.ts — 输入区位置/行数定位历史 bug 回归测试
 *
 * 覆盖 refactor/orthogonal-tui 分支 8 个已修复的 bug（黑盒行为断言：
 * 只断言「屏幕输出序列」的最终结果，不依赖内部实现细节）：
 *
 *   572bb26 命令结果区超宽行触发终端 wrap 破坏行数定位 — 输入区逐次下移/残留
 *   930ce77 输出结束后命令结果区消失 — inputCycle 重建用 renderInput 画完整底部
 *   af2693e 命令执行后输入区残留命令文本 — 命令路径 return 前清空输入区
 *   03dec44 双工中断 + 视图关闭 fire-and-forget 竞态 — 流式期间键盘失效与双流并发
 *   0838994 键入字符时输入框逐字符上移 — 上移基准改为 lastCmdRows + lastCursorDisplayRow
 *   f827d93 键入命令时输入框上移、对话内容逐行消失 — 移除冗余建议列表残留清除
 *   6f537df 命令结果区导致模型输出被截断 — 底部区域行数管理重构
 *   41828a5 命令结果区移至输入框下方 — 完整显示、不随对话滚动
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TuiApp } from '../../../src/presentation/tui-app.js';
import type { SessionManager } from '../../../src/core/session.js';
import type { StreamEvent } from '../../../src/types/index.js';
import type { TuiConfig } from '../../../src/presentation/types.js';
import { GRAY_BG_START, stripAnsi, dim } from '../../../src/render/ansi.js';

/** 与 app.ts 中定义的 CLEAR_TO_END 一致（从光标处清除到屏幕底） */
const CLEAR_TO_END = '\x1b[0J';

/** 让微任务/宏任务推进（等待 async 内部继续执行） */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 构造最小可用的 TuiApp（mock sessionMgr，不启动真实会话） */
function makeApp(sessionMgr?: Partial<SessionManager>): TuiApp {
	const mgr = {
		getSubagentAsync: () => false,
		getSession: () => ({
			meta: { id: 'm', title: '', created_at: '', updated_at: '', turnCount: 0, totalCost: 0 },
			turns: [],
			systemPrompt: undefined,
		}),
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

/** mock 输出事件序列的 sessionMgr（维护 turns 供 viewer 渲染） */
function mockStreamSession(events: StreamEvent[]): Partial<SessionManager> {
	const turns: import('../../../src/types/index.js').TurnRecord[] = [];
	return {
		getSession: () => ({
			meta: { id: 'mock', title: '', created_at: '', updated_at: '', turnCount: turns.length, totalCost: 0 },
			turns,
			systemPrompt: undefined,
		}),
		sendMessageStream: vi.fn(async (content: string, onEvent: (e: StreamEvent) => void) => {
			for (const e of events) onEvent(e);
			const reasoning = events
				.filter((e) => e.type === 'reasoning_delta' && e.text)
				.map((e) => e.text)
				.join('');
			const reply = events
				.filter((e) => e.type === 'content_delta' && e.text)
				.map((e) => e.text)
				.join('');
			turns.push({
				version: 2,
				messages: [
					{ role: 'user', content },
					{ role: 'assistant', content: reply, reasoning_content: reasoning || undefined },
				],
				cost_rmb: 0,
				created_at: new Date().toISOString(),
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
			return null;
		}) as unknown as SessionManager['sendMessageStream'],
	};
}

/** 终端宽度（测试环境非 TTY → 回退 80 列，与应用内 getTermSize 一致） */
function termCols(): number {
	return (process.stdout.columns as number) || 80;
}

/** 剥离 ANSI 与行结构（'│ ' 前缀/空白），用于内容完整性断言 */
function flatText(raw: string): string {
	return stripAnsi(raw).replace(/[\s│]/g, '');
}

describe('输入区定位回归测试（8 个历史 bug）', () => {
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

	// ─── 572bb26 ──────────────────────────────────────────────
	it('572bb26: 命令结果区超宽行折行后光标上移按物理行数（完整显示、输入区不逐次下移）', () => {
		const app = makeApp();
		const anyApp = app as unknown as {
			bottom: {
				clearCommandResult: (redraw?: boolean) => void;
				pushCommandLine: (l: string) => void;
				renderIdle: () => void;
			};
		};
		const wrapWidth = termCols() - 2; // availWidth - 2（'│ ' 前缀占 2 列）
		const wide = '─'.repeat(wrapWidth * 2 + 3); // 确定折成 3 个物理行

		anyApp.bottom.clearCommandResult(false);
		anyApp.bottom.pushCommandLine(wide);
		anyApp.bottom.renderIdle();
		const out = writes.join('');

		// 完整显示不截断：157 个 '─' 全部在输出中（折成 3 行）
		expect(flatText(out)).toContain('─'.repeat(wrapWidth * 2 + 3));
		// '│ ' 前缀出现 3 次（3 个物理行，而非 1 个逻辑行）
		const prefixCount = out.split(dim('│ ')).length - 1;
		expect(prefixCount).toBe(3);
		// 光标定位上移 = 物理行数（3），不是逻辑行数（1）
		expect(out).toContain('\x1b[3A');
		expect(out).not.toContain('\x1b[1A');
		expect(out).not.toContain('\x1b[2A');

		// 再次重绘（模拟键入）：上移基准为光标行偏移（0），不产生额外上移 → 输入区不逐次下移
		writes.length = 0;
		anyApp.bottom.renderIdle();
		const out2 = writes.join('');
		expect(out2).not.toContain('\x1b[1A');
		expect(out2).not.toContain('\x1b[2A');
		expect(out2).toContain('\x1b[3A');
	});

	// ─── 930ce77 ──────────────────────────────────────────────
	it('930ce77: 流式期间执行命令后，输出结束 inputCycle 重建仍绘制命令结果区（不消失）', async () => {
		let release!: () => void;
		let callCount = 0;
		const sendSpy = vi.fn(async (_content: string, onEvent: (e: StreamEvent) => void) => {
			callCount++;
			if (callCount === 1) {
				onEvent({ type: 'content_delta', text: '输出行\n' });
				// 第一轮暂停，等待测试驱动双工 /context
				await new Promise<void>((r) => { release = r; });
			}
			onEvent({ type: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			return null;
		}) as unknown as SessionManager['sendMessageStream'];
		const app = makeApp({
			sendMessageStream: sendSpy,
			getSession: () => ({
				meta: { id: 'm', title: '', created_at: '', updated_at: '', turnCount: 0, totalCost: 0 },
				turns: [],
				systemPrompt: undefined,
			}),
		});
		const anyApp = app as unknown as {
			inputCycle: () => Promise<void>;
			stdinHandler: ((d: string) => void) | null;
		};

		// 第一轮：发送普通消息；流式期间双工执行 /context 填充命令结果区
		const r1 = anyApp.inputCycle();
		await tick();
		anyApp.stdinHandler?.('你好');
		anyApp.stdinHandler?.('\x0d');
		await tick();
		anyApp.stdinHandler?.('/context');
		anyApp.stdinHandler?.('\x0d');
		await tick();
		// 命令结果区已在屏幕上（输入区下方）
		expect(writes.join('')).toContain('Session Context');
		release();
		await r1;

		// 第二轮：inputCycle 重建底部区域（修复前只画输入区灰底 → 命令结果区消失）
		writes.length = 0;
		const r2 = anyApp.inputCycle();
		const rebuild = writes.join('');
		expect(rebuild).toContain(GRAY_BG_START); // 输入区
		expect(rebuild).toContain('Session Context'); // 命令结果区仍在（不消失）
		expect(rebuild).toContain(dim('│ ')); // 命令结果区行前缀

		// 收尾：发送消息让第二轮完成
		anyApp.stdinHandler?.('bye');
		anyApp.stdinHandler?.('\x0d');
		await r2;
	});

	// ─── af2693e ──────────────────────────────────────────────
	it('af2693e: 命令执行后输入区清空（不残留命令文本，避免后续键入追加成误输入）', async () => {
		const app = makeApp();
		const anyApp = app as unknown as {
			inputCycle: () => Promise<void>;
			stdinHandler: ((d: string) => void) | null;
			input: { getDisplayLines: () => string[] };
		};

		const r = anyApp.inputCycle();
		await tick();
		anyApp.stdinHandler?.('/context');
		anyApp.stdinHandler?.('\x0d');
		await r;

		// 命令路径 return 前 input.clear()：输入框为空（修复前显示 '/context' 残留）
		expect(anyApp.input.getDisplayLines().join('').trim()).toBe('');
		// 命令结果区正常渲染在底部
		expect(writes.join('')).toContain('Session Context');
	});

	// ─── 03dec44 ──────────────────────────────────────────────
	it('03dec44: 流式期间 Enter 不破坏双工键盘；视图关闭后排队消息由主循环发送（无双流）', async () => {
		let callCount = 0;
		let releaseFirst!: () => void;
		const sendSpy = vi.fn(async (_content: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal) => {
			callCount++;
			if (callCount === 1) {
				onEvent({ type: 'content_delta', text: '第一行\n' });
				await new Promise<void>((r) => {
					releaseFirst = r;
					signal?.addEventListener('abort', () => r(), { once: true });
				});
			} else {
				onEvent({ type: 'content_delta', text: '排队消息输出\n' });
			}
			onEvent({ type: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			return null;
		}) as unknown as SessionManager['sendMessageStream'];
		const app = makeApp({
			sendMessageStream: sendSpy,
			getSession: () => ({
				meta: { id: 'm', title: '', created_at: '', updated_at: '', turnCount: 0, totalCost: 0 },
				turns: [],
				systemPrompt: undefined,
			}),
		});
		const anyApp = app as unknown as {
			sendMessageStream: (c: string) => Promise<void>;
			stdinHandler: ((d: string) => void) | null;
			openViewer: () => void;
			closeViewer: () => void;
			inputCycle: () => Promise<void>;
			nextMessage: string | null;
		};

		// 启动第一轮流（不 await），进入流式状态
		const first = anyApp.sendMessageStream('第一条');
		await tick();
		// 流式期间键入 + Enter：双工 handler 保留（修复前被置空 → 键盘全部失效）
		anyApp.stdinHandler?.('排队');
		anyApp.stdinHandler?.('\x0d');
		expect(anyApp.stdinHandler).not.toBeNull();
		expect(anyApp.nextMessage).toBe('排队');
		expect(sendSpy).toHaveBeenCalledTimes(1); // 无双流

		// 打开视图 → 流在视图打开期间结束（finally 跳过排空）→ 关闭视图：
		// closeViewer 不得 fire-and-forget 启动新流
		anyApp.openViewer();
		releaseFirst();
		await first;
		anyApp.closeViewer();
		expect(sendSpy).toHaveBeenCalledTimes(1); // 视图关闭未启动第二条流

		// 主循环 inputCycle 统一发送排队消息（唯一第二流，顺序不交错）
		await anyApp.inputCycle();
		expect(sendSpy).toHaveBeenCalledTimes(2);
		expect(sendSpy.mock.calls[1][0]).toBe('排队');
		expect(writes.join('')).toContain('排队消息输出');
	});

	// ─── 0838994 ──────────────────────────────────────────────
	it('0838994: 多行输入 + 命令结果区时，上移基准为光标行偏移（输入框不逐字符上移）', () => {
		const app = makeApp();
		const anyApp = app as unknown as {
			bottom: {
				clearCommandResult: (redraw?: boolean) => void;
				pushCommandLine: (l: string) => void;
				renderIdle: () => void;
				collapse: () => void;
			};
			input: { insertChar: (c: string) => void; getDisplayLines: () => string[] };
		};
		anyApp.bottom.clearCommandResult(false);
		anyApp.bottom.pushCommandLine('命令结果行');
		anyApp.bottom.renderIdle(); // 设定 wrap width

		// 键入超宽内容：输入框折成 2 行，光标在第 2 行（display row = 1）
		for (let i = 0; i < termCols() + 10; i++) anyApp.input.insertChar('a');
		expect(anyApp.input.getDisplayLines().length).toBeGreaterThan(1);
		anyApp.bottom.renderIdle();
		// 再次键入重绘：上移量 = 光标行偏移（1），不是底部区域总高度（2 + 命令结果区 1 = 3）
		writes.length = 0;
		anyApp.bottom.renderIdle();
		const out = writes.join('');
		expect(out.startsWith('\x1b[?25l\x1b[1A\r\x1b[0J')).toBe(true);

		// collapse 同样只上移光标行偏移：\x1b[1A + \r + 清到屏底
		writes.length = 0;
		anyApp.bottom.collapse();
		expect(writes.join('')).toBe('\x1b[1A\r\x1b[0J');
	});

	// ─── f827d93 ──────────────────────────────────────────────
	it('f827d93: 建议列表收缩时无残留清除序列（额外 \\r\\n+clearLine 会触发滚动吞掉对话）', async () => {
		const app = makeApp();
		const anyApp = app as unknown as {
			inputCycle: () => Promise<void>;
			stdinHandler: ((d: string) => void) | null;
		};

		const r = anyApp.inputCycle();
		await tick();
		// 输入 '/co'：建议列表 2 条（/compact、/context）
		writes.length = 0;
		anyApp.stdinHandler?.('/co');
		const segCo = writes.join('');
		expect(segCo).toContain('/compact');
		expect(segCo).toContain('/context');
		// 2 条建议行（选中 '▸ /context' + 未选中 '  /compact'）
		const coSuggestRows = (segCo.match(/(?:▸ |  )\//g) ?? []).length;
		expect(coSuggestRows).toBe(2);

		// 输入 'n'：建议从 2 收缩到 1（/context）
		// 修复前：绘制后额外 \r\n + clearLine 清残留（屏底 \r\n 触发终端滚动 → 对话逐行消失）
		writes.length = 0;
		anyApp.stdinHandler?.('n');
		const segN = writes.join('');
		expect(segN).toContain('/context');
		// 该重绘段只含 1 个 \r\n（输入行 → 建议行）与 1 个上移序列（光标回输入行）
		const rnCount = segN.split('\r\n').length - 1;
		const up1Count = segN.split('\x1b[1A').length - 1;
		expect(rnCount).toBe(1);
		expect(up1Count).toBe(1);

		// 收尾：补全为 /context 并提交，完成本轮
		anyApp.stdinHandler?.('text');
		anyApp.stdinHandler?.('\x0d');
		await r;
	});

	// ─── 6f537df ──────────────────────────────────────────────
	it('6f537df: 命令结果区存在时流式输出不被错误上移+清屏截断（无 \\x1b[nA + CLEAR_TO_END）', async () => {
		const app = makeApp(mockStreamSession([
			{ type: 'content_delta', text: '输出第一行\n' },
			{ type: 'content_delta', text: '输出第二行\n' },
			{ type: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
		]));
		const anyApp = app as unknown as {
			handleCommand: (c: string) => Promise<boolean>;
			sendMessageStream: (c: string) => Promise<void>;
			bottom: { getCommandLineCount: () => number };
		};

		// 先执行 /context：命令结果区占据底部区域
		await anyApp.handleCommand('/context');
		expect(anyApp.bottom.getCommandLineCount()).toBeGreaterThan(0);

		// 发送消息：模型输出必须完整
		await anyApp.sendMessageStream('hello');
		const out = writes.join('');
		expect(out.indexOf('输出第一行')).toBeGreaterThanOrEqual(0);
		expect(out.indexOf('输出第二行')).toBeGreaterThan(out.indexOf('输出第一行'));

		// 不变量：流式输出期间，任何 CLEAR_TO_END 都不由「上移 + 清屏」触发
		// （修复前：错误上移 lastBottomRows 后 CLEAR_TO_END 把输出区末尾清掉 → 截断）
		const clearIdxs: number[] = [];
		let idx = -1;
		while ((idx = out.indexOf(CLEAR_TO_END, idx + 1)) !== -1) clearIdxs.push(idx);
		expect(clearIdxs.length).toBeGreaterThan(0);
		for (const ci of clearIdxs) {
			const before = out.slice(Math.max(0, ci - 8), ci);
			expect(before).not.toMatch(/\x1b\[\d+A$/);
		}
	});

	// ─── 41828a5 ──────────────────────────────────────────────
	it('41828a5: 命令结果区绘制在输入框下方且完整显示（输入区在区域顶部，结果区不截断）', async () => {
		const app = makeApp();
		const anyApp = app as unknown as {
			handleCommand: (c: string) => Promise<boolean>;
			bottom: { renderAfterOutput: () => void };
		};

		await anyApp.handleCommand('/help');
		anyApp.bottom.renderAfterOutput();
		const out = writes.join('');

		// 输入区（灰底）出现在命令结果区（'│ ' 前缀）之前 → 结果区在输入框下方
		const inputIdx = out.indexOf(GRAY_BG_START);
		const cmdIdx = out.indexOf(dim('│ '));
		expect(inputIdx).toBeGreaterThanOrEqual(0);
		expect(cmdIdx).toBeGreaterThan(inputIdx);

		// 完整显示不截断：标题、超宽分隔线（折行后全部保留）、最后一条命令说明都在
		expect(stripAnsi(out)).toContain('Commands');
		expect(flatText(out)).toContain('─'.repeat(termCols() - 1));
		expect(stripAnsi(out)).toContain('/exit  |  Ctrl+C');
	});
});
