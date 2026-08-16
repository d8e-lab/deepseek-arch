# Skill 机制彻底重构（deepseek-arch）

## 目标
以 Claude Code skill 架构为蓝本，重建 deepseek-arch 的 skill 机制：
frontmatter 元数据 + 目录扫描 + 静态 listing 注入 + 单一通用 skill 工具，
替换现有"硬编码 plan_on 工具 + 无发现"架构。无新依赖，compact 平滑兼容。

## 文件格式
skill/*.skill.md = YAML frontmatter + Markdown 正文
字段：name(默认文件名) / description(缺失取首行) / when_to_use / aliases /
argument-hint / context(inline|fork) / allowed-tools / model /
requires-confirm / version

## 子任务
- T1 core/skill.ts：类型 + parseSkillFrontmatter + loadSkills(两级目录+realpath去重) + buildSkillListing(预算1500/条200) + findSkill(别名) + getContent(参数替换 $ARGUMENTS/${SKILL_DIR})
- T2 tools/skill.ts：通用 skill 工具 {skill, args}，inline 返回全文；未找到时错误消息列可用 skill
- T3 tools/index.ts：-planOnTool +skillTool；删除 tools/plan.ts；保留 save-plan.ts
- T4 cli/index.ts：loadSkills → buildSkillListing → 拼入 system prompt
- T5 compact.ts：extractSkills 双识别（新 skill 工具读 arguments.skill + 旧 plan_on 兼容）
- T6 config.ts：copyPlanSkill → copySkillDir（复制整个 skill/ 目录）
- T7 示例 skill frontmatter + system_prompt.txt 指引改为 skill 工具
- T8 测试：tests/core/skill.test.ts + tests/tools/skill.test.ts + compact 测试更新

## 关键决策
- frontmatter 手写轻量解析（正则切块 + 引号 fallback），不引入 YAML 依赖
- listing 静态注入 system prompt（会话开始一次，写 system-prompt.txt 命中 KV-cache）
- 只认 *.skill.md 后缀
- 第一期 inline 执行；fork/requires-confirm/paths 第二三期（frontmatter 已解析预留）
- 工具 requiresConfirm: false 静态

## 验收
npm test 全绿；启动后 system-prompt.txt 含 <skill_listing>；skill 工具可调用 plan 返回全文；compact 双识别通过。

## 分支
git checkout -b feature/skill-rework
