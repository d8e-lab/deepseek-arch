/**
 * memory-recall.test.ts — 召回选择单元测试
 *
 * 覆盖：预算内不调模型（零成本）、超预算用模型挑选、越界/非法下标过滤、
 * 模型报"都不相关"、解析失败/超时/API 错误 → 退化（按 updated 倒序且仍注入）、
 * alreadySurfaced 去重、maxItems 上限。
 */
import { describe, it, expect, vi } from 'vitest';
import { MemoryRecall, extractSelectedIndices } from '../../src/core/memory-recall.js';
import type { ModelProvider } from '../../src/core/model-provider.js';
import type { MemoryEntry } from '../../src/core/memory-store.js';
import type { ChatCompletionResponse } from '../../src/types/index.js';

function entry(n: number, over: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		slug: `topic-${n}`,
		name: `主题${n}`,
		description: `描述${n}${'x'.repeat(30)}`,
		type: 'user',
		subject: `topic.${n}`,
		tags: [],
		scope: 'project',
		confidence: 3,
		created: '2026-09-01T00:00:00Z',
		updated: `2026-09-${String(10 + n).padStart(2, '0')}T00:00:00Z`,
		status: 'active',
		body: 'b',
		filePath: `/tmp/topic-${n}.md`,
		...over,
	};
}

/** 构造只实现 chat() 的 provider；记录调用次数 */
function makeProvider(reply: string | (() => Promise<never>)): { provider: ModelProvider; calls: () => number } {
	let calls = 0;
	const provider = {
		async chat(): Promise<ChatCompletionResponse> {
			calls++;
			if (typeof reply === 'function') return reply();
			return {
				id: 'x', object: 'chat.completion', created: 0, model: 'm',
				choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
			} as ChatCompletionResponse;
		},
		chatStream: async function* () { /* 未使用 */ },
	} as unknown as ModelProvider;
	return { provider, calls: () => calls };
}

describe('MemoryRecall', () => {
	it('预算内且数量未超上限：直接全给，不调用模型', async () => {
		const { provider, calls } = makeProvider('{"selected":[1]}');
		const recall = new MemoryRecall({ provider, model: 'flash' });

		const r = await recall.select({ taskText: 't', candidates: [entry(1), entry(2)], maxItems: 10, maxTokens: 10_000 });
		expect(r.mode).toBe('all');
		expect(r.reason).toBe('budget_fits');
		expect(r.entries).toHaveLength(2);
		expect(calls()).toBe(0);
	});

	it('超预算：调用模型挑选，返回被选中的条目', async () => {
		const { provider, calls } = makeProvider('{"selected":[2]}');
		const recall = new MemoryRecall({ provider, model: 'flash' });

		const r = await recall.select({ taskText: 't', candidates: [entry(1), entry(2), entry(3)], maxItems: 1, maxTokens: 10_000 });
		expect(r.mode).toBe('llm');
		expect(r.entries.map((e) => e.slug)).toEqual(['topic-2']);
		expect(calls()).toBe(1);
	});

	it('越界与重复下标被过滤，maxItems 生效', async () => {
		const { provider } = makeProvider('{"selected":[1,1,99,-3,2,3]}');
		const recall = new MemoryRecall({ provider, model: 'flash' });

		const r = await recall.select({ taskText: 't', candidates: [entry(1), entry(2), entry(3)], maxItems: 2, maxTokens: 10_000 });
		expect(r.mode).toBe('llm');
		expect(r.entries.map((e) => e.slug)).toEqual(['topic-1', 'topic-2']);
	});

	it('模型明确返回空选择 → 尊重判断，不注入（不是失败）', async () => {
		const { provider } = makeProvider('{"selected":[]}');
		const recall = new MemoryRecall({ provider, model: 'flash' });

		const r = await recall.select({ taskText: 't', candidates: [entry(1), entry(2)], maxItems: 1, maxTokens: 10_000 });
		expect(r.mode).toBe('llm');
		expect(r.entries).toHaveLength(0);
		expect(r.reason).toBeUndefined();
	});

	it('模型输出不可解析 → 退化：按 updated 倒序仍注入', async () => {
		const { provider } = makeProvider('sorry, I cannot help with that');
		const recall = new MemoryRecall({ provider, model: 'flash' });

		const r = await recall.select({ taskText: 't', candidates: [entry(3), entry(1), entry(2)], maxItems: 2, maxTokens: 60 });
		expect(r.mode).toBe('fallback');
		expect(r.reason).toBe('llm_invalid');
		expect(r.entries[0].slug).toBe('topic-3'); // 保持入参顺序（调用方按 updated 倒序传入）
		expect(r.entries.length).toBeGreaterThan(0);
	});

	it('API 抛错 → 退化并标注原因（绝不因此少注入）', async () => {
		const { provider } = makeProvider(async () => {
			throw new Error('api down');
		});
		const recall = new MemoryRecall({ provider, model: 'flash' });

		const r = await recall.select({ taskText: 't', candidates: [entry(1), entry(2)], maxItems: 1, maxTokens: 10_000 });
		expect(r.mode).toBe('fallback');
		expect(r.reason).toBe('llm_error');
		expect(r.entries.length).toBeGreaterThan(0);
	});

	it('超时 → 退化并标注 timeout', async () => {
		const { provider } = makeProvider(() => new Promise<never>(() => { /* 永不返回 */ }));
		const recall = new MemoryRecall({ provider, model: 'flash', timeoutMs: 30 });

		const r = await recall.select({ taskText: 't', candidates: [entry(1), entry(2)], maxItems: 1, maxTokens: 10_000 });
		expect(r.mode).toBe('fallback');
		expect(r.reason).toBe('timeout');
	});

	it('alreadySurfaced 去重；全部已出示则直接返回空', async () => {
		const { provider, calls } = makeProvider('{"selected":[1]}');
		const recall = new MemoryRecall({ provider, model: 'flash' });

		const r = await recall.select({
			taskText: 't',
			candidates: [entry(1), entry(2)],
			maxItems: 5,
			maxTokens: 10_000,
			alreadySurfaced: new Set(['topic-1']),
		});
		expect(r.entries.map((e) => e.slug)).toEqual(['topic-2']);

		const r2 = await recall.select({
			taskText: 't',
			candidates: [entry(1)],
			maxItems: 5,
			maxTokens: 10_000,
			alreadySurfaced: new Set(['topic-1']),
		});
		expect(r2.entries).toHaveLength(0);
		expect(r2.reason).toBe('no_candidates');
		expect(calls()).toBe(0); // 去重后仍在预算内 → 两个用例都没必要调用模型
	});

	it('预算约束：选中条目按预算截断', async () => {
		const { provider } = makeProvider('{"selected":[1,2,3]}');
		const recall = new MemoryRecall({ provider, model: 'flash' });
		const candidates = [entry(1), entry(2), entry(3)];

		const r = await recall.select({ taskText: 't', candidates, maxItems: 3, maxTokens: 40 });
		expect(r.mode).toBe('llm');
		expect(r.entries.length).toBeLessThan(3);
		expect(r.tokens).toBeLessThanOrEqual(40);
	});

	it('extractSelectedIndices：JSON / 宽松数字 / 无内容', () => {
		expect(extractSelectedIndices('{"selected":[1,2]}')).toEqual([1, 2]);
		expect(extractSelectedIndices('```json\n{"selected":[3]}\n```')).toEqual([3]);
		expect(extractSelectedIndices('selected: 1, 3')).toEqual([1, 3]);
		expect(extractSelectedIndices('{"selected":[]}')).toEqual([]);
		expect(extractSelectedIndices('no numbers here')).toBeNull();
		expect(extractSelectedIndices('')).toBeNull();
	});

	it('下标全部越界：视为召回失败 → 退化为按 updated 倒序，绝不因此一条都不注入（v3）', async () => {
		const { provider } = makeProvider('{"selected":[99,100]}');
		const recall = new MemoryRecall({ provider, model: 'flash' });
		const candidates = [entry(1), entry(2), entry(3)];

		const r = await recall.select({ taskText: 't', candidates, maxItems: 2, maxTokens: 10_000 });
		expect(r.mode).toBe('fallback');
		expect(r.reason).toBe('llm_invalid');
		expect(r.entries.length).toBeGreaterThan(0);
	});

	it('模型明确返回空数组：尊重"都不相关"，不注入（与"全部越界"区分开）', async () => {
		const { provider } = makeProvider('{"selected":[]}');
		const recall = new MemoryRecall({ provider, model: 'flash' });
		const candidates = [entry(1), entry(2), entry(3)];

		const r = await recall.select({ taskText: 't', candidates, maxItems: 2, maxTokens: 10_000 });
		expect(r.mode).toBe('llm');
		expect(r.entries).toHaveLength(0);
	});
});
