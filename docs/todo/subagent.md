## 子代理 TUI 设计提案

### 现状回顾

当前子代理在 TUI 中的渲染方式：

| 事件 | 当前 TUI 渲染 | 问题 |
| :--- | :--- | :--- |
| spawn（异步） | `[T: subagent_spawn] {args...}` + `│ [SPAWNED]...` | 和其他工具一样，没有专用视觉 |
| spawn（同步） | 同上 | 然后终端**完全静止**直到所有子代理完成 |
| wait | `[T: wait] {name}` + `│ result...`（截断12行） | 结果太长看不全，失败不显眼 |
| 子代理内部 shell 输出 | 不穿透到主 TUI | 用户在等待期的几分钟里屏幕是空的 |
| 事后检查 | 无持久化，只有 turns.json 里的 tool_call 记录 | 无法独立查看子代理做了什么 |
---

### 设计目标

1. **默认简洁**：主 Agent 的 TUI 中，子代理只占 1 行状态条，不干扰阅读主线对话
2. **可切入**：用户有明确的交互方式切换到子代理详情视图，查看实时进度
3. **可回溯**：子代理的完整执行记录持久化到磁盘，支持 resume 后检查

---

### 一、数据模型：子代理持久化记录

新增 `SubagentRecord` 类型，保存在会话目录的 `subagents/` 子目录下：

```
~/.deepseek-arch/sessions/<session-id>/
├── meta.json
├── turns.json
├── system-prompt.txt
└── subagents/                    ← 新增
    ├── _index.json               ← 索引文件：所有子代理概要
    ├── research.json             ← 子代理 "research" 的完整记录
    ├── codegen.json
    └── lint.json
```

**`_index.json`**（快速枚举，不需要加载全量子代理文件）：

```typescript
interface SubagentIndex {
  entries: SubagentSummary[];
}

interface SubagentSummary {
  name: string;             // "research"
  status: 'running' | 'completed' | 'failed';
  task: string;             // 模型下达的原始任务（截断到 200 字符）
  spawned_at: string;       // ISO timestamp
  completed_at?: string;
  duration_ms?: number;
  /** 结果摘要：模型返回的最终文本前 200 字符 */
  result_summary?: string;
  /** 对应的主 turn 编号（哪个 turn 里 spawn 的） */
  turn: number;
}
```

**`<name>.json`**（单个子代理的完整记录）：

```typescript
interface SubagentRecord {
  name: string;
  task: string;
  spawned_at: string;
  completed_at?: string;
  status: 'running' | 'completed' | 'failed';
  /** 子代理内部每轮的消息（含 tool_calls、tool results） */
  messages: Message[];
  /** 最终输出 */
  result?: string;
  /** 子代理内各轮 token 用量 */
  round_usage?: RoundUsage[];
  /** 总 token 用量 */
  total_usage?: TokenUsage;
  /** 对应的主 turn 编号 */
  turn: number;
}
```

**Storage 新增方法**：

```typescript
class Storage {
  // ... existing ...

  subagentDir(sessionId: string): string
  async saveSubagentIndex(sessionId: string, index: SubagentIndex): Promise<void>
  async loadSubagentIndex(sessionId: string): Promise<SubagentIndex | null>
  async saveSubagentRecord(sessionId: string, record: SubagentRecord): Promise<void>
  async loadSubagentRecord(sessionId: string, name: string): Promise<SubagentRecord | null>
}
```

#### 写入时机

- **spawn 时**：写入 `_index.json`（status: running），创建 `<name>.json`（初始 stub，含 task + messages 开头）
- **子代理每轮完成时**：增量写入 `<name>.json`（追加新的 messages / round_usage）
- **子代理结束时**：更新 `_index.json`（status → completed/failed，填 completed_at 等），更新 `<name>.json`

这样即使主进程崩溃，已完成的子代理执行记录也不会丢失。

---

### 二、StreamEvent 扩展：子代理生命周期事件

新增三种事件类型，让 TUI 层获得子代理的专门信息，不再依赖通用 `tool_result`：

```typescript
// 在 StreamEvent.type 联合中新增：
| 'subagent_spawn'     // 子代理已启动
| 'subagent_progress'  // 子代理内部实时输出行
| 'subagent_done'      // 子代理执行完毕
```

**`subagent_spawn`**：
```typescript
{
  type: 'subagent_spawn';
  subagentName: string;      // "research"
  task: string;               // 模型原始任务（截断100字符）
  mode: 'async' | 'sync';     // 异步还是同步
}
```

**`subagent_progress`**：
```typescript
{
  type: 'subagent_progress';
  subagentName: string;
  outputLine: string;         // 一行输出
  stream: 'stdout' | 'stderr';
  /** 子代理内部轮次 */
  round: number;
}
```

**`subagent_done`**：
```typescript
{
  type: 'subagent_done';
  subagentName: string;
  status: 'completed' | 'failed';
  durationMs: number;
  resultSummary?: string;     // 前 200 字符
}
```

`tool_result` 事件仍然触发（因为 agent loop 要把结果回传给模型），但 TUI 层可以根据 `toolName === 'subagent_spawn'` 或 `'wait'` 来决定不重复渲染——改用上面的专用事件渲染。

---

### 三、TUI 渲染设计

#### 3.1 默认紧凑模式（Default Compact Mode）

子代理在主 TUI 中只占**一行**，用 ANSI 颜色/符号标识状态：

```
（主 Agent 流式输出...）

⏳ research  正在执行 (45s)
✅ codegen   已完成 (1m12s) → wait 获取结果
❌ lint      失败 (23s) → wait 获取错误详情
⏳ tests     正在执行 (5s)

（主 Agent 调用 wait("codegen")，得到结果继续输出...）
```

**状态更新方式**：
- `subagent_spawn` 事件 → 写入一行 `⏳ <name> 正在执行 (0s)`，进入 scrollback
- 状态更新不新建行，而是**原地覆盖最后一行**（用 `\r` + `\x1b[K` 清除，重新写入）
- 多个子代理时，使用多行动态刷新（类似 `docker-compose` 的日志风格）
- 主 Agent 有其他输出（content_delta）时，先"锁定"当前子代理状态行（不再覆盖），然后正常输出主 Agent 内容，再重新画状态行

**关键设计决策：状态行的位置**。两种方案：


| 方案 | 描述 | 体验 |
| :--- | :--- | :--- |
| **底部状态栏** | 在输入框下方固定一行，显示子代理状态 | 不干扰 scrollback，但无 alternate screen 不好实现 |
| **"浮动"到 scrollback 末尾** | 状态行在最新输出的末尾，每次更新原地覆盖 | 实现简单，用户 scrollback 中能看到状态变化历史 |

考虑到当前 TUI 不使用 alternate screen，建议用**浮动方案**：状态行在 scrollback 末尾动态刷新。主 Agent 有输出时，把当前状态行"固化"（不再覆盖）→ 输出新内容 → 重新画新状态行。

#### 3.2 详情切换模式（Detail Toggle）

用户通过按键或命令切换详情视图：

**触发方式**：
- `/subagent [name]`：展开指定子代理的详情（如果省略 name，列出所有子代理供选择）
- `Ctrl+T`：循环切换焦点子代理（无焦点 → research → codegen → lint → 无焦点）

**详情模式下的渲染**（以 `/subagent research` 为例）：

```
──────────────────────────────────────────────────
 子代理: research    状态: ⏳ 正在执行 (2m05s)    第 3/25 轮
 任务: 查找所有使用 deprecated API 的调用点，列出文件路径和行号
──────────────────────────────────────────────────
 │ Found 15 files matching pattern...
 │ src/old-module.ts:42: deprecatedMethod()
 │ src/legacy.ts:18: deprecatedMethod()
 │ ...
──────────────────────────────────────────────────
 [按 Ctrl+T 切换子代理 | /subagent 退出详情]
──────────────────────────────────────────────────
```

这个详情区域**也是写入 scrollback**，用分隔线和 dim 颜色区分于主对话。如果子代理正在运行，新输出会持续追加。如果子代理已完成，就是静态的历史回放。

**实现方式**：
- `TuiApp` 新增 `detailSubagent: string | null` 状态
- 当 `detailSubagent` 非 null 时，`subagent_progress` 事件直接渲染到 scrollback（像主 Agent 的 `tool_output` 一样）
- 当 `detailSubagent` 为 null 时，`subagent_progress` 事件被抑制（只更新紧凑状态行）

#### 3.3 终止后的持久化检查

用户退出 `deepseek-arch chat` 后，可以通过以下方式检查子代理记录：

```bash
# 方式一：直接读 JSON
cat ~/.deepseek-arch/sessions/<id>/subagents/research.json | jq .

# 方式二：resume 后使用命令
deepseek-arch resume <id>
# 进入 chat 后：
/subagent research    # 展开该子代理的完整执行历史
```

---

### 四、实现路线

#### Phase 1：持久化（2-3 个文件改动）

1. `src/types/session.ts` 或新文件 `src/types/subagent.ts`：定义 `SubagentIndex`、`SubagentSummary`、`SubagentRecord`
2. `src/core/storage.ts`：新增 `subagentDir`、`saveSubagentIndex`、`loadSubagentIndex`、`saveSubagentRecord`、`loadSubagentRecord`
3. `src/core/session.ts`：在 `interceptSubagentTool` 的 spawn/wait 路径中调用持久化。spawn 时写初始记录，每个 round 结束时增量保存。

**这个阶段不改变任何 TUI 行为**，用户无感知，但数据开始在磁盘上累积。

#### Phase 2：StreamEvent 扩展（2 个文件改动）

1. `src/types/chat.ts`：`StreamEvent.type` 联合新增 `'subagent_spawn' | 'subagent_progress' | 'subagent_done'` 及对应字段
2. `src/core/session.ts`：在子代理相关路径发射新事件
3. `runSubagentLoop`（`src/core/subagent.ts`）：接受 `onProgress` 回调，子代理内 shell 工具执行时通过回调输出

**这个阶段 TUI 还不消费新事件**，但事件管道已就绪。

#### Phase 3：TUI 紧凑模式（1 个文件改动）

1. `src/cli/tui/app.ts`：
   - `sendMessageStream` 的 switch 新增 `subagent_spawn` / `subagent_done` 分支
   - 维护 `subagentStatuses: Map<string, {status, startMs}>`
   - 在 scrollback 末尾渲染紧凑状态行（原地刷新）
   - `subagent_progress` 在紧凑模式下被抑制

**效果**：子代理 spawn 后，用户看到 `⏳ research 正在执行` 并在原地刷新秒数。

#### Phase 4：TUI 详情切换（1-2 个文件改动）

1. `src/cli/tui/app.ts`：
   - 新增 `detailSubagent` 状态 + `/subagent` 命令 + `Ctrl+T` 快捷键
   - 详情模式下 `subagent_progress` 渲染到 scrollback
   - 详情模式下用分隔线框定子代理输出区域

---

### 五、渲染效果示意

假设一个场景：主 Agent spawn 了 3 个子代理并行工作，用户在异步模式下观察。

**默认紧凑模式**（实际终端效果）：

```
deepseek-arch v1.3.5  |  Provider: deepseek  |  Model: deepseek-v4-pro
Session: a1b2c3d4...  |  Turns: 2
────────────────────────────────────────────────────────
[You] 帮我重构 src/ 下所有文件的 import 路径

（模型思考中...）
好的，我先并行启动几个子代理来摸底。

  ⏳ scanner 正在扫描文件结构 (3s)
  ⏳ analyzer 分析依赖图 (2s)
  ⏳ linter 检查当前 lint 状态 (1s)

（模型调用 list_subagents 确认状态...）

  ✅ scanner 已完成 (12s) → wait 获取
  ⏳ analyzer 正在分析依赖图 (11s)
  ❌ linter 失败 (5s) → wait 获取错误

（模型调用 wait("scanner") 获取结果...）

找到 47 个 .ts 文件，其中 23 个有 import 语句...

  ⏳ analyzer 正在分析依赖图 (18s)

（模型调用 wait("analyzer") 获取结果...）
...
```

**用户按 Ctrl+T 切换到 analyzer 详情**：

```
（主对话内容在上方...）

──────────────────────────────────────────────────
 子代理: analyzer    状态: ⏳ 正在执行 (18s)     第 2/25 轮
 任务: 分析 src/ 下所有 TypeScript 文件的 import 依赖图，输出循环依赖和可合并的路径...
──────────────────────────────────────────────────
 │ Reading src/core/session.ts... (1054 lines)
 │ Reading src/cli/tui/app.ts... (933 lines)
 │ Reading src/tools/edit-file.ts... (312 lines)
 │ Found dependency: session.ts → storage.ts
 │ Found dependency: session.ts → subagent.ts
 │ ...
──────────────────────────────────────────────────
 [Ctrl+T: 下一个子代理 | Esc: 退出详情]
──────────────────────────────────────────────────
```

---

### 总结

| 维度 | 现状 | 提案后 |
| :--- | :--- | :--- |
| 默认视觉占用 | 和 shell 工具一样，显示 args + 12行结果 | **1 行紧凑状态条**，不干扰阅读主线 |
| 切换查看进度 | 没有切换机制 | **`/subagent <name>` 或 `Ctrl+T`** 展开详情 |
| 实时进度可见 | 完全没有（内部 shell 输出不可见） | 详情模式下实时流式输出 |
| 事后检查 | 只能看 turns.json 的 tool_call 记录 | **完整 `subagents/<name>.json`**，含每轮消息和 token 用量 |
| 崩溃恢复 | 子代理状态全在内存，丢失 | spawn 时立即写磁盘，增量更新 |

这个设计**不引入 alternate screen、不破坏 scrollback 范式、不需要终端模拟器特殊支持**。所有新增渲染都是向 scrollback 写 ANSI 文本。唯一的小技巧是紧凑状态行的原地刷新（`\r` + `\x1b[K`），这已经在当前 TUI 的输入编辑器中有成熟实现。