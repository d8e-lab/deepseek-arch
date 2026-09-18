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
import { MemoryAgent, renderInput, pickRelated } from '../../src/core/memory-agent.js';
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
		// v3：游标由调用方（会话层）持久化，agent 只返回"该推进到哪"
		expect(r.advanceCursorTo).toBe('t1');

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
		expect(r.advanceCursorTo).toBe('t1');
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
		expect(r.limitReason).toBe('tool_limit');
		// 首次中止不推进游标 → 下一轮可重试该窗口
		expect(r.advanceCursorTo).toBeUndefined();
	});

	it('watchdog：同一窗口连续失败达到上限 → 放弃该窗口（推进游标），不再无限重试', async () => {
		const steps: Step[] = Array.from({ length: 10 }, (_, i) => ({
			toolCalls: [{ id: `c${i}`, name: 'memory_read', args: { path: 'x.md' } }],
		}));
		const agent = makeAgent(makeProvider(steps), store, { maxToolCalls: 3, minIntervalSec: 0 });
		const input = {
			turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u', nextCursor: 't1',
		};

		const first = await agent.run(input);
		expect(first.advanceCursorTo).toBeUndefined();

		const second = await agent.run(input);
		expect(second.status).toBe('error');
		// 连续第二次失败 → 放弃窗口并推进游标（调用方据此跳过该段）
		expect(second.advanceCursorTo).toBe('t1');
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
		expect(r.advanceCursorTo).toBe('t9');
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

	// ── 记忆索引前置（含候选池）：agent 的升级/去重判断依据 ──────────────────

	it('输入前置现有记忆索引：正式条目 + 候选区（conf 1 只有 agent 看得到）', async () => {
		await store.write('project', { subject: 'reply.format', name: '正式条', description: '可见', confidence: 3, body: 'b1' });
		const cand = await store.write('project', { subject: 'style.tone', name: '候选条', description: '模糊', confidence: 1, body: 'b2' });
		// 直接摆使用次数：recordUse 会触发会话内即时升级（v3），而本用例要的是"仍是候选"的场景
		await store.setState('project', {
			usage: { [cand.slug]: { uses: 3, lastUsedAt: new Date().toISOString() } },
		});

		const seen: string[] = [];
		const provider = makeProvider([{ content: 'ok' }], (messages) => {
			seen.push(String(messages[1]?.content ?? ''));
		});
		const agent = makeAgent(provider, store);
		await agent.run({ turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u' });

		const input = seen[0];
		expect(input).toContain('现有记忆');
		expect(input).toContain('正式条目');          // 段标题
		expect(input).toContain('正式条');            // 正式条目内容
		expect(input).toContain('候选区');            // 段标题（master 不可见的那批）
		expect(input).toContain('待观察');            // conf 1 = 待观察
		expect(input).toContain(cand.slug);          // 候选条目（拿得到 slug 才能升级）
		expect(input).toContain('共被使用 3 次');     // 升级判断依据
		expect(input.indexOf('现有记忆')).toBeLessThan(input.indexOf('需要归纳的对话片段'));  // 清单前置
	});

	it('「可能与本轮相关」：按本轮对话关键词初筛（语义接近的条目顶到眼前）', async () => {
		await store.write('project', { subject: 'reply.format', name: '回复格式', description: '回复先给结论', tags: ['reply'], confidence: 3, body: '先给结论。' });
		await store.write('project', { subject: 'test.policy', name: '测试策略', description: '集成测试用真实依赖', tags: ['test'], confidence: 3, body: '集成测试不打桩。' });
		const cand = await store.write('project', { subject: 'commit.message', name: '提交信息', description: '遵循约定', tags: ['git'], confidence: 1, body: '提交信息写清动机。' });

		const seen: string[] = [];
		const provider = makeProvider([{ content: 'ok' }], (messages) => {
			seen.push(String(messages[1]?.content ?? ''));
		});
		const agent = makeAgent(provider, store);
		await agent.run({
			turns: [{ user: '提交信息怎么写比较好？', assistant: '按约定来。', turnId: 't1' }],
			currentUser: '提交信息怎么写比较好？',
		});

		const input = seen[0];
		expect(input).toContain('可能与本轮相关');
		const related = input.slice(input.indexOf('可能与本轮相关'));
		expect(related).toContain(cand.slug);          // 语义接近的候选条目被挑出来
		expect(related).toContain('候选池');            // 并标注它在候选池
		expect(related).not.toContain('测试策略');      // 不相关的条目不进这段
	});

	it('关键词初筛：拉丁词 + 中文二元组，标签/subject 加权；无关则不出段', () => {
		const base = {
			name: 'A', description: '描述', type: 'user' as const, subject: 'replyformat',
			tags: ['reply'], scope: 'project' as const, confidence: 3,
			created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z',
			status: 'active' as const, body: '正文', filePath: '/x.md',
		};
		expect(pickRelated([{ ...base, slug: 'a' }], '帮我改一下 reply 的风格').map((e) => e.slug)).toEqual(['a']);
		expect(pickRelated([{ ...base, slug: 'a' }], '今天天气不错')).toEqual([]);
		expect(
			pickRelated(
				[{ ...base, slug: 'b', name: '提交信息', description: '提交信息写清动机', subject: 'commitmessage', tags: [], body: 'b' }],
				'提交信息要写什么？',
			).map((e) => e.slug),
		).toEqual(['b']);
	});

	// ── 淘汰（memory_forget）：归纳时顺带清理过时记忆 ──────────────────────
	async function seed(scope: 'project' | 'global', subject: string, confidence: number) {
		return store.write(scope, {
			subject, name: `主题-${subject}`, description: 'd', type: 'user', confidence, body: 'b',
		});
	}

	it('memory_forget：淘汰低置信条目并记录 action=forget', async () => {
		const w = await seed('project', 'topic.a', 2);
		expect(await store.listEntries('project')).toHaveLength(1); // 前置：在可见清单里
		const provider = makeProvider([
			{ toolCalls: [{ id: 'c1', name: 'memory_forget', args: { slug: w.slug, reason: '话题已结束' } }] },
			{ content: '清理 1 条。' },
		]);
		const agent = makeAgent(provider, store);

		const r = await agent.run({ turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u' });

		expect(r.status).toBe('done');
		expect(r.writes).toEqual([{ slug: w.slug, action: 'forget' }]);
		expect(await store.listEntries('project')).toHaveLength(0);
		expect((await store.readEntry('project', w.slug))?.status).toBe('superseded');
	});

	it('memory_forget：confidence 3 被拒绝，条目保留（代理无法删除用户显式偏好）', async () => {
		const w = await seed('project', 'topic.b', 3);
		const results: string[] = [];
		const provider = makeProvider(
			[
				{ toolCalls: [{ id: 'c1', name: 'memory_forget', args: { slug: w.slug } }] },
				{ content: '放弃清理。' },
			],
			(messages) => {
				const last = messages[messages.length - 1] as { content?: unknown };
				if (typeof last?.content === 'string') results.push(last.content);
			},
		);
		const agent = makeAgent(provider, store);

		const r = await agent.run({ turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u' });

		expect(r.writes).toEqual([]); // 未淘汰 → 不记写
		expect(results.join('\n')).toContain('Refused');
		expect(await store.listEntries('project')).toHaveLength(1);
	});

	it('memory_forget：每轮硬淘汰上限 3 条（不计入写入配额，但受独立上限约束）', async () => {
		const slugs: string[] = [];
		for (const s of ['topic.c', 'topic.d', 'topic.e', 'topic.f']) {
			slugs.push((await seed('project', s, 2)).slug);
		}
		const provider = makeProvider([
			...slugs.map((slug, i) => ({
				toolCalls: [{ id: `c${i}`, name: 'memory_forget', args: { slug } }],
			})),
			{ content: 'done' },
		]);
		const agent = makeAgent(provider, store, { maxToolCalls: 20 });

		const r = await agent.run({ turns: [{ user: 'u', assistant: 'a', turnId: 't1' }], currentUser: 'u' });

		expect(r.writes.filter((w) => w.action === 'forget')).toHaveLength(3); // 上限 3
		const statuses = await Promise.all(slugs.map(async (s) => (await store.readEntry('project', s))?.status));
		expect(statuses.filter((s) => s === 'superseded')).toHaveLength(3);
		expect(statuses.filter((s) => s === 'active')).toHaveLength(1); // 第 4 条保留
	});
});
