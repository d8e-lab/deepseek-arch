# TUI 渲染反馈系统 — 让模型了解前端真实展示情况

## 问题
模型在 Agent Loop 中无法感知 TUI 前端的真实渲染效果（颜色、对齐、布局、截断等），导致调试 TUI 渲染代码困难。

## 方案
不改变现有渲染流程，通过切入"捕获点" + 新增工具，让模型通过 tool call 获取结构化渲染报告。

## 架构

```
TuiApp.captureScreen()          → ScreenCapture 结构化数据
ConversationView.renderToText() → 纯文本渲染（剥离 ANSI）
tui_capture tool                → 调用 captureFn 获取当前状态
tui_render_preview tool         → 离线预览渲染效果
```

## 新增/修改文件

| 文件 | 改动 |
|------|------|
| `src/cli/tui/renderer.ts` | 新增 `stripAnsi()` 纯函数 |
| `src/cli/tui/conversation.ts` | 新增 `renderToText()` 方法 |
| `src/cli/tui/types.ts` | 新增 `ScreenCapture`, `TurnCaptureInfo`, `ToolCallCaptureInfo`, `InputAreaCapture`, `CaptureScreenFn` 类型 |
| `src/cli/tui/app.ts` | 新增 `captureScreen()` 方法 |
| `src/tools/tui-capture.ts` | **新建** — `tui_capture` 工具 + captureFn 注册机制 |
| `src/tools/tui-render-preview.ts` | **新建** — `tui_render_preview` 工具 |
| `src/tools/index.ts` | 注册两个新工具，导出 setCaptureFn |
| `src/cli/index.ts` | 注入 capture 回调 |

## 新增测试

| 测试文件 | 测试数 | 内容 |
|---------|--------|------|
| `tests/cli/tui/renderer.test.ts` | 13 | stripAnsi, strDisplayWidth, truncateByWidth |
| `tests/tools/tui-capture.test.ts` | 5 | capture 工具在各种状态下的行为 |
| `tests/tools/tui-render-preview.test.ts` | 7 | preview 工具的渲染效果 |
