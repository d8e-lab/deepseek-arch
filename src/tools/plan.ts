/**
 * plan_on — 模型主动激活编码规划框架
 *
 * 模型判断任务复杂时调用此工具，注入结构化规划 skill。
 * skill 内容从 ~/.deepseek-arch/skill/plan.skill.md 读取，
 * 首次运行 ConfigManager 自动复制到该路径。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Tool, ToolResult } from './types.js';

const SKILL_PATH = resolve(homedir(), '.deepseek-arch', 'skill', 'plan.skill.md');

/** 硬编码兜底——skill 文件找不到时 */
const FALLBACK_SKILL = `# Plan Skill

> 目标：用最小改动量一次做对，避免改错模块、过度设计、反复返工。

## 0. 复杂度快速评估
判断任务复杂度。回答：
1. 涉及几个独立的功能点/模块？
2. 需修改 ≥3 个文件或变更核心接口？
3. 存在不确定因素（技术方案未定、遗留代码行为未知）？
4. 是否有可独立执行的子任务（适合 subagent_spawn 并行）？

**判定规则**（满足任一即"复杂"）：
- 功能点 ≥ 2
- 文件数 ≥ 3 或核心接口变更
- 问题 3 为"是"

## Phase 0 — Comprehend（理解需求）
- 复述需求，逐条确认
- 明确"不要什么"
- 识别模糊点主动追问
- 识别可独立子任务（适合 subagent_spawn）
- 确认验收标准（人视角 + 技术视角）

## Phase 1 — Orient（定位）
- 从入口追踪调用链
- 画出数据流
- 标记拦截点
- 标记哪些模块可独立修改 → 适合 subagent_spawn

## Phase 2 — Decide & Plan（决策与拆解）
- 列出受影响文件清单
- 拆解为子任务（含输入/输出/验收标准/风险）
- 标注每子任务是否可委派给 subagent_spawn
- 削减过度设计

**委派指南**：独立调研、独立模块修改、测试编写、代码审查 → 用 subagent_spawn
不要委派：核心接口修改、依赖未产出中间结果的任务、架构决策

## Phase 2.5 — 自检
- 对照理想计划原则逐条自检
- 特别检查：是否遗漏了可并行/可委派给 subagent 的子任务？
- 输出自检表
- 修订计划

## 用户确认断点
输出最终计划后，等待用户确认后再执行。

## Phase 3 — Act（执行）
- git stash → git checkout -b <分支>
- 按子任务顺序执行，每步编译+测试+commit
- 对标注了委派 subagent 的子任务，在适当时机 spawn subagent 并行执行

## Phase 4 — Verify（验证）
- 确认新代码可达
- 全量测试
- 对照验收标准
`;

async function readPlanSkill(): Promise<string> {
	try {
		return await readFile(SKILL_PATH, 'utf-8');
	} catch {
		return FALLBACK_SKILL;
	}
}

export const planOnTool: Tool = {
	name: 'plan_on',
	description: `激活结构化编码规划框架。调用后注入完整规划流程（理解需求 → 定位调用链 → 决策与拆解 → 自检 → 确认）。

何时调用：
- 任务涉及 ≥2 个独立功能模块
- 需修改 ≥3 个文件或变更核心接口/数据模型
- 存在不确定因素（技术方案未定、遗留代码行为未知）
- 用户明确要求先出方案

调用后遵循规划框架的 Phases 逐步执行。完成 Phase 2.5 自检后输出最终计划，
等待用户确认。用户确认后调用 save_plan 保存产物。
不需要再单独加 PLAN_SKILL_ACTIVATED 标记——你收到的 tool result 就是规划框架全文。

重要提示：规划时积极评估哪些子任务可委派给 subagent_spawn 并行执行。
独立调研、独立模块修改、测试编写、代码审查都是好的 subagent 候选。`,
	parameters: {
		type: 'object',
		properties: {},
		required: [],
	},
	requiresConfirm: false,

	async execute(): Promise<ToolResult> {
		const content = await readPlanSkill();
		return { content };
	},
};
