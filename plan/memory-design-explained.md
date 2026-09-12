# Memory 机制 —— 讲解版（给用户看）

> 配套文件：
> - `plan/memory-heartbeat-design.md`（实施级设计稿，含代码行号依据；**§12 评审决议为准**）
> - `plan/claude-code-memory-reference.md`（Claude Code 记忆机制的调研报告，本方案的主要参照）
> 本文只讲「它会变成什么样、你如何使用、为什么这么设计」，不贴实现细节。

---

## 1. 一句话

在**不占用大量上下文**的前提下，让 agent 跨会话记住你的**偏好、约定与边界**，
并在相关任务时自动带上；记忆的写入由后台代理完成，任何失败都不影响你的正常使用。

---

## 2. 记忆长什么样（目录结构）

```
{workspace}/.deepseek-arch/memory/        # 项目层：只跟这个工作区有关
  index.md                               # 概览/索引：一行一条，注入给模型看的就是它
  2026-09-13-reply-style.md              # 主题文件：一个主题一个文件
  2026-09-10-test-policy.md
  log/2026/09/2026-09-13.md              # 追加式原始观察（可审计，不注入）
  audit.jsonl                            # 机器可读审计（谁在什么时候写了什么/为什么没注入）
  legacy/                                # 你手写的旧笔记（原样保留，不被程序改写）

~/.deepseek-arch/memory/                  # 全局层：跨项目通用偏好（结构同上）
```

**主题文件示例**（人可以直接读、直接改）：

```markdown
---
id: memo_3c2b1a09
subject: reply.format
description: 回复先给结论再给理由，不要长篇铺垫
tags: [reply, format, style]
scope: project
confidence: 3
signal: A
paths: ["src/**"]
created: 2026-09-12T09:10:00Z
updated: 2026-09-13T02:00:00Z
---

回复先给结论，再给理由；避免长篇铺垫。
**Why:** 用户明确说过「别铺垫」。
**How to apply:** 所有面向用户的总结，第一句就是结论。
```

**概览 `index.md` 示例**（注入给模型的就是这段，一屏以内）：

```markdown
# Memory index (project)

- [reply.format](2026-09-13-reply-style.md) — 回复先结论后理由，别铺垫 (confidence 3, updated today)
- [test.policy](2026-09-10-test-policy.md) — 改动必须跑全量测试再汇报 (confidence 3, updated 3 days ago)
- [plan.dir](2026-09-11-plan-dir.md) — 计划文档写 {workspace}/.deepseek-arch/plan/ (confidence 2, updated 2 days ago)
```

设计取舍：**主题文件用 Markdown 而不是数据库/JSONL**，理由有三：
人是主要读者（你能直接改、能进 git、能 diff）；一个主题一个文件 → 「这条记忆何时更新」由文件 mtime 天然表达；
agent 对项目层可以直接用普通 `read_file` 读全文（全局层要用专用工具，见 §5）。

---

## 3. 三个时刻：注入 / 写入 / 读取

### 3.1 注入（把记忆放进模型上下文）

> 决定（2026-09-13）：**概览进 system prompt**，参照 Claude Code 的做法；
> **不再使用「临时 user 消息」**形态（设计稿 §12 R11/R12）。

| 时刻 | 注入什么 | 为什么 |
|:--|:--|:--|
| **会话创建 / resume 首轮** | **概览**（`index.md` 的 top-K，≤800 tokens）追加进 system prompt（`<memory_listing>` 段，风格同现有 `<skill_listing>`），随会话快照落盘 | 让模型一开始就知道「有哪些方面的记忆」 |
| **compact 之后** | 用当前记忆**重建** system prompt（并同步重写会话快照文件） | compact 本来就要换前缀，这次重建不额外损失缓存；顺便让过期概览变新 |
| **会话中概览发生变化** | 默认**不刷新 system prompt**（避免整段历史重算）；变化以**合并进你当前发言**的 `<system-reminder>` 小块注入 | 复用 Claude Code 的动态通道：只增加尾部增量，不动稳定前缀 |
| **你读过的记忆文件被更新** | 同样合并进你当前发言的提醒 | 避免模型基于旧内容下判断 |
| **想手动刷新** | `/memory refresh` | 显式动作：重建 system prompt + 重写快照（会作废该次请求的前缀，所以不做成自动） |

关键设计（为什么这样最省）：

- system prompt 在**一个会话内是冻结的**（现状：创建时构建 + 落盘快照，`resume` 复用快照，`src/core/session.ts:176-179, 191-194`）
  → 概览放进去**不会**产生任何缓存失效；唯一代价是「可能过期」。
- 「重装」只允许发生在**前缀本来就要变**的时刻：新会话（没有更长前缀）、compact（前缀被摘要替换）、或你手动 `/memory refresh`。
  **绝不在会话中途自动重装**——那一刻 system 变了，后面整段历史都要重算。
- 会变的东西（新增/改写/遗忘、你读过的文件被更新）走**合并式 `<system-reminder>`**（不新开消息 → 兼容严格交替的 provider）。

### 3.2 写入（谁来记、什么时候记）

**你发消息 → 主 agent 正常干活（同时后台跑一个 memory agent）→ 你下一次发言时，上级新记忆以「变化提醒」生效。**

- memory agent 的输入：**上一轮的（你的消息 + agent 的最终回复）+ 本轮你的消息**，再加它自己按需检索出来的历史记忆。
  也就是它总是「拿着模型上一轮的输出 + 你这一轮的反馈」判断，因此：
  - 「不对，应该……」→ 能判定为**否决/纠正**；
  - 「就按这个做」→ 能判定为**方案确认**；
  - 它**看不到**工具调用轨迹与思维链（按你的要求），因此判定只依据对话文本。
- 它是**并发跑的**：独立中断信号，你 Ctrl+C 只中断主 agent；它跑失败/超时/卡住都只写日志，绝不打扰你。
- 同一时刻只有一个 memory agent 在跑（重复触发直接跳过，不排队）；两次归纳间隔 ≥30s。
- 写入配额：一次最多 3 条；宁少勿滥（技术事实、任务细节、一次性指令都不记）。

### 3.3 读取（模型想查更细的内容时）

- **概览**已经在上下文里，模型知道有哪些记忆；
- 需要全文时用 `memory_search`（项目层 + 全局层都能查，返回「一行一条 + id + 路径」）→ 再 `memory_read` 或直接 `read_file`（项目层）；
- `memory_search` 是必需品而不是优化项：全局层路径在 `~/.deepseek-arch/` 下，**普通文件工具按沙箱规则根本读不到**（见 §6 约束 A）。

---

## 4. 记忆的「保质期」：置信度、衰减、淘汰

| 概念 | 规则（用户视角） |
|:--|:--|
| 置信度 1–3 | 3 = 你明确说过的（「以后都要…」）；2 = 否决/确认类；1 = 重复出现推断出来的 |
| 升级 | 同一偏好再次出现 → 置信度 +1（封顶 3） |
| 降级/衰减 | 长期不用会慢慢降权（半衰期 180 天），但**不会静默删除** |
| 过期提醒 | 你说过「下周再看」这类话 → 到期时提醒你 |
| 淘汰 | 分数低于阈值且长期未命中的进入归档；被新偏好取代的保留「演化记录」（可从 memory 目录里查到历史） |
| 冲突 | 同一 `subject` 新旧矛盾 → 新的生效，旧的标记为被取代（不物理删除） |

---

## 5. 你能做什么

| 操作 | 命令 |
|:--|:--|
| 看状态（两层条数、开关、上次注入/归纳、可检索路径） | `/memory` |
| 列出条目（可按关键词、层级过滤） | `/memory show [kw] [--scope all|project|global]` |
| 看审计（哪次写了什么、为什么没注入） | `/memory show --audit` |
| 忘掉某条 | `/memory forget <id>` |
| 开关记忆 / 只关自动归纳 | `/memory on|off`、`/memory agent on|off` |
| 置顶某条（优先注入） | `/memory pin <id>` / `unpin <id>` |
| 启动时关闭 | `--no-memory`（还有 `--memory-scope`、`--memory-model`） |

**模型自己也能用记忆**：主 agent 有 `memory_search` 与 `memory_write` 两个工具（子代理没有）。
所以你可以直接说「记住：以后 X」或「查一下我之前说过的测试约定」。

---

## 6. 两个必须绕开的实现约束（你问到的 B、C）

### 约束 B：`search_content` 不遍历隐藏目录

搜索工具递归时会跳过名字以 `.` 开头的子目录（`src/tools/search-content.ts:63`），
所以从工作区根 `search_content("结论")` **搜不到** `.deepseek-arch/memory/` 里的东西。

- 这不是「有问题」，而是「不能依赖通用搜索」的依据：必须给专用工具 `memory_search`，并在注入块里写明可检索路径。
- 补充事实：显式指定 `path: ".deepseek-arch/memory"` 时**可以**搜到——被跳过的规则作用于「递归时的子目录名」，
  而搜索起点本身不受影响，且 memory 目录里的文件名不以 `.` 开头。
- 参考 claude-code：它不解决这个问题，因为它没有文件沙箱；它用「索引注入 + 让模型自己读文件」的方式绕过。

### 约束 C：配置合并是白名单

加载配置时只挑 `paths / defaults / providers / pricing / systemPrompts / display` 这几段（`src/core/config.ts:362-369`），
`set()` 也只认这几段（`src/core/config.ts:490-501`）。所以新增 `[memory]`/`[heartbeat]` 必须**同时改 5 处**，
否则用户会看到两种典型症状：

1. **配置里写了但不生效**：你在 `config.toml` 写 `[memory] enabled = false`，程序读出来仍是 `undefined` → 按默认值（开启）跑，
   你会觉得「我明明关了」；
2. **命令报错**：`/memory off` 内部要写回配置，`set('memory.enabled', ...)` 会直接抛「不支持的配置段」。

修法就是把这 5 处都补上（类型定义、`AppConfig`、`ResolvedConfig` 组装、`set()` 的 `fileMap`、默认配置模板），
设计稿 §9.3 给了精确清单。

---

## 7. session 里的 system-prompt.txt：重建还是复用？

**结论（已核对代码）：**

| 场景 | 行为 |
|:--|:--|
| 新建会话 | 构建一次 → 写一份到 `<session>/system-prompt.txt`（`src/core/session.ts:176-179`） |
| 每次请求 | 直接用内存里的那条 system 消息，**不重建、不重读文件** |
| `resume` | 读回 `system-prompt.txt` 并**覆盖**当前构建的（`src/core/session.ts:191-194`，为的是让消息前缀与缓存一致）→ 是复用，不是重建 |

副作用：如果你升级了软件（改了 `system_prompt.txt` / skills），**旧会话 resume 时仍然用旧的 system prompt**。

**你的提议（compact 后重建一次 system prompt）已升为默认项**（设计稿 §12 R7 + R11）：Claude Code 在 `/clear` 与 `/compact` 就是这么做的（清掉段落缓存重算）。要注意两点：
1. 重建后必须**同步重写 `<session>/system-prompt.txt`**，否则下次 resume 又变回旧的；
2. 重建意味着「同一会话前后两段用不同 system prompt」，这在 API 上完全合法（system 是消息数组首条），
   只是那一次请求的前缀缓存作废——compact 场景下本来就要作废，无额外代价。

另外多了一个**显式刷新**入口：`/memory refresh`（重建 system prompt + 重写快照），用于「新增了 skill / 记忆变了想立刻生效」的场景。
它是有代价的动作（作废一次前缀），所以做成手动而不是自动。

---

## 8. 与 claude-code 的对照（我们采用/不采用什么）

参考实现：`~/.claude/projects/<项目>/memory/`，核心是 `MEMORY.md` 索引 + 每主题一个 `.md`（带 frontmatter）+ `logs/yyyy/mm/dd.md` 日志，
索引被注入 system prompt，召回时让一个便宜模型从「文件名 + description 清单」里挑 ≤5 个文件再读全文。

| 维度 | claude-code | 本设计 | 取舍理由 |
|:--|:--|:--|:--|
| 存储形态 | 每主题一个 `.md` + `MEMORY.md` 索引 | **采用**（`index.md` + 主题 `.md` + `log/`） | 人可读可改、mtime 表达更新、agent 可直接读项目层 |
| 索引注入 | `MEMORY.md` 进 system prompt（限 200 行/25KB），**段落 memoize**，`/clear`·`/compact` 重算 | **采用**：概览进 system prompt，重装点 = 新会话 / compact / `/memory refresh` | system prompt 在会话内冻结 → 缓存零代价；只在"前缀本来就要变"的时刻重装 |
| 会话内变化 | 无（靠下一轮召回兜底） | 合并进当前发言的 `<system-reminder>` 小块（采纳其动态通道形态） | 你要的「变化提醒」；不新开 user 消息 |
| 召回 | 便宜模型从清单里挑 ≤5 个文件 | **确定性打分**（关键词/路径/标签 × 置信度 × 时效 × LRU），不额外调 LLM | 省一次 API 调用；分数与阈值可审计、可调参；不够好再退回「LLM 选择」 |
| 更新表达 | 改写文件 + 改索引行 | 同（但写入统一走 `memory_write` 工具，保证格式与审计） | 防止模型手写坏 frontmatter |
| 时效提示 | `N days ago` + 陈旧告警注入 | **采用**（概览行带 `updated` 人话时间） | 模型对「3 天前」比 ISO 时间戳更有感觉 |
| 去重 | 已读过滤 + 已出示过滤（compact 后自然重置） | **采用** | 避免重复注入同一份内容 |
| 分类词表 | `user / feedback / project / reference` | 采用其**受控词表 + 不记什么清单** | 直接复用经过验证的提示词约束，省得自己踩坑 |
| 全局/项目 | 按项目分目录（+团队目录） | 两层：项目 `{workspace}/.deepseek-arch/memory/`、全局 `~/.deepseek-arch/memory/` | 你要的「跨项目偏好」需要全局层 |
| 沙箱 | 无文件沙箱 | 有沙箱 → 全局层必须走专用工具；项目层可用 `read_file` | 约束 A/B 的直接后果 |

---

## 9. 成本（为什么这么注入）

用仓库现有价格表（v4-pro：命中 0.2 / 未命中 6.0 CNY 每 1M tokens）：

| 做法 | 每次发言的额外输入成本 |
|:--|:--|
| **本设计**：概览进 system prompt（会话创建时一次，之后冻结）+ 会话内变化合并进你当前发言的 `<system-reminder>` | 概览：**≈0**（随会话前缀，冻结）；变化那次约 **¥0.005** |
| 会话中途自动重装 system prompt（本设计禁止） | 每次重装让**整段历史**作废（长会话 10 万 tokens）→ **¥0.6+/次** |
| 每轮把记忆追加在请求末尾 | 每个 agent 轮次都算未命中 → 10 轮约 **¥0.05**（差 10 倍） |

一句话：**概览进 system prompt 并冻结（零代价、只会过期）；变化走合并进当前发言的小块（只在真变化时花一次小钱）；重装只发生在"前缀本来就要变"的时刻。**

---

## 10. 落地清单（要动的模块）

| 模块 | 用途 |
|:--|:--|
| `src/core/memory-store.ts`（新） | 读/写主题 `.md`、生成/维护 `index.md`、置信度/衰减/LRU/去重/冲突、审计 |
| `src/core/memory-inject.ts`（新） | 选择算法 + 注入块渲染 + 变化检测（含「读过的文件被更新」） |
| `src/core/memory-agent.ts`（新） | 后台归纳代理（复用 `runSubagentLoop`，独立中断信号、watchdog、配额） |
| `src/tools/memory-search.ts` / `memory-write.ts`（新） | 主 agent 的检索/写入工具（项目层 + 全局层） |
| `src/core/session.ts` | ① 概览注入 system prompt 的构建点（会话创建 / resume 首轮）② `compactContext` 重建 system prompt + **重写 `<session>/system-prompt.txt`** ③ `/memory refresh` 的重建入口 ④ `afterTurnAsync` 触发（用户发消息后并发）⑤ `memory_updated` 事件 |
| `src/tools/memory-search.ts` / `memory-write.ts`（新） | 主 agent 的检索/写入工具（项目层 + 全局层；`scope` 决定目录） |
| `src/presentation/tui-app.ts` | `/memory show/forget/pin/on/off` + `/memory refresh`（重建 system prompt 与快照）、一行 dim 的「已更新记忆」提示 |
| `src/core/config.ts` + `src/types/config.ts` | `[memory]`/`[heartbeat]` 五处同步（约束 C） |
| `src/presentation/tui-app.ts` | `/memory*` 命令、一行 dim 的「已更新记忆」提示 |
| `src/cli/index.ts` | `--no-memory` 等参数、`chat --prompt`（心跳载体） |

---

## 11. 还需要你拍板的点

1. **概览行粒度**：只注入「主题 + 一行摘要 + updated」（省 token，模型需要细节时自己 `memory_search`）—— 还是连 `confidence`/`tags` 一起给？（我倾向后者只给 confidence 数字，tags 不给）
2. **「读过的记忆被更新」的判定范围**：只算模型通过 `memory_read`/显式 `read_file` 读过的文件，还是凡注入进概览的条目被改动都提醒？
3. **memory agent 的模型**：默认跟随 `defaults.model`（贵但准），还是固定用便宜模型（`deepseek-v4-flash`）？
4. **旧手写笔记**：`.deepseek-arch/memory/*.md`（现存 2 篇，无 frontmatter）——要不要在首次启用时做一次「迁移成记忆条目」的归纳，还是永远只作为 `legacy/` 参考资料？
5. **`/memory refresh` 的范围**：只重建 system prompt + 重写快照，还是顺带强制跑一次归纳（立即把本次会话的偏好落库）？

> 已定：compact 后重建 system prompt（含重写快照）→ **本期必做**（原为可选增强，依据 Claude Code 的做法）。
