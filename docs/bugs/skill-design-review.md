# Skill 设计审查 — release skill 不可达、更新策略缺陷、plan skill 与工具描述断裂

**类型**: Skill 设计审查（Skill Design Review）
**发现日期**: 2026-08-06
**当前基线**: `main` @ `68acdb7`（HEAD）
**涉及文件**: `skill/plan.skill.md`、`skill/release.skill.md`、`src/tools/plan.ts`、`src/tools/save-plan.ts`、`src/core/config.ts`、`src/core/session.ts`、`src/tools/subagent-spawn.ts`、`src/tools/subagent-wait.ts`、`src/tools/index.ts`、`system_prompt.txt`、`docs/paste-retrospective.md`、`aur/PKGBUILD`、`scripts/build-prebuilt-tarball.sh`

**总体结论**: plan skill 的**内容设计**（Phase 流程、确认断点、subagent 委派引导）质量较高且与 plan_on 工具基本自洽；但**机制层存在 4 个实质问题**——release skill 无触发链路（形同虚设）、skill 更新无法到达老用户、subagent 工具描述增强在 merge 中丢失造成 skill 与工具不一致、save_plan 时机在 system_prompt 与 skill 正文之间表述冲突。

---

## 一、Skill 机制概览（完整链路）

```
skill/plan.skill.md (187行) ──┬── 打包分发 ──┬── npm 包 (package.json:17 "skill/")
skill/release.skill.md (161行)│             ├── prebuilt tarball (scripts/build-prebuilt-tarball.sh:44)
                              │             └── AUR 包 (aur/PKGBUILD:31 "cp -r skill")
                              │
                              ├── 首次运行复制 → ~/.deepseek-arch/skill/plan.skill.md
                              │    src/core/config.ts:71-94 copyPlanSkill()（已存在则跳过，不更新）
                              │
                              ├── 读取注入 → plan_on 工具
                              │    src/tools/plan.ts:14 SKILL_PATH（用户配置目录）
                              │    src/tools/plan.ts:75-81 readPlanSkill()（失败回退 FALLBACK_SKILL）
                              │    src/tools/plan.ts:83-110 planOnTool（无参数，返回全文作 tool result）
                              │
                              └── 触发条件 → system_prompt.txt:32 "If you judge the task complex, call plan_on"
                                    ↓
                              模型调用 plan_on → skill 全文作为 tool_result 进入对话上下文
                                    ↓
                              模型按 Phase 0→2.5 输出计划 → 用户确认（plan.skill.md:172-176）
                                    ↓
                              save_plan 持久化 → <cwd>/.plans/<name>.md
                                    src/tools/save-plan.ts:41-53（requiresConfirm: true，路径校验 checkPath）
                                    ↓
                              Phase 3 执行 → subagent_spawn 委派（session.ts:349 interceptSubagentTool 拦截）
```

**关键事实**: 以上链路**只对 plan skill 成立**。release skill 在代码中零引用——没有加载函数、没有触发工具、不在 copyPlanSkill 的复制清单里（config.ts:71-94 硬编码只复制 plan.skill.md）、system_prompt.txt 全文无 "release" 字样。已发布 AUR 预构建包（1.3.5）`skill/` 目录中只有 plan.skill.md（`tar tzf aur/src/deepseek-arch-1.3.5-prebuilt.tar.gz` 验证）。

---

## 二、plan.skill.md 审查

### 2.1 内容质量（良好，但有文案瑕疵）

- 结构清晰：复杂度评估（:8-21）→ Phase 0-4 + Phase 2.5 自检 → 用户确认断点（:172-176）→ 技巧区，闭环完整。
- 复杂度判定规则（:17-21）与 plan_on 工具 description 的触发条件（plan.ts:88-91）**逐条一致** ✓。
- **文案残缺**：:95 行「在同一次 tool call 中 spawn 多个 subagent（每轮最多 spawn）」——括号内语句不完整（"最多 spawn" 后面缺数字/说明），属明显未完成编辑。

### 2.2 与 plan_on / save_plan 实现的一致性（两处断裂）

| 检查点 | 状态 | 证据 |
|:---|:---|:---|
| plan_on description ↔ skill 内容 | ✅ 一致 | plan.ts:85-98 的"何时调用/Phases/确认后 save_plan"与 skill 正文吻合 |
| system_prompt ↔ skill 的确认后动作 | ❌ **断裂** | system_prompt.txt:40 要求"确认后调用 save_plan"；plan.ts:94 也说"用户确认后调用 save_plan"；但 skill 正文确认断点（plan.skill.md:174-176）只写"确认后我将开始执行"，**全文无 save_plan 环节**。模型以 skill 为准时可能跳过持久化 |
| skill 鼓励的 subagent 委派 ↔ 工具描述 | ❌ **断裂** | skill 大量鼓励委派（:15/31/48/81-96/112/142/184-185），配套的 subagent_spawn/wait 工具描述增强（WHEN TO USE / WORKFLOW）在 fa02940 提交中已实现，但 **merge 348d82e（v1.3.6）冲突解决时被丢弃**，当前 subagent-spawn.ts:21-27 与 subagent-wait.ts:13-18 均为简化版。同类 merge 回归见 subagent-merge-regression.md，但该文档未提及 description 丢失这一项 |

### 2.3 流程问题

1. **save_plan 与"强制产物"脱节**：skill 要求 Phase 0-2.5 每阶段输出"强制产物"（:37/51/98/124），但 save_plan 只在最后一次性保存（save-plan.ts:15-16）。中间产物如何汇总进最终 plan_content 无说明。
2. **回顾文档的建议一条未落实**：docs/paste-retrospective.md:81-89 汇总的 4 条修改建议（Phase 1 挑战用户技术假设、确认断点前 TL;DR、<100 行降级规则、风险列写具体场景）对照当前 skill 正文**全部缺失**。skill 演进缺乏闭环。
3. **委派上限缺失**：:95 行残缺句暴露"每轮最多 spawn 几个"未定义；无每轮 spawn 上限（轮次上限已删除 2026-08-06），skill 指引与实现参数不对齐。
4. **确认断点依赖模型自觉**：:176 行"绝不允许在未收到确认的情况下进入 Phase 3"是纯提示词约束，无代码强制。

---

## 三、release.skill.md 审查

### 3.1 内容质量（步骤完整，但激活机制缺失是致命伤）

- **步骤覆盖面完整**：前置检查（:6-13）→ 版本号（:17-30）→ 构建打包（:34-52）→ AUR 更新（:56-64）→ git tag（:68-73）→ GitHub Release（:77-87）→ Release Notes（:91-140）→ 发布后验证（:144-151）。
- **与代码实现一致**：src/cli/index.ts:35 确有 PACKAGE_VERSION；aur/PKGBUILD:7 的 pkgver、aur/.SRCINFO 均存在；scripts/build-prebuilt-tarball.sh:40-47 的打包清单与步骤 2 一致 ✓。
- **致命问题：skill 对模型完全不可达**。它没有 plan skill 那样的加载链路（见第一节）。copyPlanSkill 硬编码只复制 plan.skill.md（config.ts:75-78），system_prompt 无引用，也无 release_on 工具。模型**没有任何途径获知这个 skill 的存在**——用户说"发版"时，模型只能靠通用知识操作，或用户手动粘贴文件内容。这与文件头部自称"当用户要求发版时激活"（:3）形成鲜明反差：激活条件是写在文档里的"自我声明"，不是实现。

### 3.2 流程矛盾

1. **步骤 5/6 顺序颠倒**：步骤 5（:82-87）`gh release create --notes-file RELEASE-vX.Y.Z.md` 要求 notes 文件**已存在**，但步骤 6（:91-140）才是撰写 Release Notes 并产出 RELEASE-vX.Y.Z.md。按 skill 顺序执行必然失败（文件不存在）。
2. **上传动作重复**：步骤 5 已在 create 时带 --notes-file，步骤 6 又要求"RELEASE-vX.Y.Z.md → gh release edit 上传"（:140），职责重叠、语义含糊。
3. **版本号同步无自动化**：步骤 1 要求 package.json 与 src/cli/index.ts:35 两处手动同步（:19-24），无校验脚本。

### 3.3 其他

- Release Notes 写作原则（:93-138）质量高，与实际产物 RELEASE-v1.3.6.md 风格一致 ✓。
- 发布后验证（步骤 7）覆盖 asset、渲染、页面效果，完整 ✓。

---

## 四、Skill 机制本身的设计问题

### 4.1 格式：纯 Markdown，零元数据
- 两个 skill 均无 frontmatter/YAML 头、无版本号、无激活条件的结构化声明（激活条件写在正文 `>` 引用块里，:3，靠模型语义理解）。
- 后果：skill 无法自描述（名字/版本/适用场景需代码硬编码）、无法版本追踪、无法支撑未来"skill 目录自动发现"。

### 4.2 加载：单文件硬编码，扩展性差
- copyPlanSkill（config.ts:71-94）把文件名 plan.skill.md 硬编码进函数，新增 skill（如 release）需要改代码。
- plan.ts:14 的 SKILL_PATH 同样硬编码，与 config.ts 的复制目标重复定义路径常量，两处需同步维护。

### 4.3 更新策略：老用户永远用旧版 skill（显著缺陷）
- copyPlanSkill 在 config.ts:80-85 **目标已存在即跳过**（注释"用户可能自定义了"）。
- 而 planOnTool 读取的是 ~/.deepseek-arch/skill/plan.skill.md（plan.ts:14）。
- 推论：**已有配置目录的老用户升级到新版本后，plan skill 内容永远不会更新**（例如 fa02940 的 subagent 委派增强、1bacc05 的 Phase 3 分支强制步骤，老用户全部收不到）。只有全新用户能获得最新 skill。git 历史佐证：skill/ 有 4 次实质更新，但用户侧最多见过首次复制的版本。

### 4.4 兜底内容漂移
- plan.ts:17-73 的 FALLBACK_SKILL 是简化版（无自检表细节、无完整确认断点、无技巧区），与 skill/plan.skill.md 是**两份内容**，需手动同步，一旦漂移，skill 文件缺失时模型获得的行为与预期不一致（如缺"绝不允许未确认进入 Phase 3"的强约束）。

### 4.5 注入方式与 token 开销
- plan_on 注入 187 行全文作为 tool_result，且随对话持久化进 turns.json（session.ts:762-765）；resume 时全文重新进入上下文，每次会话吃掉约 2k+ tokens。plan.ts:95 特意写"不需要再单独加 PLAN_SKILL_ACTIVATED 标记"防重复调用，说明已意识到开销问题，但未提供"一次注入、后续精简引用"的机制。

### 4.6 与 system prompt 的关系：职责重叠
- system_prompt.txt:23-42 已内嵌完整工作流（survey → assess → decompose → confirm → save_plan → execute），plan skill 又定义一套 Phase 0-4。两者对"复杂任务怎么办"给出两条指令路径：system_prompt 说"调用 plan_on 获得框架"，skill 说"按 Phase 执行"——模型需自行合并，且合并点（save_plan 时机）恰是两处表述不一致的地方（见 2.2）。
- release skill 完全游离于 system prompt 之外，与 plan skill 待遇不对等。

### 4.7 与 subagent 的关系
- 方向正确：skill 在 Phase 0/1/2/2.5/技巧区系统性地鼓励 subagent 委派（fa02940 的提交意图），子代理侧明确禁止 plan_on/save_plan（session.ts:54、docs/subagent-design.md:223），职责边界清晰（主 agent 规划、子代理执行）。
- 但配套工具描述增强在 merge 中丢失（见 2.2），当前是"skill 单向鼓励、工具描述不引导"的残缺状态，与 fa02940 提交信息（"encourage subagent delegation in **plan skill & tool descriptions**"）直接矛盾——提交意图只实现了一半。

---

## 五、修改建议清单（按优先级）

| 优先级 | 建议 | 依据 |
|:---|:---|:---|
| 🔴 P0 | **给 release skill 建立加载/触发机制**：新增 release_on 工具（仿 plan.ts），或把 copyPlanSkill 改为复制整个 skill/ 目录并在 system_prompt 声明 release skill 存在；否则删除该文件降级为普通文档 | 3.1 节：零引用、模型不可达 |
| 🔴 P0 | **修复 skill 更新策略**：copyPlanSkill（config.ts:80-85）改为按版本/哈希比较后更新，或在 plan_on 读取时优先读项目包内 skill、用户目录仅作覆盖层 | 4.3 节：老用户永久旧版 |
| 🟠 P1 | **恢复 fa02940 的 subagent_spawn/wait 描述增强**（cherry-pick fa02940 中这两个文件改动），并在 subagent-merge-regression.md 补记该项 | 2.2 节：git diff 实证 |
| 🟠 P1 | **统一 save_plan 时机**：在 plan.skill.md 确认断点段（:172-176）补上"用户确认后调用 save_plan 持久化"，与 system_prompt.txt:40、plan.ts:94 对齐 | 2.2 节 |
| 🟠 P1 | **修正 release.skill.md 步骤 5/6 顺序**：先写 RELEASE-vX.Y.Z.md 再 gh release create --notes-file，删除"gh release edit 补传"重复步骤 | 3.2 节 |
| 🟡 P2 | **skill 格式引入轻量元数据**：文件头加 YAML frontmatter（name/version/trigger/updated），copyPlanSkill 与触发工具据此加载 | 4.1/4.2 节 |
| 🟡 P2 | **消除 FALLBACK_SKILL 漂移**：改为从包内 skill/plan.skill.md 读取失败时提示用户而非返回简化版 | 4.4 节 |
| 🟡 P2 | **补齐缺失 skill**：新增测试 skill（8 个测试文件、覆盖率 ≥80% 约定在 agent.md:8，但无测试流程 skill）和浏览器 skill（9 个浏览器工具无配套 skill；docs/browser-tools.md 可作底稿）；评估 review skill（src/core/reviewer.ts 已存在，feat/yolo-review-model 分支） | 工具清单 |
| 🟢 P3 | **落实 paste-retrospective 的 4 条建议**（Phase 1 挑战用户技术假设、确认前 TL;DR、<100 行降级规则、风险列具体化），修复 :95 行残缺文案，建立 skill 更新闭环（更新后同步 retrospective） | 2.1/2.3 节 |
| 🟢 P3 | **版本号同步自动化**：release.skill.md 步骤 1 增加校验脚本检查 package.json 与 src/cli/index.ts:35 一致，或统一单一来源 | 3.2 节 |

---

## 关联文档

- [subagent-merge-regression.md](./subagent-merge-regression.md) — subagent 工具描述增强丢失（merge 回归）的代码层背景
- [prompt-review.md](./prompt-review.md) — system prompt 内嵌工作流与 skill 职责重叠（§4.6）
- [architecture-code-review.md](./architecture-code-review.md) — config.ts copyPlanSkill 所在模块的结构问题
