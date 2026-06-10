# Resume 时重建 Diff 展示

状态: **挂起** | 创建: 2026-06-10

## 问题描述

resume 会话时，diff 预览（文件修改工具执行前生成的 unified diff）需要在历史对话中重新展示。

### 当前实现（commit 6f5624b）

- `ToolCallRecord` 中新增 `preview?: string` 字段，存储 raw diff 文本
- Agent loop 中 `tool.preview(args)` 生成 diff → 存入 `toolRecords` → 持久化到 `turns.json`
- Resume 时 `ConversationView.render()` 读取 `tcr.preview`，逐行调用 `renderDiffLine()` 着色

## 潜在问题

### 1. turns.json 膨胀
大文件的 diff 文本可能很大，完全以字符串存入 JSON 会让会话持久化体积显著增长。

### 2. 冗余存储
`ToolCallRecord.arguments` 已包含生成 diff 所需的全部参数（`path`、`content`/`old_string`/`new_string`）。理论上可以从参数重建 old/new 内容再 diff，无需额外存储纯文本。

### 3. 中断场景的 gap
用户在确认阶段（preview 已生成、工具尚未执行）中断时：
- `toolRecords.push()` 在执行之后才调用（`session.ts:L345`）
- 未执行的 tool + preview 不会被持久化
- Resume 时看不到这个 pending 工具调用

### 4. 纯文本 diff 缺乏结构化信息
存储 raw diff 文本，丢失了 old/new 内容和路径信息，无法做交互式展示（如折叠/展开、跳转到文件等）。

## 候选方案

### 方案 A — 存储 old+new 内容，resume 时重新 diff
`ToolCallRecord` 中存 `oldContent` + `newContent`，resume 时调用 `unifiedDiff()` 重建。
- ✅ 不存冗余 diff 文本
- ❌ old+new 内容可能更大（尤其是 write_file 的 new content）
- ❌ write_file 创建新文件时无 oldContent（需处理空值）

### 方案 B — 只存 preview 字符串，截断大 diff
当前方案的优化版：对超长 diff 做截断（如只存前 200 行 + `…truncated`）。
- ✅ 简单直接
- ❌ 丢失完整信息
- ❌ 中断场景 gap 未解决

### 方案 C — 混合方案
preview 字符串作为主要展示来源（开箱即用）。如果参数完整（`write_file` 有 content，`edit_file` 有 old_string/new_string），resume 时优先从参数重新生成 diff。
- ✅ 保证渲染一致性
- ✅ preview 为空时 fallback 到参数重建
- ❌ 实现复杂度较高
- ❌ edit_file 的 oldContent 仍需从磁盘读取（文件可能已被后续修改）

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/tools/types.ts` | `ToolCallRecord.preview` 字段定义 |
| `src/core/session.ts` | Agent loop 中 preview 生成与持久化 |
| `src/core/storage.ts` | `turns.json` 序列化 |
| `src/cli/tui/conversation.ts` | Resume 时 diff 渲染 |
| `src/cli/tui/renderer.ts` | `renderDiffLine()` 着色 |
| `src/tools/write-file.ts` | write_file 的 preview() 实现 |
| `src/tools/edit-file.ts` | edit_file 的 preview() 实现 |
| `src/tools/diff.ts` | `unifiedDiff()` — 系统 diff -u 封装 |
