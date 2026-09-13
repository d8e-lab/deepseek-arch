/**
 * save-plan.test.ts — save_plan 落盘位置（{workspace}/.deepseek-arch/plan/）与 compact 读回
 *
 * 覆盖需求 6：save_plan 写到新 runtime 目录；compact 的 plan 重注入从同一位置读取。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { savePlanTool } from '../../src/tools/save-plan.js';
import { buildPlanBlock } from '../../src/core/compact.js';
import type { TurnRecord } from '../../src/types/index.js';

describe('save_plan 落盘位置', () => {
	let dir: string;
	const original = process.env.DEEPSEEK_ARCH_SESSION_CWD;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'deepseek-save-plan-'));
		process.env.DEEPSEEK_ARCH_SESSION_CWD = dir;
	});

	afterEach(async () => {
		if (original === undefined) delete process.env.DEEPSEEK_ARCH_SESSION_CWD;
		else process.env.DEEPSEEK_ARCH_SESSION_CWD = original;
		await rm(dir, { recursive: true, force: true });
	});

	it('写入 {workspace}/.deepseek-arch/plan/<name>.md', async () => {
		const result = await savePlanTool.execute({ plan_name: 'my-plan', plan_content: '# 计划\n内容' });

		const filePath = join(dir, '.deepseek-arch', 'plan', 'my-plan.md');
		expect(result.error).toBeUndefined();
		expect(result.content).toContain(filePath);
		expect(await readFile(filePath, 'utf-8')).toBe('# 计划\n内容');
		// 旧目录不再产生
		await expect(stat(join(dir, '.plans'))).rejects.toThrow();
	});

	it('文件名做安全化处理（非 [A-Za-z0-9_-] 替换为 _）', async () => {
		await savePlanTool.execute({ plan_name: 'a/b c', plan_content: 'x' });
		const filePath = join(dir, '.deepseek-arch', 'plan', 'a_b_c.md');
		expect(await readFile(filePath, 'utf-8')).toBe('x');
	});

	it('空内容报错且不落盘', async () => {
		const result = await savePlanTool.execute({ plan_name: 'empty', plan_content: '   ' });
		expect(result.error).toBe('plan_content is empty');
		await expect(stat(join(dir, '.deepseek-arch', 'plan', 'empty.md'))).rejects.toThrow();
	});

	it('compact 的 plan 重注入能从新位置读回同一份内容（需求 6 同步）', async () => {
		await savePlanTool.execute({ plan_name: 'refactor', plan_content: '# 重构计划\n步骤一' });

		const turn: TurnRecord = {
			version: 2,
			messages: [{ role: 'user', content: '开始' }],
			tool_calls: [
				{
					id: 'c1',
					name: 'save_plan',
					arguments: { plan_name: 'refactor', plan_content: '# 重构计划\n步骤一' },
					result: 'ok',
					duration_ms: 1,
				},
			],
			cost_rmb: 0,
			created_at: new Date().toISOString(),
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		};

		const block = await buildPlanBlock([turn], dir);
		expect(block.text).toContain('[Current Plan: refactor]');
		expect(block.text).toContain('# 重构计划');
		expect(block.tokenCount).toBeGreaterThan(0);
	});
});
