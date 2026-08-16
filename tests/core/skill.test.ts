/**
 * skill.test.ts — Skill 核心引擎单元测试
 *
 * 覆盖：
 *   - parseSkillFrontmatter：正常/缺失/降级/数组字段/特殊字符/requires-confirm
 *   - loadSkills：从项目 skill/ 目录加载真实 skill（plan/release）
 *   - buildSkillListing：预算内完整、超预算截断、极端只剩名字
 *   - findSkill：精确/别名/前导斜杠/大小写
 *   - getSkillContent：剥离 frontmatter、$ARGUMENTS 与 ${SKILL_DIR} 替换
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	parseSkillFrontmatter,
	loadSkillsFromDirs,
	getProjectSkillDir,
	clearSkillCache,
	findSkill,
	buildSkillListing,
	getSkillContent,
	SKILL_LISTING_BUDGET,
} from '../../src/core/skill.js';

// ─── parseSkillFrontmatter ─────────────────────────

describe('parseSkillFrontmatter', () => {
	it('解析完整 frontmatter', () => {
		const content = `---
name: my-skill
description: 我的技能
when_to_use: 用户要求做 X 时
aliases: [skill-a, skill-b]
context: fork
allowed-tools: Read, Grep
requires-confirm: true
version: 1.2.0
---
# 正文
内容`;
		const { fields, body } = parseSkillFrontmatter(content, '/tmp/my-skill.skill.md');
		expect(fields.name).toBe('my-skill');
		expect(fields.description).toBe('我的技能');
		expect(fields.whenToUse).toBe('用户要求做 X 时');
		expect(fields.aliases).toEqual(['skill-a', 'skill-b']);
		expect(fields.context).toBe('fork');
		expect(fields.allowedTools).toEqual(['Read', 'Grep']);
		expect(fields.requiresConfirm).toBe(true);
		expect(fields.version).toBe('1.2.0');
		expect(body.startsWith('# 正文')).toBe(true);
	});

	it('无 frontmatter 时降级（name 取文件名、description 取正文首行）', () => {
		const content = `# My Skill
第一行说明`;
		const { fields } = parseSkillFrontmatter(content, '/tmp/fallback.skill.md');
		expect(fields.name).toBe('fallback');
		expect(fields.description).toContain('My Skill');
		expect(fields.context).toBe('inline');
	});

	it('frontmatter 缺失 name 时取文件名', () => {
		const content = `---
description: 只有描述
---
正文`;
		const { fields } = parseSkillFrontmatter(content, '/tmp/only-desc.skill.md');
		expect(fields.name).toBe('only-desc');
		expect(fields.description).toBe('只有描述');
	});

	it('aliases 支持逗号分隔形式', () => {
		const content = `---
aliases: alpha, beta
---
正文`;
		const { fields } = parseSkillFrontmatter(content, '/tmp/x.skill.md');
		expect(fields.aliases).toEqual(['alpha', 'beta']);
	});

	it('requires-confirm 解析布尔', () => {
		const t = (v: string) =>
			parseSkillFrontmatter(`---\nrequires-confirm: ${v}\n---\nbody`, '/tmp/x.skill.md').fields
				.requiresConfirm;
		expect(t('true')).toBe(true);
		expect(t('false')).toBe(false);
		expect(t('')).toBeUndefined();
	});

	it('特殊字符值（glob 模式）不破坏解析', () => {
		const content = `---
description: 匹配 docs 下的文件
when_to_use: 处理 docs/**\/*.{md,txt} 时
---
正文`;
		const { fields } = parseSkillFrontmatter(content, '/tmp/glob.skill.md');
		expect(fields.whenToUse).toContain('docs');
	});
});

// ─── loadSkillsFromDirs（隔离环境：临时 user 目录 + 真实项目目录）──

describe('loadSkillsFromDirs', () => {
	let tmpDir: string;
	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'skill-test-'));
		await mkdir(tmpDir, { recursive: true });
		// 用户目录：自定义 skill + 覆盖项目的同名 skill（自定义 frontmatter）
		await writeFile(
			join(tmpDir, 'custom.skill.md'),
			`---
name: custom
description: 用户自定义技能
when_to_use: 用户要求做自定义事情时
---
自定义正文`,
			'utf-8',
		);
		await writeFile(
			join(tmpDir, 'release.skill.md'),
			`---
name: release
description: 用户覆盖的发布技能
when_to_use: 用户自定义发版流程时
---
用户版发布正文`,
			'utf-8',
		);
	});
	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
		clearSkillCache();
	});

	it('加载 user + project 两级目录', async () => {
		const skills = await loadSkillsFromDirs(tmpDir, getProjectSkillDir());
		const names = skills.map((s) => s.name);
		expect(names).toContain('custom'); // 用户自定义
		expect(names).toContain('plan'); // 项目自带
		expect(names).toContain('release');
		expect(names).toContain('research'); // fork 示例
	});

	it('user 目录优先（findSkill 返回用户版）', async () => {
		const skills = await loadSkillsFromDirs(tmpDir, getProjectSkillDir());
		const release = findSkill('release', skills);
		expect(release).toBeDefined();
		expect(release!.description).toBe('用户覆盖的发布技能');
		expect(release!.source).toBe('user');
	});

	it('项目 skill frontmatter 解析完整', async () => {
		const skills = await loadSkillsFromDirs(tmpDir, getProjectSkillDir());
		const plan = skills.find((s) => s.name === 'plan' && s.source === 'project');
		expect(plan).toBeDefined();
		expect(plan!.whenToUse).toBeDefined();
		expect(plan!.context).toBe('inline');
		// fork 示例：context 解析为 fork
		const research = skills.find((s) => s.name === 'research');
		expect(research).toBeDefined();
		expect(research!.context).toBe('fork');
	});

	it('不存在的目录返回空（不崩溃）', async () => {
		const skills = await loadSkillsFromDirs(join(tmpDir, 'nope'), join(tmpDir, 'nope2'));
		expect(skills).toEqual([]);
	});
});

// ─── findSkill ─────────────────────────────────────

describe('findSkill', () => {
	const skills = [
		{ name: 'plan', description: 'd', context: 'inline' as const, skillPath: '/p', source: 'project' as const, aliases: ['planning'] },
		{ name: 'release', description: 'd', context: 'inline' as const, skillPath: '/r', source: 'project' as const },
	];

	it('精确匹配', () => {
		expect(findSkill('plan', skills)?.name).toBe('plan');
	});
	it('别名匹配', () => {
		expect(findSkill('planning', skills)?.name).toBe('plan');
	});
	it('前导斜杠', () => {
		expect(findSkill('/release', skills)?.name).toBe('release');
	});
	it('大小写不敏感', () => {
		expect(findSkill('Plan', skills)?.name).toBe('plan');
	});
	it('未找到返回 undefined', () => {
		expect(findSkill('nope', skills)).toBeUndefined();
	});
});

// ─── buildSkillListing ─────────────────────────────

describe('buildSkillListing', () => {
	const mk = (name: string, description: string, whenToUse?: string) => ({
		name,
		description,
		whenToUse,
		context: 'inline' as const,
		skillPath: `/tmp/${name}.skill.md`,
		source: 'project' as const,
	});

	it('空列表返回空串', () => {
		expect(buildSkillListing([])).toBe('');
	});

	it('预算内完整展示（含 when to use）', () => {
		const listing = buildSkillListing([mk('plan', '规划框架', '接到任务时')], 10_000);
		expect(listing).toContain('- plan: 规划框架 - when to use: 接到任务时');
		expect(listing).toContain('Available skills');
	});

	it('超预算时截断描述', () => {
		const skills = [
			mk('plan', '很长的描述'.repeat(100)),
			mk('release', '也很长的描述'.repeat(100)),
		];
		const listing = buildSkillListing(skills, 500);
		// 名字保留、描述被截断
		expect(listing).toContain('- plan:');
		expect(listing).toContain('- release:');
		expect(listing.length).toBeLessThan(500);
	});

	it('极端预算只剩名字', () => {
		const skills = [mk('plan', 'x'.repeat(300)), mk('release', 'y'.repeat(300))];
		const listing = buildSkillListing(skills, 100);
		expect(listing).toContain('- plan');
		expect(listing).not.toContain('x'.repeat(50));
	});

	it('默认预算常量生效', () => {
		const skills = Array.from({ length: 20 }, (_, i) => mk(`s${i}`, 'd'.repeat(100)));
		const listing = buildSkillListing(skills);
		expect(listing.length).toBeLessThanOrEqual(SKILL_LISTING_BUDGET);
	});
});

// ─── getSkillContent ───────────────────────────────

describe('getSkillContent', () => {
	let tmpDir: string;
	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'skill-content-'));
		await writeFile(
			join(tmpDir, 'sub.skill.md'),
			`---
name: sub
description: 占位符替换测试
---
正文 $ARGUMENTS 结束
目录: \${SKILL_DIR}`,
			'utf-8',
		);
	});
	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('剥离 frontmatter', async () => {
		const skills = await loadSkillsFromDirs('/nonexistent-user-dir', getProjectSkillDir());
		const release = skills.find((s) => s.name === 'release');
		expect(release).toBeDefined();
		const content = await getSkillContent(release!, '1.4.0');
		// frontmatter 字段已剥离（正文本身含 --- 水平线，不能断言 ---）
		expect(content).not.toContain('when_to_use');
		expect(content).not.toContain('name: release');
		expect(content).toContain('# Release Skill');
	});

	it('替换 $ARGUMENTS 与 ${SKILL_DIR}', async () => {
		const skills = await loadSkillsFromDirs(tmpDir, '/nonexistent-project-dir');
		const sub = skills.find((s) => s.name === 'sub');
		expect(sub).toBeDefined();
		const content = await getSkillContent(sub!, 'hello world');
		expect(content).toContain('正文 hello world 结束');
		expect(content).toContain(`目录: ${tmpDir}`);
		expect(content).not.toContain('$ARGUMENTS');
		expect(content).not.toContain('${SKILL_DIR}');
	});
});
