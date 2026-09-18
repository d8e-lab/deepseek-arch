# Memory 机制技术报告：算法与实现

> 版本：v3（2026-09-15）
> 范围：`deepseek-arch` 的长期记忆子系统（存储、写入、生命周期、注入、召回、后台归纳、并发与可靠性）
> 代码基线：`src/core/memory-store.ts`、`memory-inject.ts`、`memory-recall.ts`、`memory-agent.ts`、`memory-lock.ts`、`memory-service.ts`、`src/tools/memory-*.ts`、`src/core/session.ts`
> 配套：决策记录 `plan/memory-v3-decisions.md`（本文以该决策为准）、设计稿 `plan/memory-heartbeat-design.md`、用户视角讲解 `plan/memory-design-explained.md`

---

## 1. 问题与目标

Agent 每次会话都从零开始。用户反复表达过的偏好（"回复先给结论"）、项目约定（"plan 写 `.deepseek-arch/plan`"）、边界声明（"提示词体系先不动"）无法跨会话保留，于是用户重复说、agent 重复犯。

本子系统的目标是：**跨会话记住偏好、约定与边界；随对话自动累积；在相关任务时自动注入；且不占用大量上下文。**

据此定下的四条硬约束（决定了后面所有取舍）：

| 约束 | 含义 |
|:--|:--|
| **不占上下文** | 默认注入 ≤ 800 tokens；条目再多也只能挤占预算，不会撑爆 |
| **可解释** | 每条记忆为什么可见/不可见、为什么被淘汰，都要能向用户解释，且留下审计 |
| **可检索** | 模型要能"知道有哪些记忆"并取全文，而不是被塞一整本 |
| **不打扰主流程** | 归纳、召回、维护的任何失败都只写审计，绝不让主对话失败 |

**明确不做**：向量/embedding 检索、通用对话记忆（turns 已承担）、用户手动编辑记忆（v3 起只读，避免外部漂移）、连续数值衰减（半衰期）、记忆参与 compact 摘要生成。

---

## 2. 总体架构

### 2.1 两层作用域

| 层 | 位置 | 内容 |
|:--|:--|:--|
| **project** | `{workspace}/.deepseek-arch/memory/` | 项目约定、本仓库的决策 |
| **global** | `~/.deepseek-arch/memory/` | 跨项目的个人偏好、环境知识 |

两层结构完全同构，各自独立维护工作集、活动日与审计。**合并时 project 优先**：同 slug（同主题）时屏蔽 global 条目。

### 2.2 组件

```
┌──────────────────────────── SessionManager（编排）────────────────────────────┐
│  新会话/resume：结算 → 建清单 → 写 system-prompt 快照                          │
│  每轮开始：增量注入（落盘）                                                     │
│  compact/退出：收敛归纳代理、重建清单                                          │
└───────┬──────────────────┬───────────────────┬───────────────────┬───────────┘
        │                  │                   │                   │
┌───────▼───────┐  ┌───────▼────────┐  ┌───────▼────────┐  ┌───────▼─────────┐
│ MemoryStore   │  │ MemoryInjector │  │ MemoryRecall   │  │ MemoryAgent     │
│ 存储 + 工作集 │  │ 清单/增量渲染  │  │ 超预算时挑选   │  │ 后台归纳        │
│ 写入三规则    │  │ 变化检测       │  │ (flash) + 退化 │  │ (复用 subagent) │
│ LRU 结算      │  └───────┬────────┘  └───────┬────────┘  └───────┬─────────┘
│ 审计          │          │                   │                   │
└───┬───────┬───┘          │                   │                   │
    │       │              └───────────────────┴───────────────────┘
    │       │
    │       └──► memory_read / memory_write / memory_forget（工具，仅主代理；forget 仅代理）
    │
┌───▼──────────────┐   ┌──────────────────┐
│ manifest.json    │   │ withMemoryLock   │
│ 工作集持久化     │   │ 跨进程写互斥     │
└──────────────────┘   └──────────────────┘
```

职责边界：`MemoryStore` 不依赖任何 core 模块（只有 `node:fs`/`node:crypto`），便于被工具与代理复用；`MemoryInjector` 只管"给模型看什么"；`MemoryAgent` 只管"从对话里提炼什么"；编排全部收在 `SessionManager`。

### 2.3 一次会话的数据流

```
新会话 ─► LRU 结算(两层) ─► 构建清单 ─► 追加进 system prompt ─► 写 system-prompt.txt 快照
每轮   ─► 读过的条目被更新? ─┐
         └ 清单变化(新增/更新/移除)? ─┴─► 合成一条 user 消息（落盘进本轮 messages）
读写   ─► 记账(use/touch) ─► 局部判定(升级/复活) ─► 更新工作集 + 落盘 manifest
会话中 ─► 后台归纳代理（并发）→ 索引前置 + 对话片段 → memory_write/forget → 审计
compact/退出 ─► 收敛代理 ─► 重建清单/写回快照
```

---

## 3. 数据模型

### 3.1 条目（`MemoryEntry`）

| 字段 | 说明 |
|:--|:--|
| `slug` | 条目 id = 文件名（由 `subject` 派生：`reply.format` → `reply-format`，冲突自动加后缀） |
| `name` / `description` | 索引里显示的名字与一行描述（`description` 是召回判断相关性的主要依据） |
| `type` | 受控词表：`user` / `feedback` / `project` / `reference` |
| `subject` | **合并键**：同 subject 才可能被合并或取代 |
| `tags` / `paths` | 相关性与适用范围（可选） |
| `scope` | `project` / `global` |
| `confidence` | **档位**：3 明确陈述 / 2 否决·确认 / 1 待观察 / 0 待销毁 |
| `signal` | 触发信号 A–F（审计用） |
| `pinned` | 用户钉住：免疫自动升降级与销毁 |
| `created` / `updated` | ISO 时间；`updated` 同时是"变化检测"的输入之一 |
| `status` | `active` / `candidate` / `superseded`；**由 confidence 派生**，见 §3.3 |
| `supersededBy` | 被取代时指向新条目（演化链） |
| `body` | 正文（规则 + `**Why:**` + `**How to apply:**`），**只存在主题文件里** |
| `filePath` | 派生字段（工作集里由目录 + slug 拼出） |

### 3.2 主题文件格式

```markdown
---
name: 回复格式偏好
description: 回复先给结论再给理由，不要长篇铺垫   # 召回判断相关性，必须具体
type: feedback
subject: reply.format                            # 合并键
tags: [reply, format, style]
scope: project
confidence: 3
signal: A
created: 2026-09-12T09:10:00Z
updated: 2026-09-13T02:00:00Z
---

回复先给结论，再给理由。
**Why:** 用户明确说过「别铺垫」。
**How to apply:** 面向用户的总结，第一句就是结论。
```

没有 frontmatter 或缺 `subject` 的 `.md` 视为**用户手写笔记**：保留在目录里、计入 `legacy` 名单、不进索引、不参与任何算法。

### 3.3 档位与状态的派生关系

```
confidence ≥ master_min_confidence(默认 2)  ──► status = active      （模型可见）
confidence <  master_min_confidence        ──► status = candidate   （模型不可见，仅代理管理）
status = superseded                        ──► 终态（被取代/被遗忘），永不复活
```

**不变量**：`status` 必须是"最终 confidence"的函数。历史上曾出现 `status=candidate + confidence=3` 的自相矛盾状态（低置信的同义重复把正式条目踢出清单），现在由 `deriveStatus(previous, finalConfidence, threshold)` 统一派生，`superseded` 是唯一例外。

### 3.4 总表（`manifest.json`）

每层一份，是 harness 的**工作集持久化**：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-09-15T15:17:33.501Z",
  "activeDayCount": 42,          // 活动日时钟
  "lastActiveDate": "2026-09-15",
  "entries": [ /* MemoryEntryMeta[]：元数据，不含 body */ ],
  "usage": { "reply-format": { "uses": 2, "lastUsedAt": "...", "lastUsedDay": 41, "lastStepDay": 40 } }
}
```

设计要点：

- **元数据集中、正文分散**：决策（可见性、LRU、召回）只需要元数据，因此它们全在总表里；正文留在 `<slug>.md`，只在"读全文"时按需读取。
- **渲染视图**：`MEMORY.md`（可见条目）与 `candidates.md`（候选，不含墓碑）由总表派生，与注入清单共用同一个渲染函数，保证"磁盘上的索引"与"模型看到的清单"字节一致。
- **旧 `state.json`**：仅在重建时导入一次（usage / 活动日），此后不再写入。

---

## 4. 存储层算法

### 4.1 目录布局（每层同构）

```
<layerDir>/
├── manifest.json        总表：工作集（元数据 + 使用统计 + 活动日）
├── MEMORY.md            渲染视图：可见条目索引（注入用同一渲染函数）
├── candidates.md        渲染视图：候选（conf < 阈值）
├── <slug>.md            主题文件：frontmatter + 正文（内容唯一来源）
├── audit.jsonl          追加式审计（write/merge/supersede/forget/inject/use/lru/agent_run/error/pin）
├── state.json           旧版状态（只读导入）
├── logs/yyyy/mm/dd.md   追加日志（appendLog，当前无生产调用方）
└── legacy/              手写笔记；legacy/archive/ 存放被销毁的条目
```

### 4.2 工作集的生命周期

```
layer(scope):
  m ← mtime(manifest.json)
  缓存有效?(缓存存在 且 (缓存 dirty 或 m=0 或 m ≤ 缓存.loadedAtMs)) → 直接返回
  m>0 且 manifest 可解析且 version=1 → 从总表载入（正文留空）→ 返回
  否则 → 全量扫描主题文件重建 + 一次性导入旧 state.json → 写回总表（自愈）→ 返回
```

四条不变量：

1. **进程内读不落盘**：读路径只碰内存；只有写入路径 `flush` 才动 manifest。
2. **`dirty` 期间禁止重载**：本进程有未落盘的本地变更时，即使发现其它进程改过 manifest 也不重载（否则会丢掉刚写的条目）。
3. **跨进程可见性**：其它进程写入会推进 manifest 的 mtime；本进程下次读取时 `m > loadedAtMs` → 重载。
4. **自愈**：manifest 缺失/损坏/版本不符 → 从主题文件重建（主题文件始终是内容的最终依据）。

### 4.3 跨进程写互斥（`withMemoryLock`）

写操作（写入/遗忘/结算/钉住）在**层目录**上取一把文件锁：

| 性质 | 规则 |
|:--|:--|
| 粒度 | 每层一把（`.memory.lock`），一次一个写者 |
| 获取 | `open(path, 'wx')`；失败则重试（40–80ms 抖动） |
| 有界等待 | 默认 15s 拿不到即抛错（调用方按"本次记忆操作失败"处理，不影响主流程） |
| 陈旧锁 | 锁文件 mtime 超过 5 分钟视为持有者已死，可抢占 |
| 释放 | 先核对 token（写入时写入 `pid-time-rand`），只删自己的锁，避免删掉抢占者的锁 |

**读路径不取锁**：读不破坏数据；读路径上的 `recordUse/recordTouch` 仍是无锁读改写——最坏结果是丢失少量 LRU 信号，不会丢条目（这是有意的权衡）。

### 4.4 原子写与大小上限

- 所有落盘走**临时文件 + rename**，临时名带 `randomUUID`（历史上用 `pid-Date.now()` 会撞名，导致同毫秒并发写时第二个 rename 拿到 ENOENT、写入静默失败）。
- 单条记忆上限 **64KB（含 frontmatter）**：读取时截断返回并带标记，同时在 UI 弹一行告警；写入侧超限也会告警（趁早发现"把资料写进记忆"的误用）。

---

## 5. 写入算法：三条确定性规则

不做相似度算法、不做阈值调参。重复检测交给模型判断，代码只做确定性动作：

```
applyWrite(scope, input):
  1. input.slug 存在且条目存在            → update     （改写该文件，保留 created 与 slug）
  2. 同 subject 的现有条目中：
     a. normalize(body) 完全相等           → merge      （confidence 取 max、刷新 updated，不新建）
     b. 否则                               → supersede  （旧条目 status=superseded + supersededBy，退出索引但保留文件）
  3. 其余                                  → add        （slug 由 subject 派生，冲突自动加后缀）
```

- `normalize = 去空白 + 去常见标点 + 小写`；`supersedes` 参数可**跨 subject** 指名取代。
- 状态派生在**算出最终 confidence 之后**进行（merge 取 max、update 可能显式降级）。
- 写入即"重申"：`write()` 末尾调用一次 `recordUse`（使用次数 +1、刷新老化时钟）；**但写路径不做即时升级**（`allowPromote:false`），否则"显式降到 1"会被同一次写入的 use 立刻抬回 2。
- 取代时**使用计数跨条目继承**（`inheritUsage`）：同主题反复出现是候选条目升级的唯一确定性证据，清零会让"一年才提一次"的偏好永远攒不够证据。
- 被取代/被遗忘的条目的使用记录会被清理（避免状态无限累积）。
- 每次写入后索引自维护（`syncIndex` → 重建 `MEMORY.md` / `candidates.md`；失败只落审计，条目本身已写盘）。

---

## 6. 生命周期算法：LRU 档位状态机

### 6.1 状态机

```
  conf 3 ──闲置>90活动日──▶ 2 ──闲置>90──▶ 1 ──容量超限──▶ 0 ──闲置>180活动日──▶ 销毁
         ◀──累计使用≥2 且近期用过──        ◀──任何触达────
                                        （回到 1 重新观察，不越级）
```

| 档位 | 含义 | 模型可见 |
|:--|:--|:--:|
| **3** | 用户明确陈述（A/D/E） | ✅ |
| **2** | 否决/纠正、确认（B/C） | ✅ |
| **1** | 待观察：模糊，或曾可见但久未用 | ❌ |
| **0** | 待销毁：**只在容量装不下时产生** | ❌ |

两条边界：**闲置最低只降到 1**（没有容量压力时不存在销毁的理由）；**0 只由容量压力产生**。

### 6.2 活动日时钟

- `activeDayCount` 只在"换了一天 **且程序确实被使用**"时 +1，每次结算至多 +1。
- 条目记 `lastUsedDay`（最近触达）与 `lastStepDay`（最近结算）。
- **老化程度 = `activeDay − max(lastUsedDay, lastStepDay)`**。
- 意义：用日历天会导致"半年不开程序，回来所有条目同时过期 → 一次清空"；活动日下**缺席不老化**，只有"你一直在用、但这条一直没被用到"才老化。
- 老数据（无活动日记录）回退为日历天估算，下次触达即转正。

### 6.3 两种触达强度

| 信号 | 触发者 | 效果 |
|:--|:--|:--|
| **使用** `recordUse` | master 读全文（`memory_read`）／任何写入与重申 | `uses+1`、刷新老化时钟、可把 0 拉回 1、**唯一能推动升级** |
| **看到** `recordTouch` | 归纳代理为查重而读 | 只刷新老化时钟；**不增 uses、不推动升级**、但也能把 0 拉回 1 |
| **曝光**（出现在清单里） | 注入 | **什么都不算** |

"曝光不算触达"是刻意设计：否则会形成"越注入越升级"的正反馈。"使用/看到"分离则是因为代理查重读很频繁，若计入 uses 会让所有被查过的条目集体升级。

### 6.4 检查点结算（`reconcile`）

一次结算 = 纯计算出一个计划 → 统一落盘（因此 `--dry-run` 零副作用）。**每条只命中一个分支**：

| # | 条件 | 动作 |
|:-:|:--|:--|
| 0 | `pinned` | 跳过（免疫自动升降级与销毁） |
| 1a | conf **0** 且最近一个 decay 周期内被触达过 | **复活** → conf 1（不直接回 2） |
| 1b | conf **0** 且闲置活动日 > `destroy_after_days` | **销毁**（归档 `legacy/archive/` 或物理删除） |
| 2a | `uses ≥ promote_uses` 且闲置 ≤ decay 且 conf < 3 | **升级** conf+1，uses 清零 |
| 2b | 属于"超出 `window_size` 的最久未用者"（且 conf > 1） | **窗口换出** → conf 1（观察区，不是判死刑） |
| 2c | 属于"超出 `total_limit` 的最久未用**候选**" | **容量淘汰** → conf 0（0 的唯一来源） |
| 2d | 闲置活动日 > `decay_active_days` 且 conf > 1 | **降级** conf−1（下限 1） |

- **容量拆分**：可见上限 `window_size`（默认 200），候选上限 = `total_limit − window_size`（默认 400−200=200）。
- **排序键（确定性）**：`lastUsedAt` 升序 → `uses` 升序 → slug。最久未用者先出局。
- **一次结算每条只走一步**：`lastStepDay` 保证同一活动日内重复结算（两次会话启动 / 手动 gc）不会连降两级。
- **可逆且不越级**：任何降级/销毁都由"再次被使用"拉回 **1**，想回 2/3 要继续被使用。
- **销毁灭火**：归档失败不中断整批计划（历史实现里裸 rename 会让一条失败拖垮全批）。

### 6.5 会话内局部判定（v3）

检查点之外，**被触达的那一条**立即判定（O(1)，只看自己）：

```
applyLocalJudgement(slug, allowPromote):
  pinned / superseded / lru_enabled=false → 不动
  conf ≤ 0      → 复活到 1（uses 清零，lastStepDay=activeDay）
  allowPromote 且 uses ≥ promote_uses 且 conf < 3 → 升级 +1，uses 清零
```

- **明确不做**（留给检查点）：闲置降级、窗口换出、容量淘汰、销毁——这些需要看全体。
- **写路径不升级**（见 §5），**"看到"不升级**（只复活）。
- 局部升级**不改 `updated`**，所以"可见性变化通知"必须把 confidence 纳入变化检测键（§7.3）。

### 6.6 复杂度

| 操作 | 复杂度 |
|:--|:--|
| 读（清单/候选/单条元数据/状态） | 进程内 O(1) 起，无文件 IO；单条正文 1 次文件读 |
| 写一条 | 1 次条目写 + 1 次总表写（O(N) 字节）+ 索引重建（O(N) 渲染） |
| 会话内局部判定 | O(1) |
| 检查点结算 | O(N log N)（排序）+ O(N) 文件写（仅变更项） |
| 每轮增量注入 | 进程内过滤，O(1) 文件 stat |

---

## 7. 注入算法

### 7.1 两条通道

| 通道 | 载体 | 生效时机 | 缓存影响 |
|:--|:--|:--|:--|
| **① 清单** `<memory_listing>` | **system prompt** | 会话创建时构建并写入快照；resume 复用快照；compact / `/memory refresh` 重建 | **零额外代价**（system prompt 会话内冻结） |
| **② 变化提醒** `<memory-update>` | **一条落盘的 user 消息**（写进本轮 `turn.messages`） | 每轮开轮时检查；有内容才注入 | 只重算该块自身（≤200 tokens） |

为什么这样省：system prompt 只在会话创建时确定一次，会话内**没有改写它的路径**，所以清单放进去只会"过期"、不会造成缓存失效；变化提醒**落盘**成为历史的一部分，下一轮前缀仍然命中。**没有记忆时不注入任何内容**——"关闭记忆 = 现有请求字节不变"是一条回归不变量。

### 7.2 清单构建

```
buildListingBlock(taskText):
  manifest ← 两层的可见条目（project 优先，同 slug 屏蔽 global），按 updated 倒序
  预算内直接全给（零模型调用）
  超预算 → MemoryRecall.select(...)（§8）
  渲染 <memory_listing> 块（每条一行：- [name](slug.md) — description (confidence N, updated age)）
  seen ← {slug → updated|confidence}
```

预算 `max_inject_tokens = 800`。排序是 `updated` 倒序（确定性）；超出按行截断并标注 `…(N more)`；**一行都放不下时返回空块**（保住"无记忆 = 字节不变"）。

### 7.3 变化检测：版本键 = `updated|confidence`

```
visibilityKey(entry) = `${entry.updated}|${entry.confidence}`
```

早期实现只比 `updated`。但 LRU 升降级**不改** `updated`——"这条已经退出可见清单"于是永远不会通知模型，模型会继续拿冻结清单里的旧条目当现状。把 confidence 纳入版本键后：

- **进入可见**（新增 / 升档跨过门槛） → 报 `added` / `updated`（行内带新 confidence）
- **离开可见**（降为 1 / 被取代 / 被遗忘） → 报 `removed/retired`
- **仅可见范围内升降**（3↔2） → 报 `updated`，模型能看到新档位

### 7.4 增量通知的推进规则

- 每类（added / updated / removed）最多展示 **6 条**，其余标 `…(N more, will be reported on a later turn)`。
- **只有真正展示给模型的条目才推进 `seen`**：被截断的变更保持旧键，下一轮继续进入 diff —— 早期实现先把全部标为"已见"，导致未展示的变更永久静默。
- "你读过的条目被更新"提醒同样**提醒一次即推进**，避免每轮重复打扰；模型重新 `memory_read` 会再次刷新。
- 整个块按 `delta_inject_tokens = 200` 截断（按字符截断，不会切断多字节字符）。
- 提醒块以 `role: user` 追加进 `agentMessages` → 随本轮落盘。

### 7.5 按需读取

清单只给"有哪些"，取全文靠 `memory_read`：

- 路径只允许：裸文件名（自动定位层，project 优先）、`global:x.md` / `project:x.md`、或**两个 memory 目录之内**的路径；其余一律拒绝（早期版本允许任意绝对路径，等于绕过文件沙箱读全盘）。
- 读到全文**记一次"使用"**（这是 LRU 升级/保鲜/复活的主要证据来源）。
- 单条超过 64KB 截断并告警。

---

## 8. 召回算法

只在**清单超预算**时使用（`recall_model`，默认 `deepseek-v4-flash`）：

```
select(taskText, candidates, maxItems, maxTokens, alreadySurfaced):
  池 = 候选 − 已出示（会话内去重）
  池为空 → 空结果（no_candidates）
  预算内（且数量未超上限）→ 全部给，**不调用模型**
  否则：
    问模型 → {"selected":[i,...]}
      ├ 解析失败(null)                    → 退化
      ├ 解析出下标但**全部非法**           → 退化（关键修复：不能当成"都不相关"）
      ├ 空数组                            → 尊重"都不相关"，不注入
      └ 依序按预算收编，收编为空           → 退化
  退化 = 按 updated 倒序取预算内的条目，标注原因
  记录 {mode, reason, tokens} 供审计（mode ∈ all/llm/fallback）
```

**绝不因为召回失败而少注入或不注入**——这是该模块的头号不变量。20s 自身超时（超时后退化，不等底层请求）。

**已知限制**：会话创建时还没有用户消息，因此那一次的召回没有"当前任务"文本（只能按预算/更新时间给）；`/memory refresh` 与 compact 后的重建会带上"最近一轮用户消息"作为任务文本。

---

## 9. 后台归纳代理算法

### 9.1 触发与游标

- **触发**：用户发出消息后**并发**启动（fire-and-forget），不阻塞主 agent、不连坐中断（独立 AbortController）。
- **游标按会话存放**（`<sessionDir>/memory-cursor.json`）：窗口 = `turns[cursor..]`，成功后推进到 `turns.length`。
  - 早期实现把游标放在**共享的项目状态**里：新会话会把它清零 → 再 resume 旧会话会整段重新归纳，多会话还会互相踩。
- **游标推进规则**：`done` / `no_input` / `master_wrote` → 推进；watchdog 首次失败**不推进**（保留重试机会），同一窗口连续失败 2 次 → 推进并审计（放弃该窗口，避免每轮重试、反复花钱）。

### 9.2 输入构造（有界）

```
系统提示：MEMORY_AGENT_PROMPT（信号 A–F 判定表、置信度取值、"不该记什么"、同 subject 复用要求、
          正文结构、时效与清理规则、工具说明）
用户消息：
  ① 现有记忆索引（前置）：正式条目 + 候选池（每段 ≤30 行；候选行带"共被使用 N 次"与"⏳待销毁(已 N/180 活动日)"）
  ② 可能与本轮相关（关键词确定性初筛，零 API 成本；只用元数据，不读正文）
  ③ 需要归纳的对话片段：游标之后的「用户消息 + 助手最终回复」——**不含工具轨迹、不含思维链**
  ④ 本轮用户消息（单独强调）
预算：对话 ≤ agent_max_input_turns(3) 轮、agent_max_input_tokens(6000)；索引/本轮消息/任务文本各自按比例截断
```

**索引前置是必需的**：没有它，代理无从判断"该更新哪条"，只能瞎猜 subject 造重复条目；候选池（conf 1）模型看不到、也不会被 `memory_read` 命中，其升级只能由代理在归纳时决定。这一条曾在文档里声称做了、代码里没做（后来补上），是本子系统最值得记的教训之一。

### 9.3 工具集与配额（有意收紧）

| 工具 | 说明 |
|:--|:--|
| `memory_read`（`touch` 模式） | 读清单/条目/候选池；**只刷新老化时钟**，不增 uses、不推动升级 |
| `memory_write` | 写入；单次运行配额 `agent_max_writes_per_run`(3)，超限返回错误文本让代理自然收尾 |
| `memory_forget` | 硬淘汰（写墓碑、退出索引、文件保留）；**每轮上限 3 条且不占写入配额**；`confidence: 3` 直接拒绝（只能由新说法取代，或用户 `/memory forget`） |

不给文件/搜索工具——从根上避免它去"核实技术细节"，也就省掉了白名单与路径限制逻辑。

### 9.4 保护

| 保护 | 规则 |
|:--|:--|
| 单飞 | 同会话已有在跑 → 跳过（不排队） |
| 最小间隔 | 两次归纳间隔 ≥ `agent_min_interval_sec`(30s) |
| 主/后台互斥 | 本窗口内 master 自己写过 `memory_write` → 跳过后台归纳并推进游标 |
| watchdog | 工具调用数 > 8 / 墙钟 > 90s / 累计 tokens > 输入预算 × 3 → 中止并记 `reason` |
| 失败 | 只写审计（`agent_run` / `error`），绝不抛给主流程 |
| 收敛 | compact 前与进程退出时 `abortAndWait()` |

审计记录 `agent_run`：`{sid, model, elapsedMs, totalTokens, toolCalls, writes[], aborted, reason, notes}`。

---

## 10. 会话编排：谁在什么时候调用什么

| 时机 | 动作 |
|:--|:--|
| **新建会话** | ① 两层 LRU 结算（与"是否注入"解耦）② 构建清单并追加进 system prompt ③ 写 `system-prompt.txt` 快照 ④ 写 `inject` 审计 |
| **resume** | 复用快照（保证前缀一致）→ 从快照解析清单播种"已见" → 跑一次 LRU 结算 |
| **每轮开轮** | ① 读过的条目被更新？② 清单变化？→ 合成一条 user 消息落盘 |
| **每轮（并发）** | 后台归纳代理（游标窗口 + 索引前置） |
| **写/读记忆** | 记账 → 局部判定 → 更新工作集 → 落盘总表（写路径取锁） |
| **compact** | 收敛子代理与归纳代理 → 复位"已出示" → 重建清单并重写快照 |
| **`/memory gc`** | 手动结算（支持 `--dry-run` 预览） |
| **进程退出** | 收敛归纳代理（不做回收） |

---

## 11. 参数与默认值

| 参数 | 默认 | 作用 |
|:--|:--|:--|
| `enabled` | true | 总开关（`/memory off`；`--no-memory` 优先级更高） |
| `inject` | true | 是否把清单注入 system prompt（**不再影响 LRU 维护**） |
| `max_inject_tokens` | 800 | 清单注入预算 |
| `delta_inject_tokens` | 200 | 变化提醒块预算 |
| `master_min_confidence` | 2 | 可见门槛（1 = 候选，仅代理管理） |
| `recall_model` / `agent_model` | `deepseek-v4-flash` | 召回 / 归纳模型 |
| `agent_on_turn_end` | true | 是否在用户发言后异步归纳 |
| `agent_min_interval_sec` | 30 | 同会话两次归纳最小间隔 |
| `agent_max_writes_per_run` | 3 | 单次归纳最多写入条数 |
| `agent_max_input_turns` | 3 | 归纳输入最多轮数 |
| `agent_max_input_tokens` | 6000 | 归纳输入 token 预算（watchdog 上限 = ×3） |
| `agent_timeout_ms` | 90000 | 单次归纳最长时长 |
| `notify_read_updates` | true | "你读过的条目被更新"是否提醒 |
| `lru_enabled` | true | LRU（局部判定 + 结算）总开关 |
| `lru_decay_active_days` | 90 | 闲置超过该活动日数 → 降一级 |
| `lru_promote_uses` | 2 | 累计使用达阈值且近期用过 → 升一级 |
| `lru_window_size` | 200 | 可见条目上限（超出按 LRU 换出到 conf 1） |
| `lru_total_limit` | 400 | 记忆总量上限（超出把最久未用候选降到 conf 0） |
| `lru_destroy_after_days` | 180 | conf 0 的销毁期限（活动日） |
| `lru_destroy_mode` | `archive` | 销毁方式：归档 / 删除 |

用户控制面：`/memory [show [kw] | candidates | gc [--dry-run] | pin <slug> | unpin <slug> | forget <slug> | on | off | refresh]`；启动参数 `--no-memory`、`--workspace`。

---

## 12. 复杂度与成本（v2 → v3）

| 维度 | v2 实现 | v3 实现 |
|:--|:--|:--|
| 每轮注入检查 | **4–6 遍全量扫描**（每遍 = readdir + 每个文件 readFile + parse；400 条 ≈ 1600–2400 次文件读/轮） | 内存工作集过滤 + 几次 manifest mtime stat |
| 读一条记忆 | 全量扫描后取一条 | 1 次文件读（正文，按需） |
| 写一条记忆 | 全量扫描 + 条目写 + 索引重建 | 工作集就地更新 + 1 次条目写 + 1 次总表写 + 索引重建 |
| 结算触发 | 只在"新建会话 + 注入开启" | 新建会话 / resume / 手动 gc（与注入解耦） |
| 会话内升降档 | 只在结算时 | 被触达的那条即时生效（升级/复活） |

**写放大**：每次变更重写整份总表（O(N) 字节，400 条约 ~100KB）。这是"单一工作集"换来的代价；条目文件仍按需单写。若未来记忆量级显著变大，可拆分"元数据 / 使用统计"两份文件或做节流。

---

## 13. 正确性保证与失效模式

**设计保证**

1. **主题文件是内容的最终依据**：总表丢失/损坏可全量重建；索引是纯投影，可随时重建。
2. **状态派生的唯一性**：`status` 恒等于"最终 confidence 的函数"（`superseded` 例外），不会出现档位与可见性自相矛盾。
3. **结算幂等**：一次结算每条只走一步；同日重复结算不连降；`--dry-run` 零副作用。
4. **消息前缀稳定**：清单冻结在 system prompt、变化以落盘消息呈现；无记忆时注入为空。
5. **日志不致命**：审计/索引/注入/归纳/召回的失败都只落审计，不影响主流程与已落盘的条目。

**已知失效模式与缓解**

| 风险 | 现状 |
|:--|:--|
| 总表与主题 frontmatter 是"两份真相" | 写入顺序定为"条目文件先、总表后"；崩溃后靠重建扫描收敛。**同步规则尚未形式化**（见 §14 O1） |
| 读路径的 `recordUse/recordTouch` 无锁 | 只可能丢少量 LRU 信号，不丢条目（有意权衡） |
| 会话创建时的召回没有任务文本 | 该次只能按预算/更新时间给；refresh/compact 时已有任务文本 |
| 归纳代理被 watchdog 中止 | 首次保留重试，连续两次放弃窗口并审计 |
| 局部判定即时升级不改 `updated` | 由版本键 `updated|confidence` 覆盖 |

---

## 14. 已知限制与未做项

| # | 事项 | 说明 |
|:-:|:--|:--|
| O1 | 总表与 frontmatter 的同步规则 | 写顺序、崩溃点、以谁为准，尚未形式化；当前靠"文件先写 + 启动重建"兜底 |
| O2 | 锁粒度与抢占语义 | 当前每层一把、15s 超时、5 分钟判陈旧；更细的粒度/公平性未做 |
| O3 | 自动升到 conf 3 | 连续被写/用即可到最高档，而 conf 3 会被 `memory_forget` 拒绝删除（获得"删除豁免"）。建议自动晋升封顶 2 |
| O4 | 归纳代理直接更新 skill | 需求里的"反馈时判断是否更新 skill"未实现（reviewer 已删，代理只有 memory 工具） |
| O5 | 心跳与无人值守 | 只有 `chat --prompt` 载体；定时唤醒、无人时的工具放行策略未定 |
| O6 | 会话创建时的按任务召回 | 见 §8 已知限制 |
| O7 | 关键词初筛不读正文 | 工作集不含正文，初筛只用 name/description/subject/tags（避免把初筛变成全量 IO） |
| O8 | 每次变更重写整份总表 | 见 §12 写放大 |

---

## 15. 术语表

| 术语 | 含义 |
|:--|:--|
| **条目 / entry** | 一条记忆（一个主题 Markdown 文件 + 总表里的一行元数据） |
| **主题文件** | `<slug>.md`，frontmatter + 正文，内容唯一来源 |
| **总表 / manifest** | `manifest.json`，元数据 + 使用统计 + 活动日；harness 工作集 |
| **工作集 / layer cache** | 进程内的总表镜像；读走内存、写就地更新 |
| **档位 / confidence** | 3/2/1/0 四级；可见性、升级、淘汰全部由它表达 |
| **活动日** | "程序确实被使用过的一天"；缺席不老化 |
| **使用 / 看到** | 两种触达强度；前者推动升级，后者只保鲜 |
| **结算 / reconcile** | 检查点上的全局维护（升级/降级/换出/淘汰/销毁） |
| **局部判定** | 会话内只针对被触达条目的即时判定（升级/复活） |
| **清单 / listing** | 注入到 system prompt 的 `<memory_listing>` 块 |
| **增量 / delta** | 落盘的一条 `<memory-update>` 用户消息（变化提醒） |
| **召回 / recall** | 清单超预算时用 flash 挑选条目；失败必退化 |
| **归纳 / extraction** | 后台代理从对话片段提炼/更新记忆 |
| **可见门槛** | `master_min_confidence`（默认 2）：≥ 门槛才进清单 |
| **墓碑 / tombstone** | `status=superseded` 的条目：退出索引但保留文件作为演化记录 |
