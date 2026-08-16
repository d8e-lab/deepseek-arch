/**
 * skill 工具 — 通用 skill 调用入口
 *
 * 模型通过系统提示中的 <skill_listing> 发现可用 skill，
 * 调用本工具按名称加载并执行。支持 inline（默认，内容注入当前对话）
 * 与 fork（frontmatter context: fork，内容作为子代理任务执行）。
 *
 * 替换旧的硬编码 plan_on 工具：新增 skill 只需放文件 + 写 frontmatter，
 * 无需修改代码。
 */

import { loadSkills, findSkill, getSkillContent } from '../core/skill.js';
import type { Tool, ToolResult } from './types.js';

/** fork 执行器（懒绑定，避免与 SessionManager 循环依赖） */
export type SkillForkRunner = (name: string, task: string) => Promise<string>;

let _forkRunner: SkillForkRunner | null = null;

export function setSkillForkRunner(runner: SkillForkRunner): void {
	_forkRunner = runner;
}

export const skillTool: Tool = {
	name: 'skill',
	description:
		'调用一个 skill（技能）。可用 skill 列表与各自适用场景见系统提示中的 <skill_listing>。' +
		'当用户请求与某个 skill 的适用场景匹配时，必须先调用本工具再继续生成其他内容。' +
		'示例: {"skill": "plan", "args": "重构 session 模块"}、{"skill": "release", "args": "1.4.0"}。' +
		'若用户提到 "/plan" 等斜杠命令，即指同名 skill，用本工具调用。',
	parameters: {
		type: 'object',
		properties: {
			skill: {
				type: 'string',
				description: 'skill 名称（见系统提示 <skill_listing> 中的列表，可用别名）',
			},
			args: {
				type: 'string',
				description: '可选参数，传入 skill 正文的 $ARGUMENTS',
			},
		},
		required: ['skill'],
	},
	requiresConfirm: false,

	async execute(params): Promise<ToolResult> {
		const skillName = typeof params.skill === 'string' ? params.skill.trim() : '';
		const args = typeof params.args === 'string' ? params.args : '';

		if (!skillName) {
			return { content: 'Error: "skill" is required.', error: 'invalid_params' };
		}

		const skills = await loadSkills();
		const skill = findSkill(skillName, skills);
		if (!skill) {
			const available = skills.map((s) => s.name).join(', ') || '(none)';
			return {
				content: `Unknown skill: ${skillName}. Available skills: ${available}`,
				error: 'not_found',
			};
		}

		// fork 模式：内容作为子代理任务执行，只回传结果文本
		if (skill.context === 'fork') {
			if (!_forkRunner) {
				return {
					content: `Skill "${skill.name}" is declared as context: fork but no fork runner is configured.`,
					error: 'not_configured',
				};
			}
			const content = await getSkillContent(skill, args);
			const result = await _forkRunner(skill.name, content);
			return {
				content: `Skill "${skill.name}" completed (forked execution).\n\nResult:\n${result}`,
			};
		}

		// inline 模式（默认）：返回完整正文，模型在现有上下文继续执行
		const content = await getSkillContent(skill, args);
		return { content };
	},
};
