# Ctrl+J 多行输入导致对话历史渲染重复

状态: **挂起** | 创建: 2026-06-10 | 证据: `demo_test/cli.txt`

> **仅出现在 Tabby 终端**，标准终端（如 Windows Terminal、iTerm2、Konsole）无法复现。  
> 推测为 Tabby 对 ANSI 控制序列/原始模式的处理差异导致，非通用 bug。  
> **挂起原因**：低优先级，非核心逻辑问题，待用户主动提出时再修复。

## 问题描述

全屏 TUI 对话界面中，当用户粘贴/输入多行文本并发送后，**对话历史渲染**出现内容重复：

- 已发送的行反复显示在对话列表中
- 每次渲染都会追加一次，行数越来越多
- 部分行被截断（换行处后半段单独成行）

详见 `demo_test/cli.txt`（用户实际录屏记录）。

### 复现步骤

1. 粘贴一段多行文本到输入框
2. 发送消息
3. 观察对话历史区域——同一段文本重复出现多次，越来越多

### 实际现象（来自 cli.txt）

```
我
我
是
我
是
我
我
【测试多行粘贴】基于 Node...
【测试多行粘贴】基于 Node...
【测试多行粘贴】基于 Node...
...
```

逐字拆开 + 整段重复十几次。

## 根因推测

**不是输入缓冲区问题，而是渲染问题。** 怀疑点在：

1. 对话历史渲染时，**增量追加逻辑有 bug**：每次有新回合加入时，把历史消息又重新渲染了一遍，导致旧内容重复累积
2. 多行消息分割成多段后，每段被当作独立消息渲染
3. `ConversationView.render()` 或 `ChatUI` 的状态管理未正确处理多行消息的增量渲染

## 已修复（分支: fix/ctrl-j-input-bug）

- ✅ Shift+Enter → 换行（CSI u: `\x1b[13;2u`，xterm: `\x1b[27;2;13~`）
- ✅ Ctrl+Enter → 换行（CSI u: `\x1b[13;5u`，xterm: `\x1b[27;5;13~`）
- ✅ Ctrl+Enter 不再发送空消息（增加 content.trim() 检查）
- ✅ Ctrl+J 换行保持兼容

## 修复要求

- 修复此 bug 时，**必须从 `main` 分支创建新分支**（如 `fix/ctrl-j-input-bug`）
- 不得在 `main` 上直接修改

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/cli/tui/conversation.ts` | 对话历史渲染（最可疑） |
| `src/cli/tui/renderer.ts` | 行渲染工具 |
| `src/cli/tui/app.ts` | TuiApp 主应用，事件调度与渲染循环 |
| `src/cli/state/chat-state.ts` | 对话状态管理 |
| `src/cli/chat-ui.ts` | ChatUI 主循环，输入/输出流管理 |
