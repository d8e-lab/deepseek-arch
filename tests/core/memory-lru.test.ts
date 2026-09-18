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
	 * 把条目推到 **conf 0（待销毁）**：R31 起 0 **只能由容量压力产生**
	 * （`totalLimit` 超限 → 最久未用的候选降到 0），闲置最多只降到 1。
	 * 做法：目标条目 + 一条"较新"的候选，把总量上限压到刚好 1 条候选 → 最久未用者进 0。
	 * 注意用增量 `setState`（不要用会整体覆盖 state 的 `seed`）。
	 */
	async function toDoomed(subject: string, activeDay = 100, idleFrom = 1): Promise<string> {
		const w = await store.write('project', { subject, name: subject, description: 'd', confidence: 1, body: `body-${subject}` });
		const filler = await store.write('project', { subject: 'filler.one', name: 'filler.one', description: 'd', confidence: 1, body: 'body-filler' });
		const now = Date.now();
		await store.setState('project', {
			activeDayCount: activeDay,
			lastActiveDate: new Date().toISOString().slice(0, 10),
			usage: {
				...(await store.getState('project')).usage,
				[w.slug]: { uses: 0, lastUsedAt: new Date(now - 30 * DAY).toISOString(), lastUsedDay: idleFrom, lastStepDay: idleFrom },
				[filler.slug]: { uses: 0, lastUsedAt: new Date(now + 1000).toISOString(), lastUsedDay: activeDay },
			},
		});
		const r = await store.reconcile('project', { windowSize: 10, totalLimit: 11 });
		expect(r.doomed.map((d) => d.slug)).toEqual([w.slug]);
		return w.slug;
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

		// 只是继续闲置 → **停在 1（待观察）**，不会被闲置推向销毁（R31）
		await setDay(300);
		expect((await store.reconcile('project')).demoted).toEqual([]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(1);
		expect((await store.readEntry('project', slug))!.status).toBe('candidate');
	});

	it('conf 0 = 待销毁：闲置超过销毁期限 → 销毁（默认归档，文件保留）', async () => {
		const slug = await toDoomed('a.one');                        // 容量淘汰 → conf 0
		await store.setState('project', { activeDayCount: 100 + 31, lastActiveDate: new Date().toISOString().slice(0, 10) });

		const r = await store.reconcile('project', { destroyAfterDays: 30 });

		expect(r.destroyed).toEqual([slug]);
		expect((await store.scan('project')).entries.map((e) => e.slug)).not.toContain(slug);
		expect((await store.getState('project')).usage![slug]).toBeUndefined();
		expect(existsSync(join(projectDir, 'legacy', 'archive', `${slug}.md`))).toBe(true);

		const audit = await readFile(join(projectDir, 'audit.jsonl'), 'utf-8');
		expect(audit).toContain('"kind":"lru"');
		expect(audit).toContain(`"destroyed":["${slug}"]`);
	});

	it('destroyMode=delete：物理删除文件（用户显式要求时才这么配）', async () => {
		const slug = await toDoomed('a.one');
		await store.setState('project', { activeDayCount: 100 + 31, lastActiveDate: new Date().toISOString().slice(0, 10) });

		expect((await store.reconcile('project', { destroyAfterDays: 30, destroyMode: 'delete' })).destroyed).toEqual([slug]);
		expect(existsSync(join(projectDir, `${slug}.md`))).toBe(false);
		expect(existsSync(join(projectDir, 'legacy', 'archive', `${slug}.md`))).toBe(false);
	});

	it('conf 0 被 master 使用 → 回到 conf 1 重新观察（不销毁、也不直接回 2）', async () => {
		const slug = await toDoomed('a.one');
		await store.setState('project', { activeDayCount: 100 + 31, lastActiveDate: new Date().toISOString().slice(0, 10) });

		await store.recordUse('project', slug);                       // master 读全文
		// v3：会话内局部判定 —— 复活在读取当下就发生（不再等结算）
		const entry = (await store.readEntry('project', slug))!;
		expect(entry.confidence).toBe(1);                             // 从 1 开始观察，不是 2
		expect(entry.status).toBe('candidate');
		expect(await store.listEntries('project')).toHaveLength(0);

		const r = await store.reconcile('project', { destroyAfterDays: 30 });
		expect(r.destroyed).toEqual([]);
		expect(r.revived).toEqual([]);                                // 已复活，结算不再重复报告
	});

	it('conf 0 被归纳代理「看到」→ 回到 conf 1（话题又出现了），但不增 uses', async () => {
		const slug = await toDoomed('b.two');
		await store.setState('project', { activeDayCount: 100 + 31, lastActiveDate: new Date().toISOString().slice(0, 10) });

		await store.recordTouch('project', slug);
		// 「看到」也即时复活，但不升级；uses 不增加
		expect((await store.readEntry('project', slug))!.confidence).toBe(1);
		expect((await store.getState('project')).usage![slug].uses).toBe(0);

		const r = await store.reconcile('project', { destroyAfterDays: 30 });
		expect(r.destroyed).toEqual([]);
		expect(r.revived).toEqual([]);                                // 已在触达当下复活
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

	it('conf 0 只由容量压力产生：总量不超限时，闲置再久也不会出现 0', async () => {
		// 一条候选闲置 10 万个活动日，但总量完全没超限 → 不许出现 conf 0/销毁
		const slug = await seed({ subject: 'lonely.one', confidence: 1, activeDay: 100_000, lastUsedDay: 1, lastStepDay: 1 });
		const r = await store.reconcile('project', { windowSize: 200, totalLimit: 400, destroyAfterDays: 30 });
		expect(r.doomed).toEqual([]);
		expect(r.destroyed).toEqual([]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(1);
	});

	it('候选区超容量 → 最久未用的候选降到 conf 0（待销毁），可见清单不受影响', async () => {
		// 可见 1 条（窗口 10 不超）+ 候选 2 条（候选区上限 = 11−10 = 1，超 1 条）
		const visible = await store.write('project', { subject: 'vis.one', name: 'vis.one', description: 'd', confidence: 3, body: 'b0' });
		const oldCand = await store.write('project', { subject: 'old.cand', name: 'old.cand', description: 'd', confidence: 1, body: 'b1' });
		const newCand = await store.write('project', { subject: 'new.cand', name: 'new.cand', description: 'd', confidence: 1, body: 'b2' });
		const now = Date.now();
		await store.setState('project', {
			activeDayCount: 10, lastActiveDate: new Date().toISOString().slice(0, 10),
			usage: {
				[visible.slug]: { uses: 1, lastUsedAt: new Date(now).toISOString(), lastUsedDay: 10 },
				[oldCand.slug]: { uses: 0, lastUsedAt: new Date(now - 30 * DAY).toISOString(), lastUsedDay: 1 },
				[newCand.slug]: { uses: 0, lastUsedAt: new Date(now - 1 * DAY).toISOString(), lastUsedDay: 9 },
			},
		});

		const r = await store.reconcile('project', { windowSize: 10, totalLimit: 11 });

		expect(r.doomed).toEqual([{ slug: oldCand.slug, from: 1, to: 0 }]);   // 最久未用的候选
		expect((await store.readEntry('project', oldCand.slug))!.confidence).toBe(0);
		expect((await store.readEntry('project', newCand.slug))!.confidence).toBe(1);
		expect((await store.readEntry('project', visible.slug))!.confidence).toBe(3);   // 可见清单不受影响
	});

	it('索引标注：conf 1 = 待观察、conf 0 = ⏳待销毁（带 已N/期限 活动日）、pinned = 📌', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const doomed = await toDoomed('doomed.one', 100, 1);          // 容量淘汰 → conf 0，lastStepDay = 100
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

	it('稀疏偏好（一年才提一次）：闲置只降到 1，不会被清掉（R31）', async () => {
		const now = new Date().toISOString();
		const slug = await seed({ subject: 'sparse.pref', confidence: 1, activeDay: 95, lastUsedDay: 1, uses: 1 });
		const setDay = (d: number) => store.setState('project', { activeDayCount: d, lastActiveDate: now.slice(0, 10) });

		// 1 档继续闲置很久：既不销毁，也不降级（1 已是"只是没人用"的下限）
		for (const d of [200, 400, 800]) {
			await setDay(d);
			const r = await store.reconcile('project');
			expect(r.destroyed).toEqual([]);
			expect(r.demoted).toEqual([]);
		}
		expect((await store.readEntry('project', slug))!.confidence).toBe(1);

		// 400 活动日后再提到它 → 重申累积到 2 次 → 升进清单（稀疏偏好的真正出路）
		await setDay(800);
		await store.write('project', { subject: 'sparse.pref', name: 'sparse.pref', description: 'd', confidence: 1, body: 'body-sparse.pref', slug });
		await store.recordUse('project', slug);
		// v3：第二次使用达到阈值 → 会话内即时升级（结算不再重复报告）
		expect((await store.readEntry('project', slug))!.confidence).toBe(2);
		expect(await store.listEntries('project')).toHaveLength(1);
		expect((await store.reconcile('project')).promoted).toEqual([]);
	});

	it('会话内局部判定：读满阈值即升级；写路径不升级（显式降级不会被同一次写入抬回）', async () => {
		const w = await store.write('project', { subject: 'local.judge', name: 'L', description: 'd', confidence: 2, body: 'b' });
		// 写入算一次使用，但**不触发即时升级**（uses=1 < 阈值 2）
		expect((await store.readEntry('project', w.slug))!.confidence).toBe(2);

		// 显式降到 1：写路径 allowPromote=false，不会被这次写入的 use 抬回
		await store.write('project', { slug: w.slug, subject: 'local.judge', name: 'L', description: 'd', confidence: 1, body: 'b' });
		expect((await store.readEntry('project', w.slug))!.confidence).toBe(1);

		// master 读全文 → 累计使用达到阈值 → 立即升到 2（不等检查点结算）
		await store.recordUse('project', w.slug);
		expect((await store.readEntry('project', w.slug))!.confidence).toBe(2);
	});

	it('会话内局部判定：lruEnabled=false 时完全不介入（只留检查点结算）', async () => {
		const plain = new MemoryStore({
			projectDir: join(root, 'plain-project'), globalDir: join(root, 'plain-global'),
			masterMinConfidence: 2, lruEnabled: false,
		});
		const w = await plain.write('project', { subject: 'no.lru', name: 'N', description: 'd', confidence: 1, body: 'b' });
		await plain.recordUse('project', w.slug);
		await plain.recordUse('project', w.slug);
		expect((await plain.readEntry('project', w.slug))!.confidence).toBe(1);
	});

	it('会话内局部判定：「看到」不升级（即使 uses 远超阈值）', async () => {
		const w = await store.write('project', { subject: 'touch.only', name: 'T', description: 'd', confidence: 1, body: 'b' });
		await store.setState('project', { usage: { [w.slug]: { uses: 99, lastUsedAt: new Date().toISOString() } } });
		await store.recordTouch('project', w.slug);
		expect((await store.readEntry('project', w.slug))!.confidence).toBe(1);
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
