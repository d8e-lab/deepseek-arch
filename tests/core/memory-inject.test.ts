/**
 * memory-inject.test.ts — 注入层单元测试
 *
 * 覆盖：清单块渲染与解析（resume 播种）、变化检测（新增/更新/移除）、
 * 变化提醒块（含预算截断）、读过的条目被更新提醒、去重集合重置、关闭开关。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../../src/core/memory-store.js';
import { MemoryInjector, parseListingSlugs, diffSeen, truncateToBudget } from '../../src/core/memory-inject.js';
import { MemoryRecall } from '../../src/core/memory-recall.js';
import type { ModelProvider } from '../../src/core/model-provider.js';
import type { ChatCompletionResponse } from '../../src/types/index.js';

/** 召回桩：默认返回空选择（不影响清单路径） */
function stubRecall(): MemoryRecall {
	const provider = {
		async chat(): Promise<ChatCompletionResponse> {
			return {
				id: 'x', object: 'chat.completion', created: 0, model: 'm',
				choices: [{ index: 0, message: { role: 'assistant', content: '{"selected":[]}' }, finish_reason: 'stop' }],
			} as ChatCompletionResponse;
		},
		chatStream: async function* () { /* unused */ },
	} as unknown as ModelProvider;
	return new MemoryRecall({ provider, model: 'flash' });
}

describe('memory-inject', () => {
	let root: string;
	let store: MemoryStore;
	let injector: MemoryInjector;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'deepseek-memory-inject-'));
		store = new MemoryStore({ projectDir: join(root, 'project'), globalDir: join(root, 'global') });
		injector = new MemoryInjector({
			store, recall: stubRecall(), maxInjectTokens: 800, deltaInjectTokens: 200,
		});
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('无记忆时清单块为 null（保证"无记忆 = 现状字节"）', async () => {
		const r = await injector.buildListingBlock('任务');
		expect(r.block).toBeNull();
	});

	it('清单块含标签与条目行；关闭开关时始终 null', async () => {
		await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });
		const r = await injector.buildListingBlock('任务');
		expect(r.block).toContain('<memory_listing>');
		expect(r.block).toContain('- [A](a-b.md) — d (confidence 3, updated today)');
		expect(r.block).toContain('memory_read');

		const off = new MemoryInjector({
			store, recall: stubRecall(), maxInjectTokens: 800, deltaInjectTokens: 200, enabled: false,
		});
		expect((await off.buildListingBlock('任务')).block).toBeNull();
		expect(await off.buildUpdateBlock()).toBeNull();
	});

	it('列表块可被 parseListingSlugs 解析（resume 播种用）', async () => {
		await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });
		await store.write('global', { subject: 'c.d', name: 'C', description: 'd', confidence: 3, body: 'y' });
		const r = await injector.buildListingBlock('任务');
		expect(parseListingSlugs(r.block!)).toEqual(['a-b', 'c-d']);
	});

	it('resume 播种：快照里的清单算"已见"，之后只有真变化才提醒', async () => {
		await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });
		const first = await injector.buildListingBlock('任务');
		const snapshot = `system prompt 前缀\n${first.block}`;

		// 新 injector 模拟重新 resume：用快照播种
		const fresh = new MemoryInjector({ store, recall: stubRecall(), maxInjectTokens: 800, deltaInjectTokens: 200 });
		fresh.seedFromSystemPrompt(snapshot);
		expect(await fresh.buildUpdateBlock()).toBeNull(); // 没变化 → 不提醒

		await store.write('project', { subject: 'e.f', name: 'E', description: 'd2', confidence: 3, body: 'z' });
		const update = await fresh.buildUpdateBlock();
		expect(update).toContain('<memory-update>');
		expect(update).toContain('added');
		expect(update).toContain('E');
		expect(await fresh.buildUpdateBlock()).toBeNull(); // 只提醒一次
	});

	it('变化检测：更新与移除都能识别', async () => {
		const a = await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });
		await injector.buildListingBlock('任务');

		// 更新 A
		await new Promise((r) => setTimeout(r, 5));
		await store.write('project', { slug: a.slug, subject: 'a.b', name: 'A2', description: 'd', confidence: 3, body: 'x2' });
		const update = await injector.buildUpdateBlock();
		expect(update).toContain('updated');
		expect(update).toContain('A2');

		// 移除（forget → 退出索引）
		await store.forget('project', a.slug);
		const removed = await injector.buildUpdateBlock();
		expect(removed).toContain('removed');
		expect(removed).toContain(a.slug);
	});

	it('置信度降到阈值以下的条目视为移除（不再注入）', async () => {
		const a = await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 2, body: 'x' });
		await injector.buildListingBlock('任务');
		await store.write('project', { slug: a.slug, subject: 'a.b', name: 'A', description: 'd', confidence: 1, body: 'x' });
		const update = await injector.buildUpdateBlock();
		expect(update).toContain('removed');
	});

	it('读过的条目被更新 → 单独提醒；未变化则不提醒（且只提醒一次）', async () => {
		const a = await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });
		await injector.markRead(a.slug); // 记录"模型读过当前版本"
		expect(await injector.buildReadUpdateBlock([a.slug])).toBeNull(); // 未变化 → 不提醒

		await new Promise((r) => setTimeout(r, 5));
		await store.write('project', { slug: a.slug, subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x2' });

		const block = await injector.buildReadUpdateBlock([a.slug]);
		expect(block).toContain('<memory-update>');
		expect(block).toContain('you read earlier');
		expect(await injector.buildReadUpdateBlock([a.slug])).toBeNull(); // 只提醒一次
		expect(await injector.buildReadUpdateBlock(['not-exist'])).toBeNull();
	});

	it('buildDueBlock：到期条目渲染提醒块并清空 remindAt（一次性）', async () => {
		await store.write('project', {
			subject: 'defer.a', name: '到期项', description: 'd', confidence: 3, body: 'b',
			remindAt: '2020-01-01T00:00:00Z',
		});
		const r = await injector.buildDueBlock();
		expect(r).not.toBeNull();
		expect(r!.block).toContain('<memory-due>');
		expect(r!.block).toContain('到期项');
		expect(r!.slugs).toEqual(['defer-a']);

		// 一次性：再次调用不再有内容，且条目本身仍在
		expect(await injector.buildDueBlock()).toBeNull();
		expect((await store.readEntry('project', 'defer-a'))!.body).toBe('b');

		// 未到期 / 无 remindAt → 无内容
		await store.write('project', { subject: 'future.x', name: '未来', description: 'd', confidence: 3, body: 'b', remindAt: '2999-01-01T00:00:00Z' });
		expect(await injector.buildDueBlock()).toBeNull();
	});

	it('markSurfaced / resetSurfaced：去重集合可重置（compact 后）', async () => {
		await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });
		injector.markSurfaced(['a-b']);
		expect(injector.seenSnapshot().size).toBe(0); // seen 与 surfaced 是两套状态
		injector.resetSurfaced();
		expect((await injector.buildListingBlock('任务')).block).toContain('a-b.md');
	});

	it('纯函数：diffSeen / truncateToBudget', () => {
		const entry = (slug: string, updated: string) => ({
			slug, name: slug, description: 'd', type: 'user' as const, subject: slug, tags: [],
			scope: 'project' as const, confidence: 3, created: updated, updated, status: 'active' as const,
			body: '', filePath: '',
		});
		const diff = diffSeen(new Map([['a', 'u1'], ['b', 'u2']]), [entry('a', 'u1-new'), entry('c', 'u3')]);
		expect(diff.updated.map((e) => e.slug)).toEqual(['a']);
		expect(diff.added.map((e) => e.slug)).toEqual(['c']);
		expect(diff.removed).toEqual(['b']);

		const long = 'x'.repeat(3000);
		expect(truncateToBudget(long, 10)).toContain('(truncated)');
		expect(truncateToBudget('short', 100)).toBe('short');
	});
});
