/**
 * memory-agent.test.ts — 后台归纳代理单元测试
 *
 * 覆盖：正常写入 + 游标推进 + 审计、single-flight（busy）、最小间隔、
 * 主/后台互斥（master 写过则跳过并推进游标）、写入配额、watchdog（工具数/超时）、
 * 输入裁剪（无工具轨迹与思维链）、失败只写审计不抛。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../../src/core/memory-store.js';
import { MemoryAgent, renderInput } from '../../src/core/memory-agent.js';
import type { ModelProvider } from '../../src/core/model-provider.js';
import type { Message, StreamChunk } from '../../src/types/index.js';

/** 脚本化 provider：按步骤依次返回；每步可选 tool_calls 或纯文本 */
type Step = { content?: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] };

function makeProvider(steps: Step[], onCall?: (messages: Message[]) => void): ModelProvider {
	let i = 0;
	async function* gen(messages: Message[]): AsyncGenerator<StreamChunk> {
		onCall?.(messages);
		const step = steps[Math.min(i, steps.length - 1)];
		i++;
		const delta: Record<string, unknown> = {};
		if (step.content) delta.content = step.content;
		if (step.toolCalls) {
			delta.tool_calls = step.toolCalls.map((tc, idx) => ({
				index: idx, id: tc.id, type: 'function',
				function: { name: tc.name, arguments: JSON.stringify(tc.args) },
			}));
		}
		yield {
			id: 'c', object: 'chat.completion.chunk', created: 0, model: 'flash',
			choices: [{ index: 0, delta, finish_reason: null }],
		} as StreamChunk;
	}
	return { chatStream: gen } as unknown as ModelProvider;
}

function makeAgent(provider: ModelProvider, store: MemoryStore, over: Partial<ConstructorParameters<typeof MemoryAgent>[0]> = {}) {
	return new MemoryAgent({
		provider, store, model: 'flash',
		maxInputTurns: 3, maxInputTokens: 6000, maxWritesPerRun: 3,
		maxToolCalls: 8, timeoutMs: 90_000, minIntervalSec: 0,
		...over,
	});
}

describe('MemoryAgent', () => {
	let root: string;
	let store: MemoryStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'deepseek-memory-agent-'));
		store = new MemoryStore({ projectDir: join(root, 'project'), globalDir: join(root, 'global') });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('正常归纳：写入记忆 + 推进游标 + 写审计', async () => {
		const provider = makeProvider([
			{
				toolCalls: [{
					id: 'c1', name: 'memory_write',
					args: { subject: 'reply.format', name: '回复格式', description: '先给结论', confidence: 3, body: '先给结论。' },
				}],
			},
			{ content: '本轮写入 1 条。' },
		]);
		const agent = makeAgent(provider, store);

		const r = await agent.run({
			turns: [{ user: '我希望回复先给结论', assistant: '好的', turnId: 't1' }],
			currentUser: '我希望回复先给结论',
			nextCursor: 't1',
		});

		expect(r.status).toBe('done');
		expect(r.writes).toEqual([{ slug: 'reply-format', action: 'add' }]);
		expect(r.notes).toContain('写入 1 条');
		expect((await store.getState('project')).lastExtractedTurnId).toBe('t1');

		const audit = await readFile(join(root, 'project', 'audit.jsonl'), 'utf-8');
		expect(audit).toContain('"kind":"agent_run"');
		expect(audit).toContain('"writes":[{"slug":"reply-format","action":"add"}]');
	});

	it('输入只含用户消息与助手最终回复（不含工具轨迹/思维链）', () => {
		const text = renderInput(
			[{ user: '问题', assistant: '回答', turnId: 't1' }],
			'本轮问题',
		);
		expect(text).toContain('## 用户\n问题');
		expect(text).toContain('## 助手\n回答');
		expect(text).toContain('## 本轮用户消息（重点）\n本轮问题');
		expect(text).not.toContain('tool_call');
	});

	it('single-flight：运行中重复触发被跳过', async () => {
		let resolveHold: () => void = () => {};
		const hold = new Promise<void>((r) => { resolveHold = r; });
		const provider = {
			async *chatStream() {
				await hold;
				yield {
					id: 'c', object: 'chat.completion.chunk', created: 0, model: 'f',
					choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }],
				} as StreamChunk;
			},
		} as unknown as ModelProvider;
		const agent = makeAgent(provider, store);

		const input = { turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u' };
		const first = agent.run(input);
		await new Promise((r) => setTimeout(r, 10));
		const second = await agent.run(input);
		expect(second.status).toBe('skipped');
		expect(second.reason).toBe('busy');

		resolveHold();
		expect((await first).status).toBe('done');
	});

	it('最小间隔：两次归纳间隔不足时跳过', async () => {
		const agent = makeAgent(makeProvider([{ content: 'ok' }]), store, { minIntervalSec: 60 });
		const input = { turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u' };

		expect((await agent.run(input)).status).toBe('done');
		const second = await agent.run(input);
		expect(second.status).toBe('skipped');
		expect(second.reason).toBe('interval');
	});

	it('主/后台互斥：master 写过记忆 → 跳过且推进游标', async () => {
		const agent = makeAgent(makeProvider([{ content: 'should not run' }]), store);
		const r = await agent.run({
			turns: [{ user: 'u', assistant: 'a', turnId: 't1' }],
			currentUser: 'u',
			masterWrote: true,
			nextCursor: 't1',
		});
		expect(r.status).toBe('skipped');
		expect(r.reason).toBe('master_wrote');
		expect((await store.getState('project')).lastExtractedTurnId).toBe('t1');
		expect(await store.listEntries('project')).toHaveLength(0);
	});

	it('写入配额：超过 maxWritesPerRun 的写入被拒绝（agent 仍正常收尾）', async () => {
		const write = (i: number) => ({
			id: `c${i}`, name: 'memory_write',
			args: { subject: `topic.${i}`, name: `T${i}`, description: 'd', confidence: 3, body: `b${i}` },
		});
		// 一轮里连续 4 次写入 → 第 4 次应被配额拒绝
		const provider = makeProvider([{ toolCalls: [write(1), write(2), write(3), write(4)] }, { content: 'done' }]);
		const agent = makeAgent(provider, store, { maxWritesPerRun: 3 });

		const r = await agent.run({ turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u' });
		expect(r.writes).toHaveLength(3);
		expect(await store.listEntries('project')).toHaveLength(3);
	});

	it('watchdog：工具调用数超限 → 中止并标 tool_limit，游标不推进', async () => {
		const steps: Step[] = Array.from({ length: 10 }, (_, i) => ({
			toolCalls: [{ id: `c${i}`, name: 'memory_read', args: { path: 'x.md' } }],
		}));
		const agent = makeAgent(makeProvider(steps), store, { maxToolCalls: 3, minIntervalSec: 0 });

		const r = await agent.run({
			turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u', nextCursor: 't1',
		});
		expect(r.status).toBe('error');
		expect(r.reason).toBe('tool_limit');
		// 中止窗口不推进游标 → 下一轮可重试
		expect((await store.getState('project')).lastExtractedTurnId).toBeUndefined();
	});

	it('watchdog：超时 → 中止并标 timeout（不抛错）', async () => {
		// provider 需响应 signal（真实 provider 由 fetch abort 实现同一行为）
		const provider = {
			async *chatStream(_messages: Message[], opts?: { signal?: AbortSignal }): AsyncGenerator<StreamChunk> {
				await new Promise<void>((resolve) => {
					if (opts?.signal?.aborted) return resolve();
					opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
					const t = setTimeout(resolve, 5000);
					if (typeof t.unref === 'function') t.unref();
				});
				const err = new Error('aborted');
				err.name = 'AbortError';
				throw err;
			},
		} as unknown as ModelProvider;
		const agent = makeAgent(provider, store, { timeoutMs: 40 });

		const r = await agent.run({ turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u' });
		expect(r.status).toBe('error');
		expect(r.reason).toBe('timeout');
	});

	it('无输入（空轮次或空消息）→ 跳过并推进游标', async () => {
		const agent = makeAgent(makeProvider([{ content: 'x' }]), store);
		const r = await agent.run({ turns: [], currentUser: '', nextCursor: 't9' });
		expect(r.status).toBe('skipped');
		expect(r.reason).toBe('no_input');
		expect((await store.getState('project')).lastExtractedTurnId).toBe('t9');
	});

	it('provider 抛错 → 记审计 error 且不抛给调用方', async () => {
		const provider = {
			async *chatStream(): AsyncGenerator<StreamChunk> {
				throw new Error('api down');
			},
		} as unknown as ModelProvider;
		const agent = makeAgent(provider, store);

		const r = await agent.run({ turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u' });
		expect(r.status).toBe('error');
		expect(r.reason).toBe('failed');
		const audit = await readFile(join(root, 'project', 'audit.jsonl'), 'utf-8');
		expect(audit).toContain('"kind":"error"');
		expect(audit).toContain('api down');
	});

	it('输入裁剪：只保留最近 maxInputTurns 轮，且带 token 预算', async () => {
		const seen: string[] = [];
		const provider = makeProvider([{ content: 'ok' }], (messages) => {
			seen.push(String(messages[1]?.content ?? ''));
		});
		const agent = makeAgent(provider, store, { maxInputTurns: 2 });
		const turns = ['t1', 't2', 't3', 't4'].map((id, i) => ({ user: `user-${i}`, assistant: `asst-${i}`, turnId: id }));

		await agent.run({ turns, currentUser: 'user-3' });
		expect(seen[0]).not.toContain('user-0');
		expect(seen[0]).not.toContain('user-1');
		expect(seen[0]).toContain('user-2');
		expect(seen[0]).toContain('user-3');
	});
});
