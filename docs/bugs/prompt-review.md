# 提示词体系审查 — system prompt 缺漏/矛盾、tool description 不一致、subagent 提示词冲突

**类型**: 提示词审查（Prompt Review）
**发现日期**: 2026-08-06
**当前基线**: `main` @ `68acdb7`（HEAD）
**涉及文件**: `system_prompt.txt`、`agent.md`、`src/core/session.ts`、`src/core/subagent.ts`、`src/core/reviewer.ts`、`src/core/config.ts`、`src/core/system-info.ts`、`src/tools/*.ts`（全部工具）、`src/tools/index.ts`、`src/cli/index.ts`、`skill/plan.skill.md`、`docs/subagent-design.md`

**总体结论**: 提示词体系整体设计扎实（KV-cache 前缀稳定性是亮点，工具描述大多与实现一致），但存在三类实质问题——① 主 prompt 内部与子代理模式的行为指令冲突（最影响子代理质量）；② agent loop 轮次上限是死代码，README/注释的"25 轮"承诺与实际不符；③ 子代理提示词缺少输出格式、安全语义、async 衔接三类关键信息。

---

## 一、System Prompt 审查

### 1.1 缺漏

| # | 缺漏 | 位置 | 说明 |
|:---|:---|:---|:---|
| S1 | 工具确认机制未说明 | system_prompt.txt:61-65 | 只对"破坏性操作"要求确认，实际**每次 execute_command 都弹 y/N**（shell.ts:66 + session.ts:699）。模型预期"只有危险命令才确认"，连 git status 都被拦截时会困惑 |
| S2 | 浏览器工具完全没提 | system_prompt.txt 全文 | 6 个 browser_* 工具的调用指引只存在于各自 description，无"何时用浏览器/无确认/快照是文本模态"总纲 |
| S3 | Subagent 工具完全没提 | system_prompt.txt 全文 | 主 prompt 无 subagent_spawn/wait/list_subagents 使用指引，async/sync 差异、spawn 后要 wait 的最佳实践靠模型自发探索 |
| S4 | Agent loop 机制未告知模型 | system_prompt.txt:12-21 | 模型不知道独立工具调用应**同一轮并行发起**、tool 结果会继续送回、shell 输出截断到 8192 字节（shell.ts:23） |
| S5 | 系统注入消息未告知模型 | session.ts:573-576, 599-600 | `[system] You have pending subagents...`、`[auto-continue]` 伪装成 user 角色注入，未预告存在与含义 |
| S6 | 错误恢复指引不完整 | system_prompt.txt:18 | 只有"受阻换策略"一句。未覆盖 edit_file staleness 后重读、非零退出码查 stderr、浏览器元素找不到先 snapshot |
| S7 | 主代理与子代理产物衔接未说明 | system_prompt.txt + subagent-spawn.ts:27 | 无"spawn 时给足上下文、取回结果后验证/引用"约定，委派质量靠模型自觉 |

### 1.2 矛盾

| # | 矛盾 | 位置 | 说明 |
|:---|:---|:---|:---|
| S8 | **`git reset --hard` 自相矛盾** | system_prompt.txt:89 vs :105 | 89 行鼓励自执行 `git reset --hard <commit>`；105 行又说 "Never run destructive commands (`git reset --hard`) without the user's explicit confirmation"。同一命令一个允许一个禁止 |
| S9 | ~~轮次上限声明与实际代码不符~~ **✅ 已解决 2026-08-06** | ~~README"最多 25 轮" vs session.ts:42,495~~ | `MAX_AGENT_ROUNDS` 死代码与截断逻辑已删除（主 Agent 与子代理均无轮次上限）。历史：常量定义但未用于循环条件，`:810-818` 截断消息是死代码（见 subagent-merge-regression.md M-4/M-6） |
| S10 | 主 prompt"用户确认"流程与子代理环境冲突 | system_prompt.txt:37-40 + session.ts:45-56 | 主 prompt 要求"向用户呈现选项、等用户确认计划再实施"，子代理没有用户，追加的 Subagent Mode 片段无法覆盖强指令 |

### 1.3 冗余

| # | 冗余 | 位置 |
|:---|:---|:---|
| S11 | "Never commit files containing secrets" 出现两次 | system_prompt.txt:85 与 :112 |
| S12 | "--no-verify/--no-gpg-sign 禁止" 出现两次 | system_prompt.txt:63 与 :104 |
| S13 | "git clean -fd / git branch -D / git reset --hard 需确认" 出现两次 | system_prompt.txt:61-62 与 :105 |
| S14 | "最小改动/不重构已有代码" 语义重复三处 | system_prompt.txt:17, 44, 57 |
| S15 | agent.md:21 技术栈表仍写 "better-sqlite3" | agent.md:21,45（已改用文件存储，文档过时） |

### 1.4 KV-cache 友好性评估

**做得好的**:
- system prompt 每次会话构建一次、resume 用持久化的 `session.systemPrompt` 覆盖（session.ts:112-115）
- 工具 definitions 是模块级静态对象，每轮发送完全一致（session.ts:322）
- `agentMessages` 只追加不修改（session.ts:331,627）
- 异步提醒用固定字符串注入（session.ts:572 注释明确保证 kv-cache 前缀稳定）——比 docs/subagent-design.md:268-276 设计的动态状态块更缓存友好，**文档已过时**

**风险点**:
- `<environment_info>`（system-info.ts:252-294）含目录树、git 分支、**最多 8KB README 全文**。README 被全文注入占 prompt 很大比例，但大部分是安装/用法说明，对模型执行任务价值低
- `FALLBACK_SYSTEM_PROMPT`（config.ts:97-100）只有 Reasoning Effort 一段，与完整 prompt 差异巨大——npm 包剥离 system_prompt.txt 后行为退化且无提示

---

## 二、Tool Description 审查

### 2.1 与实现不一致 / 缺漏（按严重度排序）

| 工具 | 位置 | 问题 |
|:---|:---|:---|
| `execute_command` | shell.ts:47-49 | 描述完全没提 `requiresConfirm: true`（主代理每次调用弹 y/N，子代理完全不确认）；没提 10 分钟超时、输出截断 8192 字节、stdin 关闭（非交互）、退出码+killed 标记 |
| `write_file` / `edit_file` | write-file.ts:31-33 / edit-file.ts:37-40 | 描述"用户确认"对主代理正确，但子代理 loop 无确认环节，子代理会误以为用户审核其写入；未提 staleness 检查（write-file.ts:94-99） |
| `subagent_spawn` | subagent-spawn.ts:20-27 | 未说明 async/sync 两种模式行为差异（async 立即返回 `[SPAWNED]` 需后续 wait；sync 阻塞到完成）；未提子代理 shell 无需用户确认 |
| `wait` | subagent-wait.ts:13-18 | 未说明"已 retrieved 的子代理再次 wait 会报错"（session.ts:441-447）；sync 模式 spawn 后 wait 行为有歧义 |
| `search_content` | search-content.ts:81-84 | 描述"跳过 node_modules/.git/dist 等"，实现还跳过隐藏目录（:63）和 >1MB 大文件（:192）；未提 max_results 硬上限 100（:21） |
| `read_file` | read-file.ts:23-26 | 未提二进制文件被拒绝（:81-83）、读取会记录文件状态供 staleness 检查（:120-122）——模型不知道"读过的文件才能改"的隐含依赖 |

### 2.2 与实现一致的（抽样确认 ✅）

- browser_* 系列（navigate/snapshot/click/type/scroll/press_key/navigate_back）：描述与实现吻合
- plan_on（plan.ts:84-98）：与 skill 注入行为一致
- list_subagents（subagent-list.ts:13-17）：与拦截实现一致

### 2.3 注册/语言问题

| 问题 | 位置 |
|:---|:---|
| **`tts_speak` 工具名存实亡**：README 工具表列了 tts_speak（需 `--voice`），但 src/tools/ 下**没有** tts-speak.ts，index.ts 也未注册；src/core/voice-service.ts 同样不存在（仅 dist/ 有陈旧产物），src/cli/index.ts 也没有 `--voice` 选项。README 与源码严重脱节 | README 工具表 vs src/tools/index.ts |
| 语言混用：主 prompt 英文、工具 description 中英文混杂（subagent/tui 系列英文，其余中文）、reviewer prompt 英文但 auto-continue 消息中文 | 各文件 |
| subagent 三件套 description 全英文，而模型主要工作语言是中文——委派指引有效性打折 | subagent-spawn.ts:20-27 等 |

### 2.4 缺失的跨工具最佳实践指引

- **并行批处理**：无任何描述告知"同一轮可并行发起多个独立 tool_calls"（plan.skill.md:104 只对 subagent 提了）
- **读→改→验闭环**：edit_file 要求先 read 有提，但"改完用 search/测试验证"无指引
- **浏览器完整流程**：navigate→snapshot→click→type→press_key 无总纲，无"元素找不到先 snapshot 再看"的错误恢复指引

---

## 三、Subagent 提示词优化建议

### 3.1 当前设计的问题

**当前子代理 prompt 构成**: `basePrompt(完整主 system prompt + environment_info) + SUBAGENT_APPEND_PROMPT`（session.ts:176-178），追加内容为 session.ts:44-56 的 7 条约束。

| # | 问题 | 证据 |
|:---|:---|:---|
| A1 | **主 prompt 与子代理模式直接冲突**：主 prompt 要求"识别模糊点主动追问用户"（:36）、"向用户呈现选项"（:37）、"**Do NOT start implementation until the user has confirmed the plan**"（:39）、"When in doubt... ask rather than guessing"（:21）、"执行前 MUST confirm"（:61-62）。追加片段无法覆盖这些强指令——子代理可能输出计划后卡住等"用户确认" | system_prompt.txt |
| A2 | **输出格式完全未约束**：追加片段只有"return a concise result"（session.ts:50）。没有"做了什么/改了哪些文件/验证结果/遗留问题"结构化要求，没有长度上限，可能回传整文件内容刷爆主上下文 | session.ts:44-56 |
| A3 | **安全语义缺失**：子代理 loop 直接 `tool.execute()`（subagent.ts:85），requiresConfirm 被忽略——**子代理的 shell 命令无任何确认**。追加片段没告诉子代理这一点，而主 prompt 又教它"破坏性操作要问用户"，双重误导 | subagent.ts:85 |
| A4 | ~~不知道自己的运行上限~~ **✅ 已解决 2026-08-06** | ~~MAX_SUBAGENT_ROUNDS = 25（subagent.ts:13）~~ | 轮次上限已删除，子代理由模型自主决定完成时机，不再有超限截断 |
| A5 | **结束语缺失**：若最后一轮是工具调用、无最终文本，返回 `'(subagent completed with no output)'`（subagent.ts:66）。没有"必须以总结文本收尾"要求 | subagent.ts:66 |
| A6 | **与主代理的衔接缺失**：子代理不知道结果会被完整回传、不知道主代理可能并行运行多个子代理（不应假设独占资源/全局状态） | session.ts:176-178 |
| A7 | **主代理侧缺 async 模式指引**：主 prompt 无 async 说明；subagent_spawn description 未提异步行为。模型 async 模式 spawn 后可能不主动 wait，靠运行时注入提醒兜底 | subagent-spawn.ts |
| A8 | **subagent.ts 未接 SubagentStore 回调**：设计的 onEntry 回调不存在（subagent.ts:18-24 无 callbacks 参数），子代理内部过程对主代理完全黑盒 | docs/subagent-design.md:206-214 |

### 3.2 具体优化方案

1. **改追加片段为独立子代理 system prompt（推荐）**：不再拼接完整主 prompt，构建精简自洽的子代理 prompt：角色声明（被主代理委派的子代理，无交互用户）+ 工具集说明（shell/read/search/write/edit/browser，无 plan/save_plan/spawn/wait/list）+ 安全规则（**你的 shell 命令无用户确认，破坏性操作（rm -rf、git reset --hard 等）除非任务明确要求否则不要执行**，执行了要在结果中声明）+ 输出格式（**必须以总结文本收尾**：做了什么、改了哪些文件、验证结果、遗留问题，简明扼要，不回传大段文件内容）+ 效率（独立调用并行发起，无轮次上限但应尽快完成）。若担心丢失主 prompt 编码规范，抽取"最小改动/先读后动/commit 规范"几条关键规则带过去，删掉所有"询问用户/等待确认/plan_on"段落。
2. **若保留拼接方案**，追加片段至少增加：①"忽略主 prompt 中所有'询问用户/等待用户确认'的要求——本环境中没有用户"；②"你的 shell 命令执行**不会经过用户确认**，自行用保守判断"；③"最终必须以一段总结文本结束，不要以工具调用结束"。
3. **主代理侧**：subagent_spawn description 补充 async/sync 行为差异（async 立即返回 `[SPAWNED]`，需用 list_subagents+wait 取结果；sync 阻塞到完成）；system prompt 增加"spawn 后继续做自己的事，之后用 wait 取结果，结果只能取一次"。
4. **回填 SubagentStore 回调**（代码问题，影响模型可观测性）：按 docs/subagent-design.md:206-214 恢复 onEntry。
5. ~~修复 MAX_AGENT_ROUNDS 死代码~~ **✅ 已解决 2026-08-06**：常量与截断逻辑已删除，主 Agent 无轮次上限。

---

## 四、修改优先级清单

### 高（直接影响正确性/安全）

| # | 修改 | 说明 |
|:---|:---|:---|
| P1 | 重构子代理 system prompt（3.2 方案 1 或 2），消除"问用户/等确认"冲突 | src/core/session.ts:44-56 |
| P2 | 修复 system_prompt.txt:89 与 :105 的 `git reset --hard` 自相矛盾——二选一：允许自查点回退（105 行限定为"对未提交工作的破坏性重置"），或禁止自执行 | system_prompt.txt |
| ~~P3~~ ✅ 已解决 2026-08-06 | ~~修复 agent loop 无轮次上限（MAX_AGENT_ROUNDS 死代码）~~ | ~~src/core/session.ts:42,495~~ —— 常量与截断逻辑已删除 |
| P4 | execute_command description 补充：主代理调用前弹确认、输出截断 8192 字节、10 分钟超时、非交互 | src/tools/shell.ts:47-49 |
| P5 | 子代理安全语义：明确告知 shell 无确认 + 破坏性操作保守处理（或实现层给子代理 shell 加确认/只读约束） | session.ts:44-56 + subagent.ts:85 |

### 中（影响效率/可用性）

| # | 修改 | 说明 |
|:---|:---|:---|
| P6 | subagent_spawn description 补充 async/sync 差异与"结果只取一次" | src/tools/subagent-spawn.ts:20-27 |
| P7 | system prompt 增加 agent loop 机制段：并行发起独立工具调用、工具结果会送回、shell 输出可能截断、`[system]` 注入消息含义 | system_prompt.txt Task Execution |
| P8 | system prompt 增加 subagent 总纲：何时委派、async 模式下 spawn→继续→wait 闭环 | system_prompt.txt 新增小节 |
| P9 | 主 prompt 增加浏览器工具一句话总纲（文本模态快照、无确认、与 shell curl 的取舍） | system_prompt.txt |
| P10 | 更新 docs/subagent-design.md 过时内容：动态状态块→静态提醒（§5.3/8.3）、§5.4 Agent Loop 上限（已标注移除 2026-08-06）、onEntry 回调（§4.3） | docs/subagent-design.md |

### 低（一致性/清洁度）

| # | 修改 | 说明 |
|:---|:---|:---|
| P11 | 删除 system_prompt.txt 重复项（S11-S14），顺带压缩 | system_prompt.txt:61-63,85,104-105,112 |
| P12 | 处理 tts_speak/--voice 名存实亡：恢复实现或从 README 删除相关段落与 dist/tools/tts-speak.* 陈旧产物 | README / dist/tools/ |
| P13 | 统一工具 description 语言（至少 subagent 三件套与主 prompt 语言对齐） | subagent-spawn.ts 等 |
| P14 | search_content/read_file 描述补充隐藏目录、>1MB 跳过、二进制拒绝 | search-content.ts:81-84、read-file.ts:23-26 |
| P15 | agent.md:21 删掉 better-sqlite3，agent.md:51 版本号与 package.json 对齐 | agent.md |

---

## 关联文档

- [subagent-merge-regression.md](./subagent-merge-regression.md) — MAX_AGENT_ROUNDS 死代码（M-4，已删除）、subagent 接线缺失（M-1/M-7）的代码层详情
- [skill-design-review.md](./skill-design-review.md) — plan skill 与 system prompt 的 save_plan 时机冲突
- [architecture-code-review.md](./architecture-code-review.md) — session.ts 结构问题的架构层详情
