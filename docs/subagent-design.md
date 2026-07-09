# Subagent 系统设计文档

> 版本: 1.0  
> 最后更新: 2026-07-10  
> 对应分支: `feat/subagent`

---

## 目录

1. [概述](#1-概述)
2. [核心架构](#2-核心架构)
3. [数据模型](#3-数据模型)
4. [执行引擎](#4-执行引擎)
5. [Agent Loop 集成](#5-agent-loop-集成)
6. [TUI 前端设计](#6-tui-前端设计)
7. [持久化](#7-持久化)
8. [KV-Cache 安全设计](#8-kv-cache-安全设计)
9. [线程安全与并发模型](#9-线程安全与并发模型)
10. [未来可改进项](#10-未来可改进项)

---

## 1. 概述

Subagent（子代理）系统允许主 Agent 通过工具调用委派子任务给独立运行的子代理。每个子代理有独立的模型上下文、受限工具集，可并行执行，适合长程复杂任务的拆解与并行化。

### 设计目标

- **独立执行**: 子代理有完整的 Agent Loop，不受主 Agent 状态干扰
- **安全隔离**: 子代理不能创建子子代理，不能反问用户
- **并行加速**: 多子代理可同时运行，互不阻塞
- **视觉分离**: 子代理状态在主 TUI 中紧凑展示，不干扰主线对话
- **可回溯**: 子代理执行记录持久化到磁盘，支持事后检查

### 两种运行模式

| 模式 | 切换方式 | spawn 后行为 | 何时获取结果 |
|------|---------|-------------|-------------|
| **非异步 (默认)** | `/async off` | Agent Loop 等待所有子代理完成 | Promise.all 后统一返回 |
| **异步** | `/async on` | 立刻返回 `[SPAWNED]`，不等待 | 模型通过 `wait` 主动获取 |

两种模式下子代理之间始终并行执行。

---

## 2. 核心架构

### 分层架构图

```
┌─────────────────────────────────────────────────────────┐
│                     TUI (TuiApp)                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │  紧凑状态行  │  Ctrl+T 详情  │  /subagent 命令    │ │
│  └──────────────┴──────────────┴─────────────────────┘ │
└──────────────────────────┬──────────────────────────────┘
                           │ StreamEvent 回调
                           ▼
┌─────────────────────────────────────────────────────────┐
│                 SessionManager                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Agent Loop                                        │ │
│  │  ├── interceptSubagentTool() ← 拦截 spawn/wait/list│ │
│  │  ├── buildStatusBlock()   ← 异步状态注入模型       │ │
│  │  └── SubagentStore        ← 输出内存缓冲           │ │
│  └──────────────────────┬─────────────────────────────┘ │
└─────────────────────────┬───────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ SubagentStore│ │  storage.ts  │ │ runSubagent()│
│  (内存缓冲)   │ │ (磁盘持久化)  │ │   启动子代理  │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       └────────────────┼────────────────┘
                        ▼
               ┌──────────────────┐
               │ runSubagentLoop  │
               │  (独立模型循环)   │
               │  MAX_ROUNDS=25  │
               └──────────────────┘
```

### 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| `runSubagentLoop` | `src/core/subagent.ts` | 子代理独立循环引擎，驱动模型 API 调用 |
| `SubagentStore` | `src/core/subagent-store.ts` | 子代理输出内存缓冲（运行时） |
| `SessionManager` | `src/core/session.ts` | Agent Loop 集成，工具拦截，状态注入 |
| `Storage` | `src/core/storage.ts` | 子代理记录持久化读写 |
| `TuiApp` | `src/cli/tui/app.ts` | 紧凑渲染、详情视图、快捷键 |
| `ConversationView` | `src/cli/tui/conversation.ts` | 历史对话渲染（含子代理工具记录） |

---

## 3. 数据模型

### 3.1 SubagentRoundEntry（运行时单条记录）

```typescript
interface SubagentRoundEntry {
  type: 'thinking' | 'content' | 'tool_call' | 'tool_result' | 'tool_output';
  content: string;
  timestamp: number;
  toolName?: string;           // type=tool_call/tool_result/tool_output
  toolArgs?: Record<string, unknown>;  // type=tool_call
  toolError?: string;          // type=tool_result
  outputStream?: 'stdout' | 'stderr';  // type=tool_output
}
```

每种 type 对应子代理执行过程中的一种输出：

| type | 来源 | 用途 |
|------|------|------|
| `thinking` | 模型的 `reasoning_content` delta | 运行时缓冲，详情视图暂时跳过 |
| `content` | 模型的 `content` delta | 详情视图显示子代理思考/回复 |
| `tool_call` | 模型的 `tool_calls` | 详情视图显示工具调用 |
| `tool_result` | 工具执行的返回内容 | 详情视图显示工具结果 |
| `tool_output` | 工具执行中的实时 stdout/stderr | 详情视图显示 shell 实时输出 |

### 3.2 SubagentRecord（完整记录）

```typescript
interface SubagentRecord {
  name: string;          // 子代理名（模型指定）
  task: string;          // 模型下达的任务描述
  status: 'running' | 'completed' | 'failed';
  startMs: number;       // 启动时间戳
  endMs?: number;        // 结束时间戳
  result?: string;       // 最终返回文本
  entries: SubagentRoundEntry[];  // 按时间序的输出条目
}
```

### 3.3 StreamEvent（TUI 通信事件）

```typescript
// StreamEvent.type 新增：
type = 'subagent_spawned' | 'subagent_finished' | 'subagent_update';

// subagent_spawned — 子代理已启动
{ subagentName, subagentTask }

// subagent_finished — 子代理已完成
{ subagentName, subagentStatus, subagentElapsedMs, error? }

// subagent_update — 子代理有新增输出（详情视图刷新信号）
{ subagentName }
```

### 3.4 持久化格式

```
sessions/<id>/subagents/
├── _index.json          # 索引: ["name1", "name2"]
├── research.json        # 完整 SubagentRecord JSON
└── codegen.json
```

---

## 4. 执行引擎

### 4.1 `runSubagentLoop` 函数签名

```typescript
async function runSubagentLoop(
  task: string,           // 任务描述
  provider: ModelProvider, // 模型提供商
  tools: Tool[],           // 可用工具（不含 spawn/wait/list）
  systemPrompt: string,    // 系统提示（含子代理约束）
  signal?: AbortSignal,     // 取消信号
  callbacks?: SubagentCallbacks,  // 可选回调
): Promise<string>
```

### 4.2 执行流程

```
1. 构建 tool definitions
2. 构建消息队列: [system_prompt, user_task]
3. 循环（最多 25 轮）:
   a. 调用 provider.chatStream()
   b. 累积 delta (thinking, content, tool_calls)
   c. 每轮通过 callbacks.onEntry 发射 SubagentRoundEntry
   d. 无 tool_calls → 返回最终文本
   e. 有 tool_calls → 执行每个工具:
      - 传递 onOutput 回调接收实时 stdout/stderr
      - 工具结果追加到消息队列
      - 继续下一轮
4. 超过 25 轮 → 返回已有结果
```

### 4.3 回调接口

```typescript
interface SubagentCallbacks {
  onEntry?: (entry: SubagentRoundEntry) => void;
}
```

`SessionManager.runSubagent()` 将回调接入 `SubagentStore.push()`：

```typescript
this.subagentStore.start(name, task);
const result = await runSubagentLoop(task, provider, tools, prompt, signal, {
  onEntry: (entry) => this.subagentStore.push(name, entry),
});
this.subagentStore.finish(name, result, failed);
```

### 4.4 子代理工具集

子代理可用工具通过 `getAllTools()`（无参数）获取，不包含：

- `subagent_spawn` — 不能创建子子代理
- `wait` — 不能等待其他子代理
- `list_subagents` — 不能枚举子代理
- `plan_on` / `save_plan` — 子代理不做规划

---

## 5. Agent Loop 集成

### 5.1 Spawn 拦截流程

```
模型返回 tool_calls，其中包含 subagent_spawn
         │
         ▼
  emit tool_call_start（异步模式跳过）
         │
         ▼
  interceptSubagentTool()
         │
         ├── async:  push [SPAWNED] 到 agentMessages
         │            emit subagent_spawned → TUI 紧凑状态行
         │            不阻塞，promise 后台运行
         │            promise.then() 发射 subagent_finished
         │
         ├── sync + deferredSpawns:
         │            收集到 allDeferredSpawns[]
         │            循环结束后 Promise.all → 统一推 tool_result
         │
         └── sync (回退): 直接 await → 阻塞当前 spawn
```

### 5.2 Wait 拦截

```
模型调用 wait("name")
         │
         ▼
  interceptSubagentTool()
         │
         ├── 子代理 running → await promise（阻塞）
         ├── 子代理 completed → 立刻返回结果
         ├── 子代理 already_retrieved → 报错
         └── 子代理不存在 → 报错
```

### 5.3 异步状态块注入

每轮构造 `roundMessages` 时，异步模式下在末尾追加动态状态块：

```
[Subagent Status — async mode]
- "research"  (running, 2m 30s)
- "codegen"   (completed, 45s) — use wait("codegen")
```

状态块**不写入** `agentMessages`，只作为本轮的末尾消息，以保证 KV-cache 前缀不变。

### 5.4 Agent Loop 上限

```typescript
const MAX_AGENT_ROUNDS = 50;
for (let round = 0; round < MAX_AGENT_ROUNDS && !userDenied; round++) {
  // ...
}
// 达到上限后注入截断消息：
// "(Reached max tool rounds — stopping. Please summarize...)"
```

---

## 6. TUI 前端设计

### 6.1 紧凑状态行（默认）

异步模式下，子代理相关事件渲染为单行紧凑状态：

```
[Sub: scanner] ⏳ 正在扫描文件结构 (3s)...
[Sub: analyzer] ⏳ 分析依赖图 (2s)...
[Sub: scanner] ✓ 12.4s
[Sub: analyzer] ✗ 5.1s  Error: dependency not found
```

实现方式：`TuiApp.sendMessageStream` 中新增 `subagent_spawned` 和 `subagent_finished` 事件处理分支。

### 6.2 详情视图

**触发方式**：

| 方式 | 效果 |
|------|------|
| `Ctrl+T` | 列出所有子代理 |
| `/subagent` | 列出所有子代理 |
| `/subagent <name>` | 展开指定子代理的完整执行记录 |

**详情视图示例**：

```
═══ Subagent: analyzer ✓ 18.4s ═══
Task: 分析 src/ 下所有 TypeScript 文件的 import 依赖图...
────────────────────────────────────────────────────────
  Starting dependency analysis...
  Reading src/core/session.ts... (1123 lines)
  │ 433 matches found
  │ import patterns identified: 47
  [T: search_content] {"pattern":"import from"}
  │ Found 23 files using deprecated import paths.
────────────────────────────────────────────────────────
── Final Result ──
完成依赖分析：47 个 .ts 文件，23 个需要重构。
────────────────────────────────────────────────────────
```

### 6.3 快捷键

| 按键 | 条件 | 行为 |
|------|------|------|
| `Ctrl+T` | IDLE 状态 | 列出所有子代理 |
| `Ctrl+C` | 任意状态 | 中断流式/退出 |
| `/subagent` | IDLE | 列出所有子代理 |
| `/subagent <name>` | IDLE | 展开详情 |

### 6.4 历史对话渲染（ConversationView）

历史对话中，子代理工具记录以通用工具格式渲染（与其他工具一致）：

```
[T: subagent_spawn] {"subagent_name":"analyzer","task":"..."}  (45s)
 │ [SPAWNED] Subagent "analyzer" started.
 │ Subagent "analyzer" result:
 │ 完成依赖分析：47 个文件...
```

---

## 7. 持久化

### 7.1 存储路径

```
~/.deepseek-arch/sessions/<session-id>/
├── meta.json
├── turns.json
└── subagents/
    ├── _index.json          # ["analyzer", "scanner", "codegen"]
    ├── analyzer.json        # 完整 SubagentRecord
    ├── scanner.json
    └── codegen.json
```

### 7.2 写入时机

| 事件 | 操作 |
|------|------|
| Subagent spawn | `_index.json` 创建（如果不存在） |
| Subagent loop 完成 | `SubagentRecord` 写入 `<name>.json`，更新 `_index.json` |

### 7.3 Storage API

```typescript
class Storage {
  saveSubagentRecord(sessionId, record: SubagentRecord): Promise<void>;
  loadSubagentRecord(sessionId, name: string): Promise<SubagentRecord | null>;
  listSubagentRecords(sessionId: string): Promise<string[]>;
}
```

### 7.4 Resume 流程

1. `SessionManager.resumeSession()` 加载 turns 和 system prompt
2. `/subagent` 命令首次调用时，检查 SubagentStore（内存）为空
3. 自动从磁盘 `sessions/<id>/subagents/_index.json` 加载索引
4. 读取每个 `<name>.json` 回写到 SubagentStore
5. 后续 `/subagent <name>` 直接从 SubagentStore 读取

---

## 8. KV-Cache 安全设计

### 8.1 原则

**`agentMessages` 只追加，不修改**。任何子代理状态信息必须在不修改前缀的前提下注入。

### 8.2 异步模式的消息构造

```
每轮 roundMessages:
  [...baseMessages, ...agentMessages, statusBlock]

  ┌───────────┐ ┌─────────────┐ ┌──────────┐
  │ baseMsg   │ │ agentMsg    │ │ status   │  ← 每轮新拼接
  │ (不变)     │ │ (只追加)    │ │ (新构建)  │
  └───────────┘ └─────────────┘ └──────────┘
                    ↑ 前缀命中 KV cache
```

### 8.3 状态块内容

```
[Subagent Status — async mode]
- "research"  (running, 2m 30s)
- "codegen"   (completed, 45s) — use wait("codegen")
```

每次新构建（每轮一次），以 `role: "user"` 消息追加到 messages 末尾。

### 8.4 spawn 结果的不可变性

异步模式下，`[SPAWNED]` 消息一旦写入 `agentMessages` 就**永远不变**。子代理的真实结果通过 `wait` 工具异步获取，不会回填修改已有的 `[SPAWNED]` 消息。

---

## 9. 线程安全与并发模型

### 9.1 单线程 Event Loop

Node.js 单线程模型下，`SubagentStore` 不需要锁。所有操作（start/push/finish）都在主 event loop 中执行。

### 9.2 并发子代理的生命周期

```
Agent Loop Round N:
  ┌─────────────────────────────────────┐
  │ 模型返回 3 个 tool_calls:            │
  │  spawn("A", "分析...")              │
  │  spawn("B", "搜索...")              │
  │  spawn("C", "编译...")              │
  └──────────────┬──────────────────────┘
                 ▼
  同时启动 A, B, C (Promise 已创建)
                 │
                 ├── A: timer
                 ├── B: timer       (并行执行)
                 └── C: timer
                 │
  Agent Loop 继续后续逻辑...
                 │
  （异步模式）不等待，进入下一轮
  （同步模式）Promise.all 等待全部完成
                 │
                 ▼
  Agent Loop Round N+1:
  模型看到 [SPAWNED] A/B/C
  或模型看到 A/B/C 的完整结果
```

### 9.3 子代理数量限制

- 无硬性并发上限（由模型自行管理）
- 每个子代理有 `MAX_SUBAGENT_ROUNDS = 25` 独立上限
- 主 Agent 有 `MAX_AGENT_ROUNDS = 50` 总上限

---

## 10. 未来可改进项

| 优先级 | 任务 | 说明 | 工作量 |
|--------|------|------|--------|
| P2 | 子代理详情视图实时刷新 | 定时轮询 SubagentStore，增量渲染新条目 | 中 |
| P3 | 子代理并发上限 | 可配置 `maxConcurrentSubagents`，超过时排队 | 小 |
| P3 | thinking 内容可切换显示 | 详情视图中增加 `--verbose` 标志显示 thinking | 小 |
| P3 | Subagent CLI 独立查看工具 | `deepseek-arch subagent <session-id> <name>` 离线查看 | 中 |

---

## 附录：文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/core/subagent.ts` | 核心 | 子代理循环引擎 |
| `src/core/subagent-store.ts` | 核心 | 子代理输出缓冲 |
| `src/core/session.ts` | 核心 | Agent Loop 集成 |
| `src/core/storage.ts` | 核心 | 持久化 |
| `src/tools/subagent-spawn.ts` | 工具 | spawn 工具定义 |
| `src/tools/subagent-wait.ts` | 工具 | wait 工具定义 |
| `src/tools/subagent-list.ts` | 工具 | list_subagents 工具定义 |
| `src/tools/index.ts` | 工具 | 工具注册（ALL_TOOLS / SUBAGENT_TOOLS） |
| `src/cli/tui/app.ts` | TUI | 紧凑渲染 + 详情视图 + 快捷键 |
| `src/cli/tui/conversation.ts` | TUI | 历史对话渲染 |
| `src/types/chat.ts` | 类型 | StreamEvent 扩展 |
| `tests/core/subagent-store.test.ts` | 测试 | SubagentStore 单元测试 |
