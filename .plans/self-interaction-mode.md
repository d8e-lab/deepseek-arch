# 自我交互模式 — 让模型自主调试 TUI 渲染

## 概述
模型通过启动子 TUI 实例（PTY 中），与之交互并捕获渲染状态，
实现"模型写代码 → 启动子实例 → 验证效果 → 修复"的自循环调试。

## 架构

```
主 Agent               子 TUI 实例 (PTY)
  │                          │
  │  tui_session_start ──→  spawn node dist/cli/index.js chat --mock
  │                          │
  │  tui_session_send ──→  键盘输入 "hello\r"
  │                          │
  │                         MockProvider 处理 → 输出渲染
  │                          │
  │  tui_session_read  ←── 原始 PTY 输出 (ANSI)
  │  tui_session_capture ←── 结构化渲染报告
  │                          │
  │  tui_session_stop  ──→  SIGTERM + SIGKILL
```

## 新增/修改文件

| 文件 | 说明 |
|------|------|
| `src/tools/tui-session-manager.ts` | PTY 会话管理器（node-pty） |
| `src/tools/tui-session-start.ts` | 启动工具 |
| `src/tools/tui-session-send.ts` | 发送输入工具 |
| `src/tools/tui-session-read.ts` | 读取输出工具 |
| `src/tools/tui-session-capture.ts` | 结构化捕获工具 |
| `src/tools/tui-session-stop.ts` | 停止+列表工具 |
| `src/cli/index.ts` | 添加 --mock 和 --self-interaction |
| `src/cli/tui/app.ts` | 添加 selfInteraction 标记和 header 显示 |
| `src/core/session.ts` | 添加 getSystemPrompt() |
| `src/tools/index.ts` | 注册自交互工具集 |

## 关键技术点
- node-pty 创建 300×200 伪终端
- ANSI dim 分析 (analyzeDimPerLine) 区分 think/content
- 200KB 环形输出缓冲区
- MockProvider 零 API 成本

## 使用方式
```bash
deepseek-arch chat --self-interaction
```
模型自动获得 6 个自交互工具，可自主调试 TUI 渲染。
