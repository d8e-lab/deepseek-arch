# Memory 机制 + 心跳机制 设计（v2 定稿）

> **版本说明**
> - **v2（2026-09-13）**：与实现一致，是唯一的实施依据。§13 列出 v1 已废弃的方案及理由。
> - v1 曾以「JSONL 单文件 + 临时 user 消息注入 + memory_search」为核心；五轮评审（R1–R25）后改为
>   「每主题 Markdown + 清单注入 system prompt + 落盘式变化提醒 + flash 召回」，
>   并删除了 reviewer（censor agent）；R25 补齐了「过时记忆如何淘汰」（§4）。
>
> **配套文件**
> - 讲解版（用户视角）：`plan/memory-design-explained.md`
> - Claude Code 记忆机制调研（参照对象，含 `文件:行号` 证据）：`plan/claude-code-memory-reference.md`
> - 未做项 / 挂起项：`docs/todo/memory-open-items.md`
> - 实现状态与测试映射：本文 §12
>
> **代码锚点约定**：v2 一律引用**符号名**（模块/函数/方法），不引用行号 —— v1 的行号锚点已大面积漂移。

---

## 0. 阅读指南

| 章节 | 读者 | 一句话 |
|:--|:--|:--|
| 1 | 所有人 | 边界：做什么、明确不做什么 |
| 2 | 实现者 | 决策依据：3 条硬约束 + 复用的既有机制 |
| 3–5 | 实现者 | 存储 / 可见性 / 去重三条主干 |
| 6–8 | 实现者 | 注入（最关键）/ 召回 / 后台归纳代理 |
| 9–11 | 使用者 | 命令、配置、心跳与 `chat --prompt` |
| 12–14 | 所有人 | 实现状态 / 废弃清单 / 未做项 |

---

## 1. 目标与边界

### 1.1 目标

1. 跨会话记住**用户偏好、约定与边界**，随对话累积自动更新，在相关任务时自动注入。
2. **不占用大量上下文**：默认注入 ≤800 tokens，条目按预算裁剪。
3. **方便检索**：清单（`MEMORY.md`）整份注入提供"有哪些记忆"的索引，模型按需 `memory_read` 取全文。
4. 两层：**项目层**（`{workspace}/.deepseek-arch/memory/`）+ **全局层**（`~/.deepseek-arch/memory/`）。
   用户个人偏好第三层暂不做。
5. 写入**不需要用户确认**，但写入后要**给提示**；任何失败都不打扰主流程（只写审计）。

### 1.2 明确不做（本期）

| # | 不做 | 理由 |
|:--|:--|:--|
| 1 | 向量/embedding 检索 | 本地无此能力；清单 + 关键词 + LLM 选择已够 |
| 2 | 第三层「用户个人偏好」 | 与全局层边界不清，用户未想好 |
| 3 | `memory_search` 工具 | 清单已提供发现通道；全局层由 `memory_read` 覆盖（§13-B2） |
| 4 | 相似度阈值去重、确定性打分公式 | 清单前置 + 模型判断 + 三条等值规则（§5） |
| 5 | 连续数值衰减公式（半衰期）、fold 折叠、容量清理 | 半衰期带来不可解释的可见性漂移；fold 在"每主题一文件"后无对象。淘汰改走**离散档位 + agent 顺带清理**（§4）；确定性 GC 见 A3b |
| 6 | reviewer（censor agent）/ YOLO 审查自动续答 | 用户决定删除（§13-B5） |
| 7 | 常驻 daemon | 心跳走外部 cron/systemd + TUI 定时器（§11） |
| 8 | 记忆参与 compact 摘要生成 | 职责分离：摘要管上下文，记忆管偏好；compact 只做**重注入** |
| 9 | `/memory edit` 图形化编辑 | 记忆就是 Markdown 文件，直接编辑即可 |

---

## 2. 决策依据

### 2.1 三条硬约束（决定了后面所有取舍）

**约束 A：全局层对文件工具不可见。**
`checkPath`（`src/tools/utils.ts`）强制路径落在 `sessionCwd` 内，越界报 `path outside workspace`；`read_file` /
`search_content` 都走它 → `~/.deepseek-arch/memory/` **永远无法**被普通文件工具读到。
→ 对策：全局层只能通过**专用工具**（core 内直接 `node:fs`）暴露 ⇒ **这是 `memory_read` 工具存在的硬依据**。

**约束 B：`search_content` 不遍历隐藏目录。**
`collectFiles` 递归时跳过名字以 `.` 开头的子目录（`src/tools/search-content.ts` 的 `base.startsWith('.')`）。
→ 从工作区根搜不到 `.deepseek-arch/memory/`；**显式传 `path: ".deepseek-arch/memory"` 可以搜到**（该目录内的文件不以 `.` 开头）。
→ 对策：不依赖通用搜索，注入块里写明可用 `memory_read` 取全文。

**约束 C：配置合并是白名单。**
`ConfigManager.load()` 逐字段组装 `resolved`；`set()` 的 `fileMap` 只认已知段，否则抛「不支持的配置段」。
→ 新增 `[memory]` **必须同时改 5 处**（§10.2），否则出现「配置写了读不到」或「`/memory off` 报错」。

### 2.2 复用的既有机制

| 机制 | 位置（符号） | 复用点 |
|:--|:--|:--|
| system prompt 快照（会话创建写入、resume 复用） | `SessionManager.startNewSession` / `resumeSession`、`Storage.getSession` | 让 system prompt **在一个会话内冻结** → 清单注入零缓存代价 |
| 预算化 listing 注入 | `cli/index.ts` 的 `<skill_listing>`、`core/skill.ts` 的 `buildSkillListing` | 清单块的预算裁剪写法 |
| 循环引擎 | `core/subagent.ts` 的 `runSubagentLoop`（无轮次上限） | memory agent 的引擎（必须外挂 watchdog） |
| 独立中断信号 | `core/subagent-session.ts` 的 run 级 `AbortController` | memory agent 不随主 agent 中断而死 |
| 落盘的"一行提示"形态 | 子代理通知（`render/conversation.ts` 渲染 `⇢ [Subagent] …`） | 注入块落盘 + UI 一行呈现 |
| 追加式日志 | `core/cache-log.ts`（多进程 append） | `audit.jsonl` |
| 工具白名单过滤 | `cli/index.ts` 的 `loadMasterTools` | `--no-memory` 剔除记忆工具 |

### 2.3 关键取舍一览（评审定稿）

| # | 取舍 | 结论 |
|:--|:--|:--|
| 1 | 记忆放 system prompt 还是消息层 | **清单进 system prompt**（会话内冻结，零缓存代价）；会变的内容走**落盘的消息块** |
| 2 | 注入块落盘还是临时 | **落盘**（成为历史 → 下一轮前缀不断；临时块会让前缀在注入点断开） |
| 3 | 重装 system prompt 的时机 | **只在"前缀本来就要变"的时刻**：新会话 / compact / 用户显式 `/memory refresh` |
| 4 | 召回由谁决定 | **`deepseek-v4-flash`**（清单超预算裁剪；会话内出示）；失败退化为按更新时间倒序，**绝不少注入** |
| 5 | 去重怎么做 | **清单前置 + agent 判断 + 三条确定性规则**（不做相似度算法） |
| 6 | 归纳何时跑 | **用户发出消息后并发**（输入含上一轮"用户+助手最终回复"），不阻塞、不连坐 |

---

## 3. 存储

### 3.1 目录与文件

```
{workspace}/.deepseek-arch/memory/      # 项目层
~/.deepseek-arch/memory/                # 全局层（跨项目偏好）
├── MEMORY.md            索引：正式条目（confidence ≥ 阈值）。由条目派生，可随时重建；注入用的就是它
├── <slug>.md            主题文件：YAML frontmatter + 正文（一个主题一个文件）
├── candidates.md        候选池：confidence < 阈值的模糊条目（不注入、master 不可见）
├── logs/yyyy/mm/dd.md   追加式日志（当前无调用方，见 §14-A4）
├── state.json           游标等状态（`lastExtractedTurnId`）
├── audit.jsonl          机器可读审计（追加式）
└── legacy/              用户手写笔记（原样保留；不参与索引）
```

`{workspace}` = `DEEPSEEK_ARCH_SESSION_CWD`（`SessionManager` 构造时锁定，CLI `--workspace` 可覆盖）；
路径解析单一入口：`src/core/workspace-paths.ts` 的 `getMemoryDir()`。装配入口：`src/core/memory-service.ts`
（`createMemoryStore` / `setMemoryStore` / `getMemoryStore`）。

**为什么是 Markdown 而不是 JSONL/数据库**：人是主要读者（可直接改、可进 git、可 diff）；一主题一文件 →
"这条何时更新"由文件 mtime / frontmatter `updated` 天然表达；agent 对**项目层**可直接 `read_file` 读全文。

### 3.2 主题文件格式（字段定义）

```markdown
---
name: 回复格式偏好
description: 回复先给结论再给理由，不要长篇铺垫      # 供召回判断相关性，必须具体
type: feedback                                    # user | feedback | project | reference（受控词表）
subject: reply.format                             # 合并键：同 subject 才可能被合并/取代
tags: [reply, format, style]
scope: project                                    # project | global
confidence: 3                                     # 1 模糊 | 2 否决/确认 | 3 显式陈述
signal: A                                         # 触发信号 A–F（审计用）
paths: ["src/**"]                                 # 可选：适用路径 glob
remindAt: 2026-09-15T09:00:00.000Z                # 可选：到期提醒时间（发出后清空）
created: 2026-09-12T09:10:00Z
updated: 2026-09-13T02:00:00Z
status: active                                    # active | candidate | superseded
supersededBy: reply-format-2                      # status=superseded 时指向新条目
---

回复先给结论，再给理由；避免长篇铺垫。
**Why:** 用户明确说过「别铺垫」。
**How to apply:** 面向用户的总结，第一句就是结论。
```

- **条目 id = 文件名**（`<slug>.md`，slug 由 `subject` 派生：`reply.format` → `reply-format`，冲突自动加后缀）。
- 正文建议结构：`规则/事实` + `**Why:**` + `**How to apply:**`（对齐 Claude Code 的实践）。
- frontmatter 解析/序列化在 `memory-store.ts` 的 `parseEntry` / `serializeEntry`（极简 YAML 子集：`key: value`、`[a, b]`、引号按需）。
- **无 frontmatter 或缺 `subject`** 的文件视为用户手写笔记：进 `legacy` 名单，**不进索引**（`scan()` 返回 `{entries, legacy}`）。

### 3.3 索引（`MEMORY.md`）与清单渲染

- 索引行与注入清单**共用同一渲染函数** `renderManifestLine()`，保证磁盘与注入字节一致：
  `- [名称](slug.md) — description (confidence N, updated today|yesterday|N days ago)`
- `rebuildIndex(scope)` 从条目文件派生 `MEMORY.md`（正式条目）与 `candidates.md`（候选）；
  写入 / 遗忘后自动调用 → **索引永远可重建，不需要额外状态**。
- 人话时间由 `ageText()` 生成（模型对"3 days ago"比 ISO 时间戳更敏感；对齐 Claude Code 的 `memoryAge`）。
- 清单排序：`updated` 倒序（确定性）；预算不足时按序截断并标注 `…(N more)`。
  **一行都放不下时返回空** —— 保住「无记忆 = 现有请求字节不变」这条不变量。

### 3.4 写入规则（四条确定性规则，无相似度算法）

| 情形 | 动作 | 说明 |
|:--|:--|:--|
| 给了 `slug` 且文件存在 | **update** | 改写该文件；`created` 与 slug 不变 |
| 同 `subject` + 正文**归一化后完全相等** | **merge** | 置信度取 max、刷新 `updated`，不新建 |
| 同 `subject` 但内容冲突，或显式给了 `supersedes` | **supersede** | 新条目生效；旧条目写 `status=superseded` + `supersededBy`（**退出索引，文件保留**作为演化记录） |
| 其余 | **add** | slug 由 subject 派生，冲突自动加后缀 |

归一化 = 去空白 + 去常见标点 + 小写（`normalizeText()`）。显式 `supersedes` 可**跨 subject** 指名取代。

### 3.5 游标（增量判断）

- `state.json` 的 `lastExtractedTurnId` 存**已归纳到的轮次序号**（字符串 `"1"`/`"2"`…）。
- 归纳窗口 = `allTurns.slice(cursor)`；成功后 `nextCursor = String(allTurns.length)`。
- **同一段对话只归纳一次**（替代 v1 的"每次喂最近 3 轮"，从源头消除重复条目）。
- 语义：归纳在**本轮开始时**分析"已完成的历史轮次"→ 第一轮不产生归纳（没有 assistant 回复可判断）。

### 3.6 审计

`audit.jsonl` 追加式（写日志本身不抛错）。`kind` 取值：

| kind | 触发 | 关键字段 |
|:--|:--|:--|
| `write` | add / update | `action, slug, scope, subject, by, reason` |
| `merge` | 同义合并 | `slug, scope, subject` |
| `supersede` | 取代 | `slug, superseded[]` |
| `forget` | 遗忘（用户或 agent） | `slug, reason` |
| `inject` | 注入变化提醒/到期提醒 | `sid, mode, tokens` |
| `agent_run` | 归纳代理一次运行 | `sid, model, elapsedMs, totalTokens, toolCalls, writes[], aborted, reason, notes` |
| `remind_due` | 到期提醒发出 | `slug, remindAt` |
| `error` | 归纳/解析/写入失败 | `where, message, sid` |

用途：排查「为什么这条没注入/为什么被取代」、成本核算、参数调优。

### 3.7 并发与容量

- **并发**：条目文件写入用「临时文件 + rename」原子替换；审计/日志追加式。
  单进程内 memory agent 单飞（§8.5）；多进程（多会话同时跑）下同一 workspace 的写入按 last-write-wins 处理，不做跨进程锁。
- **容量**：不做自动清理（v1 的 fold/容量清理已废弃）。条目数量级由归纳配额（≤3 条/轮、宁少勿滥）与用户
  `/memory forget` 控制；`manifestAll()` 按预算截断，条目再多也不会撑爆上下文。

---

## 4. 置信度与可见性

| 概念 | 规则 |
|:--|:--|
| 置信度 1–3 | 3 = 用户明确陈述（A/D/E）；2 = 否决/纠正、确认（B/C）；1 = 重复模式推断（F，模糊） |
| **可见性门槛** | 只有 `confidence ≥ memory.master_min_confidence`（默认 **2**）进入 `MEMORY.md` 与注入清单 |
| 候选池 | `confidence < 门槛` 的条目进 `candidates.md`：**不注入、master 不可见**，由 memory agent 独占管理 |
| 升级 | 同义再现 → merge 时置信度取 max（封顶 3）；升到门槛以上时由 `rebuildIndex` 自动进入正式索引 |
| 取代 | 同 subject 冲突 → 旧条目 `status=superseded`，退出索引但保留文件（演化记录） |
| 软淘汰 | 归纳代理对某条 `memory_write` 传同 slug + `confidence: 1` → 掉回候选池（`candidates.md`），**master 不再看到**，仍可恢复 |
| 硬淘汰 | `memory_forget`（**仅 memory agent 可用**，每轮上限 3 条，不计入写入配额）：写墓碑 + 退出索引；**`confidence: 3` 拒绝**（只能取代或用户本人 `/memory forget`） |
| 静默失效的治理 | 归纳代理每轮读清单（含 `updated N days ago`）→ 顺带清理与本轮话题相关且明显过时的条目；配合 `confidence` 的**离散档位**（3→2→1→候选池→superseded），不做连续数值衰减 |
| 衰减 / LRU（确定性 GC） | **本期不做**，设计要点见 `docs/todo/memory-open-items.md` A3b |
| 到期提醒 | `remindAt` 到期的条目（**含候选条目**）在下一轮注入 `<memory-due>`，发出后清空 `remindAt`（一次性） |

**淘汰路径（R25：过时记忆如何消失）**

"过时"分两类，机制不同：

| 类型 | 表现 | 机制 |
|:--|:--|:--|
| **被推翻**（有矛盾证据） | 同 subject 出现新说法 | 取代：旧条目 `superseded`、退出索引（代码自动，确定性） |
| **被判断无意义** | 话题早结束、内容再无价值 | agent 软淘汰（`confidence: 1` → 候选池）或硬淘汰（`memory_forget`） |
| **静默失效**（没人再提、也没被推翻） | `updated` 越来越旧 | 归纳时按「时效 + 本轮话题相关性」顺带处理；**不做半衰期公式** |
| **用户显式偏好过时** | `confidence: 3` 但你判断它老了 | 代码层**拒绝删除**（`forbidden`）→ 只能由新说法取代，或用户 `/memory forget` |

为什么不用连续衰减：可见性随日期漂移无法向用户解释（"昨天还在，今天怎么没了"），
而"离散档位（3→2→1→候选池→superseded）+ 由归纳代理在读到相关对话时决定"既可控又可审计（每次动作都落 `audit.jsonl`）。
清单预算 ≤800 tokens 是安全阀：即使滞留条目存在，它们也只能挤占预算、不会撑爆上下文。

**什么时候会写出 `confidence: 1`（降级 vs 出生低）**

代码层只有一条规则：**显式传入 `confidence` 才改它**（`pickFields`），且 `status` 一律由**最终 confidence** 派生（`deriveStatus`）。

| 路径 | 场景 | 结果 |
|:--|:--|:--|
| 出生即 1（非降级） | 归纳代理按信号 F（重复模式推断）新增条目 | 新条目直接进候选池 |
| **显式软淘汰**（唯一"降级"入口） | `memory_write {slug, confidence: 1}` —— 归纳代理按 §4 规则判断"已无意义"；master 自己也能这么写 | 原条目退出清单 → `candidates.md`，**可逆**（再写回 2/3 即恢复） |
| 显式降级到 2 | 同上但传 2（仍 ≥ 阈值） | 仍在清单，等级 3 → 2 |
| 什么都不传 | 更新条目（给 slug）而未给 confidence | **原值保留**，状态不变 → 不会无意降级 |
| 同义重复（merge 分支） | 同 subject + 正文归一化后相等（无论传多低） | **永不降级**：confidence 取 `max`，状态按最终 confidence 重算（见下） |
| 取代 / 遗忘 | supersede / forget | confidence 不改，改的是 `status`（`superseded` 是终态，后续 update 不会复活） |

> **实现注意（本次修复的一个真 bug）**：`status` 原先由 `pickFields` 按传入 confidence 直接写成 `candidate`，
> 而 merge 分支只在之后把 confidence 抬回 `max`，于是出现 `confidence=3 + status=candidate` 的自相矛盾状态 ——
> **一条正式条目会因为"低置信的同义重复"而静默退出注入清单**（已由 `deriveStatus` 统一派生修复，
> 并加了单测：merge 不降级、显式降级可逆、superseded 终态、阈值可配 `masterMinConfidence=3`）。
> 提示词与工具描述同步加了"更新已有条目时沿用原 confidence，别在改写措辞时降级"。

---

## 5. 去重与冲突

**核心：不写相似度算法。** 重复检测交给模型，代码只做确定性动作。

1. **清单前置**（对齐 Claude Code）：归纳代理的输入里带上"现有记忆清单"，并明确要求
   「先查清单 / 先 `memory_read`：能更新已有条目就不要新建」。
2. **三条确定性规则**（§3.4）覆盖了代码能做的一切：指定 slug 改写、完全相等合并、同 subject 取代。
3. **演化记录**：被取代的条目保留在原文件里（`status` + `supersededBy` + `updated`），可回溯"偏好怎么变的"。
4. **源头控制重复**：游标增量（§3.5）+ 主/后台互斥（§8.4）→ 同一段对话只归纳一次、master 写过就不重复写。
5. 兜底：如需人工清理，用 `/memory show` 找重复 → `/memory forget <slug>`。

> v1 的 Jaccard 阈值（0.72/0.45）、冲突打分、`sim` 分布调参、对应单测矩阵**全部废弃**（§13-B3）。

---

## 6. 注入（最关键）

### 6.1 两条通道

| 通道 | 载体 | 生效时机 | 缓存影响 |
|:--|:--|:--|:--|
| **① 清单** `<memory_listing>` | **system prompt** | 会话创建时构建并写入快照；`resume` 复用快照；`/memory refresh` 与 compact 后重建 | **零额外代价**（system prompt 在会话内冻结） |
| **② 变化提醒** `<memory-update>` / 到期提醒 `<memory-due>` | **一条落盘的 user 消息**（写进 `turn.messages`） | 每轮开轮时检查；有内容才注入，且只注入一次 | 只重算该块自身（≤200 tokens） |

### 6.2 为什么这样就省（缓存分析）

- system prompt 只在两处确定：`startNewSession`（构建 + 落盘快照）、`resumeSession`（**复用快照**）
  → 会话内**没有改写 system prompt 的路径** → 清单放进去只会"过期"，不会造成缓存失效。
- 代价只出现在**重装的那一瞬间**：新会话（没有更长前缀，≈0）／compact（前缀本来就被摘要替换，≈0）／
  **会话中途自动重装（禁止：整段历史作废）**。
- 变化提醒**落盘**：成为历史的一部分 → 下一轮请求的前缀仍然命中（不落盘会重算上一轮内容一次）。
- 无记忆时不注入任何内容 → 「关闭记忆 = 现有请求字节不变」（回归不变量）。

### 6.3 实现落点

| 动作 | 位置 |
|:--|:--|
| 会话创建注入清单 | `SessionManager.startNewSession`（追加 `<memory_listing>` 后再写快照） |
| resume 播种"已见" | `resumeSession` → `MemoryInjector.seedFromSystemPrompt(快照)`（解析快照里的清单 → 之后只提醒差异） |
| 每轮注入变化/到期 | `SessionManager.injectMemoryUpdates`（到期 → 读过的条目被更新 → 清单变化，合成一条消息） |
| 重建 + 重写快照 | `SessionManager.refreshMemoryPrompt`（`/memory refresh` 与 `compactContext` 调用；用 `stripMemoryListing` 保留基座文本） |
| 清单渲染 | `MemoryInjector.buildListingBlock` / `MemoryStore.manifestAll` |
| 差异检测 | `MemoryInjector.buildUpdateBlock` + `diffSeen`（按 `slug → updated` 对比） |
| 已读追踪 | `MemoryInjector.markRead` / `buildReadUpdateBlock`（提醒一次后推进，不重复打扰） |

---

## 7. 召回（`deepseek-v4-flash`）

**只用在一个地方**：清单超预算时从候选中挑出该注入的条目（`memory.recall_model`，默认 `deepseek-v4-flash`）。

```
候选（正式条目，项目层优先、同 slug 屏蔽全局层）
  ├─ 全部能放进预算（且数量未超上限）→ 直接全给，**不调用模型**（零额外成本）
  └─ 超预算 → 编号清单 + 当前任务文本 → 模型返回 {"selected":[i,...]}
        ├─ 越界/重复下标过滤；返回空数组 = 尊重"都不相关"的判断
        └─ 失败（超时 20s / API 错误 / 不可解析）→ **退化**：按 updated 倒序取预算内的条目，标注原因
```

**绝不因为召回失败而少注入或不注入**；退化原因写进审计。日志进 `audit.inject`。

> v1 的确定性打分公式（0.45 相关性 + 0.25 置信度 + 0.15 时效 + 0.15 LRU）已废弃（§13-B4）。

---

## 8. memory agent（后台归纳）

### 8.1 触发

- **用户发出消息后并发启动**（`SessionManager.sendMessageStream` 开轮时 `void maybeRunMemoryAgent(...)`）。
- 输入片段：**游标之后**的「用户消息 + 助手最终回复」+ **本轮用户消息**。
- 不阻塞主 agent、不连坐中断（独立 `AbortController`）；失败只写审计。

### 8.2 输入范围（有意收紧，R2）

- **只给**「用户消息 + 助手最终回复」；
- **不给**工具调用轨迹、**不给**思维链（`reasoning_content`）。
- 后果（明示）：信号 C（"assistant 随后确实执行"）不再可验证，C 降级为按用户话术判断。
- 裁剪：最多 `agent_max_input_turns`（默认 3）轮、总预算 `agent_max_input_tokens`（默认 6000），**最新轮优先**。

### 8.3 工具集（有意收紧）

只有三个：`memory_read`（读清单/条目，含候选池文件）、`memory_write`（写入）、`memory_forget`（淘汰）。
- 不给文件/搜索工具 → 从根上避免它去"核实技术细节"（也就省掉了白名单与路径限制逻辑）。
- **写入配额在工具层强制**：包装后的 `memory_write` 超过 `agent_max_writes_per_run`（默认 3）返回错误文本，
  让 agent 自然收尾（而不是中断运行）。
- **淘汰配额独立**：`memory_forget` 每轮上限 3 条（常量 `MAX_FORGETS_PER_RUN`），**不占用写入配额**
  （否则"写满了就没法清理"）；`confidence: 3` 直接拒绝。
- **清理是硬职责**：提示词含"时效与清理"表 —— 相关话题下矛盾 → 取代；无意义 → `confidence: 1` 软淘汰；
  事实错误且无替代 → `memory_forget`。判断依据只有「清单里的 `updated` 时效」+「本轮对话」，
  且要求"每轮最多处理 3 条、优先相关且明显过时的"，禁止为清理而批量淘汰无关条目。
- 提示词在 `src/core/memory-agent-prompt.ts`：信号 A–F 判定表、置信度取值、"不该记什么"清单、
  同 subject 复用要求、正文结构、时效与清理规则、工具说明。

### 8.4 主/后台互斥

该窗口内 **master 自己调用过 `memory_write`**（扫最近一轮的 `tool_calls`）→ **跳过**后台归纳并把游标推进到当前轮。
（对齐 Claude Code 的 `hasMemoryWritesSince`；我们的实现比它简单——直接看工具调用而非嗅探文件写入。）

### 8.5 保护

| 保护 | 规则 |
|:--|:--|
| 单飞 | 同会话已有在跑 → **跳过**（不排队），审计 `skipped:"busy"` |
| 最小间隔 | 两次归纳间隔 ≥ `agent_min_interval_sec`（默认 30s） |
| 轮次上限 | `runSubagentLoop` 无上限 → watchdog：工具调用数 > 8 / 墙钟 > `agent_timeout_ms`（90s）/ 累计 tokens > 输入预算 × 3 |
| 中止语义 | watchdog 中止 → 状态 `error` + 原因，**游标不推进**（下一轮可重试该窗口）；`no_input` / `master_wrote` → 推进游标（避免空转） |
| 失败 | 只写审计（`agent_run` 带 `aborted/reason`、`error`），绝不抛给主流程 |
| 进程退出 | TUI/headless 收尾时 `abort()`（当前未接，见 `docs/todo/memory-open-items.md` C 组） |

### 8.6 写入提示

- 归纳代理写入成功 → `memoryNoticeCallback`（TUI 一行 dim：`[memory] 已更新 N 条（/memory show 查看）`；headless 走 stderr）。
- master 自己调用 `memory_write` → TUI 在 `tool_result` 事件里对 `toolName === 'memory_write'` 追加同一行提示。
- 到期提醒 → `memoryDueCallback`（TUI 一行提示；提醒块本身已注入给模型）。
- 频控：不弹层、不打断流式（当前无额外频控；如需合并计数见 §14-A5）。
- 注：v1 设计的 StreamEvent `memory_updated` 改为**回调**实现（`setMemoryNoticeCallback` / `setMemoryDueCallback`）。

---

## 9. 面向用户接口

### 9.1 TUI 命令

| 命令 | 行为 |
|:--|:--|
| `/memory` | 状态摘要：两层条数、候选条数、注入预算、召回/归纳模型、项目层目录、可用子命令 |
| `/memory show [kw]` | 列出条目（`slug  conf  scope  updated  description`，≤20 行；带 kw 时按关键词过滤） |
| `/memory candidates` | 列出候选池（模糊条目，仅 memory agent 管理） |
| `/memory forget <slug>` | 遗忘：写墓碑 + 退出索引（文件保留）；自动判断条目在哪一层 |
| `/memory on` / `off` | 开关；写回 `memory.enabled`；关闭立即生效（不再注入/归纳，已有记忆保留） |
| `/memory refresh` | 重建 system prompt 里的清单并同步重写会话快照（前缀会作废一次，故做成手动） |

### 9.2 启动参数

| 参数 | 作用 |
|:--|:--|
| `--no-memory` | 完全关闭：不注入、不归纳、**并从工具集里剔除** `memory_read`/`memory_write`（`chat` 与 `resume` 均支持） |
| `--workspace <dir>` | 指定工作区根（决定项目层记忆落在哪里） |

### 9.3 模型可用工具（仅主代理）

| 工具 | 说明 |
|:--|:--|
| `memory_read { path }` | 读条目全文。`path` 可为 `reply-format.md`（自动定位层）/ `global:x.md` / `project:x.md` / 绝对路径；返回正文 + 元信息（confidence/updated/subject）。**core 内直接 `node:fs`，绕过 `checkPath`** → 全局层唯一通道 |
| `memory_write { scope, subject, body, name?, description?, type?, tags?, paths?, confidence?, slug?, remindAt?, supersedes? }` | 写入/更新/取代（见 §3.4）；写后自动重建索引 + 审计。描述里写明"不该记什么"，提醒模型宁少勿滥 |

子代理 `SUBAGENT_TOOLS` **不含**记忆工具；`memory_forget` **不进 `ALL_TOOLS`**，只挂在归纳代理的工具集里
（master 想淘汰只能走 `confidence: 1` 软降级，或用户 `/memory forget`）。

---

## 10. 配置

### 10.1 字段与默认值（`config.toml` 的 `[memory]` 段）

| 字段 | 默认 | 说明 |
|:--|:--|:--|
| `enabled` | `true` | 总开关（`/memory off` 写回此处；`--no-memory` 优先级更高） |
| `inject` | `true` | 会话创建时是否把清单注入 system prompt |
| `max_inject_tokens` | `800` | 清单注入预算（超出时用 `recall_model` 挑选） |
| `delta_inject_tokens` | `200` | 变化提醒 / 到期提醒块预算 |
| `master_min_confidence` | `2` | master 可见的最低置信度（1 = 候选，仅 memory agent 管理） |
| `recall_model` | `deepseek-v4-flash` | 召回选择用模型 |
| `agent_model` | `deepseek-v4-flash` | 后台归纳代理用模型 |
| `agent_on_turn_end` | `true` | 是否在用户发言后异步归纳（关闭后只注入不归纳） |
| `agent_min_interval_sec` | `30` | 同会话两次归纳最小间隔 |
| `agent_max_writes_per_run` | `3` | 单次归纳最多写入条数 |
| `agent_max_input_turns` | `3` | 归纳输入最多轮数（游标之后的保护上限） |
| `agent_max_input_tokens` | `6000` | 归纳输入 token 预算（同时决定 watchdog 的 token 上限 = ×3） |
| `agent_timeout_ms` | `90000` | 单次归纳最长时长 |
| `notify_read_updates` | `true` | 「你读过的条目被更新」是否提醒 |

### 10.2 必须同步的 5 处（约束 C）

1. `src/types/config.ts`：`MemoryConfig` 接口 + `AppConfig.memory` + `ResolvedConfig.memory`
2. `src/types/index.ts`：导出 `MemoryConfig`
3. `src/core/config.ts` 的 `DEFAULT_MAIN_CONFIG` 模板：追加带注释的 `[memory]` 段
4. `src/core/config.ts` 的 `load()` 合并：`MEMORY_DEFAULTS` 代码默认兜底（**老配置无该段也能 `get` 到值**）
5. `src/core/config.ts` 的 `set()` `fileMap`：`memory → config.toml`（`/memory on|off` 才能写回）

漏掉第 4 处 → "配置写了读不到"；漏掉第 5 处 → `/memory off` 抛「不支持的配置段」。

---

## 11. 心跳与 `chat --prompt`

### 11.1 已实现：`chat --prompt`（心跳载体）

```
deepseek-arch chat --prompt "<内容>" [--workspace <dir>] [--resume <id|name>] [--mock]
```

| 契约项 | 已实现 |
|:--|:--|
| stdout | **仅最终回复**（一行结尾），便于管道处理 |
| stderr | 进度（`[tool] <name>`）与错误；记忆更新提示 `[memory] updated N` |
| 退出码 | `0` 成功；`1` 会话不存在 / `--workspace` 不可用 / 本轮失败 |
| 工具确认 | 不注册确认回调 → 需要确认的工具**直接执行**（yolo） |
| 落盘 | 与 TUI 一致（会话、turn 正常写入）；失败且未产生轮次时丢弃刚创建的空会话 |
| 会话 | 默认新建（标题由 prompt 派生）；`--resume` 续用既有会话 |

> v1 曾设计的 `--json` / `--session <name>` / `--timeout` / 退出码 0/1/2/3 / 工具白名单**未实现**，
> 与心跳一起定（`docs/todo/memory-open-items.md` A6/C1）。

### 11.2 待做：心跳（用户已定方向，细节未定）

- 形态：**外部 cron/systemd timer 调 `chat --prompt`**（主）+ **TUI 内定时器**（备）；不做常驻 daemon。
- 待定项：间隔与 token 预算、与用户正在输入时的抢占用、无人值守时的工具放行策略（当前 yolo 全放行）、
  以及"到期记忆在无人时如何呈现"（见 `docs/todo/memory-open-items.md` C 组）。

---

## 12. 实现状态与测试映射

截至 2026-09-13：**全量 584 测试通过**（53 个测试文件），`tsc` 无错。

| 模块 | 文件 | 测试 | 用例数 |
|:--|:--|:--|:--|
| 存储 | `src/core/memory-store.ts` | `tests/core/memory-store.test.ts` | 19 |
| 召回 | `src/core/memory-recall.ts` | `tests/core/memory-recall.test.ts` | 10 |
| 注入 | `src/core/memory-inject.ts` | `tests/core/memory-inject.test.ts` | 10 |
| 服务装配 | `src/core/memory-service.ts` | 经工具测试覆盖 | — |
| 记忆工具 | `src/tools/memory-read.ts`、`memory-write.ts` | `tests/tools/memory-tools.test.ts` | 10 |
| 淘汰工具 | `src/tools/memory-forget.ts` | `tests/tools/memory-forget.test.ts` | 6 |
| 归纳代理 | `src/core/memory-agent.ts`、`memory-agent-prompt.ts` | `tests/core/memory-agent.test.ts` | 14 |
| 会话接线 | `src/core/session.ts` | `tests/core/memory-session.test.ts` | 8 |
| 配置段 | `src/types/config.ts`、`src/core/config.ts` | `tests/core/config.test.ts` | +4 |
| CLI（含 `--no-memory`、`--prompt`） | `src/cli/index.ts` | `tests/cli/prompt.test.ts` | 7 |

关键实现选择（与评审稿的差异以此为准）：

1. **游标用轮次序号**（`"1"`/`"2"`…）而非消息 uuid —— 简单、跨进程稳定。
2. **agent 工具只有 read+write+forget** —— 从根上避免"去核实技术细节"。淘汰不走「打分公式」而走
   「离散档位 + 由 agent 顺带判断」（§4 末三行、§8.3）。
3. **配额在工具层强制**（返回错误文本给模型）而非中断运行。
4. **watchdog 中止不推进游标**（可重试），`no_input`/`master_wrote` 推进游标（避免空转）。
5. **注入块与子代理通知共用"落盘为一条 user 消息"形态**；并修掉了**无工具轮丢弃注入块**的 bug
   （`saveTurn` 的 `agentLoopMessages` 传递条件）。
6. **`MEMORY.md` 由条目派生**，与注入清单共用渲染函数，保证字节一致。

---

## 13. 废弃清单（v1 方案与理由）

| # | 废弃物 | 理由 | 替代 |
|:--|:--|:--|:--|
| B1 | JSONL 单文件（`memory.jsonl`）+ `op=put/touch/delete` + fold 折叠 + `.lock/` | 人不可直读、无法按主题 diff；每主题一文件后折叠不再需要 | 主题 `.md` + `MEMORY.md` 派生索引 |
| B2 | `memory_search` 工具 | 清单整份注入已提供发现通道；全局层由 `memory_read` 覆盖 | `memory_read`（+ 清单） |
| B3 | 相似度阈值去重（Jaccard 0.72/0.45）+ 冲突打分 | 代码复杂度高、阈值需调参；模型判断 + 三条等值规则已够 | 清单前置 + 三条确定性规则 |
| B4 | 确定性打分公式（0.45/0.25/0.15/0.15）+ `score_floor` | 召回已交给 flash；公式无消费者 | `memory-recall.ts`（flash + 退化） |
| B5 | reviewer（censor agent）、YOLO 审查自动续答、`defaults.review_model`、`/review_model` | 用户决定删除（memory agent 取代它） | 已删除（commit `ad24395`） |
| B6 | 临时 user 消息注入（T2/P2/P3/P5） | 不落盘会让下一轮前缀在注入点断开 | 清单进 system prompt + 落盘式变化提醒 |
| B7 | StreamEvent `memory_updated` | 回调更简单，且当前无外部订阅者 | `setMemoryNoticeCallback` / `setMemoryDueCallback` |
| B8 | `logs/` 每日日志的写入 | 与 `audit.jsonl` 重复 | 审计（`appendLog` 保留但暂无调用方，见 §14-A4） |

---

## 14. 未做项

完整清单与工作量估计见 **`docs/todo/memory-open-items.md`**。摘要：

| 组 | 内容 |
|:--|:--|
| **A** | A2 事件化提示、A3b 确定性 GC（衰减/LRU 归档）、A4 `logs/` 写入、A5 CLI 面（`--memory-scope`/`--quiet`/`pin`/`show --audit`）、A6 `--prompt` 契约对齐、A7 跨层去重分层、A8 `agent_max_tokens` 字段 |
| **C** | 心跳载体契约、cron/systemd 细节、无人值守时的到期提醒呈现 |
