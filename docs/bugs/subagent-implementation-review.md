# 子代理实现审查报告

**日期**: 2026-07-10
**审查范围**: feat/subagent 分支 vs plan/remove-agent-loop-limit.md 计划 + docs/bugs/subagent.md

---

## 一、已修复项（本次实现）

| Bug # | 描述 | 状态 |
|:---|:---|:---|
| #2 | 异步模式每轮缺少状态注入块 `buildStatusBlock()` | ✅ 已修复 — 每轮 `roundMessages` 末尾注入动态状态块 |
| #3 | 提醒消息错误推入 `agentMessages` 而非作为末尾动态块 | ✅ 已修复 — 状态块不修改 agentMessages，仅拼到 roundMessages 末尾 |
| #5 | 缺少 `subagent_spawned`/`subagent_finished` StreamEvent 类型 | ✅ 已修复 — 新增三种事件（含 subagent_update） |
| #6 | 缺少子代理测试 | ❌ 仍未实现 |

### 新增功能

| 功能 | 说明 |
|:---|:---|
| `SubagentStore` | 内存缓冲，捕获子代理每轮 thinking/content/tool_call/tool_result |
| `SubagentCallbacks` | `runSubagentLoop` 新增回调参数，每产出条目时触发 |
| 紧凑 TUI 渲染 | async 模式下 spawn → 1 行 `[Sub: name] ⏳ task...`，完成 → `[Sub: name] ✓ 3.2s` |
| `/subagent [name]` 命令 | 列出所有子代理 / 查看单个完整输出 |
| `Ctrl+T` 快捷 | 快速列出子代理 |
| Storage 持久化 | `saveSubagentRecord`/`loadSubagentRecord` → `sessions/<id>/subagents/<name>.json` |
| Resume 支持 | `/subagent` 加载历史记录（回退到 Storage） |

---

## 二、剩余 Bug

### 🔴 Bug #1: 非异步模式 deferredSpawns 仍是顺序执行

**位置**: `src/core/session.ts` 第 751 行

**根因**: `deferredSpawns` 数组在 **per-tool-call 循环内部**创建（第 727 行 `for` 循环中），导致同一轮内多个 spawn 被串行处理：

```typescript
for (let i = 0; i < pendingToolCalls.length; i++) {  // ← 外层循环
    // ...
    const deferredSpawns = [];  // ← 每次迭代新建数组！
    const intercepted = await interceptSubagentTool(..., deferredSpawns);
    if (deferredSpawns.length > 0) {
        await Promise.all(deferredSpawns.map(...));  // ← 立刻等待
    }
}
```

模型一轮内 spawn "A" 和 "B" 两个子代理时：
1. i=0：spawn "A" → deferredSpawns=[A] → `await Promise.all([A])` 阻塞直到 A 完成
2. i=1：spawn "B" → deferredSpawns=[B] → `await Promise.all([B])` 阻塞直到 B 完成

**期望行为**: A 和 B 并行启动，`Promise.all([A, B])`。

**修复**: 将 `deferredSpawns` 提升到 `for` 循环外部，所有 spawn 收集完毕后统一 `await`。

---

### 🟢 Bug #4: MAX_AGENT_ROUNDS 死代码

**位置**: 已从 session.ts 移除（本次同步基线时删除）。

但 Bug #7 仍然存在——agent loop 没有 round 上限：

```typescript
for (let round = 0; !userDenied; round++) {
```

理论上模型可以无限循环（持续返回 tool_calls 不终止）。应在循环条件或 `continue` 前加检查。

---

### 🟡 Bug #7: 潜在死循环（无 round 上限）

异步模式下子代理未完成时 `continue` 重入循环，无上限保护。若模型持续返回纯文本不调用工具，会无限循环。

---

## 三、计划 vs 实现差异

| 计划项 | 实现 | 偏差 |
|:---|:---|:---|
| SubagentIndex (含 summary/turn 等) | 简化为 `_index.json` (仅存 names 数组) | 索引字段不足 |
| SubagentRecord.messages (完整 Message[]) | SubagentRecord.entries (SubagentRoundEntry[]) | 结构不同但功能等价 |
| 实时穿透 shell 输出 | 未实现 | 子代理 shell 输出不穿透到主 TUI |
| 状态行原地刷新 (`\r\x1b[K`) | 每次写新行 | 视觉体验略差 |
| Per-round 增量持久化 | 仅在完成时一次写入 | 崩溃时可能丢失 |
