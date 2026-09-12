/**
 * subagent.test.ts — runSubagentLoop 单元测试 + SessionManager 子代理集成测试
 *
 * 覆盖：
 *   - runSubagentLoop：callbacks 条目发射（M-7）、onUsage 收集（O-1）、signal 取消（I-1/I-2）
 *   - SessionManager：async spawn → store 填充 + 事件发射（M-1/M-5）
 *   - I-1：主 agent 中断不连坐子代理（signal 独立）
 *   - cancelSubagent：取消后状态标 cancelled（I-2）
 *   - M-3：sync 模式多 spawn 并行启动
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../../src/core/storage.js';
import type { ModelProvider } from '../../src/core/model-provider.js';
import { SessionManager } from '../../src/core/session.js';
import { runSubagentLoop, SUBAGENT_CANCELLED } from '../../src/core/subagent.js';
import type { SubagentRoundEntry } from '../../src/core/subagent-store.js';
import type { Tool } from '../../src/tools/types.js';
import type { Message, StreamChunk, TokenUsage } from '../../src/types/index.js';

/** 脚本步骤：一轮 chatStream 的返回内容 */
interface Step {
	reasoning?: string;
	content?: string;
	toolCalls?: { id: string; function: { name: string; arguments: string } }[];
	usage?: TokenUsage;
	/** 挂起等待 signal abort（默认 200ms 超时兜底） */
	hang?: boolean;
}

function chunk(overrides?: Partial<StreamChunk>): StreamChunk {
	return {
		id: 'sub-chunk',
		object: 'chat.completion.chunk',
		created: 0,
		model: 'deepseek-v4-pro',
		choices: [{ index: 0, delta: {}, finish_reason: null }],
		...overrides,
	};
}

function emitStep(step: Step): StreamChunk {
	const delta: Record<string, unknown> = {};
	if (step.reasoning) delta.reasoning_content = step.reasoning;
	if (step.content) delta.content = step.content;
	if (step.toolCalls) {
		delta.tool_calls = step.toolCalls.map((tc, i) => ({
			index: i, id: tc.id, type: 'function', function: tc.function,
		}));
	}
	return chunk({
		choices: [{ index: 0, delta, finish_reason: null }],
		...(step.usage ? { usage: step.usage } : {}),
	});
}

/** 可编程流式 provider：按步骤脚本依次返回（超出重复最后一步） */
function makeScriptClient(
	steps: Step[],
	signalLog?: AbortSignal[],
): ModelProvider {
	let callCount = 0;
	async function* gen(_messages: Message[], opts?: any): AsyncGenerator<StreamChunk> {
		if (signalLog) signalLog.push(opts?.signal);
		const step = steps[Math.min(callCount, steps.length - 1)];
		callCount++;
		if (step.hang) {
			await new Promise<void>((resolve) => {
				if (opts?.signal?.aborted) return resolve();
				opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
				setTimeout(resolve, 200);
			});
			const err = new Error('aborted');
			err.name = 'AbortError';
			throw err;
		}
		yield emitStep(step);
	}
	return { chatStream: gen } as unknown as ModelProvider;
}

/**
 * 记录每次 chatStream 收到的 messages 的分流 provider。
 * 用于断言「注入到 master 上下文里的文本」（状态块 / 子代理通知）。
 */
function makeRecordingSplitClient(
	mainSteps: Step[],
	onSub: (messages: Message[]) => Step | 'hang',
	messageLog: Message[][],
): ModelProvider {
	const inner = makeSplitClient(mainSteps, onSub);
	return {
		chatStream(messages: Message[], opts?: unknown) {
			messageLog.push(messages.map((m) => ({ ...m })));
			return (inner.chatStream as (m: Message[], o?: unknown) => AsyncGenerator<StreamChunk>)(messages, opts);
		},
	} as unknown as ModelProvider;
}

/** 主/子代理分流 provider：主代理走 mainSteps，子代理由 onSub 决定行为 */
function makeSplitClient(
	mainSteps: Step[],
	onSub: (messages: Message[]) => Step | 'hang',
	signalLog?: AbortSignal[],
): ModelProvider {
	let mainCallCount = 0;
	async function* gen(messages: Message[], opts?: any): AsyncGenerator<StreamChunk> {
		if (signalLog) signalLog.push(opts?.signal);
		const isSub = messages[0]?.content?.includes('Subagent Mode');
		if (isSub) {
			const sub = onSub(messages);
			if (sub === 'hang') {
				await new Promise<void>((resolve) => {
					if (opts?.signal?.aborted) return resolve();
					opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
					setTimeout(resolve, 200);
				});
				const err = new Error('aborted');
				err.name = 'AbortError';
				throw err;
			}
			yield emitStep(sub);
			return;
		}
		const step = mainSteps[Math.min(mainCallCount, mainSteps.length - 1)];
		mainCallCount++;
		if (step.hang) {
			await new Promise<void>((resolve) => {
				if (opts?.signal?.aborted) return resolve();
				opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
				setTimeout(resolve, 200);
			});
			const err = new Error('aborted');
			err.name = 'AbortError';
			throw err;
		}
		yield emitStep(step);
	}
	return { chatStream: gen } as unknown as ModelProvider;
}

const fakeTool: Tool = {
	name: 'fake_tool',
	description: 'fake tool',
	parameters: { type: 'object', properties: {} },
	requiresConfirm: false,
	async execute() { return { content: 'fake result' }; },
};

/** 构造子代理消息队列（新 runSubagentLoop 签名：完整 messages 入参） */
function subMessages(task: string, systemPrompt = 'subagent prompt'): Message[] {
	return [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: task },
	];
}

/**
 * 断言消息序列合法：每个 assistant.tool_calls 声明的 id 都必须有配对 tool 消息。
 * 中断（取消）后仍应成立——否则续跑时 API 会因悬空 tool_calls 报错。
 */
function assertToolCallsPaired(messages: Message[]): void {
	const toolIds = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
	for (const m of messages) {
		if (m.role !== 'assistant' || !m.tool_calls) continue;
		for (const tc of m.tool_calls) {
			expect(toolIds.has(tc.id)).toBe(true);
		}
	}
}

function spawnCall(name: string, task: string): { id: string; function: { name: string; arguments: string } } {
	return {
		id: `call-${name}`,
		function: { name: 'subagent_spawn', arguments: JSON.stringify({ subagent_name: name, task }) },
	};
}

function waitCall(name: string): { id: string; function: { name: string; arguments: string } } {
	return {
		id: `call-wait-${name}`,
		function: { name: 'wait', arguments: JSON.stringify({ subagent_name: name }) },
	};
}

function waitCallMany(names: string[]): { id: string; function: { name: string; arguments: string } } {
	return {
		id: 'call-wait-many',
		function: { name: 'wait', arguments: JSON.stringify({ subagent_name: names }) },
	};
}

function waitCallAll(): { id: string; function: { name: string; arguments: string } } {
	return {
		id: 'call-wait-all',
		function: { name: 'wait', arguments: '{}' },
	};
}

function listCall(): { id: string; function: { name: string; arguments: string } } {
	return {
		id: 'call-list',
		function: { name: 'list_subagents', arguments: '{}' },
	};
}

function traceCall(name: string): { id: string; function: { name: string; arguments: string } } {
	return {
		id: `call-trace-${name}`,
		function: { name: 'subagent_trace', arguments: JSON.stringify({ subagent_name: name }) },
	};
}

function cancelCall(name: string): { id: string; function: { name: string; arguments: string } } {
	return {
		id: `call-cancel-${name}`,
		function: { name: 'subagent_cancel', arguments: JSON.stringify({ subagent_name: name }) },
	};
}

function sendCall(name: string, instruction: string): { id: string; function: { name: string; arguments: string } } {
	return {
		id: `call-send-${name}`,
		function: { name: 'subagent_send', arguments: JSON.stringify({ subagent_name: name, instruction }) },
	};
}

// ─── runSubagentLoop 单元测试 ───────────────────────

describe('runSubagentLoop', () => {
	it('完整循环：thinking/content/tool_call/tool_result 条目发射（M-7）', async () => {
		const client = makeScriptClient([
			{ reasoning: '思考中', content: '开始', toolCalls: [{ id: 'c1', function: { name: 'fake_tool', arguments: '{}' } }] },
			{ content: '最终结果' },
		]);
		const entries: SubagentRoundEntry[] = [];
		const { status, messages } = await runSubagentLoop(subMessages('任务'), client, [fakeTool], undefined, {
			onEntry: (e) => entries.push(e),
		});
		expect(status).toBe('completed');
		// 最终 content 作为最后一条 assistant 消息入队（取代旧的 result 字段）
		expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: '最终结果' });
		assertToolCallsPaired(messages);
		expect(entries.some((e) => e.type === 'thinking' && e.content === '思考中')).toBe(true);
		expect(entries.filter((e) => e.type === 'content')).toHaveLength(2);
		expect(entries.some((e) => e.type === 'tool_call' && e.toolName === 'fake_tool')).toBe(true);
		expect(entries.some((e) => e.type === 'tool_result' && e.content === 'fake result')).toBe(true);
	});

	it('流式 content 按完整行 emit（不逐 chunk 拆碎，半行结尾 flush）', async () => {
		// 模拟真实流式：一个轮次内多个 delta chunk（DeepSeek 每 chunk 几个词）
		const client = {
			chatStream: async function* () {
				yield emitStep({ content: '第一行' });        // 半行（无 \n）
				yield emitStep({ content: '续写\n第二行\n' }); // 续写 + 拆出两行
				yield emitStep({ content: '第三行' });        // 半行，轮次结束 flush
			},
		} as unknown as ModelProvider;
		const entries: SubagentRoundEntry[] = [];
		const { status, messages } = await runSubagentLoop(subMessages('任务'), client, [], undefined, {
			onEntry: (e) => entries.push(e),
		});
		expect(status).toBe('completed');
		expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: '第一行续写\n第二行\n第三行' });
		const contentEntries = entries.filter((e) => e.type === 'content');
		// 按 \n 边界拆成完整行，而非每 chunk 一条碎 entry
		expect(contentEntries.map((e) => e.content)).toEqual(['第一行续写', '第二行', '第三行']);
	});

	it('onUsage 回调收集每轮 usage（O-1）', async () => {
		const client = makeScriptClient([
			{ content: '结果', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
		]);
		const usages: TokenUsage[] = [];
		await runSubagentLoop(subMessages('任务'), client, [], undefined, { onUsage: (u) => usages.push(u) });
		expect(usages).toHaveLength(1);
		expect(usages[0].total_tokens).toBe(8);
	});

	it('signal abort 返回 status=cancelled（I-1/I-2）', async () => {
		const controller = new AbortController();
		const client = makeScriptClient([{ hang: true }]);
		const p = runSubagentLoop(subMessages('任务'), client, [], controller.signal);
		setTimeout(() => controller.abort(), 10);
		const { status, messages } = await p;
		expect(status).toBe('cancelled');
		// 流式阶段中断：本轮 assistant 尚未入队，不存在悬空 tool_calls
		expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
		assertToolCallsPaired(messages);
	});

	it('工具执行抛 AbortError：status=cancelled 且 tool_calls 仍配对（消息序列合法）', async () => {
		const abortingTool: Tool = {
			name: 'abort_tool',
			description: 'aborts',
			parameters: { type: 'object', properties: {} },
			requiresConfirm: false,
			async execute(_args, signal) {
				signal?.throwIfAborted();
				const err = new Error('aborted');
				err.name = 'AbortError';
				throw err;
			},
		};
		const client = makeScriptClient([
			{ content: '', toolCalls: [{ id: 'c1', function: { name: 'abort_tool', arguments: '{}' } }] },
		]);
		const { status, messages } = await runSubagentLoop(subMessages('任务'), client, [abortingTool]);
		expect(status).toBe('cancelled');
		// 中断不再直接 return：assistant.tool_calls 有配对 tool 消息（与主代理中断策略一致）
		expect(messages.filter((m) => m.role === 'assistant' && m.tool_calls?.length)).toHaveLength(1);
		const toolMsg = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
		expect(toolMsg?.content).toContain('cancelled');
		assertToolCallsPaired(messages);
	});

	it('中断后本轮剩余工具不执行，全部补配对结果', async () => {
		const executed: string[] = [];
		const abortingTool: Tool = {
			name: 'abort_tool',
			description: 'aborts',
			parameters: { type: 'object', properties: {} },
			requiresConfirm: false,
			async execute(_args, signal) {
				signal?.throwIfAborted();
				const err = new Error('aborted');
				err.name = 'AbortError';
				throw err;
			},
		};
		const otherTool: Tool = {
			name: 'other_tool',
			description: 'should not run after cancel',
			parameters: { type: 'object', properties: {} },
			requiresConfirm: false,
			async execute() {
				executed.push('other_tool');
				return { content: 'other result' };
			},
		};
		const client = makeScriptClient([
			{
				content: '',
				toolCalls: [
					{ id: 'c1', function: { name: 'abort_tool', arguments: '{}' } },
					{ id: 'c2', function: { name: 'other_tool', arguments: '{}' } },
				],
			},
		]);
		const { status, messages } = await runSubagentLoop(
			subMessages('任务'), client, [abortingTool, otherTool],
		);
		expect(status).toBe('cancelled');
		expect(executed).toHaveLength(0);
		expect(messages.find((m) => m.tool_call_id === 'c2')?.content).toContain('Not executed');
		assertToolCallsPaired(messages);
	});

	it('中断后可续跑：追加 user 指令再次驱动，序列合法且正常完成', async () => {
		const abortingTool: Tool = {
			name: 'abort_tool',
			description: 'aborts',
			parameters: { type: 'object', properties: {} },
			requiresConfirm: false,
			async execute(_args, signal) {
				signal?.throwIfAborted();
				const err = new Error('aborted');
				err.name = 'AbortError';
				throw err;
			},
		};
		const client = makeScriptClient([
			{ content: '', toolCalls: [{ id: 'c1', function: { name: 'abort_tool', arguments: '{}' } }] },
			{ content: '继续完成' },
		]);
		const first = await runSubagentLoop(subMessages('任务'), client, [abortingTool]);
		expect(first.status).toBe('cancelled');
		assertToolCallsPaired(first.messages);

		const second = await runSubagentLoop(
			[...first.messages, { role: 'user', content: '继续' }],
			client,
			[abortingTool],
		);
		expect(second.status).toBe('completed');
		expect(second.messages.at(-1)).toMatchObject({ role: 'assistant', content: '继续完成' });
		assertToolCallsPaired(second.messages);
	});
});

// ─── SessionManager 子代理集成测试 ──────────────────

describe('SessionManager subagent 集成', () => {
	let testDir: string;
	let storage: Storage;
	let mgr: SessionManager;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), 'deepseek-subagent-test-'));
		storage = new Storage(testDir);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it('async spawn → store 填充 + subagent_spawned/finished 事件（M-1/M-5）', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'do x')] },
				{ content: '主代理完成' },
			],
			() => ({ content: '子代理结果' }),
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('subagent 测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		const result = await mgr.sendMessageStream('spawn 一个子代理', (e) => events.push(e));

		expect(result).not.toBeNull();
		// store 填充
		const record = mgr.getSubagent('sub1');
		expect(record).toBeDefined();
		expect(record!.status).toBe('completed');
		// 无 result 字段：输出文本由 messages 派生（需求 4）
		expect(record!.outputText()).toBe('子代理结果');
		expect(record!.lastContent()).toBe('子代理结果');
		expect(record!.entries.length).toBeGreaterThan(0);
		// 事件发射
		const spawned = events.find((e) => e.type === 'subagent_spawned');
		expect(spawned).toBeDefined();
		expect(spawned!.subagentName).toBe('sub1');
		const finished = events.find((e) => e.type === 'subagent_finished');
		expect(finished).toBeDefined();
		expect(finished!.subagentStatus).toBe('completed');
		// 持久化到磁盘
		const names = await storage.listSubagentRecords(mgr.getSessionId()!);
		expect(names).toContain('sub1');
		const loaded = await storage.loadSubagentRecord(mgr.getSessionId()!, 'sub1');
		expect(loaded?.status).toBe('completed');
	});

	it('I-1：主 agent 中断不连坐子代理（子代理 signal 独立）', async () => {
		const subSignals: AbortSignal[] = [];
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'long task')] },
				{ hang: true }, // 主代理第二轮挂起，等待主 signal abort
			],
			() => 'hang', // 子代理挂起（用独立 signal）
			subSignals,
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('中断测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const mainController = new AbortController();
		const p = mgr.sendMessageStream('spawn', () => {}, mainController.signal);
		await sleep(50); // 让子代理启动并记录 signal
		mainController.abort();
		await p;

		// 主 agent 已中断（返回中断 turn），但子代理的 signal 未被 abort
		// （subSignals[0] 是主代理第一轮的 signal，需找到与主 signal 引用不同的子代理 signal）
		const subSignal = subSignals.find((s) => s !== mainController.signal);
		expect(subSignal).toBeDefined();
		expect(subSignal!.aborted).toBe(false);
		// 子代理仍在运行（store 状态 running）
		expect(mgr.getSubagent('sub1')?.status).toBe('running');
	});

	it('cancelSubagent：取消后状态标 cancelled（I-2）', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task')] },
				{ content: 'done' },
			],
			() => 'hang', // 子代理挂起，等待取消
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('取消测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const p = mgr.sendMessageStream('spawn', () => {});
		await sleep(50);
		const cancelled = mgr.cancelSubagent('sub1');
		expect(cancelled).toEqual(['sub1']);
		await p; // 主代理本轮正常结束（第二轮返回纯文本）

		// 子代理收到 abort → 返回 cancelled
		await sleep(50);
		const sub = mgr.getSubagent('sub1');
		expect(sub?.status).toBe('cancelled');
		// cancelled 时面向 master 的输出是状态消息（cancelled 非终态，之后可续跑）
		expect(sub?.outputText()).toBe(SUBAGENT_CANCELLED);
	});

	it('cancelSubagent("all") 取消全部运行中的子代理', async () => {
		const client = makeSplitClient(
			[
				{
					content: '',
					toolCalls: [spawnCall('a', 'task a'), spawnCall('b', 'task b')],
				},
				{ content: 'done' },
			],
			() => 'hang',
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('全部取消测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const p = mgr.sendMessageStream('spawn two', () => {});
		await sleep(50);
		const cancelled = mgr.cancelSubagent('all');
		expect(cancelled.sort()).toEqual(['a', 'b']);
		await p;
		await sleep(50);
		expect(mgr.getSubagent('a')?.status).toBe('cancelled');
		expect(mgr.getSubagent('b')?.status).toBe('cancelled');
	});

	it('M-3：sync 模式一轮多 spawn 并行启动（B 在 A 完成前被调用）', async () => {
		const subOrder: string[] = [];
		const client = makeSplitClient(
			[
				{
					content: '',
					toolCalls: [spawnCall('A', 'TASK_A slow'), spawnCall('B', 'TASK_B fast')],
				},
				{ content: 'done' },
			],
			(messages) => {
				const task = messages[1]?.content ?? '';
				if (task.includes('TASK_A')) {
					subOrder.push('A:start');
					// A 挂起（200ms 超时后结束），期间 B 应已被启动
					return 'hang';
				}
				subOrder.push('B:start');
				return { content: 'B done' };
			},
		);
		mgr = new SessionManager(storage, client);
		// 默认非 async（sync 模式）
		await mgr.startNewSession('并行测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		await mgr.sendMessageStream('spawn two sync', () => {});

		// B 已启动（旧串行实现下 A 挂起期间 B 永远不会被调用）→ 证明并行启动
		expect(subOrder).toContain('B:start');
		// A 超时结束（cancelled），B 正常完成
		expect(mgr.getSubagent('B')?.status).toBe('completed');
	});

	// ─── wait 多参数模式 ────────────────────────────

	/** 从事件流中提取 wait 工具的 tool_result 事件 */
	function findWaitEvent(events: import('../../src/types/index.js').StreamEvent[]) {
		return events.find((e) => e.type === 'tool_result' && e.toolName === 'wait');
	}

	it('wait(单参数)：取回单个已完成子代理结果（回归兼容）', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task')] },
				{ content: '', toolCalls: [waitCall('sub1')] },
				{ content: 'done' },
			],
			() => ({ content: 'sub1 result' }),
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('wait 单参数测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('spawn 并 wait', (e) => events.push(e));

		const ev = findWaitEvent(events);
		expect(ev).toBeDefined();
		expect(ev!.toolResult).toContain('=== sub1 ===');
		expect(ev!.toolResult).toContain('sub1 result');
		expect(ev!.error).toBeUndefined();
	});

	it('wait(数组)：等全部指定子代理完成后才返回，结果汇总', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('a', 'task a'), spawnCall('b', 'task b')] },
				{ content: '', toolCalls: [waitCallMany(['a', 'b'])] },
				{ content: 'done' },
			],
			(messages) => {
				const task = messages[1]?.content ?? '';
				// a 立即完成；b 挂起 200ms（超时后 cancelled）→ 验证 wait 等 b 完成才返回
				if (task.includes('task b')) return 'hang';
				return { content: 'A done' };
			},
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('wait 数组测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('spawn two and wait both', (e) => events.push(e));

		const waitIdx = events.findIndex((e) => e.type === 'tool_result' && e.toolName === 'wait');
		const bFinishedIdx = events.findIndex(
			(e) => e.type === 'subagent_finished' && e.subagentName === 'b',
		);
		// wait 的 tool_result 必须排在 b 完成事件之后 → 证明等全部结束才返回
		expect(bFinishedIdx).toBeGreaterThan(-1);
		expect(waitIdx).toBeGreaterThan(bFinishedIdx);

		const ev = findWaitEvent(events);
		expect(ev!.toolResult).toContain('=== a ===');
		expect(ev!.toolResult).toContain('A done');
		expect(ev!.toolResult).toContain('=== b ===');
		// b 被挂起超时 → cancelled，wait 带 subagent_failed 标记
		expect(ev!.error).toBe('subagent_failed');
	});

	it('wait(无参数)：等待所有未取回的子代理', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('a', 'task a'), spawnCall('b', 'task b')] },
				{ content: '', toolCalls: [waitCallAll()] },
				{ content: 'done' },
			],
			(messages) => {
				const task = messages[1]?.content ?? '';
				return { content: task.includes('task a') ? 'A done' : 'B done' };
			},
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('wait 无参数测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('spawn two and wait all', (e) => events.push(e));

		const ev = findWaitEvent(events);
		expect(ev!.toolResult).toContain('=== a ===');
		expect(ev!.toolResult).toContain('=== b ===');
		expect(ev!.toolResult).toContain('A done');
		expect(ev!.toolResult).toContain('B done');
		expect(ev!.error).toBeUndefined();
	});

	it('wait(不存在的名字)：返回 not_found 错误', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [waitCall('nope')] },
				{ content: 'done' },
			],
			() => ({ content: 'unused' }),
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('wait not_found 测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('wait missing', (e) => events.push(e));

		const ev = findWaitEvent(events);
		expect(ev!.error).toBe('not_found');
		expect(ev!.toolResult).toContain('nope');
	});

	it('wait 可重复读取（幂等）：第二次 wait 不再报 already_retrieved（需求 1）', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task')] },
				{ content: '', toolCalls: [waitCall('sub1')] },
				{ content: '', toolCalls: [waitCall('sub1')] },
				{ content: 'done' },
			],
			() => ({ content: 'sub1 result' }),
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('wait 幂等测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('wait twice', (e) => events.push(e));

		const waitEvents = events.filter((e) => e.type === 'tool_result' && e.toolName === 'wait');
		expect(waitEvents).toHaveLength(2);
		// 两次都成功且内容一致：结果可重复读取（compact 后重读报告的场景也需要）
		expect(waitEvents[0].error).toBeUndefined();
		expect(waitEvents[1].error).toBeUndefined();
		expect(waitEvents[1].toolResult).toContain('sub1 result');
	});

	it('消费语义：未消费进状态块 + [new]；wait 之后不再进状态块 + [read]（需求 1）', async () => {
		const messageLog: Message[][] = [];
		const client = makeRecordingSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task')] },
				{ content: 'end1' },
				{ content: '', toolCalls: [listCall()] },
				{ content: 'end2' },
				{ content: '', toolCalls: [waitCall('sub1')] },
				{ content: 'end3' },
				{ content: '', toolCalls: [listCall()] },
				{ content: 'end4' },
			],
			() => ({ content: 'sub1 result' }),
			messageLog,
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('消费语义测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const statusTextOf = (calls: Message[][]): string => calls
			.flat()
			.filter((m) => typeof m.content === 'string' && m.content.startsWith('[Subagent Status'))
			.map((m) => m.content)
			.join('\n');

		// ① spawn 轮
		const events1: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('spawn', (e) => events1.push(e));
		await sleep(30);
		expect(mgr.getSubagent('sub1')?.status).toBe('completed');

		// ② 未消费：状态块提示 completed + list_subagents 显示 [new]
		messageLog.length = 0;
		const events2: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('list', (e) => events2.push(e));
		expect(statusTextOf(messageLog)).toMatch(/"sub1"\s+\(completed/);
		expect(events2.find((e) => e.type === 'tool_result' && e.toolName === 'list_subagents')?.toolResult)
			.toContain('[new]');

		// ③ wait 消费（读一次就够，之后不再播报）
		await mgr.sendMessageStream('wait', () => {});

		// ④ 已消费：状态块不再出现该行（这正是「反复通知」的根因）+ list 显示 [read]
		messageLog.length = 0;
		const events4: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('list', (e) => events4.push(e));
		expect(statusTextOf(messageLog)).not.toMatch(/"sub1"\s+\(completed/);
		expect(events4.find((e) => e.type === 'tool_result' && e.toolName === 'list_subagents')?.toolResult)
			.toContain('[read]');
	});

	it('subagent_trace：master 查看被取消子代理执行过的工具与参数（需求 3）', async () => {
		let subCalls = 0;
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task')] },
				{ content: 'end1' },
				{ content: '', toolCalls: [cancelCall('sub1')] },
				{ content: 'end2' },
				{ content: '', toolCalls: [traceCall('sub1')] },
				{ content: 'end3' },
			],
			() => {
				subCalls++;
				// 第一轮：调用一个不存在的工具（不真实执行），随后挂起等待被取消
				if (subCalls === 1) {
					return {
						content: '先调用工具',
						toolCalls: [{ id: 's1', function: { name: 'nonexistent_tool', arguments: '{"a":1}' } }],
					};
				}
				return 'hang';
			},
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('trace 测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		await mgr.sendMessageStream('spawn', () => {});
		await sleep(50);

		// 取消（cancelled 非终态，仍可查轨迹）
		const events2: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('cancel', (e) => events2.push(e));
		await sleep(50);
		expect(mgr.getSubagent('sub1')?.status).toBe('cancelled');

		// master 查轨迹：看得到工具名与参数，看不到思维链与工具结果
		const events3: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('trace', (e) => events3.push(e));
		const traceEvent = events3.find((e) => e.type === 'tool_result' && e.toolName === 'subagent_trace');
		expect(traceEvent?.error).toBeUndefined();
		expect(traceEvent?.toolResult).toContain('tool: nonexistent_tool {"a":1}');
		expect(traceEvent?.toolResult).toContain('text: 先调用工具');
		expect(traceEvent?.toolResult).not.toContain('Unknown tool');
	});

	it('用户直发 subagent → 通知注入 master 上下文（含 user 指令与 subagent 内容，需求 2）', async () => {
		const messageLog: Message[][] = [];
		const client = makeRecordingSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task')] },
				{ content: '第一轮结束' },
			],
			() => ({ content: 'sub1 result' }),
			messageLog,
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('用户直发通知测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		await mgr.sendMessageStream('spawn', () => {});
		await sleep(50);
		expect(mgr.getSubagent('sub1')?.status).toBe('completed');

		// 用户从 Ctrl+T 视图直发（source='user'）
		await mgr.sendToSubagent('sub1', '用户追加的要求', 'user');

		// 下一轮：通知随开轮注入 master 上下文（Hook B 兜底投递）
		messageLog.length = 0;
		await mgr.sendMessageStream('继续', () => {});

		const text = messageLog
			.flat()
			.map((m) => (typeof m.content === 'string' ? m.content : ''))
			.join('\n');
		expect(text).toContain('<subagent-notification>');
		expect(text).toContain('用户追加的要求'); // user 侧内容
		expect(text).toContain('sub1 result'); // subagent 侧内容
	});

	it('wait(空数组)：返回 invalid_params 错误', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [waitCallMany([])] },
				{ content: 'done' },
			],
			() => ({ content: 'unused' }),
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('wait 空数组测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('wait empty array', (e) => events.push(e));

		const ev = findWaitEvent(events);
		expect(ev!.error).toBe('invalid_params');
		expect(ev!.toolResult).toContain('array is empty');
	});

	it('wait(无参数) 且无 pending 子代理：返回提示', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [waitCallAll()] },
				{ content: 'done' },
			],
			() => ({ content: 'unused' }),
		);
		mgr = new SessionManager(storage, client);
		mgr.setSubagentAsync(true);
		await mgr.startNewSession('wait 无 pending 测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('wait no pending', (e) => events.push(e));

		const ev = findWaitEvent(events);
		expect(ev!.toolResult).toContain('No pending subagents to wait for');
	});
});

// ─── SubagentSession 会话化（方案 B）────────────────────

describe('SubagentSession 会话化', () => {
	it('drive 完成：status completed + 消息队列保留（tool 轮含 assistant 消息）', async () => {
		const client = makeScriptClient([
			{ content: '开始', toolCalls: [{ id: 'c1', function: { name: 'fake_tool', arguments: '{}' } }] },
			{ content: '最终结果' },
		]);
		const { SubagentSession } = await import('../../src/core/subagent-session.js');
		const session = new SubagentSession({
			name: 'sub1', task: '任务', systemPrompt: 'subagent prompt',
			provider: client, tools: [fakeTool], onUsage: () => {},
		});
		const result = await session.drive();
		expect(result).toBe('最终结果');
		expect(session.status).toBe('completed');
		expect(session.endMs).toBeDefined();
		expect(session.messages[0].role).toBe('system');
		expect(session.messages[1]).toEqual({ role: 'user', content: '任务' });
		// 有 tool_calls 的轮：assistant（含 tool_calls）+ tool 消息被保留
		// 最终 content 也作为最后一条 assistant 消息入队（取代旧 result 字段，供 lastContent 派生）
		const assistantMsgs = session.messages.filter((m) => m.role === 'assistant');
		expect(assistantMsgs).toHaveLength(2);
		expect(assistantMsgs[0].tool_calls).toBeDefined();
		expect(assistantMsgs[1]).toMatchObject({ content: '最终结果' });
		expect(session.lastContent()).toBe('最终结果');
		expect(session.messages.some((m) => m.role === 'tool' && m.content === 'fake result')).toBe(true);
	});

	it('send 追加指令续跑：上下文保留，新 user 消息追加，返回新结果', async () => {
		const client = makeScriptClient([
			{ content: '第一轮结果' },
			{ content: '续跑结果' },
		]);
		const { SubagentSession } = await import('../../src/core/subagent-session.js');
		const session = new SubagentSession({
			name: 'sub1', task: '任务', systemPrompt: 'subagent prompt',
			provider: client, tools: [], onUsage: () => {},
		});
		await session.drive();
		expect(session.status).toBe('completed');

		const r2 = await session.send('继续深入');
		expect(r2).toBe('续跑结果');
		expect(session.status).toBe('completed');
		// 完整上下文保留：system + 两条 user（task + 指令）
		const userMsgs = session.messages.filter((m) => m.role === 'user');
		expect(userMsgs.map((m) => m.content)).toEqual(['任务', '继续深入']);
		expect(session.messages.length).toBeGreaterThanOrEqual(3);
	});

	it('running 中 send 拒绝（并发守卫）', async () => {
		const client = makeScriptClient([{ hang: true }]);
		const { SubagentSession } = await import('../../src/core/subagent-session.js');
		const session = new SubagentSession({
			name: 'sub1', task: '任务', systemPrompt: 'subagent prompt',
			provider: client, tools: [], onUsage: () => {},
		});
		const p = session.drive();
		await expect(session.send('别打断')).rejects.toThrow(/still running/);
		session.cancel();
		await p;
	});

	it('cancelled 后 send 可续跑（cancelled 非终态，需求 3）', async () => {
		const client = makeScriptClient([
			{ hang: true }, // 首轮挂起，等待取消
			{ content: '取消后继续完成' },
		]);
		const { SubagentSession } = await import('../../src/core/subagent-session.js');
		const session = new SubagentSession({
			name: 'sub1', task: '任务', systemPrompt: 'subagent prompt',
			provider: client, tools: [], onUsage: () => {},
		});
		const p = session.drive();
		setTimeout(() => session.cancel(), 10);
		await p;
		expect(session.status).toBe('cancelled');

		// 取消不是终态：追加指令 → 新建 run controller 续跑
		const r2 = await session.send('继续');
		expect(r2).toBe('取消后继续完成');
		expect(session.status).toBe('completed');
		expect(session.runs).toHaveLength(2);
		expect(session.runs[1].source).toBe('master');
	});

	it('runs 模型：逐轮记录 user 侧输入与来源，对话投影不含思维链与工具', async () => {
		const client = makeScriptClient([
			{
				reasoning: '内部思考',
				content: '第一轮结论',
				toolCalls: [{ id: 'c1', function: { name: 'fake_tool', arguments: '{}' } }],
			},
			{ content: '工具之后结论' },
			{ content: '第二轮结论' },
		]);
		const { SubagentSession } = await import('../../src/core/subagent-session.js');
		const session = new SubagentSession({
			name: 'sub1', task: '任务A', systemPrompt: 'subagent prompt',
			provider: client, tools: [fakeTool], onUsage: () => {},
		});
		await session.drive();
		await session.send('用户追问', 'user');

		expect(session.runs).toHaveLength(2);
		expect(session.runs[0]).toMatchObject({ userText: '任务A', source: 'task', status: 'completed' });
		expect(session.runs[1]).toMatchObject({ userText: '用户追问', source: 'user', status: 'completed' });
		// 首轮消息区间覆盖 user + assistant(含 tool_calls) + tool + 最终 assistant
		expect(session.runMessages(session.runs[0])[0]).toEqual({ role: 'user', content: '任务A' });

		const dialogue = session.renderDialogue();
		expect(dialogue).toContain('[run 1] task: 任务A');
		expect(dialogue).toContain('[run 2] user: 用户追问');
		expect(dialogue).toContain('subagent: 第一轮结论');
		expect(dialogue).toContain('subagent: 工具之后结论');
		expect(dialogue).toContain('subagent: 第二轮结论');
		// 对话投影：不含思维链、不含工具名/工具结果
		expect(dialogue).not.toContain('内部思考');
		expect(dialogue).not.toContain('fake_tool');
		expect(dialogue).not.toContain('fake result');
	});

	it('toRecord/fromRecord 往返：状态与消息上下文完整保留', async () => {
		const client = makeScriptClient([{ content: '结果' }]);
		const { SubagentSession } = await import('../../src/core/subagent-session.js');
		const session = new SubagentSession({
			name: 'sub1', task: '任务', systemPrompt: 'subagent prompt',
			provider: client, tools: [], onUsage: () => {},
		});
		await session.drive();
		const record = session.toRecord();
		expect(record.messages).toBeDefined();
		expect(record.messages!.length).toBeGreaterThan(0);
		expect(record.status).toBe('completed');

		// fromRecord 恢复：completed 状态、消息保留、可继续 send
		const restored = SubagentSession.fromRecord(record, { provider: client, tools: [], onUsage: () => {} });
		expect(restored.status).toBe('completed');
		expect(restored.messages.length).toBe(session.messages.length);
		const r2 = await restored.send('恢复后续跑');
		expect(r2).toBe('结果'); // steps 重复最后一步
	});
});

// ─── sendToSubagent（用户 / master 向子代理发消息）────────

describe('sendToSubagent', () => {
	let sendDir: string;
	let sendStorage: Storage;
	let sendMgr: SessionManager;

	beforeEach(async () => {
		sendDir = await mkdtemp(join(tmpdir(), 'deepseek-send-test-'));
		sendStorage = new Storage(sendDir);
	});

	afterEach(async () => {
		await rm(sendDir, { recursive: true, force: true });
	});

	it('spawn 完成后 send：子代理带上下文续跑并返回新结果', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task x')] },
				{ content: '主代理完成' },
			],
			(messages) => {
				const userCount = messages.filter((m) => m.role === 'user').length;
				return userCount === 1 ? { content: '第一轮结果' } : { content: '续跑结果' };
			},
		);
		sendMgr = new SessionManager(sendStorage, client);
		sendMgr.setSubagentAsync(true);
		await sendMgr.startNewSession('send 测试');
		sendMgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		await sendMgr.sendMessageStream('spawn', () => {});
		expect(sendMgr.getSubagent('sub1')?.status).toBe('completed');

		const r = await sendMgr.sendToSubagent('sub1', '再深入一点');
		expect(r).toBe('续跑结果');
		expect(sendMgr.getSubagent('sub1')?.status).toBe('completed');
		// 持久化含最新消息上下文
		const loaded = await sendStorage.loadSubagentRecord(sendMgr.getSessionId()!, 'sub1');
		expect(loaded?.messages?.filter((m) => m.role === 'user').map((m) => m.content))
			.toEqual(['task x', '再深入一点']);
	});

	it('不存在的子代理：抛 not found 错误', async () => {
		sendMgr = new SessionManager(sendStorage, makeSplitClient([{ content: 'ok' }], () => ({ content: 'x' })));
		await sendMgr.startNewSession('send not found');
		sendMgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });
		await expect(sendMgr.sendToSubagent('nope', 'hi')).rejects.toThrow(/not found/i);
	});

	it('resume 后恢复子代理会话：completed 可继续 send（方案 B 跨进程）', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task x')] },
				{ content: '主代理完成' },
			],
			() => ({ content: '历史结果' }),
		);
		sendMgr = new SessionManager(sendStorage, client);
		sendMgr.setSubagentAsync(true);
		await sendMgr.startNewSession('resume send 测试');
		sendMgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });
		await sendMgr.sendMessageStream('spawn', () => {});
		const sessionId = sendMgr.getSessionId()!;

		// 模拟重启：新 SessionManager + resumeSession
		const { SessionManager: SM2 } = await import('../../src/core/session.js');
		const client2 = makeSplitClient([{ content: 'ok' }], () => ({ content: '续跑结果' }));
		const mgr2 = new SM2(sendStorage, client2);
		await mgr2.resumeSession(sessionId);
		const restored = mgr2.getSubagent('sub1');
		expect(restored).toBeDefined();
		expect(restored!.status).toBe('completed');
		expect(restored!.messages.length).toBeGreaterThan(0);

		const r = await mgr2.sendToSubagent('sub1', '恢复后继续');
		expect(r).toBe('续跑结果');
	});
});

// ─── subagent_send 工具（agent loop 内拦截）────────────

describe('subagent_send 工具拦截', () => {
	let sendToolDir: string;

	beforeEach(async () => {
		sendToolDir = await mkdtemp(join(tmpdir(), 'deepseek-sendtool-test-'));
	});

	afterEach(async () => {
		await rm(sendToolDir, { recursive: true, force: true });
	});

	/** 从事件流中提取 subagent_send 的 tool_result 事件 */
	function findSendEvent(events: import('../../src/types/index.js').StreamEvent[]) {
		return events.find((e) => e.type === 'tool_result' && e.toolName === 'subagent_send');
	}

	it('spawn → send：master 向完成子代理追加指令，得到续跑结果（同步等待）', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task x')] },
				{ content: '', toolCalls: [sendCall('sub1', '继续深入')] },
				{ content: '主代理完成' },
			],
			(messages) => {
				const userCount = messages.filter((m) => m.role === 'user').length;
				return userCount === 1 ? { content: '第一轮结果' } : { content: '续跑结果' };
			},
		);
		const mgr = new SessionManager(new Storage(sendToolDir), client);
		mgr.setSubagentAsync(false);
		await mgr.startNewSession('subagent_send 测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('spawn and follow up', (e) => events.push(e));

		const ev = findSendEvent(events);
		expect(ev).toBeDefined();
		expect(ev!.toolResult).toContain('续跑结果');
		expect(ev!.error).toBeUndefined();
		// 子代理消息上下文保留两条 user 指令（task + 追加）
		const sub = mgr.getSubagent('sub1');
		expect(sub?.messages.filter((m) => m.role === 'user').map((m) => m.content))
			.toEqual(['task x', '继续深入']);
	});

	it('send 不存在的子代理：not_found 错误', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [sendCall('nope', 'hi')] },
				{ content: '主代理完成' },
			],
			() => ({ content: 'unused' }),
		);
		const mgr = new SessionManager(new Storage(sendToolDir), client);
		mgr.setSubagentAsync(false);
		await mgr.startNewSession('send not_found 测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('send missing', (e) => events.push(e));

		const ev = findSendEvent(events);
		expect(ev).toBeDefined();
		expect(ev!.error).toBe('not_found');
		expect(ev!.toolResult).toContain('nope');
	});

	it('failed 子代理可 send 续跑（failed → running → completed）', async () => {
		const client = makeSplitClient(
			[
				{ content: '', toolCalls: [spawnCall('sub1', 'task x')] },
				{ content: '', toolCalls: [sendCall('sub1', '修复一下')] },
				{ content: '主代理完成' },
			],
			(messages) => {
				const userCount = messages.filter((m) => m.role === 'user').length;
				// 第一次返回 Error: 前缀 → failed；续跑返回正常结果
				return userCount === 1 ? { content: 'Error: 第一步失败了' } : { content: '修复完成' };
			},
		);
		const mgr = new SessionManager(new Storage(sendToolDir), client);
		mgr.setSubagentAsync(false);
		await mgr.startNewSession('send failed 测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('spawn then fix', (e) => events.push(e));

		// 第一次 drive 返回 Error: 前缀 → 曾标 failed；send 续跑后覆盖为 completed
		const ev = findSendEvent(events);
		expect(ev).toBeDefined();
		expect(ev!.toolResult).toContain('修复完成');
		expect(ev!.error).toBeUndefined();
		expect(mgr.getSubagent('sub1')?.status).toBe('completed');
	});
});
