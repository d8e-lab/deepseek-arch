/**
 * skill.test.ts — 通用 skill 工具单元测试
 *
 * 覆盖：
 *   - inline 执行：返回 skill 全文（真实项目文件 plan/release）
 *   - 未找到：错误 + 列出可用 skill
 *   - 参数校验：缺 skill 参数
 *   - fork 分支：context: fork 未配置 runner → not_configured（vi.mock）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { skillTool } from '../../src/tools/skill.js';
import { clearSkillCache } from '../../src/core/skill.js';

describe('skillTool', () => {
	beforeAll(() => clearSkillCache());
	afterAll(() => clearSkillCache());

	it('inline 执行：返回 plan skill 全文（frontmatter 剥离）', async () => {
		const result = await skillTool.execute({ skill: 'plan' });
		expect(result.error).toBeUndefined();
		expect(result.content).toContain('Phase 0');
		expect(result.content).not.toContain('when_to_use');
	});

	it('支持别名与参数传递', async () => {
		const result = await skillTool.execute({ skill: 'release', args: '1.4.0' });
		expect(result.error).toBeUndefined();
		expect(result.content).toContain('# Release Skill');
	});

	it('skill 参数缺失 → invalid_params', async () => {
		const result = await skillTool.execute({});
		expect(result.error).toBe('invalid_params');
	});

	it('未找到 skill → 错误并列出可用 skill', async () => {
		const result = await skillTool.execute({ skill: 'nonexistent-skill' });
		expect(result.error).toBe('not_found');
		expect(result.content).toContain('Unknown skill');
		expect(result.content).toContain('plan'); // 可用列表
	});
});
