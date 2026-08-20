# Master Agent 向 Subagent 追加指令 — 可行性调研

> 状态：**调研稿（未实现）**
> 日期：2026-08-20
> 分支：feat/api-config-and-docs-sync（仅文档，无代码）
> 目标：评估"master agent 在 subagent 返回消息后继续给 subagent 发送进一步指令"的可实现性，输出方案与分阶段实施路径。

---

## 一、现状分析

### 1.1 当前子代理生命周期（代码证据）

```
subagent_spawn(name, task)
      │
      ▼
runSubagent(name, task)  [session.ts:261]
      │
      ├─► subagentStore.start(name, task)
      ├─► runSubagentLoop(task, provider, tools, prompt, signal, callbacks)  [subagent.ts:31]
      │     │
      │     ├─► messages = [system, user(task)]   ← 函数内局部变量，结束后丢弃
      │     ├─► while(true):
      │     │     ├─► chatStream(messages) → 累积 thinking/content/tool_calls
      │     │     ├─► 无 tool_calls → return finalContent   ← 子代理"完成"，循环结束
      │     │     └─► 有 tool_calls → 执行工具 → 结果 push messages → 继续
      │     └─► 返回最终文本
      │
      ├─► subagentStore.finish(name, result, status)   [session.ts:294]
      └─► storage.saveSubagentRecord(...)              [session.ts:304]
```

### 1.2 关键限制（代码证据）

| 限制 | 证据 | 后果 |
|---|---|---|
| **消息上下文是函数局部变量** | subagent.ts:52-55 `const messages: Message[]` 在 runSubagentLoop 内，return 即 GC | 子代理完成后无法继续对话——上下文已丢失 |
| **PendingSubagent 不存消息** | session.ts:69-75 只存 promise/status/result/startMs/toolCallId | 即使保留 Promise，也无法向已结束的循环注入新消息 |
| **wait 一次性取结果** | session.ts:673-680 取过即标记 retrieved，再取报错 | 结果只读，无后续交互通道 |
| **SubagentRecord 只存 entries** | types/subagent.ts:41 `entries: SubagentRoundEntry[]`（输出流，非 messages） | 磁盘持久化不含完整对话上下文，resume 后无法续谈 |
| **subagent 无轮次上限** | subagent.ts:31 注释"无轮次上限"（已移除 MAX_ROUNDS=25） | 单个循环可长，但仍是"一次性" |
| **SubagentStore 不存消息** | subagent-store.ts:16-26 只有 entries | 同上 |

### 1.3 用户需求

> "master agent 能够在 subagent 返回消息之后继续给 subagent 发送进一步指令"

典型场景：
1. 子代理调研后返回结论，master 觉得不够深入 → 追加"再查 X、补充 Y"
2. 子代理完成代码生成，master 发现编译错误 → 追加"修复编译错误"
3. 子代理返回部分结果，master 需要它继续推进下一步

---

## 二、方案设计

### 方案 A：可恢复循环 + subagent_send 工具（推荐）

**核心思路**：把 runSubagentLoop 从"一次性函数"改造为"可恢复会话"——消息上下文保留在 SessionManager 层，新增 `subagent_send(name, instruction)` 工具向已完成的子代理追加指令并重新驱动循环。

```
subagent_spawn(name, task)
      │
      ▼
PendingSubagent 扩展：
  { promise, status, result, startMs, messages: Message[] }   ← 新增 messages
      │
      ▼
runSubagentLoop 重构：支持"消息续跑"
  async function runSubagentLoop(messages, provider, tools, prompt, signal, callbacks)
  // 不再是 (task, ...) 一次性入口，而是接收完整消息队列
  // 返回 { result, messages } — messages 保留供后续续跑
      │
      ▼
subagent_send(name, instruction):
  1. 从 pendingSubagents.get(name) 取 messages
  2. messages.push({ role: 'user', content: instruction })
  3. 重新驱动 runSubagentLoop(messages, ...) → 返回新 result
  4. 更新 status → running → completed；SubagentStore 追加轮次
```

**核心改动**：

| 文件 | 改动 | 复杂度 |
|---|---|---|
| `src/core/subagent.ts` | runSubagentLoop 签名改为 `(messages, ...)`，返回 `{ result, messages }`；保留现有行为（task 包装成 messages） | 中 |
| `src/core/session.ts` | PendingSubagent 加 `messages: Message[]`；runSubagent 传 messages 引用；interceptSubagentTool 增加 `subagent_send` 分支 | 中 |
| `src/tools/subagent-send.ts` | 新工具定义（name/description/parameters + fallback execute） | 低 |
| `src/tools/index.ts` | ALL_TOOLS 注册 subagentSendTool | 低 |
| `src/types/subagent.ts` | SubagentRecord 增加可选 `messages?: Message[]`（持久化上下文） | 低 |
| `src/core/subagent-store.ts` | 可选：push 支持追加 messages 记录 | 低 |
| `src/core/storage.ts` | saveSubagentRecord 已存整个 record（含 messages 自动带上） | 低 |
| `src/presentation/tui-app.ts` | 详情视图渲染追加指令轮次（可选） | 低 |

**消息上下文所有权问题**：runSubagentLoop 的 messages 在循环内可变（push assistant/tool）。改造后 messages 由外部持有（SessionManager），循环每次运行时读取+修改。需注意并发——同一子代理同时被 send 两次？用 `subagent.status !== 'running'` 守卫：仅 completed/failed 状态可 send，send 后置 running。

**SubagentRecord.messages 持久化**：saveSubagentRecord 在 finish 时调用（session.ts:304），届时 record 含最终 messages；追加指令后再次 finish，messages 为最新——覆盖式保存即可（单文件）。

**TUI/compact 影响**：
- 详情视图：追加指令后子代理重新 running，entries 继续追加（SubagentRoundEntry 时间序天然支持）
- compact：SUMMARY_PROMPT 类别 4"工具调用与结果"已含"完整保留给 subagent 的指令和汇报"——追加指令同样应保留（实现时确认 serializeTurns 覆盖 subagent_send 的 tool_calls 记录）
- StreamEvent：subagent_send 走通用 tool_result 事件即可（像 wait 一样），无需新事件类型

### 方案 B：子代理会话化（全状态化）

**核心思路**：子代理升级为"会话对象"（类主会话），有独立 id、完整消息持久化、resume 能力；master 通过 `subagent_send` 或 `subagent_resume` 恢复。

```
SubagentSession {
  id, name, status, messages[], createdAt, updatedAt
  send(instruction) → 追加 user 消息 → 驱动循环
}
```

与方案 A 的区别：方案 B 要求子代理消息**全量持久化到磁盘**（每轮增量写），并支持**进程重启后 resume 子代理**——即 `deepseek-arch resume <id>` 后仍能继续向子代理发指令。

**代价**：subagent.ts 需要引入类似 SessionManager 的状态管理 + storage 增量写入；与主会话的存储格式（分代、messages 恒存）重复度高。**收益**：跨进程续谈。

**评估**：用户需求是"master agent 在 subagent 返回后继续发指令"——发生在**同一进程内**（agent loop 会话中），不需要跨进程。方案 B 的跨进程能力超出需求，工作量翻倍，**不建议本期采用**（列为未来增强）。

### 方案 C：简化模拟（不推荐）

**核心思路**：不改造循环，master 用 `subagent_spawn` 生成"新子代理"，在 task 中引用前一个子代理的结果摘要。

```
subagent_spawn("research-v2", "基于 research-v1 的结论：<摘要>，继续调研 X...")
```

**问题**：子代理 v2 从零开始（无 v1 的中间上下文、工具调用历史、文件状态），只能依赖摘要；本质是"重启"而非"追加指令"。**仅作为无代码改动的应急方案**，不满足"继续给 subagent 发送进一步指令"的语义。

---

## 三、方案 A 详细设计

### 3.1 runSubagentLoop 签名改造

```typescript
// 现状（subagent.ts:31-37）
export async function runSubagentLoop(
  task: string, provider, tools, systemPrompt, signal?, callbacks?, chatDefaults?,
): Promise<string>

// 改造后
export interface SubagentLoopResult {
  result: string;
  messages: Message[];   // 最终消息队列（含 system/user/assistant/tool 全部）
}

export async function runSubagentLoop(
  messages: Message[],          // 完整消息队列（外部持有，循环内 push）
  provider, tools, systemPrompt, signal?, callbacks?, chatDefaults?,
): Promise<SubagentLoopResult>
```

- 首启：`runSubagent(name, task)` 构造 `[system, user(task)]` 传入
- 续跑：`subagent_send` 取 `pending.messages`，push `user(instruction)` 后重新调用

### 3.2 SessionManager 状态扩展（session.ts:69-75）

```typescript
interface PendingSubagent {
  toolCallId: string;
  promise: Promise<string>;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  startMs: number;
  messages: Message[];   // ← 新增：子代理消息上下文（跨 send 保留）
}
```

- `runSubagent()` 创建时初始化 `messages: [system, user(task)]`，传给 runSubagentLoop 的**引用**（循环内 push 即更新 pending.messages）
- 完成后 pending.messages 保留（不清理）；wait 取结果不销毁 pending 条目（现状也不销毁，只标记 retrieved）

### 3.3 subagent_send 拦截逻辑（interceptSubagentTool 新增 case）

```typescript
case 'subagent_send': {
  const name = args.subagent_name as string;
  const instruction = args.instruction as string;
  // 校验存在 + 非 running + 有 messages
  const sub = this.pendingSubagents.get(name);
  if (!sub) return error('not_found');
  if (sub.status === 'running') return error('still_running', '子代理正在执行，等待其完成后再发指令');
  if (!sub.messages || sub.messages.length === 0) return error('no_context', '子代理上下文不可用');

  // 追加指令并续跑
  sub.status = 'running';
  sub.messages.push({ role: 'user', content: instruction });
  const promise = (async () => {
    const { result, messages } = await runSubagentLoop(
      sub.messages, provider, tools, prompt, signal, callbacks, chatDefaults,
    );
    sub.result = result;
    sub.status = ...;  // cancelled/failed/completed
    return result;
  })();
  sub.promise = promise;
  // 同步等待（subagent_send 是同步语义，master 需要结果才能继续）
  const result = await promise;
  pushResult(`Subagent "${name}" follow-up result:\n\n${result}`);
  return true;
}
```

**同步 vs 异步**：`subagent_send` 应**同步等待**（master 发指令后需要结果才能规划下一步）——与 wait 语义一致。异步模式下是否也同步？建议**始终同步**（追加指令是"追问"性质，不是"并行启动"）。

### 3.4 subagent_send 工具定义（src/tools/subagent-send.ts）

```typescript
export const subagentSendTool: Tool = {
  name: 'subagent_send',
  description:
    'Send a follow-up instruction to a completed subagent and get its new result. ' +
    'The subagent resumes with its full previous context (messages preserved), ' +
    'then continues working on the new instruction. Use when a subagent result ' +
    'needs refinement, extension, or fixes. Only works on completed/failed subagents.',
  parameters: {
    type: 'object',
    properties: {
      subagent_name: { type: 'string', description: 'Name of the completed subagent' },
      instruction: { type: 'string', description: 'Follow-up instruction (be specific)' },
    },
    required: ['subagent_name', 'instruction'],
  },
  requiresConfirm: false,
  async execute(params): Promise<ToolResult> { /* fallback: 需在 agent loop 内拦截 */ },
};
```

### 3.5 状态流转

```
spawn → running → completed ──subagent_send──► running → completed
                    └──failed──┐
                               └──subagent_send──► running → completed（可反复）
                    └──cancelled──┘  ← cancelled 后禁止 send（上下文已中止）
```

---

## 四、影响面分析（方案 A）

### 4.1 代码

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/core/subagent.ts` | 重构 | runSubagentLoop 签名 + 返回 SubagentLoopResult |
| `src/core/session.ts` | 核心 | PendingSubagent.messages、interceptSubagentTool 新 case、runSubagent 传引用 |
| `src/tools/subagent-send.ts` | 新文件 | 工具定义 |
| `src/tools/index.ts` | 注册 | ALL_TOOLS 添加 subagentSendTool（**SUBAGENT_TOOLS 不添加**——子代理不能给自己发指令） |
| `src/types/subagent.ts` | 类型 | SubagentRecord.messages?（可选） |
| `src/presentation/tui-app.ts` | UI | 详情视图：send 后子代理重新 running，entries 继续追加（SubagentRoundEntry 时间序已支持，改动很小） |

### 4.2 prompt

| Prompt | 改动 |
|---|---|
| `session.ts` SUBAGENT_APPEND_PROMPT（:55-66） | 增加："You may receive follow-up instructions after reporting a result. When given a follow-up, continue from your previous context — do not restart the task from scratch." |
| subagent_spawn 工具描述 | 补充："The subagent's context is preserved after completion — you can send follow-up instructions with subagent_send." |
| system_prompt.txt | 可选：工具选择策略提及 subagent_send（任务描述"模型可见"层面） |

### 4.3 compact

- 摘要类别 4"工具调用与结果"已要求"完整保留给 subagent 的指令和汇报"——subagent_send 是 master 对子代理的追加指令，serializeTurns 遍历 tool_calls 记录时会包含（tcr.name === 'subagent_send'），无需专门改动
- 但**注意**：subagent 自身上下文不在主会话 turns 中（存 subagents/ 目录），compact 压缩的是主会话——子代理的完整过程记录在 subagents/<name>.json 可回查，不受 compact 影响 ✓

### 4.4 测试

| 测试 | 内容 |
|---|---|
| `tests/core/subagent.test.ts` | runSubagentLoop 新签名：messages 传入、返回 { result, messages }、续跑后 messages 追加 |
| `tests/core/session.test.ts` | subagent_send 拦截：completed 可 send、running 拒绝、不存在报错、取消后禁止 |
| `tests/tools/`（新） | subagent-send 工具定义参数校验 |

### 4.5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 子代理消息上下文无限增长（多次 send） | 子代理自身无 compact——限制：subagent_send 前检查 messages token 估算（复用 estimateTokens，>100k 提示先 wait 取结果或 spawn 新子代理） |
| 并发 send（两次同时） | status==='running' 守卫：send 时若 running 直接报错 |
| 取消后 send | cancelled 状态禁止 send（返回错误） |
| 与 wait 的 retrieved 语义冲突 | send 不改变 retrieved 标记；send 后的新结果需再次 wait 获取？——**设计决策**：send 返回新结果（同步），retrieved 标记不清除（旧结果已取过）；若用户想再取旧结果会报 already_retrieved，可接受 |
| runSubagentLoop 内 AbortError | 续跑同样受 signal 控制（复用 controller）；send 时子代理的 controller 复用或新建？——**建议复用**（pending 有独立 controller，见 session.ts:267-269） |

---

## 五、分阶段实施路径

| 阶段 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| **P1 循环改造** | runSubagentLoop 签名改 messages + 返回 SubagentLoopResult；runSubagent 适配；**行为不变**（回归测试通过） | 🟡 中 | 现有 subagent 测试全绿 |
| **P2 send 工具** | subagent-send.ts + 注册 + PendingSubagent.messages + intercept case；同步等待 | 🟡 中 | 手动/单测：spawn → wait → send → 得到新结果 |
| **P3 持久化** | SubagentRecord.messages? + saveSubagentRecord 覆盖保存 | 🟢 小 | resume 后 /subagent 详情含追加轮次 |
| **P4 增强** | 上下文增长限制（token 估算）、SUBAGENT_APPEND_PROMPT 提示、TUI 详情优化、测试补全 | 🟢 小 | 全量测试通过 |

建议顺序：P1 → P2（先跑通闭环）→ P3 → P4。P1 是纯重构（行为不变），风险最低；P2 是核心功能。

---

## 六、结论

- **可行，且改动可控**：核心是 runSubagentLoop 从"一次性"改为"可恢复"，让 messages 所有权从函数内上移到 SessionManager
- **推荐方案 A**（可恢复循环 + subagent_send），工作量约 1 个中规模功能（3-5 个文件 + 测试），不涉及存储格式迁移
- **不做方案 B**（跨进程会话化）——超出当前需求，列为未来增强
- **不做方案 C**（spawn 新子代理模拟）——不满足语义
- 与 goal 工具（docs/goal-tool-design.md）无冲突：goal 影响 master 与子代理的方向，subagent_send 是执行层交互通道，可独立实施
