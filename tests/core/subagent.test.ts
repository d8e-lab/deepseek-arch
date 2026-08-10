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

// ─── runSubagentLoop 单元测试 ───────────────────────

describe('runSubagentLoop', () => {
	it('完整循环：thinking/content/tool_call/tool_result 条目发射（M-7）', async () => {
		const client = makeScriptClient([
			{ reasoning: '思考中', content: '开始', toolCalls: [{ id: 'c1', function: { name: 'fake_tool', arguments: '{}' } }] },
			{ content: '最终结果' },
		]);
		const entries: SubagentRoundEntry[] = [];
		const result = await runSubagentLoop('任务', client, [fakeTool], 'subagent prompt', undefined, {
			onEntry: (e) => entries.push(e),
		});
		expect(result).toBe('最终结果');
		expect(entries.some((e) => e.type === 'thinking' && e.content === '思考中')).toBe(true);
		expect(entries.filter((e) => e.type === 'content')).toHaveLength(2);
		expect(entries.some((e) => e.type === 'tool_call' && e.toolName === 'fake_tool')).toBe(true);
		expect(entries.some((e) => e.type === 'tool_result' && e.content === 'fake result')).toBe(true);
	});

	it('onUsage 回调收集每轮 usage（O-1）', async () => {
		const client = makeScriptClient([
			{ content: '结果', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
		]);
		const usages: TokenUsage[] = [];
		await runSubagentLoop('任务', client, [], 'prompt', undefined, { onUsage: (u) => usages.push(u) });
		expect(usages).toHaveLength(1);
		expect(usages[0].total_tokens).toBe(8);
	});

	it('signal abort 返回 SUBAGENT_CANCELLED（I-1/I-2）', async () => {
		const controller = new AbortController();
		const client = makeScriptClient([{ hang: true }]);
		const p = runSubagentLoop('任务', client, [], 'prompt', controller.signal);
		setTimeout(() => controller.abort(), 10);
		const result = await p;
		expect(result).toBe(SUBAGENT_CANCELLED);
	});

	it('工具执行抛 AbortError 返回 SUBAGENT_CANCELLED', async () => {
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
		const result = await runSubagentLoop('任务', client, [abortingTool], 'prompt');
		expect(result).toBe(SUBAGENT_CANCELLED);
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
		const record = mgr.getSubagentStore().get('sub1');
		expect(record).toBeDefined();
		expect(record!.status).toBe('completed');
		expect(record!.result).toBe('子代理结果');
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
		expect(mgr.getSubagentStore().get('sub1')?.status).toBe('running');
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
		expect(mgr.getSubagentStore().get('sub1')?.status).toBe('cancelled');
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
		expect(mgr.getSubagentStore().get('a')?.status).toBe('cancelled');
		expect(mgr.getSubagentStore().get('b')?.status).toBe('cancelled');
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
		expect(mgr.getSubagentStore().get('B')?.status).toBe('completed');
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

	it('wait(已取走的子代理)：返回 already_retrieved 错误', async () => {
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
		await mgr.startNewSession('wait already_retrieved 测试');
		mgr.setSystemPrompt({ role: 'system', content: '你是有用的助手。' });

		const events: import('../../src/types/index.js').StreamEvent[] = [];
		await mgr.sendMessageStream('wait twice', (e) => events.push(e));

		const waitEvents = events.filter((e) => e.type === 'tool_result' && e.toolName === 'wait');
		expect(waitEvents).toHaveLength(2);
		expect(waitEvents[0].error).toBeUndefined(); // 第一次取走成功
		expect(waitEvents[1].error).toBe('already_retrieved');
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
