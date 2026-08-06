# Subagent 中断与生命周期缺陷 — 用户中断时 subagent 被连坐杀死

**类型**: 中断/生命周期（Signal 管理）
**发现日期**: 2026-07-23
**当前基线**: `main` @ `68acdb7`（HEAD）
**涉及文件**: `src/core/session.ts`、`src/core/subagent.ts`、`src/cli/tui/app.ts`

---

## 根因

**主 agent 和 subagent 共享同一个 `AbortSignal`。** 用户 Ctrl+C 中断主 agent 时，同一个 signal 被 abort，所有后台 subagent 同步被杀死——即使它们是在 async 模式下"非阻塞 spawn"的后台任务。

完整传递链：

```
TUI (app.ts:1217)          this.abortController = new AbortController()
  ↓ 用户按 Ctrl+C (app.ts:1240-1242)
TUI                         this.abortController.abort()
  ↓ signal 传入 sendMessageStream (session.ts:313)
主 agent loop               provider.chatStream(roundMessages, { signal })   ← session.ts:502-504
  ↓ 同一个 signal 作为 launch 回调 (session.ts:675)
launch = (task) => this.runSubagent(task, signal)                           ← 关键：复用了主 agent 的 signal
  ↓
runSubagent (session.ts:174-178) → runSubagentLoop(..., signal)
  ↓ subagent.ts 三处全部绑定这个 signal：
  • :42   if (signal?.aborted) return '(subagent cancelled by user)'   ← 每轮开头检查
  • :51   provider.chatStream(messages, { ..., signal })                ← 子代理 API 调用
  • :85   tool.execute(args, signal)                                    ← 子代理工具执行
```

**中断瞬间的行为**：
1. 主 agent 的 `chatStream` abort → 抛 AbortError → catch 分支保存中断 turn
2. 所有正在运行的 subagent **同步被 abort**——若在 API 流式输出则流立即中断；若在执行 shell 等工具则工具收到 abort；若处于轮次间隙则下一轮开头 `signal.aborted` 检查直接返回

---

## Bug 清单

### 🔴 Bug I-1：用户中断时 subagent 被连坐杀死

**位置**: `src/core/session.ts:675`（`launch = (task) => this.runSubagent(task, signal)`）

**现象**: async 模式（`/async`）的设计语义是"**非阻塞 spawn + 后台并行**"（`session.ts:410-413` 立即返回 `[SPAWNED]`），用户中断主 agent 只是不想看它继续调工具，**并不代表想杀掉后台正在干活的子代理**。但实现上子代理的生死完全跟随主 agent 的中断——异步并行成了空话。

**复现场景**: turn 0 中 spawn 3 个 subagent（后台 running），用户 Ctrl+C 中断主 agent → 3 个 subagent 的 `chatStream` 全部 abort → 全部被杀 → 后续轮次 `list_subagents` 得到空列表（且 `pendingSubagents` 是 `sendMessageStream` 局部变量，中断后即丢失）。

**影响**:
- async 模式的"后台并行"承诺失效
- 用户中断主 agent 后，已 spawn 的子代理工作成果全部丢失
- 子代理可能正在执行有副作用的操作（如 shell 命令、文件编辑）——abort 中断后状态不可控

**修复方案**（按推荐度排序）:

| 方案 | 做法 | 权衡 |
|:---|:---|:---|
| A（推荐） | `runSubagent` 内部创建**独立 AbortController**，不接收/不联动主 agent 的 signal | 子代理能跑完；但没有手动取消途径，失控时只能靠外部中断/工具超时兜底（已无轮次上限） |
| B | 独立 signal + 新增取消机制（如 `subagent_cancel` 工具或 TUI 二次 Ctrl+C 取消子代理） | 最完整，改动稍大 |
| C | 保持共享 signal，但中断时只中断主 agent 流式输出，不 abort 已 spawn 的子代理 | 最小改动，语义仍不清晰 |

**注意**: 方案 A 生效后，中断导致的子代理结果返回依赖 `pendingSubagents` 跨轮次保留（见 Bug M-1 关联：`pendingSubagents` 是 `sendMessageStream` 局部变量，中断即丢）。两个问题需一并修复才能真正实现"中断后子代理继续后台跑完、结果可被后续轮次 wait 取回"。

---

### 🟡 Bug I-2：被取消的 subagent 被错误标记为 `completed`

**位置**: `src/core/session.ts:390`

**现象**:

```typescript
sub.status = r.startsWith('Error:') ? 'failed' : 'completed';
```

被取消的子代理返回 `'(subagent cancelled by user)'`（`subagent.ts:42`），**不以 `Error:` 开头** → 被错误标记为 `completed`，而不是 `cancelled`/`failed`。

**影响**:
- `list_subagents` 显示被取消的子代理为"已完成"，误导模型和用户
- 若后续实现"取消重试"逻辑，无法区分"真完成"与"被取消"
- `SubagentStore.finish` 的语义（completed/failed）被破坏

**建议**: 扩展状态机为 `running | completed | failed | cancelled`，或在 `runSubagentLoop` 的取消返回处使用 `Error:` 前缀（或让 `runSubagent` 显式抛 `AbortError` 使 catch 分支标记为 failed）。取消状态应有独立常量，避免与真正的失败混淆。

---

## 修复优先级

| 优先级 | Bug | 说明 |
|:---|:---|:---|
| P0 | I-1 | 严重：async 模式承诺失效，后台任务被无差别杀死 |
| P1 | I-2 | 中等：状态误标，影响 `list_subagents` 与未来取消逻辑 |

**验证方式**:
1. 手动：`/async` 模式 spawn 一个长任务子代理 → 主 agent Ctrl+C → 确认子代理继续运行并在后续轮次可被 `wait` 取回
2. 手动：中断后 `list_subagents` 应显示子代理为 `cancelled`（而非 `completed`）
3. 自动化：`runSubagentLoop` 单测覆盖 AbortSignal 取消路径；`interceptSubagentTool` 单测覆盖取消状态标记
