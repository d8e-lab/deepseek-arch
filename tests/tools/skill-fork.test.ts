/**
 * skill-fork.test.ts — skill 工具 fork 分支测试
 *
 * 独立文件：vi.mock 必须在模块顶层 hoisted，避免影响同文件其他测试。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock loadSkills 返回一个 context: fork 的 skill
vi.mock('../../src/core/skill.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/core/skill.js')>();
	return {
		...actual,
		loadSkills: vi.fn(async () => [
			{
				name: 'forky',
				description: 'fork 测试',
				context: 'fork' as const,
				skillPath: '/tmp/forky.skill.md',
				source: 'project' as const,
			},
		]),
		getSkillContent: vi.fn(async () => 'fork 任务内容'),
	};
});

import { skillTool, setSkillForkRunner } from '../../src/tools/skill.js';

describe('skillTool fork 分支', () => {
	beforeEach(() => {
		setSkillForkRunner(null as never); // 默认无 runner
	});

	it('context: fork 且未配置 runner → not_configured', async () => {
		const result = await skillTool.execute({ skill: 'forky' });
		expect(result.error).toBe('not_configured');
		expect(result.content).toContain('fork');
	});

	it('context: fork 且已配置 runner → 回传子代理结果', async () => {
		setSkillForkRunner(async (name, task) => `[${name} 执行完成] ${task.slice(0, 4)}`);
		const result = await skillTool.execute({ skill: 'forky' });
		expect(result.error).toBeUndefined();
		expect(result.content).toContain('forked execution');
		expect(result.content).toContain('forky 执行完成');
	});
});
