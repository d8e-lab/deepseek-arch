# TUI 前端评审报告

> ✅ **已解决 2026-08-08（v1.3.9）**
> - **Bug 1**（模型输出时输入框消失）：`0dba56e` writeOutputLine 统一收口 + 输出行后底部重绘输入区；`c6bce7a` 双工交互升级（think 逐行重绘、流式期间输入可编辑）
> - **Bug 2**（subagent 无法查看）：随 M-1/M-5 接线恢复（`24186ed`），`/subagent` 与 Ctrl+T 有数据可显示
> - **F-2**（captureScreen 读废弃字段）：`8bb24b7` 改用 turn-utils helper
> - **F-3**（/subagent 不在命令模式列表）：`24186ed` AVAILABLE_COMMANDS 补全
> - **F-4**（execSync 阻塞）：`b01d6c1` 改异步 spawn
> - **F-5**（CONFIRMING/ERROR 死状态）：`b01d6c1` 状态机补全
> - **F-6**（conversation.ts any 绕过）：`8bb24b7` 直接 turn.tool_calls
> - **F-7~F-10**（emoji 宽度/历史上限/转义/Home·End）：`b01d6c1`
> - 附带：`f886d71` getTermSize columns=0 崩溃修复；`1ad1747`/`7552c6a`/`b23407a` Ctrl+O 全屏视图与 handler 修复
> - 测试：`tests/cli/tui/app-stream.test.ts`（7 用例）、`tests/cli/tui/renderer.test.ts`

**类型**: 前端代码审查（Frontend Review）
**发现日期**: 2026-08-06
**当前基线**: `main` @ `def542a`
**涉及文件**: `src/cli/tui/app.ts`（1436 行）、`src/cli/tui/input-editor.ts`（625 行）、`src/cli/tui/markdown.ts`（217 行）、`src/cli/tui/renderer.ts`（227 行）、`src/cli/tui/selector.ts`（185 行）、`src/cli/tui/conversation.ts`（202 行）、`src/cli/tui/types.ts`（85 行）

**审查范围**: 通读全部前端代码，除用户已报告的 2 个 bug（输入框消失、subagent 无法查看）外，检查其余问题。

---

## 一、总体评价

**评分 6/10**。架构清晰（InputEditor 负责文本模型、ConversationView 负责渲染、app.ts 编排），CJK 宽度处理、粘贴标记、软换行等细节扎实；但存在 1 个**安全缺口**（shell 模式绕过 sudo 校验）、1 个**方案 C 遗漏**（captureScreen 读取已废弃的顶层字段）、1 个**命令模式 bug**（/subagent 无法提交），以及渲染状态管理（CONFIRMING/ERROR 死状态）和同步阻塞问题。

---

## 二、用户已报告问题的根因确认

### Bug 1：模型输出时输入框消失

**根因**: 输入区域只在 **IDLE** 状态绘制（`drawInputArea` 全部 7 个调用点均在 IDLE：`app.ts:333/311/761/789/807/1003`）。`sendMessageStream` 的所有输出（content_delta/tool_call/tool_result/tool_output 等，`app.ts:1246-1408`）直接 `process.stdout.write` 到 scrollback，**期间不重绘输入区域**。输出内容覆盖屏幕底部输入框，直到输出结束、下一轮 `inputCycle`（`:333`）才重新绘制。

### Bug 2：subagent 调用时无法查看

**根因**: `session.ts` 从不发射 `subagent_spawned`/`subagent_finished`/`subagent_update` 事件（0 匹配）→ `app.ts:1353-1387` 的渲染分支是死代码；`SubagentStore` 永不填充 → `/subagent`（`app.ts:564`）与 `Ctrl+T`（`:783`）永远显示 "No subagents"。属 merge regression（M-1/M-5，见 subagent-merge-regression.md）。

---

## 三、新发现的问题

### ✅ F-1（非问题，用户主动行为）：shell 命令模式绕过工具层校验

**位置**: `src/cli/tui/app.ts:700-731`（`executeShellCommand`）

**结论**: 初判为"安全缺口"（无 sudo 校验、cwd 未限定），但经确认 `!<命令>` 是**用户主动输入、直接执行于自己终端**的行为——sudo 禁、目录限定是系统 prompt 给**模型**调用 shell 工具的安全约束，不适用于用户主动执行。**非问题，保留现状**。

### 🔴 F-2：`captureScreen` 读取方案 C 已废弃的顶层字段（tui_capture 工具数据错误）

**位置**: `src/cli/tui/app.ts:197-209`

**现象**: 方案 C 重构后，有工具调用的轮次顶层 `turn.assistant.content/reasoning_content` 为 `undefined`（不再持久化），但 `captureScreen` 仍直接读取：

```typescript
const thinkLines = turn.assistant.reasoning_content ? ... : 0;  // 永远 0
const contentLines = turn.assistant.content ? ... : 0;          // 永远 0
```

**影响**: `tui_capture` 工具（模型调试用）对含工具调用的轮次报告"回复行数 0"——模型看到的屏幕状态错误。**方案 C 重构遗漏的消费方**（conversation.ts 已改用 helper，这里漏了）。

**建议**: 改用 `turnAssistantContent/turnAssistantReasoning`（`src/utils/turn-utils.ts`）。

### 🟡 F-3：`/subagent` 不在命令模式验证列表，命令模式无法提交

**位置**: `src/cli/tui/app.ts:53`（`AVAILABLE_COMMANDS`）+ `:982-1008`（`handleCommandModeEnter`）

**现象**: `AVAILABLE_COMMANDS = ['/model', '/help', '/context', '/yolo', '/async', '/exit']`——**缺 `/subagent`**。但 `handleCommand`（`:420`）支持 `/subagent`。命令模式输入 `/subagent` 会被 `handleCommandModeEnter`（`:987`）判为"未知命令"拒绝提交，用户无法通过补全/命令模式执行。

**建议**: `AVAILABLE_COMMANDS` 补上 `/subagent`。

### 🟡 F-4：shell 命令用 `execSync` 同步阻塞，期间终端冻结

**位置**: `src/cli/tui/app.ts:718`

**现象**: `execSync`（30s 超时）阻塞事件循环——执行期间 Ctrl+C 无法响应（stdin 事件被阻塞）、渲染冻结。长命令（如 `!sleep 20`）期间用户无法中断。

**建议**: 改异步 `spawn`（参考 `src/tools/shell.ts` 的 signal 中断实现），或在阻塞前提示。

### 🟡 F-5：AppState 的 CONFIRMING/ERROR 是死状态

**位置**: `src/cli/tui/types.ts:11-12` + `src/cli/tui/app.ts:1433-1436`（setState）

**现象**: `CONFIRMING`/`ERROR` 枚举定义但**从未 setState**——工具确认弹窗期间 state 仍为 STREAMING（`requestToolConfirm` 不设置 CONFIRMING），错误时走 catch（`:1409-1414`）也不设 ERROR。状态机声明与实现不一致，维护者按状态机理解会误判。

**建议**: 工具确认时 `setState(CONFIRMING)`；catch 时 `setState(ERROR)`（或删除死枚举）。

### 🟢 F-6：`conversation.ts` 用 `(turn as any).tool_calls` 绕类型

**位置**: `src/cli/tui/conversation.ts:130`

**现象**: `const tcRecords = (turn as any).tool_calls;` —— TurnRecord 已有标准 `tool_calls` 字段，any 转换掩盖类型检查。

**建议**: 直接 `turn.tool_calls`。

### 🟢 F-7：CJK 宽度不含 emoji/ZWJ

**位置**: `src/cli/tui/renderer.ts:156-171`（`isWideChar`）

**现象**: emoji（U+1F300-1FAFF）、组合字符（ZWJ 序列）未计入宽度 2，导致含 emoji 的输入/表格对齐错位（终端实际显示 2 列，计算按 1 列）。

**建议**: 补充 emoji 范围；ZWJ 序列做简化处理（至少 emoji 覆盖）。

### 🟢 F-8：输入历史无上限

**位置**: `src/cli/tui/input-editor.ts:420`（`this.history.push(content)`）

**现象**: 长会话中 history 无限增长，内存占用。

**建议**: 加容量上限（如 100 条）。

### 🟢 F-9：未知 `/` 开头的普通文本被丢弃

**位置**: `src/cli/tui/app.ts:352-355`

**现象**: 以 `/` 开头的非命令消息（如 "/usr/bin 在哪"）会被 `handleCommand` 判未知并显示错误，**不发给模型**。用户无法发送以 `/` 开头的正常提问。

**建议**: 可考虑加转义（如 `//` 前缀表示普通文本），或提供 `/send` 命令。

### 🟢 F-10：Home/End 依赖终端发送 `\x1b[H`/`\x1b[F`

**位置**: `src/cli/tui/app.ts:1059-1060`

**现象**: 只处理 `H`/`F` 序列，部分终端发送 `1~`/`4~` 时 Home/End 失效。

**建议**: 补充 `1~`/`4~` 分支。

---

## 四、修复优先级清单

| 优先级 | 问题 | 说明 |
|:---|:---|:---|
| P0 | F-2 | captureScreen 方案 C 遗漏，tui_capture 数据错误 |
| P1 | F-3 | /subagent 命令模式无法提交 |
| P1 | F-4 | execSync 阻塞事件循环（执行期间 Ctrl+C 无法响应） |
| P2 | F-5 | 状态机死状态（CONFIRMING/ERROR） |
| P3 | F-6~F-10 | 类型/emoji/历史/转义/兼容性小问题 |

**注**: F-1 经确认是用户主动 shell 行为，非问题。用户报告的两个 bug（输入框消失、subagent 无法查看）需单独修复（Bug 1 为渲染架构调整，Bug 2 为 subagent 接线恢复），不在此清单重复。

---

## 五、做得好的地方

1. **InputEditor 文本模型扎实**：显示宽度列 vs 字符串下标双坐标体系（`displayColToIndex`/`prevCharBoundary`）、surrogate pair 处理、软换行、粘贴标记的删除语义（`findPasteMarkerAt`）——细节完备。
2. **CJK 宽度处理认真**（renderer.ts 覆盖全部 CJK 区间），虽缺 emoji 但主流中文场景正确。
3. **流式输出节流**（`Throttle(30)` 30fps）避免逐字符写屏幕。
4. **markdown 表格状态机**（MAYBE_HEADER→INSIDE→flush）正确处理流式表格的暂存与边界。
5. **Selector 通用化**（getHandler/setHandler 注入）可复用，数字快捷键 + 方向键 + Ctrl+C 取消齐全。
6. **raw mode + bracketed paste + 单一 stdinHandler 分发**架构清晰，Ctrl+C 统一入口。
7. **captureScreen 结构化输出**（供模型调试）设计有远见，但需按 F-2 修复数据源。
