# 参考报告：Claude Code 的记忆（memory）机制是怎么做的

> 调研对象：`/home/helck/workspace/claude-code`（本地源码镜像）。
> 调研方式：只读源码（`grep`/`sed` 逐处核对），未运行、未修改。
> 证据格式：`相对路径:行号`（相对 claude-code 仓库根）。本文只陈述事实，最后一节才给对照与启示。

---

## 0. TL;DR —— 三件套

| 机制 | 一句话 | 关键证据 |
|:--|:--|:--|
| **① 索引进 system prompt，但被 memoize** | `MEMORY.md`（≤200 行 / 25KB）作为「系统提示段落」注入；该段落**整个会话只计算一次**，只在 `/clear`、`/compact`、session restore 时清缓存重算 | `constants/prompts.ts:495`；`constants/systemPromptSections.ts:16-25, 64-67` |
| **② 具体记忆走动态召回（不进 system prompt）** | 每轮**异步预取**：扫记忆目录 → 生成清单 → 便宜模型挑 ≤5 个文件 → 作为**附件**注入，包在 `<system-reminder>` 里合并进既有 user 消息 | `utils/attachments.ts:2197-2241`；`utils/messages.ts:3101` |
| **③ 缓存用显式断点保护，刷新用"危险 API"显式化** | Anthropic API 需显式 `cache_control: {type:'ephemeral'}`（≤4 处）；允许每轮重算的段落必须调用 `DANGEROUS_uncachedSystemPromptSection()` 并写明理由 | `services/api/claude.ts:358-374, 3063`；`constants/systemPromptSections.ts:27-38` |

**一句话总结**：**稳定的放 system prompt 并冻结（零缓存代价），会变的走消息层（增量在尾部），"允许每轮变"必须显式声明代价。**

---

## 1. 目录与文件形态

```
~/.claude/projects/<sanitized-project-path>/memory/     ← 项目级记忆目录
  MEMORY.md              ← 索引（注入 system prompt；≤200 行 / 25KB，超出截断）
  <topic>.md             ← 每个主题一个文件，带 YAML frontmatter
  logs/yyyy/mm/yyyy-mm-dd.md  ← 追加式日志（KAIROS 模式的日常记录）
```

证据：
- `memdir/paths.ts:229-231`：`getAutoMemPath()` = `join(getMemoryBaseDir(), 'projects', sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME + sep)`；`getMemoryBaseDir()` 默认 `~/.claude`（`memdir/paths.ts:85-93`），可用 `CLAUDE_CODE_REMOTE_MEMORY_DIR` / `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 覆盖（`:163, :189-194`）。
- `memdir/paths.ts:246-250`：日志路径 `logs/yyyy/mm/yyyy-mm-dd.md`。
- `memdir/paths.ts:254-258`：入口 `getAutoMemEntrypoint()` = `<memDir>/MEMORY.md`。
- `memdir/memdir.ts:34-38`：`ENTRYPOINT_NAME='MEMORY.md'`、`MAX_ENTRYPOINT_LINES=200`、`MAX_ENTRYPOINT_BYTES=25_000`；`:57` `truncateEntrypointContent()` 按行/字节截断。
- `memdir/memoryScan.ts:27, 30`：扫描时 `MAX_MEMORY_FILES=200`、只看前 `FRONTMATTER_MAX_LINES=30` 行取 frontmatter。

**主题文件 frontmatter 格式**（`memdir/memoryTypes.ts:261-272`）：

```markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations}}
type: {{user | feedback | project | reference}}
---

{{content — for feedback/project types: rule/fact, then **Why:** and **How to apply:** lines}}
```

受控词表 `MEMORY_TYPES = ['user','feedback','project','reference']`（`memdir/memoryTypes.ts:14-19`），未知/缺失类型优雅降级为 `undefined`（`:28-33`）。

**索引 `MEMORY.md` 的形态**（由抽取 agent 维护，`services/extractMemories/prompts.ts:76`）：
> `MEMORY.md` 是索引不是记忆，每条一行、<150 字符：`- [Title](file.md) — one-line hook`；**没有 frontmatter**；绝不把记忆正文写进 `MEMORY.md`；索引超过 200 行会被截断（`:78`）。

---

## 2. 注入通道 ①：索引进 system prompt，但被 memoize

```ts
// constants/prompts.ts:495
systemPromptSection('memory', () => loadMemoryPrompt()),

// constants/systemPromptSections.ts:16-25
/**
 * Create a memoized system prompt section.
 * Computed once, cached until /clear or /compact.
 */
export function systemPromptSection(name, compute) { return { name, compute, cacheBreak: false } }

// constants/systemPromptSections.ts:43-56
export async function resolveSystemPromptSections(sections) {
  const cache = getSystemPromptSectionCache()
  return Promise.all(sections.map(async s => {
    if (!s.cacheBreak && cache.has(s.name)) return cache.get(s.name) ?? null   // ← 命中段落缓存，不重算
    const value = await s.compute(); setSystemPromptSectionCacheEntry(s.name, value); return value
  }))
}

// constants/systemPromptSections.ts:64-67
export function clearSystemPromptSections() { clearSystemPromptSectionState(); clearBetaHeaderLatches() }
```

清缓存点：`/clear` 与 `/compact`（注释原文 "Called on /clear and /compact"，`constants/systemPromptSections.ts:62-63`），以及 session restore（`utils/sessionRestore.ts:364, 388`）。

**效果**：一个会话里 `MEMORY.md` 只被读一次 → system prompt 字节稳定 → 前缀缓存不受影响。
**代价**：会话内对 `MEMORY.md` 的任何写入**当前会话看不到**（下一次 `/clear`、`/compact` 或新会话才生效）。
**推论**（重要）：**记忆写入对当前会话不可见 ⇒ 写入不会引起任何缓存抖动**。

`loadMemoryPrompt()` 本身按模式分支（`memdir/memdir.ts:419+`）：auto-only / auto+team 合并 / KAIROS 日志模式；关闭时返回 `null`。配套 `buildMemoryLines()`（`:199`）、`buildMemoryPrompt()`（`:272`）、`buildSearchingPastContextSection()`（`:375`）、`ensureMemoryDirExists()`（`:129`）。

另有一条环境变量式注入：当调用方提供了自定义 system prompt 且设置了 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 时，额外把"记忆机制说明"追加进 system prompt（`QueryEngine.ts:312-321`）。

---

## 3. 注入通道 ②：动态召回（不进 system prompt）

### 3.1 选择器

```ts
// memdir/findRelevantMemories.ts
export async function findRelevantMemories(query, memoryDir, signal, recentTools = [], alreadySurfaced = new Set()) {
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(m => !alreadySurfaced.has(m.filePath))
  if (memories.length === 0) return []
  const selectedFilenames = await selectRelevantMemories(query, memories, signal, recentTools)  // ← 便宜模型（Sonnet）选 ≤5
  return selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}
```

- 清单格式（`memdir/memoryScan.ts:formatMemoryManifest`）：`- [type] filename (ISO 时间): description`。
- 选择器提示词（`memdir/findRelevantMemories.ts:13-20`）要求：只挑"确定有用"的，最多 5 个；**不要**再挑最近已用工具的 API 文档类记忆（对话里已有用法），但**要**挑这些工具的坑/告警类记忆。
- 输出走 `output_format: json_schema`（`{selected_memories: string[]}`，`max_tokens: 256`），失败/中止返回空数组（`:110-140`）。
- 返回 `mtimeMs` 是为了让调用方**不必二次 stat** 就能把"新鲜度"传给主模型。

### 3.2 注入形态：附件 + `<system-reminder>`，合并进既有消息

```ts
// utils/attachments.ts:2197-2241
const selected = allResults.flat()
  .filter(m => !readFileState.has(m.path) && !alreadySurfaced.has(m.path))   // 已读过 / 已出示过 → 跳过
  .slice(0, 5)
const memories = await readMemoriesForSurfacing(selected, signal)
return [{ type: 'relevant_memories' as const, memories }]
```

- 这些附件最终经 `wrapMessagesInSystemReminder()`（`utils/messages.ts:3101`）渲染成 `<system-reminder>` 包裹的内容 —— 也就是说**它被合并进消息内容，而不是新开一条独立消息**（Anthropic Messages API 要求 user/assistant 严格交替，不能连发两条 user）。
- `alreadySurfaced` 的来源是**扫描 transcript 中已有的 `relevant_memories` 附件**（`utils/attachments.ts:2245-2258`）→ 因此 **compact 之后附件随被压缩的 transcript 消失，去重集合自然重置**，允许重新出示。
- 附件在 transcript 折叠视图里被归组（`utils/collapseReadSearch.ts:619, 675, 907`），并在 transcript 搜索里特殊渲染（`utils/transcriptSearch.ts:83-105`）。

**小结**：索引（稳定）走 system prompt；**具体内容（会变）走消息层的尾部增量**，且**合并进现有 user 消息**。

---

## 4. 缓存策略：显式断点 + "危险刷新"显式化

```ts
// services/api/claude.ts:358-374
export function getCacheControl({ scope, querySource } = {}) {
  return { type: 'ephemeral', ...(should1hCacheTTL(querySource) && { ttl: '1h' }), ...(scope === 'global' && { scope }) }
}
```
- 断点标记加在**消息内容块的最后一个块**上（`services/api/claude.ts:590-670` 的 `userMessageToMessageParam` / `assistantMessageToMessageParam`，`addCache = true` 时）；工具 schema 也带 `cache_control`（`:229-257`、`:1388` 注释）。注释还提到 API 限制「最多 4 个 cache_control 块」（`utils/permissions/yoloClassifier.ts:1101`）。
- 「允许每轮重算」的段落必须显式标注：
```ts
/**
 * Create a volatile system prompt section that recomputes every turn.
 * This WILL break the prompt cache when the value changes.
 * Requires a reason explaining why cache-breaking is necessary.
 */
export function DANGEROUS_uncachedSystemPromptSection(name, compute, _reason) { ... cacheBreak: true }
```
（`constants/systemPromptSections.ts:27-38`）

**关键点**：它把「新鲜度 vs 缓存」变成**显式设计决策**——默认冻结，想要每轮新鲜必须写理由。这使得"偷偷每轮刷新把缓存打穿"在代码评审层面不可发生。

---

## 5. 写入路径（抽取 agent）

| 环节 | 事实 | 证据 |
|:--|:--|:--|
| 触发时机 | **turn stop**（一轮结束时）后台 fork，`void executeExtractMemories(...)` | `query/stopHooks.ts:149` |
| 常驻初始化 | `initExtractMemories()` 在 background housekeeping 里注册 | `utils/backgroundHousekeeping.ts:7-35` |
| headless 收尾 | 退出前 `await drainPendingExtraction()`（保证不丢） | `cli/print.ts:968` |
| 增量判断 | 有「本区间是否已有记忆写入」的判断，避免重复归纳（`hasMemoryWritesSince`） | `memdir/paths.ts:62` 注释 |
| 写入方式 | 用**普通文件工具**写主题 `.md` + 更新 `MEMORY.md` 索引行（不是专用写入工具） | `services/extractMemories/prompts.ts:57-78` |
| 提示词输入 | 预注入"已有记忆清单"让 agent 先查重、更新而非新建 | `services/extractMemories/prompts.ts:29-32` |
| 不该记什么 | 代码模式/约定/架构/路径、git 历史、调试解法、"已写在 CLAUDE.md 里的"、临时任务细节；**即使用户明确要求保存也要先追问"哪里让你意外"** | `memdir/memoryTypes.ts:183-200` |
| 陈旧告警 | 记忆是时间点观察；断言前先核对当前状态；与现状冲突时**信任现状**并顺手更新/删除旧记忆 | `memdir/memoryTypes.ts:201-215` |
| 何时去查记忆 | `WHEN_TO_ACCESS_SECTION`（含"用户说忽略某记忆时，不要既引用又覆盖"的反模式） | `memdir/memoryTypes.ts:216-254` |
| 会话记忆层 | 另有一套 `SessionMemory`（会话内抽取/脚本钩子、`shouldExtractMemory`、`createMemoryFileCanUseTool`、`sessionMemoryCompact`），用于长会话连续性 | `services/SessionMemory/sessionMemory.ts:134, 357, 460`；`services/compact/sessionMemoryCompact.ts` |

---

## 6. 陈旧治理：把"年龄"讲给模型听

```ts
// memdir/memoryAge.ts
memoryAgeDays(mtimeMs)   // 0=今天, 1=昨天, 2+=更早（未来时间戳/时钟偏移夹到 0）
memoryAge(mtimeMs)       // 'today' | 'yesterday' | 'N days ago'
memoryFreshnessText(m)   // >1 天才给：'This memory is N days old. Memories are point-in-time observations, not live state
                         //  — claims about code behavior or file:line citations may be outdated. Verify against current code...'
memoryFreshnessNote(m)   // 上面那段包成 <system-reminder>
```
设计动机（源码注释）：模型不擅长日期算术，裸 ISO 时间戳不会触发"这可能是旧的"推理，而 "47 days ago" 会；且 `file:line` 式的过时引用会让错误结论"看起来更权威"（`memdir/memoryAge.ts:1-8, 27-40`）。

---

## 7. 面向用户的接口

- `/memory` 命令：打开**记忆文件选择器**，用户可以直接用编辑器改记忆文件本身（`commands/memory/memory.tsx:1-40`、`components/memory/MemoryFileSelector.tsx`）。
- 记忆更新通知组件：`components/memory/MemoryUpdateNotification.tsx`（含 `getRelativeMemoryPath`，用于"哪条记忆被更新了"的提示）。
- 记忆路径识别：`utils/memoryFileDetection.ts`（判断某路径是否属于记忆目录，用于 UI 归属与权限）。
- 每个 agent 类型还可以有自己的记忆目录：`tools/AgentTool/agentMemory.ts:63-121`（`~/.claude/agent-memory/<dir>/`）。

---

## 8. 与我们的对照（deepseek-arch）

| 维度 | Claude Code | 我们的现状/决定 | 说明 |
|:--|:--|:--|:--|
| 缓存机制 | Anthropic **显式** `cache_control` 断点（≤4，1h TTL，global scope 可选） | DeepSeek **隐式**前缀缓存（无断点 API） | 我们只能用「位置 + 冻结」来等价达成 |
| system prompt 在会话内 | 段落 memoize（内存缓存），`/clear`·`/compact` 才重算 | 构建一次 + 落盘快照，`resume` 复用快照（`src/core/session.ts:176-179, 191-194`） | **两者效果等价**：会话内字节稳定 |
| 索引位置 | **system prompt**（`MEMORY.md`） | **决定采用：system prompt**（R11） | 采纳 claude 方案 |
| 会话内索引更新 | 看不到（冻结到 `/clear`·`/compact`） | 同（重装点 = 新会话 / compact / 显式 `/memory refresh`） | 采纳 |
| 具体记忆内容 | 每轮召回 → 附件 → **合并进 user 消息** 的 `<system-reminder>` | 计划采纳同款（R12），**不再使用独立临时 user 消息** | 采纳 |
| 召回决策 | 便宜模型从清单选 ≤5 个文件 | 先用确定性打分（关键词/路径/标签 × 置信度 × 时效 × LRU），不够再退回 LLM 选择 | 保留差异，省一次调用 |
| 去重注入 | 已读过滤（`readFileState`）+ 已出示过滤（`alreadySurfaced`，compact 后自然重置） | 计划采纳 | 采纳 |
| 陈旧提示 | `N days ago` + "时间点观察，先核对现状" | 已采纳（R4） | 采纳 |
| 记忆形态 | 主题 `.md` + frontmatter（name/description/type）+ `MEMORY.md` 索引 + `logs/` | 主题 `.md` + frontmatter + `index.md` + `log/` + `audit.jsonl` + `legacy/`（R4） | 采纳（多一份机器可读审计） |
| 写入通道 | 抽取 agent 直接用文件工具写 | 统一走 `memory_write` 工具（参数即字段，scope 决定目录）（R3） | 我们的沙箱+审计需求更强 |
| 抽取触发 | turn stop 后台 fork；headless 退出前 drain | 用户发消息后并发（R1）；失败只写日志 | 细节不同，均零用户可感延迟 |
| 受控词表/不记清单 | `type ∈ user/feedback/project/reference` + "What NOT to save" + drift caveat | 采纳其清单与词表（R4） | 直接复用其踩坑结论 |
| 用户改记忆 | `/memory` 打开文件选择器直接编辑文件 | `/memory show/forget/pin/on/off` + 文件本身可手改 | 我们额外提供命令层 |

### 我们**不**照抄的两点（附理由）

1. **不用「便宜模型选记忆」**：每次召回一次额外 LLM 调用；我们先用确定性打分 + 可审计分数（设计稿 §6.3），若召回质量不够再退回 LLM 选择。
2. **不把 `MEMORY.md` 的长度硬截断当唯一保护**：我们有 token 预算常量（`max_inject_tokens=800`）与打分 top-K，比"截到 200 行"更可控（但保留"概览必须短"的约束）。

### 我们从它这里"改主意"的地方（重要）

- 原设计（设计稿 §6.1 T2 / §6.5 P2）打算把记忆块作为**临时 user 消息**插在当前发言之前。调研后确认：claude 的索引在 system prompt、动态部分**合并进既有消息**。
  → 已按用户决定废弃 T2/P2/P3/P5，改为「system prompt 快照层 + 合并式 `<system-reminder>` 变化层」（设计稿 §12 R11/R12）。
- 原设计把「compact 后重建 system prompt」列为可选增强；claude 在 `/compact` 明确清段落缓存重算（`constants/systemPromptSections.ts:64-67`）→ 该动作**升为默认项**（R7）。

---

## 9. 证据索引（速查）

| 主题 | 位置 |
|:--|:--|
| 记忆目录/路径 | `memdir/paths.ts:30, 69, 85-93, 163, 189-194, 229-231, 246-250, 254-258, 274` |
| 索引常量与截断 | `memdir/memdir.ts:34-38, 57, 116-129, 199, 272, 375, 419` |
| 段落 memoize / 危险 API / 清缓存 | `constants/systemPromptSections.ts:16-38, 43-56, 62-67`；`utils/sessionRestore.ts:364, 388` |
| 索引注入点 | `constants/prompts.ts:476, 495`；`QueryEngine.ts:312-321` |
| 召回选择器 | `memdir/findRelevantMemories.ts`（全文）；`memdir/memoryScan.ts:27-30, 88-101` |
| 附件注入 | `utils/attachments.ts:2197-2241, 2245-2258`；`utils/messages.ts:3101` |
| 缓存断点 | `services/api/claude.ts:358-374, 590-670, 3063` |
| 抽取 agent | `services/extractMemories/prompts.ts:29-32, 50-78, 101-137`；`query/stopHooks.ts:149`；`utils/backgroundHousekeeping.ts:35`；`cli/print.ts:968` |
| 记忆类型/不记清单/漂移告警 | `memdir/memoryTypes.ts:14-33, 183-215, 216-254, 261-272` |
| 陈旧治理 | `memdir/memoryAge.ts`（全文） |
| 用户接口 | `commands/memory/memory.tsx`；`components/memory/MemoryFileSelector.tsx`；`components/memory/MemoryUpdateNotification.tsx`；`utils/memoryFileDetection.ts` |
| 会话记忆层 | `services/SessionMemory/sessionMemory.ts:134, 357, 460`；`services/compact/sessionMemoryCompact.ts` |
| 子代理独立记忆 | `tools/AgentTool/agentMemory.ts:63-121` |
