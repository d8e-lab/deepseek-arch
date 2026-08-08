# 对话管理一致性审查 — 内存 turns 错位覆盖、userMsg 重复、cache.log 编号漂移

> ✅ **已解决 2026-08-08（v1.3.9）**
> - **C-1**（内存 turns 错位覆盖）：修复于 `a7cc07c`——首次 saveTurn 后立即 push 内存 turns，结束分支改为更新最后一项
> - **C-2**（userMsg 重复两次）：修复于 `8bb24b7`（数据格式 v2）——storage 端不再二次拼接 userMessage，messages 恒存单一来源
> - **C-3**（cache.log 编号漂移）：修复于 `a7cc07c` + `202f7ad`——用实际 turn 号替代 length+1 推断；cache.log 路径拼接 bug 一并修复
> - **C-4**（内存 meta.turnCount 不同步）：随 C-1 修复自愈
> - **C-5**（updateLastTurn 返回 null 未处理）：修复于 `8bb24b7`——对 null 判空，回退 saveTurn 兜底
> - 回归测试：`tests/core/session.test.ts`（C-1 回归用例）、`tests/core/storage.test.ts`（v2 断言）

**类型**: 一致性审查（Consistency Review）
**发现日期**: 2026-08-06
**当前基线**: `main` @ `68acdb7`（HEAD）
**涉及文件**: `src/core/session.ts`、`src/core/storage.ts`、`src/core/subagent.ts`、`src/core/cache-log.ts`、`src/types/chat.ts`、`src/types/session.ts`、`tests/core/session.test.ts`

**审查范围**: 对话管理全链路一致性——消息构建（buildMessages）、turn 持久化（saveTurn/updateLastTurn）、内存/磁盘状态同步、KV-cache 回放、cache.log 监控、子代理账目。

---

## 核心发现

**会话数据的"内存视图"与"磁盘视图"在 agent loop（工具调用）路径下不一致**。磁盘始终正确，内存 turns 在每次含工具调用的轮次结束后被错误覆盖，导致同进程内连续对话的消息序列错乱。由于 resume 时从磁盘重建，bug 表现为"重启后正常"，极难被用户察觉，现有测试也因全部通过 resume 重建 manager 而完美避开。

---

## Bug 清单

### 🔴 Bug C-1：turnSaved 路径内存 turns 错位覆盖上一轮

**位置**: `src/core/session.ts:638-650`（saveTurn 无 push）+ `:871-878`（错误下标覆盖）

**现象**: `sendMessageStream` 中，模型返回 tool_calls 时触发 `turnSaved = true` 并调用 `storage.saveTurn()`（:638），但**从不把返回的 turn push 进 `this.session.turns`**。结束时（:871-878）：

```typescript
// 注释声称 "turnSaved 时 turn 已在 turns 数组中" —— 假注释，实际从未 push
if (turnSaved) {
    const lastIdx = this.session.turns.length - 1;   // 非首轮时指向"上一轮"
    if (lastIdx >= 0) {
        this.session.turns[lastIdx] = turn;          // 上一轮被覆盖为当前轮
    } else {
        this.session.turns.push(turn);
    }
}
```

第 N 轮（N≥2）含工具调用时：内存 turns 从 `[t1..tN-1]` 变为 `[t1..tN-2, tN]`——**丢失 tN-1，长度 N-1（应为 N）**。

**影响**:
- 同进程内连续多轮工具对话：`buildMessages`（:946-1014）用错乱的内存 turns 构建 API 消息 → 上下文缺一轮、KV-cache 命中率下降、模型上下文错误
- `getSession()` 返回内存 → UI 显示 turnCount 少 1、turns 错位
- 磁盘 `turns.json` 始终正确（saveTurn/updateLastTurn 基于磁盘 existingTurns 计算轮号），resume 后正常 → bug 高度隐蔽
- `interrupted` 路径（:900-912）同样受影响

**为何现有测试未捕获**: `tests/core/session.test.ts` 的多轮场景全部通过 `resumeSession` 新建 SessionManager（`mgr2`/`mgr3`，:335/:352），内存从磁盘重建，绕过了同实例连续对话路径。

**修复**: 首次 saveTurn 成功后立即 `this.session.turns.push(turn)`，结束分支改为"更新最后一轮"（`turns[turns.length - 1] = turn`，此时最后一项就是当前轮）。

---

### 🟡 Bug C-2：首次落盘 turn.messages 中 userMsg 重复两次

**位置**: `src/core/session.ts:646` + `src/core/storage.ts:254-256`

**现象**: 首次 saveTurn 传参 `agentLoopMessages = [userMsg, ...agentMessages]`（:646），storage 端又拼一次 `turn.messages = [userMessage, ...agentLoopMessages]`（:255）→ **`[userMsg, userMsg, ...agentMessages]`**。随后每轮工具执行后的 `updateLastTurn`（:798-804）用 `messages: [userMsg, ...agentMessages]` 覆盖为正确。

**影响**: 正常流程最终被修正；但若进程在 saveTurn 与首次 updateLastTurn 之间崩溃（工具执行中），磁盘残留重复 user 消息，resume 后 `buildMessages` 将重复 user 消息发送给 API，污染上下文前缀（KV-cache 失效）。

**修复**: storage 端改为 `turn.messages = agentLoopMessages`（调用方已含 userMsg），或 session 端传 `[...agentMessages]` 并在 storage 端统一拼接。二选一，明确单一来源。

---

### 🟡 Bug C-3：cache.log 的 turn 编号在两种路径下语义不一致

**位置**: `src/core/session.ts:864-868` + `src/core/cache-log.ts:109-128`

**现象**: `appendCacheLog(dir, id, this.session.turns.length + 1, roundUsages)`（:867）依赖内存 turns.length 推断轮号：

| 路径 | 内存 length | 传入编号 | 实际轮号 | 结果 |
|:---|:---|:---|:---|:---|
| 无工具轮次（:861 push 后） | N | N+1 | N | ❌ 多 1 |
| 有工具轮次（turnSaved，Bug C-1 连带） | N-1 | N | N | ✅ 碰巧对 |

**影响**: 同一会话内 cache.log 的 turn 编号漂移（无工具轮次 +1），无法按 turn 对齐分析命中率；且修复 C-1 后（内存 length 恢复为 N），turnSaved 轮次的编号会从"碰巧对"变成"多 1"——**:867 必须在修复 C-1 时同步改为使用已知 turn 号**（如 `turn.turn` 或 `this.session.turns.length`）。

**修复**: 用实际 turn 号（saveTurn 返回值 `turn.turn`）替代 `length + 1` 推断。

---

### 🟡 Bug C-4：内存 meta 与磁盘 meta 的 turnCount 不同步

**位置**: `src/core/storage.ts:266-276`（saveTurn 写磁盘）+ `src/core/session.ts:879`（内存）

**现象**: `saveTurn` 用磁盘 `existingTurns.length + 1` 计算 turnNumber 并写磁盘 meta（正确 N）；内存 `this.session.meta.turnCount = this.session.turns.length`（:879）在 turnSaved 路径为 N-1（Bug C-1 连带）。

**影响**: 同进程内 `listSessions`（读磁盘 meta，:156-164）与 `getSession()`（读内存）显示不一致；session 列表页与对话页轮次数对不上。

**修复**: 随 C-1 一并修复（push 后 length 即正确）。若 C-1 有兼容性顾虑，可显式 `meta.turnCount = turn.turn`。

---

### 🟢 Bug C-5：updateLastTurn 返回 null 未被处理

**位置**: `src/core/session.ts:832,902`

**现象**: `turn = (await this.storage.updateLastTurn(...))!` 使用非空断言；若磁盘 turns.json 为空/损坏（如 saveTurn 失败被 :650 catch 吞掉后磁盘无数据），updateLastTurn 返回 null，随后 :880 `turn.created_at` 抛 TypeError，走 catch 分支（:884）且 toolRecords 非空会再次尝试保存——雪球。

**修复**: 对 null 结果显式判空；saveTurn 失败时不应继续置 turnSaved（或 updateLastTurn 失败时回退到 saveTurn）。

---

## 一致性观察（非 bug，设计/账目层面）

### O-1：子代理 token 完全不入账
`subagent.ts` 的循环（:41-101）不收集 `chunk.usage`，子代理的 prompt/completion 消耗不进入主会话的 `usage`/`round_usage`。子代理频繁使用时，会话费用统计严重失真（`totalCost` 仍为 0 的另一个原因）。主循环有完整的 roundUsages 记录（session.ts:542-550），子代理无对应物。

### O-2：子代理丢弃 reasoning_content
主循环累积 `delta.reasoning_content` 并持久化（session.ts:513-517，chat.ts:44）；子代理只累积 `delta.content`（subagent.ts:56），且 push 的 assistant 消息（:69-73）无 `reasoning_content` 字段。子代理多轮工具循环从第二轮起缺少 reasoning 前缀，KV-cache 命中率受损——与主循环"持久化 reasoning 以命中 kv-cache"的设计（chat.ts:17-21）不一致。

### O-3：工具结果消息格式双路径一致 ✅
`buildMessages` 的兼容重建路径（session.ts:992-994：`result + '\nError: ' + error`）与 messages 路径（:745-746：`toolResult + '\nError: ' + toolError`）格式一致，resume 时旧数据（无 messages 字段）重建后与实时路径行为等价。

### O-4：无工具轮次不保存 messages 字段（设计一致）
无工具轮次 saveTurn 传 `agentLoopMessages = undefined`（session.ts:856-857），turn 无 `messages` 字段，buildMessages 走兼容路径（user + assistant + reasoning）——消息序列恰好两条，与完整路径等价，无一致性问题。

### O-5：resume 双路径
CLI resume 用 `storage.getSession()`（磁盘，:126）而非 `sessionMgr.getSession()`（内存）。Bug C-1 未修复时，两条路径结果不同（磁盘正确/内存错乱），进一步放大 C-1 的隐蔽性。

---

## 测试缺口（为何一致性 bug 未被捕获）

1. **无同实例连续多轮工具对话测试**：现有多轮测试（:309-360）全部通过 resume 重建 manager；应增加"同一 SessionManager 连续 sendMessageStream 两轮（含工具调用）→ 断言 turns.length / 第 N-1 轮内容 / meta.turnCount"的用例
2. **无 saveTurn→updateLastTurn 中间态崩溃测试**：无法直接测崩溃，但可断言首次 saveTurn 落盘后的 messages 不重复（把 storage 的 saveTurn 返回值检查纳入）
3. **无 cache.log 编号断言**：无工具轮次 + 有工具轮次混合后检查 cache.log 行中 turn= 编号连续且与实际轮一致
4. **subagent 无 usage/reasoning 断言**：subagent 测试仅覆盖 SubagentStore 数据结构，无 `runSubagentLoop` 的 usage 收集测试

---

## 修复优先级

| 优先级 | Bug | 说明 |
|:---|:---|:---|
| P0 | C-1 | 核心：内存/磁盘不一致，同进程连续对话上下文错乱 |
| P1 | C-2, C-3, C-4 | 与 C-1 同区域，建议一并修（C-3 依赖 C-1 修复后的编号） |
| P2 | C-5 | 极端路径防御 |
| P3 | O-1, O-2 | 子代理账目/缓存一致性（可并入 subagent 修复批次） |

**修复路径**: ① saveTurn 后立即 push 当前 turn；② 结束分支改为更新最后一项；③ 867 行改用 `turn.turn` 编号；④ storage 端 messages 拼接去重；⑤ 补同实例多轮测试。①②③④ 相互关联，应作为一个 commit 提交并同步补测试。

---

## 关联文档

- [architecture-code-review.md](./architecture-code-review.md) — storage 全量读写 O(n²)/非原子写的架构层问题（本次审查的持久化背景）
- [subagent-merge-regression.md](./subagent-merge-regression.md) — 子代理接线缺失（O-1/O-2 的代码层背景）
- [prompt-review.md](./prompt-review.md) — KV-cache 前缀稳定性设计的提示词层背景
