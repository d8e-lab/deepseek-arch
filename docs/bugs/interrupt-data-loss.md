# 中断导致对话轮次丢失

状态: **已修复 (fix/windows-compat-and-interrupt)** | 创建: 2026-07-07

> 修复内容：
> - 有工具调用才保存中断轮次（`toolRecords.length > 0`）
> - 首次遇到工具调用时即创建 turn（`saveTurn`），后续每次工具执行后增量落盘（`updateLastTurn`）
> - agent loop 正常结束时 `updateLastTurn` 去掉 `interrupted` 标记
> - `buildMessages` 保留中断轮次的 `turn.messages`（含用户消息 + 已完成工具交互）
> - `src/core/storage.ts` 新增 `updateLastTurn` 方法支持原地更新末条 turn
> - 详见 `.deepseek-arch/plans/windows-compat-interrupt-fix.md`

## 问题描述

用户发送消息 → 模型正在流式回复 → 用户按 Ctrl+C 中断 → 该轮对话（含用户消息 + 模型部分回复 + 工具调用）**不会出现在后续对话上下文中**。

具体表现：用户必须重新输入一遍消息，模型对之前的中断轮次一无所知。

## 影响范围

所有中断场景：

| 场景 | 当前行为 |
|------|---------|
| 模型流式吐字时 Ctrl+C | 有部分内容时存 `interrupted: true` 但后续跳过 |
| 模型流式吐字时 Ctrl+C | 无内容时 `return null`，整轮消失 |
| 工具执行时 Ctrl+C | 同上 |
| 浏览器工具抛异常（修复前） | 非 AbortError 抛出 → `return null`，整轮消失 |
| 浏览器工具抛异常（`fix/browser-error-feedback` 后） | ✅ 正常保存，错误可见 |

## 根因

### 根因 1：partial save 条件过于严格

`src/core/session.ts` 第 546 行：

```typescript
// 仅 AbortError + 已有部分内容时才保存不完整轮次
if (isAbort && (finalReasoning || finalContent)) {
    // 保存不完整轮次 ...
}
return null; // ← 条件不满足时整轮丢失
```

`finalContent` 为空的情况：
- 模型刚返回 `tool_call`（无文字内容）就被打断
- 用户刚按发送就立刻 Ctrl+C（流式还没到第一个 chunk）
- 模型只输出了 `reasoning_content` 但没输出 `content`

### 根因 2：interrupted 轮次被后续请求跳过

`src/core/session.ts` 第 601 行：

```typescript
for (const turn of this.session!.turns) {
    if (turn.interrupted) continue; // ← 跳过中断轮次
    // ...
}
```

即使存盘成功，`buildMessages()` 构建后续 API 请求时也直接跳过中断轮次。用户消息无法出现在下一轮。

### 根因 3：非 AbortError 异常不触发任何保存

`src/core/session.ts` 第 542-586 行：

```typescript
} catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    // 只有 AbortError 才可能走 partial save 分支
    if (isAbort && (finalReasoning || finalContent)) { ... }
    // 非 AbortError → 直接 return null
    onEvent({ type: 'error', error: msg });
    return null;
}
```

任何非 `AbortError` 的异常（如工具内部错误、网络超时等）都直接 `return null`，不做任何保存。

## 复现步骤

1. 启动对话：`deepseek-arch chat`
2. 发送一条消息（如"讲一个很长的故事"）
3. 模型开始流式输出后，按 `Ctrl+C`
4. 再发一条消息（如"继续"）
5. 观察：模型对之前的中断轮次和用户消息完全不知情

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/core/session.ts` | 第 542-587 行：外层 catch，决定是否保存中断轮次 |
| `src/core/session.ts` | 第 600-601 行：buildMessages 跳过 interrupted 轮次 |
| `src/tools/browser-state.ts` | 第 46-56 行：getPage() 可抛出异常（修复前丢失源） |
| `src/tools/browser-click.ts` | execute 中 try/catch 覆盖（已修复） |
| `src/tools/browser-scroll.ts` | 同上 |
| `src/tools/browser-type.ts` | 同上 |
| `src/tools/browser-press-key.ts` | 同上 |
| `src/tools/browser-navigate.ts` | 同上 |
| `src/tools/browser-navigate-back.ts` | 同上 |

## 修复方向（供参考）

### 方向 A：放宽 partial save 条件

无条件保存中断轮次，不再判断 `finalContent` 是否为空：

```typescript
if (isAbort) {
    // 始终保存中断轮次，即使没有任何内容
    const turn = await this.storage.saveTurn(
        ..., true /* interrupted */, ...
    );
    return turn;
}
```

### 方向 B：interrupted 轮次不跳过，但降级

将中断轮次的用户消息保留到下一轮，但不包含模型的截断回复：

```typescript
if (turn.interrupted) {
    // 只保留用户消息，丢弃模型的不完整回复
    messages.push(turn.user);
    continue;
}
```

或者更完整的方式——把中断轮次标记为 "仅用户消息" 注入后续请求。

### 方向 C：兜底——非 AbortError 也尝试保存

```typescript
} catch (err: unknown) {
    if (isAbort || finalReasoning || finalContent || toolRecords.length > 0) {
        // 只要有任何有效内容就尝试保存
    }
}
```
