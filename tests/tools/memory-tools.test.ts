/**
 * memory-tools.test.ts — memory_read / memory_write 工具单元测试
 *
 * 覆盖：写入（新增/更新/合并/取代 + 索引重建）、scope 决定层级、
 * 读取（自动定位层 / global: 前缀 / 不存在）、以及「全局层不经沙箱可读」这一关键能力。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../../src/core/memory-store.js';
import { setMemoryStore } from '../../src/core/memory-service.js';
import { memoryReadTool } from '../../src/tools/memory-read.js';
import { memoryWriteTool } from '../../src/tools/memory-write.js';
import { getAllTools } from '../../src/tools/index.js';

describe('memory 工具', () => {
	let root: string;
	let projectDir: string;
	let globalDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'deepseek-memory-tools-'));
		projectDir = join(root, 'project');
		globalDir = join(root, 'global');
		setMemoryStore(new MemoryStore({ projectDir, globalDir, masterMinConfidence: 2 }));
	});

	afterEach(async () => {
		setMemoryStore(null);
		await rm(root, { recursive: true, force: true });
	});

	it('memory_write：默认写项目层并重建索引', async () => {
		const r = await memoryWriteTool.execute({
			subject: 'reply.format',
			name: '回复格式',
			description: '先给结论',
			type: 'feedback',
			tags: 'reply, format',
			confidence: 3,
			body: '先给结论再给理由。\n**Why:** 用户明确说过。',
		});

		expect(r.error).toBeUndefined();
		expect(r.content).toContain('added');
		expect(existsSync(join(projectDir, 'reply-format.md'))).toBe(true);
		const index = await readFile(join(projectDir, 'MEMORY.md'), 'utf-8');
		expect(index).toContain('[回复格式](reply-format.md)');
	});

	it('memory_write：scope=global 写到全局层', async () => {
		await memoryWriteTool.execute({ scope: 'global', subject: 'style.x', name: '全局', description: 'd', body: 'b' });
		expect(existsSync(join(globalDir, 'style-x.md'))).toBe(true);
		expect(existsSync(join(projectDir, 'style-x.md'))).toBe(false);
	});

	it('memory_write：指定 slug → 更新同一条（不新建、不取代）', async () => {
		await memoryWriteTool.execute({ subject: 'plan.dir', name: '计划目录', description: 'd', body: '写在 .plans/' });
		const updated = await memoryWriteTool.execute({
			slug: 'plan-dir', subject: 'plan.dir', name: '计划目录', description: 'd', body: '写在 .deepseek-arch/plan/',
		});
		expect(updated.content).toContain('updated');
		// 正文被替换（索引行只含 description，正文在各条目文件里）
		const entry = await readFile(join(projectDir, 'plan-dir.md'), 'utf-8');
		expect(entry).toContain('.deepseek-arch/plan/');
		expect(entry).not.toContain('.plans/');
		// 只有一个条目文件
		const index = await readFile(join(projectDir, 'MEMORY.md'), 'utf-8');
		expect(index).toContain('[计划目录](plan-dir.md)');
	});

	it('memory_write：不给 slug 且同 subject 内容冲突 → 取代旧条目（索引只留新的）', async () => {
		await memoryWriteTool.execute({ subject: 'plan.dir', name: '旧', description: 'd', body: '写在 .plans/' });
		const r = await memoryWriteTool.execute({ subject: 'plan.dir', name: '新', description: 'd', body: '写在 .deepseek-arch/plan/' });
		expect(r.content).toContain('superseded');

		const index = await readFile(join(projectDir, 'MEMORY.md'), 'utf-8');
		expect(index).toContain('新');
		expect(index).not.toContain('旧');
		// 旧条目文件仍在（留演化记录），但已退出索引
		expect(existsSync(join(projectDir, 'plan-dir.md'))).toBe(true);
	});

	it('memory_write：缺参数与非法参数报错', async () => {
		expect((await memoryWriteTool.execute({ subject: '', body: '' })).error).toBe('both "subject" and "body" are required');
	});

	it('memory_write：supersedes 显式指定被取代条目', async () => {
		await memoryWriteTool.execute({ subject: 'old.topic', name: '旧主题', description: 'd', body: 'v1' });
		// 显式取代：新 subject 不同，但指名取代 old-topic
		const r = await memoryWriteTool.execute({
			subject: 'new.topic', name: '新主题', description: 'd', body: 'v2', supersedes: 'old-topic',
		});
		expect(r.error).toBeUndefined();

		const index = await readFile(join(projectDir, 'MEMORY.md'), 'utf-8');
		expect(index).toContain('新主题');
		expect(index).not.toContain('旧主题');
	});

	it('memory_read：自动定位层（项目层优先）并返回正文与元信息', async () => {
		await memoryWriteTool.execute({ subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: '项目层正文' });
		const r = await memoryReadTool.execute({ path: 'a-b.md' });
		expect(r.error).toBeUndefined();
		expect(r.content).toContain('[memory:project] a-b');
		expect(r.content).toContain('项目层正文');
	});

	it('memory_read：global: 前缀可读全局层（普通文件工具受沙箱限制读不到）', async () => {
		await memoryWriteTool.execute({ scope: 'global', subject: 'g.x', name: 'G', description: 'd', body: '全局层正文' });
		const r = await memoryReadTool.execute({ path: 'global:g-x.md' });
		expect(r.error).toBeUndefined();
		expect(r.content).toContain('[memory:global] g-x');
		expect(r.content).toContain('全局层正文');
	});

	it('memory_read：找不到时报错并列出查找位置', async () => {
		const r = await memoryReadTool.execute({ path: 'nope.md' });
		expect(r.error).toBe('not_found');
		expect(r.content).toContain('Looked in:');
		expect((await memoryReadTool.execute({ path: '' })).error).toBe('path is required');
	});

	it('memory_read：候选池（confidence 1）与索引文件都能读 —— 归纳代理维护候选池的前提', async () => {
		await memoryWriteTool.execute({ subject: 'cand.one', name: '候选条', description: 'd', confidence: 1, body: '模糊候选正文' });

		// ① 按 slug 直接读候选条目（master 看不到它，但代理必须能读）
		const byslug = await memoryReadTool.execute({ path: 'cand-one.md' });
		expect(byslug.error).toBeUndefined();
		expect(byslug.content).toContain('[memory:project] cand-one (confidence 1');
		expect(byslug.content).toContain('模糊候选正文');

		// ② 读候选清单文件本身
		const cand = await memoryReadTool.execute({ path: 'candidates.md' });
		expect(cand.content).toContain('cand-one.md');

		// ③ 读正式索引
		const index = await memoryReadTool.execute({ path: 'MEMORY.md' });
		expect(index.content).toContain('Memory index');

		// ④ 读到条目会记一次「使用」（LRU 信号；注入不算）—— 使用统计存在总表 manifest.json。
		// 注意：候选条已被写入过一次（uses=1），这次读取使其达到升级阈值 → v3 会话内即时升到 2，
		// 计数随之清零；因此这里用审计记录来断言"确实记了一次使用"。
		const audit = await readFile(join(projectDir, 'audit.jsonl'), 'utf-8');
		expect(audit).toContain('"kind":"use"');
		expect(audit).toContain('"slug":"cand-one"');
		expect((await memoryReadTool.execute({ path: 'cand-one.md' })).content).toContain('confidence 2');
	});

	it('工具注册：主代理有 memory_read/memory_write，子代理没有', () => {
		const master = getAllTools({ includeSubagent: true }).map((t) => t.name);
		expect(master).toContain('memory_read');
		expect(master).toContain('memory_write');

		const sub = getAllTools().map((t) => t.name);
		expect(sub).not.toContain('memory_read');
		expect(sub).not.toContain('memory_write');
	});

	it('memory_read：拒绝 memory 目录之外的路径（v3 D9）', async () => {
		await memoryWriteTool.execute({ subject: 'a.b', name: 'A', description: 'd', body: '正文' });

		// 目录穿越
		const escape = await memoryReadTool.execute({ path: '../../../etc/hostname' });
		expect(escape.error).toBe('not_found');
		expect(escape.content).toContain('outside the memory directories');

		// 绝对路径指向仓库外
		const abs = await memoryReadTool.execute({ path: '/etc/hostname' });
		expect(abs.error).toBe('not_found');

		// memory 目录内的绝对路径仍可读
		const inside = await memoryReadTool.execute({ path: join(projectDir, 'a-b.md') });
		expect(inside.error).toBeUndefined();
		expect(inside.content).toContain('正文');
	});

	it('memory_write：字符串置信度被正确解析（v3 D11）', async () => {
		await memoryWriteTool.execute({ subject: 's.one', name: 'S', description: 'd', body: 'b', confidence: 2 });
		// 模型常把数字写成字符串：必须真的降到 1（软淘汰），而不是静默忽略并保持可见
		const r = await memoryWriteTool.execute({
			slug: 's-one', subject: 's.one', name: 'S', description: 'd', body: 'b', confidence: '1',
		});
		expect(r.error).toBeUndefined();
		const entry = await readFile(join(projectDir, 's-one.md'), 'utf-8');
		expect(entry).toContain('confidence: 1');
	});

	it('memory_read：条目超过 64K 时截断返回并带标记（v3 D10）', async () => {
		const big = 'x'.repeat(70 * 1024);
		await memoryWriteTool.execute({ subject: 'big.one', name: 'B', description: 'd', body: big });

		const r = await memoryReadTool.execute({ path: 'big-one.md' });
		expect(r.error).toBeUndefined();
		expect(r.content).toContain('⚠ (truncated at');
		expect(Buffer.byteLength(r.content, 'utf-8')).toBeLessThan(70 * 1024);
	});
});
