/**
 * save_plan — 保存规划文档到工作目录
 *
 * 用户确认计划后调用。写入 <workspace>/.plans/<name>.md。
 * requiresConfirm: true，用户确认写入内容后再执行。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool, ToolResult } from './types.js';
import { checkPath } from './utils.js';

export const savePlanTool: Tool = {
	name: 'save_plan',
	description: `将规划文档保存到工作目录下的 .plans/<name>.md。
在用户确认计划后调用。plan_name 用作文件名（不含扩展名），plan_content 为完整规划内容（Markdown）。`,
	parameters: {
		type: 'object',
		properties: {
			plan_name: {
				type: 'string',
				description: '计划文件名（不含路径和扩展名，如 "session-refactor"）',
			},
			plan_content: {
				type: 'string',
				description: '完整的规划内容（Markdown 格式）',
			},
		},
		required: ['plan_name', 'plan_content'],
	},
	requiresConfirm: true,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const name = String(params.plan_name ?? 'plan');
		const content = String(params.plan_content ?? '');

		if (!content.trim()) {
			return { content: '', error: 'plan_content is empty' };
		}

		const sessionCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();
		const planDir = join(sessionCwd, '.plans');
		const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
		const filePath = join(planDir, `${safeName}.md`);

		// 确保路径在工作目录内
		const check = checkPath(filePath, sessionCwd);
		if (!check.valid) {
			return { content: '', error: check.error };
		}

		await mkdir(planDir, { recursive: true, mode: 0o755 });
		await writeFile(filePath, content, 'utf-8');

		return { content: `Plan saved to ${filePath}` };
	},
};
