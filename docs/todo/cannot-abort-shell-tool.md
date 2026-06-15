# Ctrl+C 中断 + Tool Error 回传修复

> 分支: `fix/cannot-abort-shell-tool`
> 状态: 待确认
> 日期: 2026-06-15

## 修复的 Bug

### 1. Ctrl+C 无法中断 shell 工具执行

**根因**: `sendMessageStream` 的 `AbortSignal` 只传给 `chatStream()`，未传给 `tool.execute()`。

**修复**:
- `Tool.execute()` 接口新增可选 `signal?: AbortSignal`
- `shellTool`: 监听 `signal.abort` 事件 → `child.kill('SIGTERM')` + 1s 后 `SIGKILL` + `reject(AbortError)`
- `sendMessageStream`: `tool.execute(args, signal)` 传入 signal
- 其余 4 个工具签名同步

### 2. 中断后 agentMessages 残缺，buildMessages 整轮跳过

**根因**: `AbortError` 从 `tool.execute()` 抛出后穿透两层 for 落到外层 catch，turn 被标记 `interrupted=true`，`buildMessages` 看到后 `continue` 跳过整轮。模型对中断毫不知情。

**修复**: 在 `tool.execute()` 调用处 try-catch `AbortError`，转为 `cancelled` 状态 + `userDenied=true`，与用户拒绝走同一出口——推取消消息 + skip 剩余工具 + 正常持久化（`interrupted=false`）。

**修复后模型看到**:
```
assistant(tool_calls: [A,B,C])
  → tool(A): 执行成功
  → tool(B): "The user cancelled this operation during execution..."
  → tool(C): "Skipped: a previous tool call was rejected or cancelled by the user."
```

### 3. 工具执行 error 不传给模型

**根因**: `agentMessages.push` 使用 `toolResult`（即 `ToolResult.content`），工具失败时 `content` 为空字符串，`error` 信息只记录在 `toolRecords` 但模型从未看到。

**影响范围**: 所有工具。`edit_file` old_string 未找到、`read_file` 文件不存在、`shell` sudo 禁止等错误对模型均不可见。

**修复**:
- `sendMessageStream`: 构造 `toolMessage = toolError ? \`${toolResult}\nError: ${toolError}\` : toolResult`
- `agentMessages.push` 改用 `toolMessage`
- `buildMessages` 兼容路径同样拼接 error

**修复前后对比**:
```
修复前: tool: ""
修复后: tool: "\nError: old_string not found in target.ts. File may have been modified since preview — re-read the file."
```

## 变更文件

| 文件 | 变更 |
|------|------|
| `src/tools/types.ts` | `execute()` 新增 `signal?: AbortSignal` |
| `src/tools/shell.ts` | abort 监听 + child.kill + reject |
| `src/tools/edit-file.ts` | 签名同步 `_signal` |
| `src/tools/read-file.ts` | 签名同步 `_signal` |
| `src/tools/search-content.ts` | 签名同步 `_signal` |
| `src/tools/write-file.ts` | 签名同步 `_signal` |
| `src/core/session.ts` | signal 传入 / AbortError 转 cancelled / toolMessage 拼接 error |

## Commits

```
cf42955 fix: tool error 不回传给模型
fc873d5 refactor: 中断路径与拒绝路径对齐
2f1c15f fix: Ctrl+C 中断 shell 工具执行
```
