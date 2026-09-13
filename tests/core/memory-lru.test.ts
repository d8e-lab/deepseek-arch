/**
 * memory-lru.test.ts — LRU 主动维护：活动日时钟 / memory window 换出 / 销毁倒计时
 *
 * 覆盖：使用计数（写入即使用、注入不计）、升级（阈值 + 必须最近有使用）、
 * 活动日老化（**缺席不老化**）、窗口换出、换出后的销毁倒计时与复活、销毁（archive/delete）、
 * 降级阶梯与节奏、pinned 免疫、dry-run 零副作用、开关、审计、索引自维护、usage 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore, type MemoryUsage } from '../../src/core/memory-store.js';
import { renderMemoryIndex } from '../../src/core/memory-agent.js';

const DAY = 86_400_000;

describe('memory LRU（活动日 + 窗口 + 销毁倒计时）', () => {
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

	/** 直接摆好 state：活动日序号 + 条目的使用/换出记录（模拟"已经过了多少活动日"） */
	async function seed(
		options: {
			subject: string; confidence: number;
			activeDay?: number; lastUsedDay?: number; lastDemotedDay?: number;
			uses?: number; evictedAt?: string; evictedDay?: number; evictReason?: MemoryUsage['evictReason'];
			lastUsedAt?: string;
		},
	): Promise<string> {
		const w = await store.write('project', {
			subject: options.subject, name: options.subject, description: 'd',
			confidence: options.confidence, body: `body-${options.subject}`,
		});
		const now = new Date().toISOString();
		const usage: MemoryUsage = {
			uses: options.uses ?? 0,
			// 有 evictedAt 时默认"最后一次使用发生在被换出之前"（否则会被判为复活）；需要模拟复活的用例显式传 lastUsedAt
			lastUsedAt: options.lastUsedAt ?? options.evictedAt ?? now,
			...(options.lastUsedDay !== undefined ? { lastUsedDay: options.lastUsedDay } : {}),
			...(options.lastDemotedDay !== undefined ? { lastDemotedDay: options.lastDemotedDay } : {}),
			...(options.evictedAt !== undefined ? { evictedAt: options.evictedAt } : {}),
			...(options.evictedDay !== undefined ? { evictedDay: options.evictedDay } : {}),
			...(options.evictReason !== undefined ? { evictReason: options.evictReason } : {}),
		};
		await store.setState('project', {
			usage: { [w.slug]: usage },
			activeDayCount: options.activeDay ?? 1,
			lastActiveDate: new Date().toISOString().slice(0, 10),   // 今天已计过 → reconcile 不再 +1
		});
		return w.slug;
	}

	it('使用计数：写入即一次使用；注入（manifest）不计', async () => {
		const slug = await seed({ subject: 'a.one', confidence: 2, activeDay: 1, lastUsedDay: 1 });
		await store.write('project', { subject: 'a.one', name: 'a.one', description: 'd', confidence: 2, body: 'body-a.one', slug });
		await store.manifest('project');
		await store.manifestAll(10_000);

		expect((await store.getState('project')).usage![slug].uses).toBe(1);
	});

	it('活动日时钟：缺席（程序长期不启动）不推进老化', async () => {
		// 日历上 200 天前用过，但活动日只推进到 5（中间程序没启动）→ 闲置 0 活动日
		const old = new Date(Date.now() - 200 * DAY).toISOString();
		const slug = await seed({
			subject: 'a.one', confidence: 2, activeDay: 5, lastUsedDay: 5, lastUsedAt: old,
		});

		const r = await store.reconcile('project');

		expect(r.demoted).toEqual([]);
		expect(r.destroyed).toEqual([]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(2);

		// 对照：活动日真的过去很久（程序一直在用，只是没提这条）→ 降级
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
		expect((await store.getState('project')).usage![slug].lastPromotedAt).toBeDefined();

		await store.setState('project', { usage: { [slug]: { uses: 9, lastUsedAt: new Date().toISOString(), lastUsedDay: 10 } } });
		expect((await store.reconcile('project')).promoted).toEqual([]);   // 已是 3 不再升
	});

	it('降级：闲置活动日超期一次降一级；2→1 时离开清单并进入销毁倒计时', async () => {
		const slug = await seed({ subject: 'a.one', confidence: 3, activeDay: 100, lastUsedDay: 5 });

		const r1 = await store.reconcile('project');
		expect(r1.demoted).toEqual([{ slug, from: 3, to: 2 }]);
		expect(r1.evicted).toEqual([]);                       // 仍在清单（阈值 2）
		expect(await store.listEntries('project')).toHaveLength(1);

		// 同一活动日内再结算：不再连降（降级重置老化起点）
		expect((await store.reconcile('project')).demoted).toEqual([]);

		// 下一个"超期"的活动日 → 降到 1 → 换出可见清单 + 开始倒计时
		await store.setState('project', {
			usage: { [slug]: { uses: 0, lastUsedAt: new Date().toISOString(), lastUsedDay: 1 } },
			activeDayCount: 200, lastActiveDate: new Date().toISOString().slice(0, 10),
		});
		const r3 = await store.reconcile('project');
		expect(r3.demoted).toEqual([{ slug, from: 2, to: 1 }]);
		expect(r3.evicted).toEqual([{ slug, reason: 'decay' }]);
		expect(await store.listEntries('project')).toHaveLength(0);
		expect((await store.getState('project')).usage![slug].evictedAt).toBeDefined();
	});

	it('memory window：可见条目超容量 → 换出最久未用者（进候选池 + 倒计时）', async () => {
		const now = Date.now();
		const keep = await seed({ subject: 'hot.one', confidence: 3, activeDay: 10, lastUsedDay: 10, uses: 5 });
		const cold = await seed({
			subject: 'cold.one', confidence: 3, activeDay: 10, lastUsedDay: 2, uses: 1,
			lastUsedAt: new Date(now - 5 * DAY).toISOString(),
		});

		const r = await store.reconcile('project', { windowSize: 1 });

		expect(r.evicted).toEqual([{ slug: cold, reason: 'window' }]);
		expect(await store.listEntries('project')).toEqual([
			expect.objectContaining({ slug: keep }),
		]);
		const usage = (await store.getState('project')).usage!;
		expect(usage[cold].evictedAt).toBeDefined();
		expect(usage[cold].evictReason).toBe('window');
		expect((await store.readEntry('project', cold))!.confidence).toBe(1);
	});

	it('倒计时到期 → 销毁（默认归档到 legacy/archive/，文件保留）', async () => {
		const slug = await seed({
			subject: 'a.one', confidence: 1, activeDay: 100, lastUsedDay: 1,
			evictedAt: new Date(Date.now() - 100 * DAY).toISOString(), evictedDay: 10, evictReason: 'decay',
		});

		const r = await store.reconcile('project');

		expect(r.destroyed).toEqual([slug]);
		expect((await store.scan('project')).entries).toHaveLength(0);
		expect((await store.getState('project')).usage![slug]).toBeUndefined();
		expect(existsSync(join(projectDir, 'legacy', 'archive', `${slug}.md`))).toBe(true);
	});

	it('destroyMode=delete：物理删除文件（用户显式要求时才这么配）', async () => {
		const slug = await seed({
			subject: 'a.one', confidence: 1, activeDay: 100, lastUsedDay: 1,
			evictedAt: new Date(Date.now() - 100 * DAY).toISOString(), evictedDay: 10,
		});

		const r = await store.reconcile('project', { destroyMode: 'delete' });

		expect(r.destroyed).toEqual([slug]);
		expect(existsSync(join(projectDir, `${slug}.md`))).toBe(false);
		expect(existsSync(join(projectDir, 'legacy', 'archive', `${slug}.md`))).toBe(false);
	});

	it('倒计时内被再次使用 → 复活（回到可见清单），不会销毁', async () => {
		const slug = await seed({
			subject: 'a.one', confidence: 1, activeDay: 100, lastUsedDay: 1,
			evictedAt: new Date(Date.now() - 100 * DAY).toISOString(), evictedDay: 10, evictReason: 'decay',
		});
		// 用户这轮又用到了它（读/重申）→ lastUsedAt 晚于 evictedAt
		await store.recordUse('project', slug);

		const r = await store.reconcile('project');

		expect(r.revived).toEqual([slug]);
		expect(r.destroyed).toEqual([]);
		const entry = (await store.readEntry('project', slug))!;
		expect(entry.confidence).toBe(2);
		expect(entry.status).toBe('active');
		expect(await store.listEntries('project')).toHaveLength(1);
		expect((await store.getState('project')).usage![slug].evictedAt).toBeUndefined();
	});

	it('倒计时中：代理的「看到」（查重读）只推迟销毁，master 的「使用」才复活', async () => {
		const evictedAt = new Date(Date.now() - 100 * DAY).toISOString();
		const slug = await seed({
			subject: 'a.one', confidence: 1, activeDay: 100, lastUsedDay: 1,
			evictedAt, evictedDay: 80, evictReason: 'decay',
		});

		// 代理查重读到它（touch）→ 只推迟倒计时
		await store.recordTouch('project', slug);
		const afterTouch = await store.reconcile('project');
		expect(afterTouch.revived).toEqual([]);
		expect(afterTouch.destroyed).toEqual([]);        // 倒计时重置到当下 → 未超期
		expect((await store.readEntry('project', slug))!.confidence).toBe(1);
		const usage = (await store.getState('project')).usage![slug];
		expect(usage.lastSeenDay).toBe(100);
		expect(usage.uses).toBe(0);                      // 弱信号不进 uses（不推动升级）

		// master 真读全文（use）→ 复活
		await store.recordUse('project', slug);
		const afterUse = await store.reconcile('project');
		expect(afterUse.revived).toEqual([slug]);
		expect((await store.readEntry('project', slug))!.confidence).toBe(2);
	});

	it('代理把倒计时中的条目升到 2 → 用后即复活（不销毁）', async () => {
		const evictedAt = new Date(Date.now() - 100 * DAY).toISOString();
		const slug = await seed({
			subject: 'a.one', confidence: 1, activeDay: 100, lastUsedDay: 1,
			evictedAt, evictedDay: 5, evictReason: 'window',
		});

		// 代理按职责带着 slug 升级（索引里能看到 slug，也有 ⏳ 倒计时提示）
		const r = await store.write('project', {
			subject: 'a.one', name: 'a.one', description: 'd', confidence: 2, body: 'body-a.one', slug,
		});
		expect(r.action).toBe('update');

		const after = await store.reconcile('project');
		expect(after.destroyed).toEqual([]);             // 已超期也不销毁
		expect(after.revived).toEqual([slug]);
		expect((await store.readEntry('project', slug))!.status).toBe('active');
		expect(await store.listEntries('project')).toHaveLength(1);
	});

	it('代理索引里标出倒计时进度（⏳已N/期限），分母按离场原因区分', async () => {
		const evictedAt = new Date(Date.now() - 100 * DAY).toISOString();
		const decayed = await store.write('project', { subject: 'a.one', name: 'a.one', description: 'd', confidence: 1, body: 'b1' });
		const candidate = await store.write('project', { subject: 'b.two', name: 'b.two', description: 'd', confidence: 1, body: 'b2' });
		await store.setState('project', {
			usage: {
				[decayed.slug]: { uses: 0, lastUsedAt: evictedAt, lastUsedDay: 1, evictedAt, evictedDay: 70, evictReason: 'decay' },
				[candidate.slug]: { uses: 0, lastUsedAt: evictedAt, lastUsedDay: 1, evictedAt, evictedDay: 70, evictReason: 'candidate' },
			},
			activeDayCount: 100,
			lastActiveDate: new Date().toISOString().slice(0, 10),
		});

		const index = await renderMemoryIndex(store, 30, '');

		expect(index).toContain('⏳待销毁(已 30/30 活动日)');    // 曾进过清单：30 活动日缓刑
		expect(index).toContain('⏳待销毁(已 30/365 活动日)');   // 出生候选：365 活动日 TTL

		// 钉住的条目：正式条目段标 📌（告诉代理"用户要留住它，别淘汰"）
		await store.setPinned('project', decayed.slug, true);
		expect(await renderMemoryIndex(store, 30, '')).toContain('📌用户已钉住(不要淘汰它)');
	});

	it('稀疏偏好（一年才提一次）不再被"晋升需重复 vs 存活仅 30 活动日"互相削弱', async () => {
		const slug = await seed({ subject: 'sparse.pref', confidence: 1, activeDay: 95, lastUsedDay: 1, uses: 1 });
		const now = new Date().toISOString();

		// 活动日 95：出生候选闲置 → 开始倒计时
		const r1 = await store.reconcile('project');
		expect(r1.evicted).toEqual([{ slug, reason: 'candidate' }]);
		const evictedDay = (await store.getState('project')).usage![slug].evictedDay!;

		// 活动日 130（> 30 但 < 365）：**不该**被销毁 —— 否则"下一次出现"时它已经不在了
		await store.setState('project', {
			activeDayCount: 130, lastActiveDate: now.slice(0, 10),
		});
		expect((await store.reconcile('project')).destroyed).toEqual([]);
		expect(await store.readEntry('project', slug)).not.toBeNull();

		// 活动日 200：用户又提到它 → 写入重申 → 复活回到清单
		await store.write('project', { subject: 'sparse.pref', name: 'sparse.pref', description: 'd', confidence: 2, body: 'body-sparse.pref', slug });
		await store.setState('project', { activeDayCount: 200, lastActiveDate: now.slice(0, 10) });
		const r2 = await store.reconcile('project');
		expect(r2.revived).toEqual([slug]);
		expect(await store.listEntries('project')).toHaveLength(1);

		// 对照：曾进过清单（window/decay）的条目仍是 30 活动日缓刑 → 超期销毁
		const old = await seed({
			subject: 'was.visible', confidence: 1, activeDay: 100, lastUsedDay: 1,
			evictedAt: new Date(Date.now() - 400 * DAY).toISOString(), evictedDay: evictedDay + 5, evictReason: 'window',
		});
		await store.setState('project', { activeDayCount: 100 + 5 + 31, lastActiveDate: now.slice(0, 10) });
		expect((await store.reconcile('project')).destroyed).toEqual([old]);
	});

	it('出生即候选的条目长期无人问津 → 进入倒计时（候选池不是无限期坟场）', async () => {
		const slug = await seed({ subject: 'a.one', confidence: 1, activeDay: 300, lastUsedDay: 5 });

		const r = await store.reconcile('project');

		expect(r.evicted).toEqual([{ slug, reason: 'candidate' }]);
		expect((await store.getState('project')).usage![slug].evictReason).toBe('candidate');
		expect((await store.getState('project')).usage![slug].evictedDay).toBe(300);
	});

	it('pinned 免疫：不升不降不换出不销毁；且 pin 会把它移出销毁队列', async () => {
		const slug = await seed({
			subject: 'a.one', confidence: 2, activeDay: 400, lastUsedDay: 1, uses: 9,
			evictedAt: new Date(Date.now() - 400 * DAY).toISOString(), evictedDay: 1, evictReason: 'window',
		});

		await store.setPinned('project', slug, true);

		// pin 立刻把它移出销毁队列（否则界面显示 ⏳ 但实际永不销毁 = 自相矛盾），并拉到可见阈值
		const usageAfterPin = (await store.getState('project')).usage![slug];
		expect(usageAfterPin.evictedAt).toBeUndefined();
		expect(usageAfterPin.evictReason).toBeUndefined();
		expect(usageAfterPin.uses).toBe(9);                       // 使用统计保留
		const pinnedEntry = (await store.readEntry('project', slug))!;
		expect(pinnedEntry.pinned).toBe(true);
		expect(pinnedEntry.confidence).toBe(2);                   // 不低于原值、也不凭空加证据
		expect(pinnedEntry.status).toBe('active');

		const r = await store.reconcile('project', { windowSize: 0 });
		expect(r.pinned).toEqual([slug]);
		expect(r).toMatchObject({ promoted: [], demoted: [], evicted: [], revived: [], destroyed: [] });

		// 取消钉住后重新参与维护（不再有倒计时 → 被窗口换出，进入新的倒计时）
		await store.setPinned('project', slug, false);
		const after = await store.reconcile('project', { windowSize: 0 });
		expect(after.evicted).toEqual([{ slug, reason: 'window' }]);
		expect(after.destroyed).toEqual([]);
		expect((await store.readEntry('project', slug))!.pinned).toBeUndefined();
	});

	it('pin 一条 master 看不见的候选 → 拉到可见阈值（pin 看不见的东西没意义）', async () => {
		const slug = await seed({ subject: 'cand.one', confidence: 1, activeDay: 10, lastUsedDay: 10 });
		expect(await store.listEntries('project')).toHaveLength(0);

		await store.setPinned('project', slug, true);

		const entry = (await store.readEntry('project', slug))!;
		expect(entry.confidence).toBe(2);
		expect(entry.status).toBe('active');
		expect(await store.listEntries('project')).toHaveLength(1);
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

	it('审计：一次结算落一条 lru 记录（含换出/销毁原因）', async () => {
		const slug = await seed({
			subject: 'a.one', confidence: 1, activeDay: 100, lastUsedDay: 1,
			evictedAt: new Date(Date.now() - 100 * DAY).toISOString(), evictedDay: 10, evictReason: 'window',
		});
		await store.reconcile('project');

		const audit = await readFile(join(projectDir, 'audit.jsonl'), 'utf-8');
		expect(audit).toContain('"kind":"lru"');
		expect(audit).toContain(`"destroyed":["${slug}"]`);
		expect(audit).toContain('"activeDay":100');
	});

	it('索引自维护：write / forget / setPinned 后 MEMORY.md 自动更新', async () => {
		const slug = await seed({ subject: 'a.two', confidence: 3, activeDay: 1, lastUsedDay: 1 });
		expect(await readFile(join(projectDir, 'MEMORY.md'), 'utf-8')).toContain(`${slug}.md`);

		await store.forget('project', slug, 'test');
		expect(await readFile(join(projectDir, 'MEMORY.md'), 'utf-8')).not.toContain(`${slug}.md`);

		const slug2 = await seed({ subject: 'a.three', confidence: 3, activeDay: 1, lastUsedDay: 1 });
		await store.setPinned('project', slug2, true);
		expect(await readFile(join(projectDir, `${slug2}.md`), 'utf-8')).toContain('pinned: true');
		expect((await store.readEntry('project', slug2))!.pinned).toBe(true);
	});

	it('候选条的确定性升路：同主题反复出现（跨取代）→ 重申计数累积 → 自动升到 2', async () => {
		const first = await store.write('project', { subject: 'style.tone', name: '语气', description: 'd', confidence: 1, body: '希望语气轻松' });
		const second = await store.write('project', { subject: 'style.tone', name: '语气', description: 'd', confidence: 1, body: '语气要轻松一点，别太正式' });

		expect(second.action).toBe('supersede');
		const usage = (await store.getState('project')).usage!;
		expect(usage[second.slug].uses).toBe(2);
		expect(usage[first.slug]).toBeUndefined();

		const r = await store.reconcile('project');
		expect(r.promoted).toEqual([{ slug: second.slug, from: 1, to: 2 }]);
		expect(await store.listEntries('project')).toHaveLength(1);
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
		expect((await store.reconcile('project')).activeDay).toBe(7);   // 今天已计过

		// 模拟"昨天计过，今天第一次结算"
		await store.setState('project', { lastActiveDate: '2020-01-01' });
		expect((await store.reconcile('project')).activeDay).toBe(8);
		expect((await store.reconcile('project')).activeDay).toBe(8);   // 同日不再 +1
		expect((await readdir(projectDir))).toContain('MEMORY.md');
	});
});
