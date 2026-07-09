---

## 审查结果：plan/remove-agent-loop-limit.md 实现检查

我对照计划文件和实际代码，发现以下设计偏差和 bug：

---

### 🐛 Bug 1（严重）：非异步模式下子代理顺序执行而非并行

**计划要求**（第 196-199 行）：
```
/spawn 行为：
  1. 模型发多个 subagent_spawn(tool_call)
  2. Agent Loop 并行启动所有 subagent
  3. await Promise.all(全部 subagent)
  4. 全部完成后，把结果作为 tool messages 推入 agentMessages
```

**实际代码**（`src/core/session.ts` 第 367-417 行）——子代理被**逐个 await**，顺序执行：

```typescript
case 'subagent_spawn': {
    const promise = launch(task).then((r) => { ... });
    pending.set(name, { ... });
    if (async) {
        pushResult(`[SPAWNED] ...`); // 异步模式不阻塞
    } else {
        const result = await promise; // ← 阻塞等当前子代理完成，下一个才启动
        pushResult(`Subagent "${name}" completed.\n\n${result}`);
    }
}
```

代理每次 spawn 都在 `for` 循环的单次迭代中 `await promise`。如果模型一轮 spawn 了 3 个子代理，**第二个要等第一个完成后才开始**（因为 promise 是在 intercept 函数内部创建并立即 await 的），而不是计划要求的 `Promise.all` 完全并行。

**修复方案**：两阶段处理——先遍历 tool_calls 创建所有 pending 条目（不 await），再用 `Promise.all` 统一等全部完成。

---

### 🐛 Bug 2（严重）：异步模式下每轮缺少状态注入块

**计划要求**（第 103-124 行）：
```
每轮构造 roundMessages = [...baseMessages, ...agentMessages, statusBlock]

状态注入块格式：
[Subagent Status — async mode]
- "research_pkgbuild"  (running, 2m 30s)
- "check_deps"         (completed, 45s) — use wait("check_deps")
```

**实际代码**（`src/core/session.ts` 第 489 行）：
```typescript
const roundMessages = [...baseMessages, ...agentMessages];
// ↑ 完全没拼接 statusBlock！
```

模型在 async mode 下每轮 API 调用**收不到任何子代理状态信息**，无法知道哪些子代理还在跑、哪些已完成、哪些失败了。唯一的状态信息是一个静态的通用提醒（第 566-568 行），且只在模型无 tool_calls 时才注入。

**影响**：异步模式下模型无法做出明智的调度决策（"我应该 wait 哪个？"。它必须靠记忆或主动调用 `list_subagents`，增加了不必要的 API 轮次。

---

### ⚠️ Bug 3（KV-cache 相关）：提醒消息推入 agentMessages 而非作为末尾动态块

**计划要求**：
- 状态块**不写入 agentMessages**，保持 `agentMessages` 前缀不变
- 每轮重新构建状态块拼到 `roundMessages` 末尾 → 不影响 kv cache

**实际代码**（第 566-568 行）：
```typescript
agentMessages.push({
    role: 'user',
    content: '[system] You have pending subagents...',
});
```

静态提醒文本本身不会导致 cache miss（因为每次相同），但这不是计划设计的动态状态块。更重要的是，`agentMessages` 被修改后，下一轮的 `roundMessages` 末尾不是状态块，而是一个旧的提醒消息——**模型在下一轮看不到更新的状态**。

---

### 🐛 Bug 4（死代码/误导性逻辑）：MAX_AGENT_ROUNDS 未使用 + 误导性注释

**`src/core/session.ts` 第 41 行**：
```typescript
const MAX_AGENT_ROUNDS = 25;  // 已定义但从未被使用！
```

**第 488 行**（循环条件）：
```typescript
for (let round = 0; !userDenied; round++) {
```
没有 `MAX_AGENT_ROUNDS` 检查。理论上模型可以无限循环（只要不断返回 tool_calls）。

**第 802-811 行**（循环外截断逻辑）：
```typescript
// 达到最大轮次上限：注入截断消息到 agentMessages 以保证序列完整
if (!userDenied && !finalContent && toolRecords.length > 0) {
    const truncMsg = '(Reached max tool rounds — stopping.)';
    ...
}
```
注释说"达到最大轮次上限"，但**实际上从未检查任何轮次上限**。这行代码根本不会触发——因为如果模型一直返回 tool_calls，`userDenied` 为 false，`finalContent` 会为空字符串（因为模型只产生 tool_calls 无 content），变量到达时就是上面的值——但之前的循环实际上是 for 循环，除非被人为 break 否则不会跳出。所以这段逻辑只有在循环通过某种方式跳出时才会运行。实际上循环只会在`userDenied=true`或`pendingToolCalls.length===0`（无 tool_calls 时 break）时终止，所以`toolRecords.length > 0`意味着至少有一轮有 tool_calls，但循环已经结束了——所以这个条件几乎永远不会触发。

**建议**：要么删除 `MAX_AGENT_ROUNDS` 常量，要么加回上限检查。

---

### 📋 Bug 5：缺少 subagent_start/end StreamEvent 类型

**计划文件清单第 8 项**：
> `src/types/chat.ts` — 新增 `StreamEvent` 类型（可选，subagent_start/end）

**实际 `StreamEvent` 类型**（`src/types/chat.ts` 第 84-116 行）—— 没有 `subagent_start`、`subagent_end`、`subagent_status` 等与子代理相关的事件类型。

虽然计划标注为"可选"，但缺少这些事件意味着 TUI 无法展示子代理的启动/完成状态。

---

### 📋 Bug 6：缺少子代理功能的测试

**计划 2.5 自检**：
> 可独立验证：测试 spawn + wait + list_subagents 完整流程

**实际测试**（`tests/core/session.test.ts`，471 行）：
- 没有任何 subagent/spawn/wait/list_subagents 相关的测试用例
- 没有任何测试验证 async/non-async 模式行为

---

### ⚠️ Bug 7（潜在）：异步模式下无 tool_calls 时的循环行为

当 asyncMode 开启、有 pending subagents、模型返回无 tool_calls 的纯文本回复时（第 546-573 行）：

```typescript
if (asyncMode && pendingSubagents.size > 0) {
    const hasIncomplete = ...;
    const hasUnretrieved = ...;
    if (hasIncomplete || hasUnretrieved) {
        agentMessages.push({
            role: 'user',
            content: '[system] You have pending subagents...',
        });
        continue; // ← 重新进入循环
    }
}
```

这里 `continue` 后重新进入 `for` 循环，但**没有检查 `MAX_AGENT_ROUNDS`**（因为循环条件没有上限）。如果模型持续回复纯文本（不调用工具），子代理一直没完成，这就是一个**潜在的死循环**。

---

### ✅ 正确实现的部分

1. **`subagent-spawn.ts` / `subagent-wait.ts` / `subagent-list.ts` 的 fallback 实现**：各自导出正确的 Tool 对象，描述清晰，参数完整，fallback 行为合理

2. **`subagent.ts` 子代理引擎**：独立消息上下文 + 受限工具集 + round 上限（25 轮），实现正确

3. **工具集过滤 `getAllTools()`**：`SUBAGENT_TOOLS` 不含 spawn/wait/list/plan/save_plan，子代理无法创建子子代理

4. **`SessionManager.runSubagent()`**：正确合并 base prompt + 子代理约束，正确传递过滤后的工具集

5. **`/async` 命令**：TUI 中正确切换，状态正确同步到 SessionManager

6. **`wait` 工具的实现**：阻塞语义正确（await promise），retrievedSubagents 标记正确（结果只能取一次），状态检查符合计划

7. **`list_subagents` 工具**：返回格式正确（running/completed/failed + 耗时），retrieved 标记正确

8. **`buildMessages` 历史重建**：中断轮次保留完整 messages 序列、子代理工具结果正确存储和回放

---

### 总结与优先级

┌─────┬──────────────────────────────┬──────────┬──────────────────────────────────────────┐
│ #   │ 问题                         │ 严重程度 │ 影响                                     │
├─────┼──────────────────────────────┼──────────┼──────────────────────────────────────────┤
│ 1   │ 非异步模式子代理顺序执行     │ 🔴 严重   │ 完全偏离计划设计，大任务场景性能差       │
│ 2   │ 异步模式缺少状态块           │ 🔴 严重   │ 模型无法感知子代理状态，异步模式名存实亡 │
│ 3   │ 提醒消息推入 agentMessages   │ 🟡 中等   │ KV-cache 前缀被修改但文本静态影响有限    │
│ 4   │ MAX_AGENT_ROUNDS 死代码      │ 🟢 轻微   │ 不影响功能，但误导维护者                 │
│ 5   │ 缺少 subagent_start/end 事件 │ 🟢 轻微   │ 计划标注可选，不影响核心逻辑             │
│ 6   │ 缺少子代理测试               │ 🟡 中等   │ 无回归保护，新增改动不安全               │
│ 7   │ 潜在死循环（无 round 上限）  │ 🟡 中等   │ 理论场景：模型持续回复纯文本不调用工具   │
└─────┴──────────────────────────────┴──────────┴──────────────────────────────────────────┘

最严重的两个 bug（#1 和 #2）都指向同一个根因——`interceptSubagentTool` 在单次循环中处理 spawn，无法实现两阶段（先创建所有 promise → 再统一 await）和状态块注入。如果要严格按计划修复，需要重构工具执行循环为**两阶段**：第一阶段收集所有 spawn 调用并创建 pending entries，第二阶段 await 所有结果并注入状态块。