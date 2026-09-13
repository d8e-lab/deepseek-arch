/**
 * memory-forget.test.ts — 记忆淘汰（硬淘汰）单元测试
 *
 * 覆盖：confidence ≤ 2 可淘汰（写墓碑 + 退出索引 + 重建清单）、confidence 3 被拒绝
 * （只能取代，防归纳代理误删用户显式偏好）、不存在层回退（project → global）、
 * 缺参数、以及 meta（reason）写入审计。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../../src/core/memory-store.js';
import { forgetMemoryEntry, memoryForgetTool } from '../../src/tools/memory-forget.js';

describe('memory_forget', () => {
	let root: string;
	let store: MemoryStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'deepseek-memory-forget-'));
		store = new MemoryStore({
			projectDir: join(root, 'project'),
			globalDir: join(root, 'global'),
			masterMinConfidence: 2,
		});
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function seed(scope: 'project' | 'global', confidence: number) {
		return store.write(scope, {
			subject: 'topic.one',
			name: '主题一',
			description: '描述',
			type: 'user',
			confidence,
			body: '正文。',
		});
	}

	it('confidence 2：淘汰成功，条目退出索引（墓碑保留）', async () => {
		const w = await seed('project', 2);

		const r = await forgetMemoryEntry(store, { slug: w.slug, reason: 'no longer relevant' });

		expect(r.error).toBeUndefined();
		expect(r.content).toContain('retired');

		// 退出索引 = 不再出现在可注入清单里
		expect(await store.listEntries('project')).toHaveLength(0);
		const manifest = await readFile(join(root, 'project', 'MEMORY.md'), 'utf-8');
		expect(manifest).not.toContain('主题一');

		// 文件保留（演化记录），status 变 superseded
		const entry = await store.readEntry('project', w.slug);
		expect(entry?.status).toBe('superseded');

		const audit = await readFile(join(root, 'project', 'audit.jsonl'), 'utf-8');
		expect(audit).toContain('"kind":"forget"');
		expect(audit).toContain('no longer relevant');
	});

	it('confidence 3：拒绝淘汰（用户显式陈述只能由取代或用户本人删除）', async () => {
		const w = await seed('project', 3);

		const r = await forgetMemoryEntry(store, { slug: w.slug });

		expect(r.error).toBe('forbidden');
		expect(r.content).toContain('supersede');
		expect(await store.listEntries('project')).toHaveLength(1);
		expect((await store.readEntry('project', w.slug))?.status).toBe('active');
	});

	it('项目层没有则回退全局层', async () => {
		const w = await seed('global', 1);

		const r = await forgetMemoryEntry(store, { slug: w.slug });

		expect(r.error).toBeUndefined();
		expect(r.content).toContain('(global)');
		expect(await store.listEntries('global')).toHaveLength(0);
	});

	it('不存在 → not_found（两层都查过）', async () => {
		const r = await forgetMemoryEntry(store, { slug: 'nope' });
		expect(r.error).toBe('not_found');
		expect(r.content).toContain('either layer');
	});

	it('缺 slug → 参数错误', async () => {
		const r = await forgetMemoryEntry(store, {});
		expect(r.error).toBe('slug is required');
	});

	it('工具描述声明了 confidence 3 的限制与软淘汰优先', () => {
		expect(memoryForgetTool.name).toBe('memory_forget');
		expect(memoryForgetTool.requiresConfirm).toBe(false);
		expect(memoryForgetTool.description).toContain('confidence 1');
		expect(memoryForgetTool.parameters.required).toEqual(['slug']);
	});
});
