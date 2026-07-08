# SubAgent 系统设计

## 总览

主 Agent 可通过 `subagent_spawn` 工具委派子任务给独立子代理。子代理有独立消息上下文、受限工具集（无 spawn/plan/save_plan）。

支持两种模式：

| 模式 | 切换方式 | spawn 后 | 模型何时看到结果 |
|------|---------|----------|----------------|
| **非异步** (默认) | `/async off` | Agent Loop 等 **全部** subagent 完成 | 全部完成后一起返回 |
| **异步** | `/async on` | 立刻返回 `[SPAWNED]`，不等 | 通过 `wait` 主动获取 |

两种模式下 subagent 之间始终并行执行（`Promise.all`）。

---

## 工具接口

### 1. `subagent_spawn` — 委派子任务

```
name: subagent_spawn
parameters:
  subagent_name  string (required) — 唯一名称，用于后续 wait/list_subagents 引用
  task           string (required) — 详细任务描述（含期望输出格式、约束条件）
```

**返回值**：

- 非异步：等待完成后返回 `"Subagent '<name>' result:\n\n{result}"`（直接给模型看）
- 异步：立刻返回 `"[SPAWNED] subagent '<name>' spawned — use wait('<name>') to retrieve result when ready"`

**模型约束**（写入 tool description）：
- `subagent_name` 必须唯一，不与任何同名 running 或 completed-but-unretrieved subagent 冲突
- task 必须自包含：子代理无法反问用户，需要给出完成所需的一切信息
- 子代理不能 spawn 其自己的子代理

### 2. `wait` — 等待/获取 subagent 结果

```
name: wait
parameters:
  subagent_name  string (required) — 要等待的 subagent 名称
```

**行为**：

| 场景 | 行为 |
|------|------|
| subagent 正在运行 | **阻塞**当前 Agent Loop 轮次，等该 subagent 完成后返回结果 |
| subagent 已完成，结果已获取 | 返回 `"Subagent '<name>' result was already retrieved. Use list_subagents to check status."` |
| subagent 已完成，结果未获取 | 立刻返回结果（无阻塞） |
| subagent 不存在 | 返回 `"Error: no subagent named '<name>'. Use list_subagents to see all subagents."` |

**返回值**：`"Subagent '<name>' result:\n\n{result}"`

**阻塞语义**：`wait` 只阻塞当前轮次的 tool 执行，不阻塞 Agent Loop 整体。Agent Loop 在等待期间其他 subagent 继续并行运行。wait 返回后，模型在下一轮继续推理。

> **为什么 wait 只等「指定」而非「任意」一个**：模型决定依赖关系。如果模型需要 B 的结果才能继续，它应该 `wait("B")`。如果模型只需要"先完成的结果"，它可以用 `list_subagents` 查看谁完成了，再 `wait` 那个。

### 3. `list_subagents` — 列出所有 subagent

```
name: list_subagents
parameters: (none)
```

**返回值**：

```
[Subagent Status]
- "research_pkgbuild"  (running, 2m 30s)
- "check_deps"         (completed, 45s) — result available, use wait("check_deps")
- "write_test"         (running, 15s)
- "parse_config"       (failed, 12s)    — error: "Connection refused"
```

状态枚举：`running` | `completed` | `failed`

---

## 异步模式下的消息上下文设计

### 核心原则：`[PENDING]` 消息不可变

> **kv cache 命中的前提是前缀消息完全一致。** 任何对中间消息的修改（包括替换 `[PENDING]` 为真实结果）都会导致后续 API 调用 cache miss。

因此：Agent Loop 中代表 subagent_spawn tool result 的消息**永远是 `[SPAWNED]`**，永不更改。

### 每轮 API 调用构建的 messages

每轮 Agent Loop 调用模型前，构造 messages 如下：

```
[
  { role: "system", content: "<system prompt>" },
  { role: "user",   content: "<用户本轮输入>" },
  ...                                                                     ← baseMessages（不变）

  ... agentMessages ...                                                   ← 每轮追加

  // ★ 状态注入块（如果异步模式且有 subagent 记录，始终追加到最后）
  { role: "user", content: "<status block>" }
]
```

### 状态注入块格式

```
[Subagent Status — async mode]
- "research_pkgbuild"  (running, 2m 30s)
- "check_deps"         (completed, 45s) — use wait("check_deps")
```

**注入规则**：
1. 异步模式下，**每轮**都注入状态块到 messages 末尾
2. 状态块作为 `role: "user"` 消息（因为它是系统级信息注入，不是 assistant 回复）
3. 状态块只列出「模型还不知道结果」的 subagent：
   - `running` → 始终列出
   - `completed` → 列出，直到模型调 `wait` 取走结果
   - `failed` → 列出，直到模型调 `wait` 取走结果
   - 模型已 `wait` 取走的结果 → 不再列出
4. 状态块是 messages 的最后一条 → 前缀全部不变 → kv cache 命中

### Agent Loop 中的消息管理

Agent Loop 维护两个集合：

```
pendingSubagents: Map<subagent_name, {
  toolCallId: string,
  promise: Promise<string>,
  status: 'running' | 'completed' | 'failed',
  result?: string,
  startMs: number,
}>

retrievedSubagents: Set<subagent_name>  // 模型已通过 wait 取走结果的
```

**每轮 Agent Loop 流程**（异步模式）：

```
1. injectCompletedSubagents():
   检查 pendingSubagents 中是否有刚完成的
   → 完成的不做任何消息注入（不修改 agentMessages！）
   → 只更新 status

2. buildStatusBlock():
   遍历 pendingSubagents:
     running → 加入状态块
     completed 且不在 retrievedSubagents → 加入状态块
   → 生成纯文本状态块

3. 构造 roundMessages = [...baseMessages, ...agentMessages, statusBlock]

4. 调用模型 → 得到 response

5. 模型无 tool_calls → 检查：
   - 有 running subagent → 不 break，等任意一个完成后再循环
   - 全部 subagent 已完成且都 retrieved → break（正常结束）
   - 全部 subagent 已完成但有未 retrieved → 不 break（模型还有事做）

6. 模型有 tool_calls → 执行：
   - subagent_spawn → 非阻塞，push [SPAWNED] 到 agentMessages，启动后台
   - wait → 阻塞等指定 subagent，完成则返回结果 + 标记 retrieved
   - list_subagents → 即时返回状态列表
   - 其他工具 → 正常同步执行
```

### wait 工具的执行

```
wait(subagent_name):
  sub = pendingSubagents.get(subagent_name)
  if !sub → return "Error: no subagent..."
  
  if sub.status === 'running' → await sub.promise（阻塞）
  // 此时 sub.status 已变成 'completed' 或 'failed'
  
  result = sub.result
  retrievedSubagents.add(subagent_name)
  return "Subagent '{name}' result:\n\n{result}"
```

**阻塞时**：Agent Loop 停在当前轮次的 tool 执行，但其他 subagent 仍在后台并行。wait 只阻塞这一个 tool call，不阻塞整个 loop。

---

## 非异步模式

```
/spawn 行为：
  1. 模型发多个 subagent_spawn(tool_call)
  2. Agent Loop 并行启动所有 subagent
  3. await Promise.all(全部 subagent)
  4. 全部完成后，把结果作为 tool messages 推入 agentMessages
  5. 模型在下一轮看到所有结果

wait 行为：
  - 已完成的 → 直接返回结果
  - 未完成 → 阻塞等（和非异步模式下 Promise.all 等效）
  - 无论如何不修改 agentMessages 中的 [SPAWNED] 消息

list_subagents 行为：
  - 返回所有 subagent 的状态（和异步模式相同）
```

---

## agentMessages 结构示例

### 异步模式

```
[
  { role: "assistant", content: "我来并行处理这些任务", tool_calls: [
    { id: "c1", function: { name: "subagent_spawn", arguments: '{"subagent_name":"research","task":"..."}' } },
    { id: "c2", function: { name: "subagent_spawn", arguments: '{"subagent_name":"codegen", "task":"..."}' } }
  ]},
  { role: "tool", tool_call_id: "c1", content: "[SPAWNED] subagent 'research' spawned..." },
  { role: "tool", tool_call_id: "c2", content: "[SPAWNED] subagent 'codegen' spawned..." },
  { role: "assistant", content: "subagent 启动了两个，让我查一下状态" },
  { role: "assistant", content: null, tool_calls: [
    { id: "c3", function: { name: "list_subagents", arguments: '{}' } }
  ]},
  { role: "tool", tool_call_id: "c3", content: "- \"research\" (running, 30s)\n- \"codegen\" (running, 30s)" },
  { role: "assistant", content: "两个都还在跑，我先等 research" },
  { role: "assistant", content: null, tool_calls: [
    { id: "c4", function: { name: "wait", arguments: '{"subagent_name":"research"}' } }
  ]},
  { role: "tool", tool_call_id: "c4", content: "Subagent 'research' result:\n\nPKGBUILD 规范要点: ..." },
  // ← wait 取走结果后，下轮状态块不再显示 research
]
```

### 非异步模式

```
[
  { role: "assistant", content: "并行处理", tool_calls: [
    { id: "c1", function: { name: "subagent_spawn", arguments: '{"subagent_name":"research","task":"..."}' } },
    { id: "c2", function: { name: "subagent_spawn", arguments: '{"subagent_name":"codegen", "task":"..."}' } }
  ]},
  // ★ 等全部完成
  { role: "tool", tool_call_id: "c1", content: "Subagent 'research' result:\n\n..." },
  { role: "tool", tool_call_id: "c2", content: "Subagent 'codegen' result:\n\n..." },
  // ★ 模型在下一轮看到两个结果
]
```

---

## KV Cache 安全分析

### 异步模式

| 轮次 | messages | kv cache |
|------|----------|----------|
| Round N | [...base, ...agentMsgs] | 全量计算 |
| Round N+1 | [...base, ...agentMsgs, status(N+1)] | agentMsgs 前缀不变 → 命中 ✓ |
| Round N+2 | [...base, ...agentMsgs, status(N+2)] | agentMsgs 前缀不变 → 命中 ✓ |
| wait 之后 | [...agentMsgs, tool(wait_result)] | agentMsgs 新增了一条 tool 消息 → 前缀匹配到 tool 之前 → 部分命中 ✓ |

**关键**：`agentMessages` 只追加，不修改；状态块一直在最后，永远是新的 → 不影响 cache。

### 非异步模式

| 轮次 | messages | kv cache |
|------|----------|----------|
| Round N | [...base, ...agentMsgs] | 全量计算 |
| Round N+1 | [...base, ...agentMsgs, tool(res1), tool(res2)] | agentMsgs 前缀不变 → 命中 ✓ |

非异步模式自然前缀安全。

---

## 文件清单

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/core/subagent.ts` | **新建** — 子代理循环引擎 `runSubagentLoop()` |
| 2 | `src/tools/subagent-spawn.ts` | **新建** — `subagent_spawn` 工具 + 懒注入 `SubagentRunner` |
| 3 | `src/tools/subagent-list.ts` | **新建** — `list_subagents` 工具 |
| 4 | `src/tools/subagent-wait.ts` | **新建** — `wait` 工具 |
| 5 | `src/tools/index.ts` | `getAllTools()` 支持过滤 + 注册新工具 |
| 6 | `src/core/session.ts` | `SessionManager` 加 `runSubagent()`、修改 Agent Loop（async/non-async 分支）、pendingSubagents 管理、状态块注入 |
| 7 | `src/cli/index.ts` | `/async` 命令、`SessionManager` 与 subagent runner 的 wiring |
| 8 | `src/types/chat.ts` | 新增 `StreamEvent` 类型（可选，subagent_start/end） |

---

## Phase 2.5 — 自检

| 原则 | 符合？ | 说明 |
|------|--------|------|
| 可独立验证 | 是 | 测试：spawn + wait + list_subagents 完整流程；kv cache：验证 agentMessages 只追加 |
| 自动化验收 | 是 | `npm test` + `npm run build` |
| 依赖显式 | 是 | 依赖 `ModelProvider`（已有）、`Tool` 接口（已有） |
| kv cache 安全 | 是 | agentMessages 只追加、不修改；状态块始终在末尾新增 |
| 最小可行 | 是 | 3 个新工具 + 1 个核心模块 + Agent Loop 改动 |
