# Subagent 模块功能回退 — 合并冲突丢失核心逻辑

> ✅ **已解决 2026-08-08（v1.3.9，提交 `24186ed`）**
> - **M-1**（SubagentStore 永不填充 + 持久化缺失）：runSubagent 接线 start/push/finish + saveSubagentRecord
> - **M-2**（异步模式无状态块）：buildStatusBlock 拼 roundMessages 末尾（kv-cache 安全），删除静态提醒+强制 continue
> - **M-3**（同步模式串行）：allDeferredSpawns 两阶段并行（Promise.all）
> - **M-4/M-6**（轮次上限死代码/截断误触发）：已随 `b194bda` 删除（无轮次上限）
> - **M-5**（subagent 事件从不发射）：async 模式发射 subagent_spawned/finished 紧凑事件
> - **M-7**（subagent.ts 丢失输出条目发射）：恢复 SubagentCallbacks/onEntry（thinking/content/tool_call/tool_result）
> - 测试：`tests/core/subagent.test.ts`（9 用例，含并行/取消/独立信号）

**类型**: 功能回退（Merge Regression）
**发现日期**: 2026-07-23
**当前基线**: `main` @ `68acdb7`（HEAD）
**涉及文件**: `src/core/session.ts`、`src/core/subagent.ts`、`src/core/storage.ts`、`src/cli/tui/app.ts`

---

## 根因

`feat/subagent` 分支上的两个修复提交在合并到 main 时被冲突解决**整体丢弃**：

| 提交 | 内容 | 状态 |
|:---|:---|:---|
| `1a501c0` | 并行 spawn（`allDeferredSpawns`）、`buildStatusBlock()` 状态块、`MAX_AGENT_ROUNDS` 轮次上限 | ❌ 合并 `348d82e` 时丢失；轮次上限部分已放弃（2026-08-06 删除） |
| `a34f8cd` | `SubagentStore` 接线 + `SubagentCallbacks` 回调 + 事件发射 | ❌ 合并 `348d82e` 时丢失 |
| `3d2c2ef` | 恢复 `getSubagentStore()` 字段 + TUI `/subagent` 命令 + `Ctrl+T` | ✅ 已恢复（仅 UI 层） |

结果：**UI 层（TUI 命令、事件类型、渲染分支）完整保留，但数据写入链路（store 填充、持久化、事件发射、状态块）全部缺失**——模块声称的功能一半是"空转"的。

---

## Bug 清单

### 🔴 Bug M-1：SubagentStore 永不填充 + 子代理记录永不持久化

**位置**: `src/core/session.ts:174-179`（`runSubagent`）、`src/core/storage.ts:376-394`（`saveSubagentRecord`）

**现象**: `runSubagent()` 直接 `return runSubagentLoop(task, provider, tools, prompt, signal)`，既不调用 `subagentStore.start/push/finish`，也不调用 `storage.saveSubagentRecord`。整个 `src/` 中 `saveSubagentRecord` 只有定义**没有调用点**，磁盘上永远不会写入子代理记录。

**影响**:
- `/subagent` 命令（`app.ts:564`）与 `Ctrl+T` 运行时永远显示 "No subagents"
- Resume 后无历史可加载
- 设计文档 §1 的"可回溯"目标、§7 持久化、§4.3 回调接线全部落空

**建议**: 从 `1a501c0` cherry-pick 恢复 `runSubagent` 的 `start→push→finish→saveSubagentRecord` 完整接线。

---

### 🔴 Bug M-2：异步模式无状态块注入，模型无法感知子代理状态

**位置**: `src/core/session.ts:496`（`roundMessages` 构造）、`553-576`（静态提醒路径）

**现象**: 设计 §5.3/§8.2 要求每轮在 `roundMessages` 末尾拼动态状态块（`[Subagent Status — async mode]` + 各子代理 running/completed 状态）；实际代码 `roundMessages = [...baseMessages, ...agentMessages]`，**完全没有状态块**。async 模式下模型唯一能获得的信息是：当它返回**无 tool_calls 的纯文本**时，注入一条**静态** `[system] You have pending subagents...` 到 `agentMessages` 并 `continue`。

**影响**:
1. 模型无法得知哪个子代理完成、哪个还在跑，无法调度 `wait`
2. 静态提醒推入 `agentMessages` 修改了消息前缀（设计 §8.1 "只追加不修改" 被违反），下一轮模型看到的不是最新状态
3. `continue` 重入循环但无轮次上限（叠加 Bug M-4）

**建议**: 恢复 `buildStatusBlock()`，状态块只拼 `roundMessages` 末尾、不写入 `agentMessages`；同时删除静态提醒路径。

---

### 🔴 Bug M-3：非异步（同步）模式子代理顺序执行而非并行

**位置**: `src/core/session.ts:653-678`（per-tool-call 循环）+ `414-423`（sync 分支 `await promise`）

**现象**: `interceptSubagentTool` 在 `for (let i...)` 循环内被 `await`（`:672`），sync 分支内 `const result = await promise`（`:416`）。模型一轮 spawn "A"、"B" 两个子代理时，i=0 的 A 阻塞到完成，i=1 才创建 B 的 promise——**第二个子代理要等第一个完成才启动**，而非设计 §9.2 的 `Promise.all([A, B, C])` 同时启动。

**影响**: 大任务场景性能严重受损，偏离设计目标"并行加速"（§1）。

**建议**: 恢复两阶段处理——第一阶段遍历所有 tool_calls 收集 spawn 并创建 promise（不 await），第二阶段 `Promise.all` 统一等待后推 tool 结果。

---

### ✅ Bug M-4（已修复 2026-08-06）：Agent Loop 无轮次上限 + 死代码 `MAX_AGENT_ROUNDS`

> **状态**：已修复——`MAX_AGENT_ROUNDS` 常量与"达到上限截断"逻辑已整体删除（主 Agent 与子代理均无轮次上限，由模型自主决定完成）。以下为历史记录。

**位置**: `src/core/session.ts:42`（定义未用）、`495`（`for (let round = 0; !userDenied; round++)`）

**现象**: `MAX_AGENT_ROUNDS = 25` 已定义但从未参与循环条件。任何路径（包括 async 模式 `553-576` 的 `continue` 重入）都没有轮次上限保护。`docs/bugs/subagent.md` Bug #7 与 `docs/bugs/subagent-implementation-review.md` 均明确记录此问题，且 `1a501c0` 已修复（`round < MAX_AGENT_ROUNDS`），当前又回归。

**影响**: 若模型持续返回 tool_calls 或持续返回纯文本（不调用工具），Agent Loop 可无限运行，token 费用失控。

**建议**: 已执行——删除 `MAX_AGENT_ROUNDS` 与截断逻辑，明确"无轮次上限、由模型自主决定结束"（2026-08-06）。

---

### 🟡 Bug M-5：`subagent_spawned`/`subagent_finished` 事件从不发射，TUI 紧凑状态行为死代码

**位置**: `src/core/session.ts:386-423`（spawn 处理全程无 `emit`）、`src/cli/tui/app.ts:1353-1387`（渲染分支）

**现象**: `src/types/chat.ts:89` 定义了三种事件类型（`subagent_spawned`/`subagent_finished`/`subagent_update`），`app.ts` 有完整的渲染分支（启动 ⏳、完成 ✓/✗ + 耗时），但 `session.ts` 的 spawn 路径只调用 `pushResult`（发射 `tool_result`），`promise.then()` 中只更新 status/result（`:387-401`），**从不发射**这三种事件。

**影响**: 用户在主 TUI 中看不到任何子代理启动/完成的紧凑状态行（设计 §6.1 的 `[Sub: name] ⏳/✓` 输出永不出现）。

**建议**: 在 async 分支 spawn 后 `emit({type:'subagent_spawned', ...})`，在 promise 完成回调中 `emit({type:'subagent_finished', ...})`，并同步 `subagentStore`。

---

### ✅ Bug M-6（已修复 2026-08-06）：截断消息误触发路径（正常终止被误报"达到最大轮次上限"）

> **状态**：已修复——该截断逻辑已整体删除（无轮次上限，不再有"达到上限"提示）。以下为历史记录。

**位置**: `src/core/session.ts:809-818`

**现象**: 注释声称"达到最大轮次上限"，但循环（`:495`）根本没有上限，此分支实际触发条件是 `!userDenied && !finalContent && toolRecords.length > 0`——即**模型正常终止但返回空 content**（无 tool_calls 时 break，`finalContent` 为空，此前轮有工具记录）也会注入 `(Reached max tool rounds — stopping.)` 并把 `finalContent` 覆盖为这句误导文本。

**影响**: 模型正常完成（最后一条消息为空 content）时，用户看到错误的"达到上限"提示，且该文本被持久化进 turn。

**建议**: 已执行——整块截断逻辑删除，模型无输出时走 `'(no response)'` 兜底（2026-08-06）。

---

### 🟡 Bug M-7：`subagent.ts` 丢失子代理输出条目发射（thinking/content/tool_call/tool_result）

**位置**: `src/core/subagent.ts:49-100`

**现象**: 与 `1a501c0` 版本对比（`git diff 1a501c0 HEAD -- src/core/subagent.ts` 证实），当前版本删除了 `SubagentCallbacks` 接口、`callbacks` 参数以及 `emit()` 调用（thinking/content/tool_call/tool_result 条目全部不再产生）。

**影响**: 即使恢复 Bug M-1 的 `runSubagent` 接线，`SubagentStore` 也拿不到子代理执行过程的任何输出条目；详情视图（设计 §6.2 的 `[T: search_content]`、`│ 433 matches found` 等）无数据可渲染；`subagent_update` 事件失去意义。

**建议**: 恢复 `callbacks` 参数与各 emit 点。

---

## 附带：测试缺口（非 bug，但与回退直接相关）

全项目仅 `tests/core/subagent-store.test.ts` 一个 subagent 测试文件（12 用例，纯数据结构），以下均无覆盖：

1. `runSubagentLoop` 无任何测试（工具循环、AbortSignal 取消、未知工具、工具抛错、JSON 解析失败）
2. `interceptSubagentTool` 无测试（spawn 的 async/sync 分支、重复名字、wait 阻塞/已完成/已取走/不存在、list_subagents 输出格式）
3. 异步/同步模式端到端无测试（多子代理并行性、async 模式 `[SPAWNED]` 立即返回、状态块注入）
4. `Storage` 子代理持久化无测试（save/load/list、`_index.json` 创建与更新）
5. `SubagentStore` 与 `runSubagent` 集成无测试（回调 → store.push 链路）
6. StreamEvent 发射无测试（`subagent_spawned`/`subagent_finished` 是否发出）

正是由于缺少这些测试，`348d82e` 合并时回退未被任何 CI 捕获。

---

## 修复优先级

| 优先级 | Bug | 说明 |
|:---|:---|:---|
| P0 | M-1, M-2, M-3 | 严重：核心功能失效/性能退化 |
| P1 | M-5, M-7 | 中等：UI 死代码、详情无数据（M-4/M-6 已随轮次上限删除修复） |
| P2 | 测试缺口 | 补齐后防止再次回退 |

**修复路径**: 从 `1a501c0`/`a34f8cd` cherry-pick 或手动恢复 `src/core/subagent.ts`（callbacks/emit）与 `src/core/session.ts`（`buildStatusBlock`、`allDeferredSpawns` 并行、`runSubagent` 的 store 接线 + `saveSubagentRecord`、事件发射），再补测试。轮次上限相关（原 M-4/M-6）已删除，不再需要恢复。
