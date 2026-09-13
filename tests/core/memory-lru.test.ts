/**
 * memory-lru.test.ts — LRU（**统一 confidence 档位**：3/2 可见 → 1 待观察 → 0 待销毁 → 销毁）
 *
 * 覆盖：使用计数（写入即使用、注入不计、代理读到只刷新老化时钟）、活动日老化（缺席不老化）、
 * 升级、降级阶梯（3→2→1→0）、conf 0 的销毁与"回到 1 重新观察"、窗口换出到观察区、
 * pinned 免疫与"pin 拉回可见"、dry-run 零副作用、开关、审计、索引标注、索引自维护、usage 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore, type MemoryUsage } from '../../src/core/memory-store.js';
import { renderMemoryIndex } from '../../src/core/memory-agent.js';

const DAY = 86_400_000;

describe('memory LRU（统一 confidence 档位）', () => {
	let root: string;
	let projectDir: string;
	let store: MemoryStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'deepseek-memory-lru-'));
		projectDir = join(root, 'project');
		store = new MemoryStore({ projectDir, globalDir: join(root, 'global'), masterMinConfidence: 2 });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	/** 直接摆好 state：活动日序号 + 条目的使用/结算记录（模拟"已经过了多少活动日"） */
	async function seed(
		options: {
			subject: string; confidence: number;
			activeDay?: number; lastUsedDay?: number; lastStepDay?: number;
			uses?: number; lastUsedAt?: string;
		},
	): Promise<string> {
		const w = await store.write('project', {
			subject: options.subject, name: options.subject, description: 'd',
			confidence: options.confidence, body: `body-${options.subject}`,
		});
		const now = options.lastUsedAt ?? new Date().toISOString();
		const usage: MemoryUsage = {
			uses: options.uses ?? 0,
			lastUsedAt: now,
			...(options.lastUsedDay !== undefined ? { lastUsedDay: options.lastUsedDay } : {}),
			...(options.lastStepDay !== undefined ? { lastStepDay: options.lastStepDay } : {}),
		};
		await store.setState('project', {
			usage: { [w.slug]: usage },
			activeDayCount: options.activeDay ?? 1,
			lastActiveDate: new Date().toISOString().slice(0, 10),   // 今天已计过 → reconcile 不再 +1
		});
		return w.slug;
	}

	/**
	 * 把条目推到 **conf 0（待销毁）**：先造闲置超期，再由 reconcile 降级 ——
	 * 0 只能由 LRU 产生（写路径的 confidence 被 clamp 到 1..3），所以测试走真实路径。
	 */
	async function toDoomed(subject: string, doomedAt: number, idleFrom: number): Promise<string> {
		const slug = await seed({
			subject, confidence: 1, activeDay: doomedAt - 1, lastUsedDay: idleFrom, lastStepDay: idleFrom,
		});
		await store.setState('project', { activeDayCount: doomedAt, lastActiveDate: new Date().toISOString().slice(0, 10) });
		expect((await store.reconcile('project')).demoted).toEqual([{ slug, from: 1, to: 0 }]);
		return slug;
	}

	it('使用计数：写入即一次使用；注入（清单）不算', async () => {
		const slug = await seed({ subject: 'a.one', confidence: 2, activeDay: 1, lastUsedDay: 1 });
		await store.write('project', { subject: 'a.one', name: 'a.one', description: 'd', confidence: 2, body: 'body-a.one', slug });
		await store.manifest('project');
		await store.manifestAll(10_000);

		expect((await store.getState('project')).usage![slug].uses).toBe(1);
	});

	it('活动日时钟：缺席（程序长期不启动）不推进老化', async () => {
		// 日历上 200 天前用过，但活动日只推进到 5（中间程序没启动）→ 闲置 0 活动日
		const old = new Date(Date.now() - 200 * DAY).toISOString();
		const slug = await seed({ subject: 'a.one', confidence: 2, activeDay: 5, lastUsedDay: 5, lastUsedAt: old });

		const r = await store.reconcile('project');
		expect(r.demoted).toEqual([]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(2);

		// 对照：活动日真的推进了很久（一直在用程序，只是没提这条）→ 降级
		await store.setState('project', {
			usage: { [slug]: { uses: 0, lastUsedAt: old, lastUsedDay: 1 } },
			activeDayCount: 500, lastActiveDate: new Date().toISOString().slice(0, 10),
		});
		expect((await store.reconcile('project')).demoted).toEqual([{ slug, from: 2, to: 1 }]);
	});

	it('升级：使用次数达标且最近有使用 → +1（封顶 3），并消费计数', async () => {
		const slug = await seed({ subject: 'a.one', confidence: 2, activeDay: 10, lastUsedDay: 9, uses: 2 });

		const r = await store.reconcile('project');

		expect(r.promoted).toEqual([{ slug, from: 2, to: 3 }]);
		expect((await store.getState('project')).usage![slug].uses).toBe(0);

		await store.setState('project', { usage: { [slug]: { uses: 9, lastUsedAt: new Date().toISOString(), lastUsedDay: 10 } } });
		expect((await store.reconcile('project')).promoted).toEqual([]);   // 已是 3 不再升
	});

	it('降级阶梯：3→2→1→0，一次一级；同一活动日连跑两次不连降', async () => {
		const slug = await seed({ subject: 'a.one', confidence: 3, activeDay: 100, lastUsedDay: 1 });
		const now = new Date().toISOString();
		const setDay = (d: number) => store.setState('project', { activeDayCount: d, lastActiveDate: now.slice(0, 10) });

		expect((await store.reconcile('project')).demoted).toEqual([{ slug, from: 3, to: 2 }]);
		expect(await store.listEntries('project')).toHaveLength(1);       // 2 仍可见

		// 同一活动日内再结算：不再连降（lastStepDay 生效）
		expect((await store.reconcile('project')).demoted).toEqual([]);

		await setDay(200);
		expect((await store.reconcile('project')).demoted).toEqual([{ slug, from: 2, to: 1 }]);
		expect(await store.listEntries('project')).toHaveLength(0);       // 1 = 待观察，离开清单
		expect((await store.readEntry('project', slug))!.status).toBe('candidate');

		await setDay(300);
		expect((await store.reconcile('project')).demoted).toEqual([{ slug, from: 1, to: 0 }]);  // 0 = 待销毁
		expect((await store.readEntry('project', slug))!.confidence).toBe(0);
	});

	it('conf 0 = 待销毁：闲置超过销毁期限 → 销毁（默认归档，文件保留）', async () => {
		const slug = await toDoomed('a.one', 200, 1);                 // 1 → 0（lastStepDay = 200）
		await store.setState('project', { activeDayCount: 200 + 31, lastActiveDate: new Date().toISOString().slice(0, 10) });

		const r = await store.reconcile('project', { destroyAfterDays: 30 });

		expect(r.destroyed).toEqual([slug]);
		expect((await store.scan('project')).entries).toHaveLength(0);
		expect((await store.getState('project')).usage![slug]).toBeUndefined();
		expect(existsSync(join(projectDir, 'legacy', 'archive', `${slug}.md`))).toBe(true);

		const audit = await readFile(join(projectDir, 'audit.jsonl'), 'utf-8');
		expect(audit).toContain('"kind":"lru"');
		expect(audit).toContain(`"destroyed":["${slug}"]`);
	});

	it('destroyMode=delete：物理删除文件（用户显式要求时才这么配）', async () => {
		const slug = await toDoomed('a.one', 200, 1);
		await store.setState('project', { activeDayCount: 200 + 31, lastActiveDate: new Date().toISOString().slice(0, 10) });

		expect((await store.reconcile('project', { destroyAfterDays: 30, destroyMode: 'delete' })).destroyed).toEqual([slug]);
		expect(existsSync(join(projectDir, `${slug}.md`))).toBe(false);
		expect(existsSync(join(projectDir, 'legacy', 'archive', `${slug}.md`))).toBe(false);
	});

	it('conf 0 被触达 → 回到 conf 1 重新观察（不销毁、也不直接回 2）', async () => {
		const slug = await toDoomed('a.one', 200, 1);
		await store.setState('project', { activeDayCount: 200 + 31, lastActiveDate: new Date().toISOString().slice(0, 10) });

		// master 真读全文（use）→ 刷新老化时钟 → 不该被销毁
		await store.recordUse('project', slug);
		const r = await store.reconcile('project', { destroyAfterDays: 30 });

		expect(r.destroyed).toEqual([]);
		expect(r.revived).toEqual([slug]);
		const entry = (await store.readEntry('project', slug))!;
		expect(entry.confidence).toBe(1);            // 从 1 开始观察，不是 2
		expect(entry.status).toBe('candidate');
		expect(await store.listEntries('project')).toHaveLength(0);

		// 归纳代理查重读到（touch）同样能把它从 0 拉回 1（话题又出现了），但不增 uses
		const slug2 = await toDoomed('b.two', 200, 1);
		await store.recordTouch('project', slug2);
		const r2 = await store.reconcile('project', { destroyAfterDays: 30 });
		expect(r2.revived).toEqual([slug2]);
		expect(r2.destroyed).toEqual([]);
		expect((await store.readEntry('project', slug2))!.confidence).toBe(1);
		expect((await store.getState('project')).usage![slug2].uses).toBe(0);
	});

	it('memory window：可见条目超容量 → 最久未用者降到 conf 1（观察区，不是判死刑）', async () => {
		const now = Date.now();
		const keep = await seed({ subject: 'hot.one', confidence: 3, activeDay: 10, lastUsedDay: 10, uses: 5 });
		const cold = await seed({
			subject: 'cold.one', confidence: 3, activeDay: 10, lastUsedDay: 2, uses: 1,
			lastUsedAt: new Date(now - 5 * DAY).toISOString(),
		});

		const r = await store.reconcile('project', { windowSize: 1 });

		expect(r.windowEvicted).toEqual([cold]);
		expect(r.demoted).toEqual([]);                       // 换出不计入"闲置降级"
		expect((await store.listEntries('project')).map((e) => e.slug)).toEqual([keep]);
		const coldEntry = (await store.readEntry('project', cold))!;
		expect(coldEntry.confidence).toBe(1);                // 观察区
		expect(coldEntry.status).toBe('candidate');
	});

	it('pinned 免疫：不升不降不换出不销毁；pin 会把 conf 0/1 拉到可见阈值', async () => {
		const slug = await seed({ subject: 'a.one', confidence: 0, activeDay: 500, lastUsedDay: 1, lastStepDay: 1 });
		await store.setPinned('project', slug, true);

		const r = await store.reconcile('project', { windowSize: 0, destroyAfterDays: 30 });
		expect(r.pinned).toEqual([slug]);
		expect(r).toMatchObject({ promoted: [], demoted: [], windowEvicted: [], revived: [], destroyed: [] });

		const entry = (await store.readEntry('project', slug))!;
		expect(entry.pinned).toBe(true);
		expect(entry.confidence).toBe(2);                    // pin = 用户显式"留住"，拉回可见
		expect(entry.status).toBe('active');
		expect(await store.listEntries('project')).toHaveLength(1);

		// 取消钉住后重新参与维护
		await store.setPinned('project', slug, false);
		const after = await store.reconcile('project', { windowSize: 0, destroyAfterDays: 30 });
		expect(after.windowEvicted).toEqual([slug]);
	});

	it('dry-run：只返回计划，不动文件与状态', async () => {
		const slug = await seed({ subject: 'a.one', confidence: 3, activeDay: 100, lastUsedDay: 1 });
		const before = await readFile(join(projectDir, `${slug}.md`), 'utf-8');

		const r = await store.reconcile('project', {}, true);

		expect(r.dryRun).toBe(true);
		expect(r.demoted).toEqual([{ slug, from: 3, to: 2 }]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(3);
		expect(await readFile(join(projectDir, `${slug}.md`), 'utf-8')).toBe(before);
	});

	it('enabled=false → 完全不动（开关）', async () => {
		const slug = await seed({ subject: 'a.one', confidence: 3, activeDay: 400, lastUsedDay: 1 });

		const r = await store.reconcile('project', { enabled: false });

		expect(r.demoted).toEqual([]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(3);
	});

	it('索引标注：conf 1 = 待观察、conf 0 = ⏳待销毁（带 已N/期限 活动日）、pinned = 📌', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const doomed = await toDoomed('doomed.one', 100, 1);          // 1 → 0，lastStepDay = 100
		// 注意：以下都用 store.write（增量更新 usage），不要用 seed（它会整体覆盖 state）
		await store.write('project', { subject: 'watch.one', name: 'watch.one', description: 'd', confidence: 1, body: 'b1' });
		const pinned = (await store.write('project', { subject: 'kept.one', name: 'kept.one', description: 'd', confidence: 2, body: 'b2' })).slug;
		await store.setPinned('project', pinned, true);
		await store.setState('project', { activeDayCount: 130, lastActiveDate: today });

		const index = await renderMemoryIndex(store, 30, '');

		expect(index).toContain('待观察');
		expect(index).toContain('doomed-one.md');
		expect(index).toContain('⏳待销毁(已 30/180 活动日)');
		expect(index).toContain('📌用户已钉住');
	});

	it('索引自维护：write / forget / setPinned 后 MEMORY.md 自动更新', async () => {
		const slug = await seed({ subject: 'a.two', confidence: 3, activeDay: 1, lastUsedDay: 1 });
		expect(await readFile(join(projectDir, 'MEMORY.md'), 'utf-8')).toContain(`${slug}.md`);

		await store.forget('project', slug, 'test');
		expect(await readFile(join(projectDir, 'MEMORY.md'), 'utf-8')).not.toContain(`${slug}.md`);

		const slug2 = await seed({ subject: 'a.three', confidence: 3, activeDay: 1, lastUsedDay: 1 });
		await store.setPinned('project', slug2, true);
		expect(await readFile(join(projectDir, `${slug2}.md`), 'utf-8')).toContain('pinned: true');
	});

	it('候选条的确定性升路：同主题反复出现（跨取代）→ 重申计数累积 → 自动升到 2', async () => {
		const first = await store.write('project', { subject: 'style.tone', name: '语气', description: 'd', confidence: 1, body: '希望语气轻松' });
		const second = await store.write('project', { subject: 'style.tone', name: '语气', description: 'd', confidence: 1, body: '语气要轻松一点，别太正式' });

		expect(second.action).toBe('supersede');
		const usage = (await store.getState('project')).usage!;
		expect(usage[second.slug].uses).toBe(2);       // 跨取代延续
		expect(usage[first.slug]).toBeUndefined();

		expect((await store.reconcile('project')).promoted).toEqual([{ slug: second.slug, from: 1, to: 2 }]);
		expect(await store.listEntries('project')).toHaveLength(1);
	});

	it('稀疏偏好（一年才提一次）不会被"晋升需重复 vs 生存期太短"互相削弱', async () => {
		const now = new Date().toISOString();
		const slug = await seed({ subject: 'sparse.pref', confidence: 1, activeDay: 95, lastUsedDay: 1, uses: 1 });
		const setDay = (d: number) => store.setState('project', { activeDayCount: d, lastActiveDate: now.slice(0, 10) });

		// 95 → 195：闲置 94 > decay(90) → 降到 0（待销毁），但还没到销毁期限
		await setDay(195);
		expect((await store.reconcile('project')).demoted).toEqual([{ slug, from: 1, to: 0 }]);

		// 200：用户又提到它 → 归纳代理写回 conf 1（"重新启用从 1 开始观察"）→ 不会被销毁
		await setDay(200);
		await store.write('project', { subject: 'sparse.pref', name: 'sparse.pref', description: 'd', confidence: 1, body: 'body-sparse.pref', slug });
		const r = await store.reconcile('project');
		expect(r.destroyed).toEqual([]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(1);

		// 且此后继续被重申可正常升级（历史计数被降级消费过，但重新攒得起）
		await store.recordUse('project', slug);
		expect((await store.reconcile('project')).promoted).toEqual([{ slug, from: 1, to: 2 }]);
	});

	it('退休条目的使用记录被清理（取代 + 遗忘都不在 state.json 里留垃圾）', async () => {
		const a = await store.write('project', { subject: 'x.y', name: 'A', description: 'd', confidence: 3, body: '旧' });
		await store.write('project', { subject: 'x.y', name: 'B', description: 'd', confidence: 3, body: '新' });
		expect((await store.getState('project')).usage![a.slug]).toBeUndefined();

		const b = await store.write('project', { subject: 'c.d', name: 'C', description: 'd', confidence: 3, body: 'z' });
		expect((await store.getState('project')).usage![b.slug]).toBeDefined();
		await store.forget('project', b.slug, 'test');
		expect((await store.getState('project')).usage![b.slug]).toBeUndefined();
	});

	it('活动日只在"新的一天"推进一次（同日多会话不重复计数）', async () => {
		await seed({ subject: 'a.one', confidence: 3, activeDay: 7, lastUsedDay: 7 });
		expect((await store.reconcile('project')).activeDay).toBe(7);

		await store.setState('project', { lastActiveDate: '2020-01-01' });
		expect((await store.reconcile('project')).activeDay).toBe(8);
		expect((await store.reconcile('project')).activeDay).toBe(8);
	});
});
