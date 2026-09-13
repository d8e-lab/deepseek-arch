/**
 * memory-lru.test.ts — LRU 主动升降级 / 归档 与索引自维护
 *
 * 覆盖：使用计数（写入即使用、读工具记使用、注入不计）、升级（阈值 + 必须最近有使用）、
 * 降级（一次一级、下限 1）、pinned 免疫、候选池归档（移出扫描）、dry-run 零副作用、
 * 关闭开关、审计落盘，以及 write/forget/pin 后索引自动刷新（不需调用方 rebuildIndex）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../../src/core/memory-store.js';

const DAY = 86_400_000;

describe('memory LRU', () => {
	let root: string;
	let projectDir: string;
	let globalDir: string;
	let store: MemoryStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'deepseek-memory-lru-'));
		projectDir = join(root, 'project');
		globalDir = join(root, 'global');
		store = new MemoryStore({ projectDir, globalDir, masterMinConfidence: 2 });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	/** 写一条并把它"变旧"：直接改 usage 的 lastUsedAt（模拟 N 天没被用过） */
	async function seed(slug: string, confidence: number, idleDays: number, uses = 0) {
		const w = await store.write('project', {
			subject: slug, name: slug, description: 'd', confidence, body: 'b', slug,
		});
		const old = new Date(Date.now() - idleDays * DAY).toISOString();
		// 注意键必须用 store 生成的 slug（`a.one` → `a-one`），否则条目根本没有使用记录
		await store.setState('project', { usage: { [w.slug]: { uses, lastUsedAt: old } } });
		return w.slug;
	}

	it('写入即一次使用；读工具记使用；注入（manifest）不计', async () => {
		const slug = await seed('a.one', 2, 0);
		// seed 内部先 write（记 1 次），随后被 setState 覆盖为 uses=0 → 这里重新写一次
		await store.write('project', { subject: 'a.one', name: 'a.one', description: 'd', confidence: 2, body: 'b', slug });
		await store.recordUse('project', slug);
		await store.manifest('project');           // 注入不计
		await store.manifestAll(10_000);

		const usage = (await store.getState('project')).usage!;
		expect(usage[slug].uses).toBe(2);
		expect(Date.now() - Date.parse(usage[slug].lastUsedAt)).toBeLessThan(5_000);
	});

	it('升级：使用次数达标且最近有使用 → +1（封顶 3），并消费计数', async () => {
		const slug = await seed('a.one', 2, 1, 2);

		const r = await store.reconcile('project');

		expect(r.promoted).toEqual([{ slug, from: 2, to: 3 }]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(3);
		expect((await store.getState('project')).usage![slug].uses).toBe(0);   // 消费掉证据
		expect((await store.getState('project')).usage![slug].lastPromotedAt).toBeDefined();

		// 封顶：已是 3 时不再升，也不消费
		await store.recordUse('project', slug);
		await store.recordUse('project', slug);
		const r2 = await store.reconcile('project');
		expect(r2.promoted).toEqual([]);
	});

	it('升级要求"最近有使用"：用得多但闲置超期 → 不升反降', async () => {
		const slug = await seed('a.one', 3, 100, 5); // uses=5 但 100 天没用了

		const r = await store.reconcile('project');

		expect(r.promoted).toEqual([]);
		expect(r.demoted).toEqual([{ slug, from: 3, to: 2 }]);
	});

	it('降级：闲置超期一次降一级；2→1 才离开清单（进候选池），1 不再降', async () => {
		const slug = await seed('a.one', 3, 95, 0);

		await store.reconcile('project');
		expect((await store.readEntry('project', slug))!.confidence).toBe(2);
		expect(await store.listEntries('project')).toHaveLength(1);   // 仍可见（阈值 2）

		// 再闲置一个周期 → 降到 1 → 退出清单
		await store.setState('project', { usage: { [slug]: { uses: 0, lastUsedAt: new Date(Date.now() - 95 * DAY).toISOString() } } });
		const r2 = await store.reconcile('project');
		expect(r2.demoted).toEqual([{ slug, from: 2, to: 1 }]);
		expect((await store.readEntry('project', slug))!.status).toBe('candidate');
		expect(await store.listEntries('project')).toHaveLength(0);
		expect((await store.listCandidates('project')).map((e) => e.slug)).toEqual([slug]);

		// 已是 1 → 再闲置也不降（归档另说）
		const r3 = await store.reconcile('project', { archiveDays: 10_000 });
		expect(r3.demoted).toEqual([]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(1);
	});

	it('pinned 免疫：不升不降不归档', async () => {
		const slug = await seed('a.one', 3, 400, 9);
		expect(await store.setPinned('project', slug, true)).toBe(true);

		const r = await store.reconcile('project');

		expect(r.pinned).toEqual([slug]);
		expect(r.promoted).toEqual([]);
		expect(r.demoted).toEqual([]);
		expect(r.archived).toEqual([]);
		const entry = (await store.readEntry('project', slug))!;
		expect(entry.confidence).toBe(3);
		expect(entry.pinned).toBe(true);

		// 取消钉住后可被维护
		await store.setPinned('project', slug, false);
		expect((await store.readEntry('project', slug))!.pinned).toBeUndefined();
		expect((await store.reconcile('project')).demoted).toHaveLength(1);
	});

	it('节奏：同一分钟内连续两次结算只降一级（降级本身重置闲置时钟）', async () => {
		const slug = await seed('a.one', 3, 95, 0);

		await store.reconcile('project');
		await store.reconcile('project');   // 立刻再结算（模拟两次会话启动 / 手动 gc）

		const entry = (await store.readEntry('project', slug))!;
		expect(entry.confidence).toBe(2);   // 不因"又跑了一次"跌到候选池
		expect(await store.listEntries('project')).toHaveLength(1);

		// 等到下个周期（把降级时间往前挪 95 天）才降第二级
		const usage = (await store.getState('project')).usage![slug];
		await store.setState('project', {
			usage: { [slug]: { ...usage, lastDemotedAt: new Date(Date.now() - 95 * DAY).toISOString() } },
		});
		expect((await store.reconcile('project')).demoted).toEqual([{ slug, from: 2, to: 1 }]);
	});

	it('退休条目的使用记录被清理（取代 + 遗忘都不在 state.json 里留垃圾）', async () => {
		const a = await store.write('project', { subject: 'x.y', name: 'A', description: 'd', confidence: 3, body: '旧' });
		await store.write('project', { subject: 'x.y', name: 'B', description: 'd', confidence: 3, body: '新' }); // supersede a
		expect((await store.getState('project')).usage![a.slug]).toBeUndefined();

		const b = await store.write('project', { subject: 'c.d', name: 'C', description: 'd', confidence: 3, body: 'z' });
		expect((await store.getState('project')).usage![b.slug]).toBeDefined();
		await store.forget('project', b.slug, 'test');
		expect((await store.getState('project')).usage![b.slug]).toBeUndefined();
	});

	it('归档：候选池（conf 1）长期闲置 → 移出扫描范围，文件保留在 legacy/archive/', async () => {
		const slug = await seed('a.one', 1, 200, 0);

		const r = await store.reconcile('project');

		expect(r.archived).toEqual([slug]);
		expect(await store.scan('project')).toMatchObject({ entries: [] });
		expect((await store.getState('project')).usage![slug]).toBeUndefined();
		expect(existsSync(join(projectDir, `${slug}.md`))).toBe(false);
		expect(existsSync(join(projectDir, 'legacy', 'archive', `${slug}.md`))).toBe(true);
	});

	it('dry-run：只返回计划，不动任何文件与状态', async () => {
		const slug = await seed('a.one', 3, 95, 0);
		const before = await readFile(join(projectDir, `${slug}.md`), 'utf-8');

		const r = await store.reconcile('project', {}, true);

		expect(r.dryRun).toBe(true);
		expect(r.demoted).toEqual([{ slug, from: 3, to: 2 }]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(3);      // 未改
		expect(await readFile(join(projectDir, `${slug}.md`), 'utf-8')).toBe(before);
		expect((await store.getState('project')).usage![slug].uses).toBe(0);        // 未改
	});

	it('enabled=false → 完全不动（开关）', async () => {
		const slug = await seed('a.one', 3, 400, 0);

		const r = await store.reconcile('project', { enabled: false });

		expect(r).toMatchObject({ promoted: [], demoted: [], archived: [] });
		expect((await store.readEntry('project', slug))!.confidence).toBe(3);
	});

	it('审计：一次 LRU 结算落一条 lru 记录（含前后置信度）', async () => {
		const slug = await seed('a.one', 3, 95, 0);
		await store.reconcile('project');

		const audit = await readFile(join(projectDir, 'audit.jsonl'), 'utf-8');
		expect(audit).toContain('"kind":"lru"');
		expect(audit).toContain(`"slug":"${slug}","from":3,"to":2`);
	});

	it('索引自维护：write / forget / setPinned 后 MEMORY.md 自动更新（调用方不再手动 rebuildIndex）', async () => {
		const slug = await seed('a.two', 3, 0);
		// 无需调用 rebuildIndex
		expect(await readFile(join(projectDir, 'MEMORY.md'), 'utf-8')).toContain(`${slug}.md`);

		await store.forget('project', slug, 'test');
		const afterForget = await readFile(join(projectDir, 'MEMORY.md'), 'utf-8');
		expect(afterForget).not.toContain(`${slug}.md`);

		// pin 后 frontmatter 落盘 pinned=true，且仍能被解析
		const slug2 = await seed('a.three', 3, 0);
		await store.setPinned('project', slug2, true);
		const raw = await readFile(join(projectDir, `${slug2}.md`), 'utf-8');
		expect(raw).toContain('pinned: true');
		expect((await store.readEntry('project', slug2))!.pinned).toBe(true);
	});

	it('候选池升级为正式条目：被真正用过两次 → 进清单', async () => {
		const slug = await seed('a.one', 1, 1, 2); // 模糊条目被反复读到

		const r = await store.reconcile('project');

		expect(r.promoted).toEqual([{ slug, from: 1, to: 2 }]);
		expect(await store.listEntries('project')).toHaveLength(1);
		expect(await readdir(projectDir)).toContain('MEMORY.md');
	});
});
