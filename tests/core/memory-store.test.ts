/**
 * memory-store.test.ts — 记忆存储单元测试
 *
 * 覆盖：目录布局、frontmatter 往返、清单渲染与预算、置信度分层（正式/候选）、
 * 三条确定性合并规则（update / merge / supersede）、遗忘、索引重建、legacy 保留、
 * 游标（state.json）与审计追加。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	MemoryStore,
	parseEntry,
	serializeEntry,
	parseFrontmatter,
	renderManifestLine,
	ageText,
	slugify,
	estimateTokens,
	type MemoryEntry,
} from '../../src/core/memory-store.js';

describe('memory-store', () => {
	let root: string;
	let projectDir: string;
	let globalDir: string;
	let store: MemoryStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'deepseek-memory-store-'));
		projectDir = join(root, 'project');
		globalDir = join(root, 'global');
		store = new MemoryStore({ projectDir, globalDir, masterMinConfidence: 2 });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('ensureDir 创建 runtime 目录骨架（legacy/ 与 logs/）', async () => {
		await store.ensureDir('project');
		expect(existsSync(join(projectDir, 'legacy'))).toBe(true);
		expect(existsSync(join(projectDir, 'logs'))).toBe(true);
	});

	it('write(add)：落盘一个主题文件，可被解析回同一内容', async () => {
		const r = await store.write('project', {
			subject: 'reply.format',
			name: '回复格式偏好',
			description: '回复先给结论再给理由',
			type: 'feedback',
			tags: ['reply', 'format'],
			confidence: 3,
			signal: 'A',
			paths: ['src/**'],
			body: '回复先给结论，再给理由。\n**Why:** 用户明确说过。\n**How to apply:** 总结第一句就是结论。',
		});

		expect(r.action).toBe('add');
		expect(r.slug).toBe('reply-format');
		const file = join(projectDir, 'reply-format.md');
		expect(existsSync(file)).toBe(true);

		const raw = await readFile(file, 'utf-8');
		const entry = parseEntry(raw, file, 'project')!;
		expect(entry.subject).toBe('reply.format');
		expect(entry.type).toBe('feedback');
		expect(entry.confidence).toBe(3);
		expect(entry.tags).toEqual(['reply', 'format']);
		expect(entry.paths).toEqual(['src/**']);
		expect(entry.body).toContain('How to apply');
	});

	it('write(update)：指定 slug 改写同一条，created 保持不变', async () => {
		const first = await store.write('project', { subject: 'a.b', name: 'A', description: 'd', body: 'v1' });
		const before = (await store.readEntry('project', first.slug))!;

		await new Promise((r) => setTimeout(r, 5));
		const second = await store.write('project', { slug: first.slug, subject: 'a.b', name: 'A2', description: 'd2', body: 'v2' });
		const after = (await store.readEntry('project', second.slug))!;

		expect(second.action).toBe('update');
		expect(after.name).toBe('A2');
		expect(after.body).toBe('v2');
		expect(after.created).toBe(before.created); // created 不因更新而变
		expect(after.updated >= before.updated).toBe(true);
		// 仍然只有一个文件
		const files = (await readdir(projectDir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'candidates.md');
		expect(files).toEqual(['a-b.md']);
	});

	it('write(merge)：同 subject 且正文归一化后相等 → 合并（提升置信度，不新建）', async () => {
		await store.write('project', { subject: 'reply.format', name: 'A', description: 'd', confidence: 2, body: '不要 铺垫。' });
		const r = await store.write('project', {
			subject: 'reply.format', name: 'A', description: 'd', confidence: 3, body: '不要铺垫',
		});

		expect(r.action).toBe('merge');
		const entry = (await store.readEntry('project', r.slug))!;
		expect(entry.confidence).toBe(3);
		const files = (await readdir(projectDir)).filter((f) => f.endsWith('.md') && !['MEMORY.md', 'candidates.md'].includes(f));
		expect(files).toHaveLength(1);
	});

	it('write(supersede)：同 subject 冲突 → 新条目生效，旧条目留演化记录并退出索引', async () => {
		const old = await store.write('project', { subject: 'reply.format', name: '旧', description: 'd', body: '要详细展开' });
		const r = await store.write('project', { subject: 'reply.format', name: '新', description: 'd', body: '要精简' });

		expect(r.action).toBe('supersede');
		expect(r.superseded).toEqual([old.slug]);

		const oldEntry = (await store.readEntry('project', old.slug))!;
		expect(oldEntry.status).toBe('superseded');
		expect(oldEntry.supersededBy).toBe(r.slug);

		// listEntries 只含新条目
		const actives = await store.listEntries('project');
		expect(actives.map((e) => e.slug)).toEqual([r.slug]);
	});

	it('write(update)：显式传低置信 → 真降级（软淘汰），退出清单进候选池', async () => {
		const w = await store.write('project', { subject: 'reply.format', name: 'A', description: 'd', confidence: 3, body: '要精简' });
		expect(await store.listEntries('project')).toHaveLength(1);

		// 归纳代理判定"已无意义" → 同 slug + confidence 1
		const r = await store.write('project', {
			subject: 'reply.format', confidence: 1, body: '要精简', slug: w.slug,
		});

		expect(r.action).toBe('update');
		const entry = (await store.readEntry('project', w.slug))!;
		expect(entry.confidence).toBe(1);
		expect(entry.status).toBe('candidate');
		expect(await store.listEntries('project')).toHaveLength(0);
		expect((await store.listCandidates('project')).map((e) => e.slug)).toEqual([w.slug]);
		// 索引同步（索引由调用方 rebuildIndex 派生）：移出 MEMORY.md，进入 candidates.md
		await store.rebuildIndex('project');
		expect(await readFile(join(projectDir, 'MEMORY.md'), 'utf-8')).not.toContain('reply-format.md');
		expect(await readFile(join(projectDir, 'candidates.md'), 'utf-8')).toContain('reply-format.md');

		// 可逆：再写回 3 即恢复
		await store.write('project', { subject: 'reply.format', confidence: 3, body: '要精简', slug: w.slug });
		expect(await store.listEntries('project')).toHaveLength(1);
	});

	it('write(update)：降级到 2（仍可见）与不传 confidence（保留原值）', async () => {
		const w = await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });

		// 传更低但仍达阈值 → 留在清单，置信度降为 2
		await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 2, body: 'x', slug: w.slug });
		expect((await store.readEntry('project', w.slug))!.confidence).toBe(2);
		expect(await store.listEntries('project')).toHaveLength(1);

		// 不传 confidence → 原值保留（不会被默认成 2 或 1）
		await store.write('project', { subject: 'a.b', name: 'A', description: 'd2', body: 'x', slug: w.slug });
		const entry = (await store.readEntry('project', w.slug))!;
		expect(entry.confidence).toBe(2);
		expect(entry.description).toBe('d2'); // 其它字段照常更新
	});

	it('write(merge)：低置信的同义重复不得把正式条目踢出清单（取 max，不降级）', async () => {
		const w = await store.write('project', { subject: 'reply.format', name: 'A', description: 'd', confidence: 3, body: '不要铺垫' });

		// 归纳代理重复观察到同一偏好、按信号 F 报 1（正文归一化后与已有条目相等 → 命中 merge）
		const r = await store.write('project', {
			subject: 'reply.format', name: 'A', description: 'd', confidence: 1, body: '不要 铺垫。',
		});

		expect(r.action).toBe('merge');
		const entry = (await store.readEntry('project', w.slug))!;
		expect(entry.confidence).toBe(3);        // 取 max
		expect(entry.status).toBe('active');     // 关键：状态与最终 confidence 一致
		expect(await store.listEntries('project')).toHaveLength(1);
	});

	it('write：superseded 是终态，后续 update/merge 不会把它复活', async () => {
		const old = await store.write('project', { subject: 'x.y', name: '旧', description: 'd', confidence: 3, body: '旧说法' });
		await store.write('project', { subject: 'x.y', name: '新', description: 'd', confidence: 3, body: '新说法' });
		expect((await store.readEntry('project', old.slug))!.status).toBe('superseded');

		// 再次以旧 slug 更新（哪怕给高置信）
		await store.write('project', { subject: 'x.y', name: '旧', description: 'd', confidence: 3, body: '旧说法', slug: old.slug });
		expect((await store.readEntry('project', old.slug))!.status).toBe('superseded');
		expect(await store.listEntries('project')).toHaveLength(1);
	});

	it('write：阈值可配（masterMinConfidence=3 时 confidence 2 视为候选）', async () => {
		const strict = new MemoryStore({ projectDir: join(root, 'strict-p'), globalDir: join(root, 'strict-g'), masterMinConfidence: 3 });
		const w = await strict.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 2, body: 'x' });

		expect((await strict.readEntry('project', w.slug))!.status).toBe('candidate');
		expect(await strict.listEntries('project')).toHaveLength(0);
		expect((await strict.listCandidates('project')).map((e) => e.slug)).toEqual([w.slug]);
	});

	it('置信度分层：confidence=1 只进候选，不进清单/正式条目', async () => {
		await store.write('project', { subject: 'maybe.thing', name: '模糊', description: 'd', confidence: 1, body: 'x' });
		await store.write('project', { subject: 'sure.thing', name: '明确', description: 'd', confidence: 3, body: 'y' });

		const actives = await store.listEntries('project');
		expect(actives.map((e) => e.subject)).toEqual(['sure.thing']);

		const candidates = await store.listCandidates('project');
		expect(candidates.map((e) => e.subject)).toContain('maybe.thing');

		const manifest = await store.manifest('project');
		expect(manifest.text).toContain('sure.thing'.length > 0 ? '明确' : '');
		expect(manifest.text).not.toContain('模糊');
	});

	it('manifest：行格式含 confidence 与人话时间；预算截断并标注省略数', async () => {
		for (let i = 0; i < 5; i++) {
			await store.write('project', {
				subject: `topic.${i}`, name: `主题${i}`, description: 'x'.repeat(40), confidence: 3, body: 'b',
			});
		}
		const full = await store.manifest('project', 10_000);
		expect(full.lines).toHaveLength(5);
		expect(full.lines[0]).toMatch(/^- \[主题\d\]\(topic-\d\.md\) — x+ \(confidence 3, updated (today|yesterday|\d+ days ago)\)$/);
		expect(full.rev).toMatch(/^[0-9a-f]{8}$/);

		// 预算只够一行 → 截断并标注省略数（用实测行成本构造，避免与文案长度耦合）
		const oneLineBudget = estimateTokens(full.lines[0]) + 1 + 2;
		const tiny = await store.manifest('project', oneLineBudget);
		expect(tiny.lines).toHaveLength(1);
		expect(tiny.text).toContain('more)');

		// 预算连一行都放不下 → 不注入任何内容（保持"无记忆 = 现状字节"）
		const none = await store.manifest('project', 1);
		expect(none.text).toBe('');

		// rev 稳定：同集合重复调用不变；内容变化后改变
		const again = await store.manifest('project', 10_000);
		expect(again.rev).toBe(full.rev);
		await store.write('project', { subject: 'topic.9', name: '新主题', description: 'z', confidence: 3, body: 'b' });
		const after = await store.manifest('project', 10_000);
		expect(after.rev).not.toBe(full.rev);
	});

	it('manifestAll：同 subject 时项目层覆盖全局层', async () => {
		await store.write('global', { subject: 'style.x', name: '全局风格', description: 'g', confidence: 3, body: 'g' });
		await store.write('global', { subject: 'only.global', name: '仅全局', description: 'g2', confidence: 3, body: 'g2' });
		await store.write('project', { subject: 'style.x', name: '项目风格', description: 'p', confidence: 3, body: 'p' });

		const merged = await store.manifestAll(10_000);
		expect(merged.text).toContain('项目风格');
		expect(merged.text).not.toContain('全局风格');
		expect(merged.text).toContain('仅全局');
	});

	it('rebuildIndex：索引由文件派生，候选与 legacy 分列', async () => {
		await store.write('project', { subject: 'a.b', name: '正式', description: 'd', confidence: 3, body: 'x' });
		await store.write('project', { subject: 'c.d', name: '候选', description: 'd', confidence: 1, body: 'y' });
		// 手写笔记（无 frontmatter）→ legacy，不进索引
		await store.ensureDir('project');
		await writeFile(join(projectDir, 'hand-written.md'), '# 我的手写笔记\n内容\n', 'utf-8');

		await store.rebuildIndex('project');

		const index = await readFile(join(projectDir, 'MEMORY.md'), 'utf-8');
		expect(index).toContain('[正式](a-b.md)');
		expect(index).not.toContain('候选');
		expect(index).toContain('hand-written.md'); // 仅作为 legacy 提示行出现

		const candidates = await readFile(join(projectDir, 'candidates.md'), 'utf-8');
		expect(candidates).toContain('[候选](c-d.md)');
	});

	it('listDue / markReminded：到期条目（含候选）返回一次后清空 remindAt', async () => {
		const now = new Date('2026-09-15T00:00:00Z');
		await store.write('project', {
			subject: 'defer.a', name: '到期项', description: 'd', confidence: 3, body: 'b',
			remindAt: '2026-09-14T00:00:00Z',
		});
		// 候选条目（confidence=1）也应被提醒：这是用户明确要求的事
		await store.write('project', {
			subject: 'defer.b', name: '候选到期项', description: 'd', confidence: 1, body: 'b',
			remindAt: '2026-09-14T12:00:00Z',
		});
		// 未到期的不返回
		await store.write('project', {
			subject: 'defer.c', name: '未到期', description: 'd', confidence: 3, body: 'b',
			remindAt: '2026-10-01T00:00:00Z',
		});

		const due = await store.listDue('project', now);
		expect(due.map((e) => e.slug)).toEqual(['defer-a', 'defer-b']);

		expect(await store.markReminded('project', 'defer-a')).toBe(true);
		expect(await store.markReminded('project', 'defer-a')).toBe(false); // 幂等：已无 remindAt
		const after = (await store.readEntry('project', 'defer-a'))!;
		expect(after.remindAt).toBeUndefined();
		expect(after.body).toBe('b'); // 条目本身保留

		const dueAgain = await store.listDue('project', now);
		expect(dueAgain.map((e) => e.slug)).toEqual(['defer-b']);
	});

	it('scan：无 frontmatter 的手写笔记归入 legacy 且不成为条目', async () => {
		await store.ensureDir('project');
		await writeFile(join(projectDir, 'note.md'), '无 frontmatter 的笔记\n', 'utf-8');
		const { entries, legacy } = await store.scan('project');
		expect(entries).toHaveLength(0);
		expect(legacy).toEqual(['note.md']);
	});

	it('forget：写墓碑并退出索引（文件保留）', async () => {
		const r = await store.write('project', { subject: 'x.y', name: 'X', description: 'd', confidence: 3, body: 'v' });
		expect(await store.forget('project', r.slug, '用户要求')).toBe(true);

		expect(await store.listEntries('project')).toHaveLength(0);
		const entry = (await store.readEntry('project', r.slug))!;
		expect(entry.status).toBe('superseded');
		expect(existsSync(join(projectDir, `${r.slug}.md`))).toBe(true);
		expect(await store.forget('project', 'not-exist')).toBe(false);
	});

	it('state：游标读写（跨进程可恢复）', async () => {
		expect(await store.getState('project')).toEqual({});
		await store.setState('project', { lastExtractedTurnId: 'turn-42' });
		const state = await store.getState('project');
		expect(state.lastExtractedTurnId).toBe('turn-42');
		expect(state.updatedAt).toBeDefined();

		await store.setState('project', { lastExtractedTurnId: 'turn-43' });
		expect((await store.getState('project')).lastExtractedTurnId).toBe('turn-43');
	});

	it('audit / appendLog：追加式落盘且不抛错', async () => {
		await store.audit({ kind: 'write', at: new Date().toISOString(), scope: 'project', slug: 'x' });
		await store.audit({ kind: 'error', at: new Date().toISOString(), scope: 'project', where: 'parse' });
		const audit = await readFile(join(projectDir, 'audit.jsonl'), 'utf-8');
		const lines = audit.trim().split('\n');
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).kind).toBe('write');
		expect(JSON.parse(lines[1]).where).toBe('parse');

		await store.appendLog('project', '观察到用户偏好 X');
		const d = new Date();
		const yyyy = String(d.getUTCFullYear());
		const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
		const dd = String(d.getUTCDate()).padStart(2, '0');
		const log = await readFile(join(projectDir, 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`), 'utf-8');
		expect(log).toContain('观察到用户偏好 X');
	});

	it('frontmatter 往返：序列化后可解析回等价条目', () => {
		const entry: MemoryEntry = {
			slug: 'reply-format', name: '回复: 格式', description: '含冒号与逗号, 需引号', type: 'feedback',
			subject: 'reply.format', tags: ['reply style', 'format'], scope: 'project', confidence: 3, signal: 'A',
			paths: ['src/**', 'docs/*.md'], remindAt: '2026-09-15T09:00:00.000Z',
			created: '2026-09-12T09:10:00.000Z', updated: '2026-09-13T02:00:00.000Z', status: 'active',
			body: '正文\n**Why:** 原因', filePath: '/tmp/reply-format.md',
		};
		const parsed = parseEntry(serializeEntry(entry), '/tmp/reply-format.md', 'project')!;
		expect(parsed.name).toBe(entry.name);
		expect(parsed.description).toBe(entry.description);
		expect(parsed.tags).toEqual(entry.tags);
		expect(parsed.paths).toEqual(entry.paths);
		expect(parsed.confidence).toBe(3);
		expect(parsed.body).toBe(entry.body);
	});

	it('辅助函数：slugify / ageText / renderManifestLine', () => {
		expect(slugify('reply.format')).toBe('reply-format');
		expect(slugify('中文 标题')).toBe('memory');
		expect(slugify('A/B C')).toBe('a-b-c');

		const now = new Date('2026-09-13T12:00:00Z');
		expect(ageText('2026-09-13T02:00:00Z', now)).toBe('today');
		expect(ageText('2026-09-12T02:00:00Z', now)).toBe('yesterday');
		expect(ageText('2026-09-10T02:00:00Z', now)).toBe('3 days ago');
		expect(ageText('not-a-date', now)).toBe('unknown');

		const line = renderManifestLine({
			slug: 'a-b', name: 'A', description: 'd', type: 'user', subject: 'a.b', tags: [], scope: 'project',
			confidence: 2, created: '2026-09-10T00:00:00Z', updated: '2026-09-13T00:00:00Z', status: 'active', body: '', filePath: '',
		});
		expect(line).toBe('- [A](a-b.md) — d (confidence 2, updated today)');
	});

	it('parseFrontmatter：忽略未知键与注释，支持数组与数字', () => {
		const fm = parseFrontmatter('# 注释\nsubject: a.b\ntags: [x, "y z"]\nconfidence: 3\nunknown: v\n');
		expect(fm.subject).toBe('a.b');
		expect(fm.tags).toEqual(['x', 'y z']);
		expect(fm.confidence).toBe(3);
		expect(fm.unknown).toBe('v');
	});

	it('缺 subject 的 frontmatter 文件不算条目（防止半成品污染索引）', async () => {
		await store.ensureDir('project');
		await mkdir(join(projectDir, 'sub'), { recursive: true });
		await writeFile(join(projectDir, 'broken.md'), '---\nname: 只有名字\n---\n正文\n', 'utf-8');
		const { entries, legacy } = await store.scan('project');
		expect(entries).toHaveLength(0);
		expect(legacy).toContain('broken.md');
	});
});
