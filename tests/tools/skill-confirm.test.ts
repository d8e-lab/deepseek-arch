/**
 * skill-confirm.test.ts — skill 工具动态确认（confirmRequiredFor）测试
 *
 * 独立文件：vi.mock 必须在模块顶层 hoisted，避免影响其他测试文件。
 */

import { describe, it, expect, vi } from 'vitest';

// mock loadSkills：返回一个 requires-confirm: true 与一个普通 skill
vi.mock('../../src/core/skill.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/core/skill.js')>();
	return {
		...actual,
		loadSkills: vi.fn(async () => [
			{
				name: 'dangerous',
				description: '需要确认的危险技能',
				context: 'inline' as const,
				requiresConfirm: true,
				skillPath: '/tmp/dangerous.skill.md',
				source: 'project' as const,
			},
			{
				name: 'safe',
				description: '普通技能',
				context: 'inline' as const,
				skillPath: '/tmp/safe.skill.md',
				source: 'project' as const,
			},
		]),
	};
});

import { skillTool } from '../../src/tools/skill.js';

describe('skillTool.confirmRequiredFor', () => {
	it('requires-confirm: true 的 skill → 需要确认', async () => {
		const need = await skillTool.confirmRequiredFor?.({ skill: 'dangerous' });
		expect(need).toBe(true);
	});

	it('普通 skill → 不需要确认', async () => {
		const need = await skillTool.confirmRequiredFor?.({ skill: 'safe' });
		expect(need).toBe(false);
	});

	it('未找到的 skill → 不需要确认（不阻塞）', async () => {
		const need = await skillTool.confirmRequiredFor?.({ skill: 'ghost' });
		expect(need).toBe(false);
	});

	it('缺少 skill 参数 → false', async () => {
		const need = await skillTool.confirmRequiredFor?.({});
		expect(need).toBe(false);
	});
});
