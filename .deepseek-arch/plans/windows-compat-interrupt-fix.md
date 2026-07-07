# Windows 兼容 & 中断数据丢失修复计划

> 创建: 2026-07-07 | 更新: 2026-07-07 | 分支: `fix/windows-compat-and-interrupt`

---

## 需求概述

| # | 任务 | 来源 | 核心问题 |
|---|------|------|---------|
| 1 | Shell 工具 Windows 兼容 | 用户指令 + `docs/bugs/browser-on_win.md` | `/bin/bash` 硬编码 → 检测 `win32` 切换为 PowerShell |
| 2 | checkPath Windows 路径分隔符 | `docs/bugs/browser-on_win.md` 次要 Bug | `sessionCwd + '/'` 硬编码，Windows `\` 导致合法路径被拒 |
| 3 | 中断数据丢失 + 增量持久化 | `docs/bugs/interrupt-data-loss.md` | 工具执行结果全在内存，崩溃/中断丢数据 |

---

## 验收标准

1. **Windows 上 `execute_command`**：使用 `powershell.exe -Command`，描述文案也随平台切换
2. **Windows 上 `read_file`/`write_file`**：合法路径不再报 `path outside workspace`
3. **工具调用即落盘**：模型调工具后，每次工具执行完立即 `updateLastTurn` 写到磁盘
4. **仅工具调用时保存中断轮次**：`toolRecords.length > 0` 才保存，纯聊天中断不保存
5. **buildMessages 不跳过中断轮次**：用户消息 + 已完成的工具结果注入下一轮请求

---

## 受影响文件

| 文件 | 修改内容 |
|------|---------|
| `src/tools/shell.ts` | 平台检测 + 动态描述 + shell 选择 + kill 兼容 |
| `src/tools/utils.ts` | `checkPath` 路径分隔符修复 + 交互检测平台适配 |
| `src/core/storage.ts` | 新增 `updateLastTurn` 方法（原地更新末条 turn） |
| `src/core/session.ts` | 工具执行后增量落盘 + 中断保存条件 + buildMessages |

---

## 子任务拆解

### 子任务 1：`shell.ts` — 平台检测 + 动态描述 + shell 选择

1. **动态描述** — 模块加载时根据 `process.platform` 生成：

   ```typescript
   const IS_WIN = process.platform === 'win32';

   const TOOL_DESCRIPTION = IS_WIN
     ? '执行 PowerShell 命令。...注意：命令在 PowerShell 中执行，请使用 PowerShell 语法。'
     : '执行 shell 命令。...禁止 sudo。';

   const COMMAND_PARAM_DESC = IS_WIN
     ? '要执行的 PowerShell 命令（非交互式）'
     : '要执行的 shell 命令（非交互式）';
   ```

2. **`getShellBin()`**：`win32` → `powershell.exe -Command`（fallback `cmd.exe /c`），其他 → `/bin/bash -c`

3. **spawn 调用**：改用动态 `{ bin, arg }`

4. **Abort 兼容**：`child.kill('SIGTERM')` → win32 上用 `child.kill()` 无参

5. **交互命令检测**：Windows 上 PowerShell `-Command` 天然非交互，精简阻塞列表（仅 `diskpart`、`ftp`）

---

### 子任务 2：`utils.ts` — checkPath + 交互检测

**2a. checkPath 修复**：`resolved.startsWith(sessionCwd + '/')` → 用 `path.relative()` + `path.isAbsolute()`

```typescript
const rel = relative(sessionCwd, resolved);
if (rel.startsWith('..')) return invalid;
if (path.isAbsolute(rel)) return invalid;  // 跨盘符
return valid;
```

**2b. 交互命令检测**：`isInteractiveCommand` 区分平台，Windows 精简列表。

---

### 子任务 3：`storage.ts` — 新增 `updateLastTurn`

```typescript
/**
 * 原地更新最后一条 turn（用于 agent loop 中工具执行后的增量落盘）。
 * 如果 turns 为空则 no-op。
 */
async updateLastTurn(
    sessionId: string,
    patch: {
        assistant?: Partial<Message & { id: string }>;
        toolCalls?: ToolCallRecord[];
        messages?: Message[];
        usage?: TokenUsage;
        roundUsages?: RoundUsage[];
        interrupted?: boolean;
        lastBrowserUrl?: string;
    },
): Promise<TurnRecord | null> {
    const turns = await this.loadTurns(sessionId);
    if (turns.length === 0) return null;

    const last = turns[turns.length - 1] as Record<string, unknown>;

    if (patch.assistant) Object.assign(last.assistant as object, patch.assistant);
    if (patch.toolCalls) last.tool_calls = patch.toolCalls;
    if (patch.messages) last.messages = patch.messages;
    if (patch.usage) last.usage = patch.usage;
    if (patch.roundUsages) last.round_usage = patch.roundUsages;
    if (patch.interrupted !== undefined) {
        if (patch.interrupted) last.interrupted = true;
        else delete last.interrupted;
    }

    await this.writeJSON(this.turnsPath(sessionId), turns);
    return turns[turns.length - 1] as TurnRecord;
}
```

---

### 子任务 4：`session.ts` — agent loop 增量持久化 + 中断保存 + buildMessages

#### 4a. 首次保存时机

模型第一次返回 tool_calls 时，agentMessages 已 push assistant 消息，此时调 `saveTurn` 创建一条新 turn（带 `interrupted: true`，表示进行中）：

```typescript
// session.ts agent loop，模型返回 tool_calls 后、开始执行工具前：
if (toolRecords.length === 0 && pendingToolCalls.length > 0) {
    // 首次创建 turn（工具尚未执行，只有 user + assistant(tool_calls)）
    await this.storage.saveTurn(
        this.session.meta.id,
        { role: 'user', content: userContent },
        { id: responseId, role: 'assistant', content: '', reasoning_content: finalReasoning },
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        0,
        true,  // interrupted（进行中）
        pendingToolCalls.map(tc => ({ id: tc.id, name: tc.function.name, arguments: {} })),
        [userMsg, ...agentMessages],
        roundUsages.length > 0 ? roundUsages : undefined,
        await this._browserLastUrl(),
    );
}
```

#### 4b. 每次工具执行后增量落盘

```typescript
// 每个 tool.execute() 完成后（在 toolRecords.push + agentMessages.push 之后）：
await this.storage.updateLastTurn(
    this.session.meta.id,
    {
        toolCalls: toolRecords,         // 累积更新
        messages: [userMsg, ...agentMessages],  // 累积更新
        usage: usage ?? undefined,
        roundUsages: roundUsages.length > 0 ? roundUsages : undefined,
        lastBrowserUrl: await this._browserLastUrl(),
    },
);
```

#### 4c. agent loop 正常结束

去掉 `interrupted` 标记，补充最终 assistant 内容和 usage（或让原有 `saveTurn` 追加新 turn，删除进行中的旧 turn——这里需要决定）。

**方案**：正常结束时用 `saveTurn`（replaceLast=false）追加一条**不带 interrupted** 的完整 turn，然后 `updateLastTurn` 改为 `deleteLastTurn` 删除之前的进行中 turn。或者更简单：正常结束时不走 `updateLastTurn`，直接 `saveTurn`（append），同时调用一次 `updateLastTurn` 把之前进行中的 turn 标记为完整。

**简化方案**：agent loop 全程只维护一条 turn，首次 `saveTurn`（append），后续 `updateLastTurn`（更新），正常结束时最后一次 `updateLastTurn` 把 `interrupted` 去掉，设置最终 `content` 和 `usage`。

```typescript
// Agent loop 正常结束：
await this.storage.updateLastTurn(this.session.meta.id, {
    assistant: { content: finalContent, reasoning_content: finalReasoning },
    toolCalls: toolRecords.length > 0 ? toolRecords : undefined,
    messages: agentMessages.length > 0 ? [userMsg, ...agentMessages] : undefined,
    usage: finalUsage,
    roundUsages: roundUsages.length > 0 ? roundUsages : undefined,
    interrupted: false,  // 去掉进行中标记
    lastBrowserUrl: await this._browserLastUrl(),
});
```

#### 4d. catch 块：仅工具调用时处理

```typescript
} catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const msg = err instanceof Error ? err.message : String(err);

    // 有工具调用记录才保留中断轮次
    if (toolRecords.length > 0) {
        // 确保 interrupted: true
        await this.storage.updateLastTurn(this.session.meta.id, {
            interrupted: true,
            toolCalls: toolRecords,
            messages: agentMessages.length > 0 ? [userMsg, ...agentMessages] : undefined,
            usage: usage ?? undefined,
            roundUsages: roundUsages.length > 0 ? roundUsages : undefined,
            lastBrowserUrl: await this._browserLastUrl(),
        });
        onEvent({ type: 'error', error: isAbort ? '已中断' : msg });
        return /* 返回 turn */;
    }

    // 无工具调用：不保存
    onEvent({ type: 'error', error: msg });
    return null;
}
```

#### 4e. buildMessages：不跳过中断轮次

```typescript
if (turn.interrupted) {
    if (turn.messages && turn.messages.length > 0) {
        messages.push(...turn.messages);
        // turn.messages = [user_N, assistant(tool_calls), tool(result_1), ...]
    }
    continue;
}
```

`turn.messages[0]` 就是用户消息（`saveTurn` 第 254 行已拼接），无需额外处理。

---

## 自检清单

| 原则 | 结果 |
|------|------|
| 最小改动（4 源文件） | ✅ |
| Tool 接口不变 | ✅ |
| Linux 行为不变 | ✅ |
| 模型看到正确 shell 描述 | ✅ |
| 工具调用即落盘 | ✅ `updateLastTurn` 每次工具执行后调 |
| 仅 toolRecords > 0 保存中断 | ✅ |
| 中断轮次用户消息不丢失 | ✅ `turn.messages[0]` 就是 user 消息 |
| 旧 session 数据兼容 | ✅ |
| 进程崩溃只丢当前正在执行的工具 | ✅ |

---

## 执行顺序

1. **Step 1** — `utils.ts` checkPath 修复 + 交互检测适配 → `npm test`
2. **Step 2** — `shell.ts` 动态描述 + 平台检测 + kill 兼容 → `npm run build`
3. **Step 3** — `storage.ts` 新增 `updateLastTurn` → `npm run build`
4. **Step 4** — `session.ts` agent loop 增量持久化 + 中断保存 + buildMessages → `npm test`
5. **Step 5** — 全量验证
