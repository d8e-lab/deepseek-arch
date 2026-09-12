# 执行计划：Subagent 会话化 + 全双工 TUI

## 需求（已确认）

1. **方案 B 子代理会话化**：SubagentSession 对象（name/status/messages/entries/result/controller），消息全量持久化到 record，resume 后可从磁盘恢复 completed/failed 会话继续交互。
2. **全双工输入**：模型输出期间 `/` 命令立即执行（安全命令；`/compact` 提示不可用）；普通文本/`!shell` 进入队列（**不中断**当前输出，输出结束后自动发送）。
3. **命令结果区**：命令输出不写 scrollback，进入输入区上方的固定区域（最多 6 行，超出截断提示），新命令替换旧内容；**发送普通消息后清空**。
4. **subagent 总览视图**（Ctrl+T 全屏）：顶部状态条（无进度条，只显示 `● running`/`✓ completed`/`✗ failed` + 耗时），主区域实时显示选中 subagent 输出，底部输入区发送给当前选中；导航 `n`=next、`p`=previous、`1-3`=跳转、`q/ESC`=返回 master；master 后台静默缓冲，切回补渲染。
5. **master→subagent 工具**：`subagent_send`（同步语义；completed/failed 可发，running/cancelled 拒绝）。

## 架构

- `runSubagentLoop` 重构：`(messages) → { result, messages }`，消息所有权上移。
- `src/core/subagent-session.ts`（新）：SubagentSession 类，drive/send/cancel/toRecord/fromRecord。
- SessionManager：`Map<string, SubagentSession>` 取代 pendingSubagents；`sendToSubagent()`。
- 持久化：每次 finish 覆盖写 record（含完整 messages）；resume 从磁盘恢复。
- TUI：viewerMode 扩展（conversation | subagents）；流式 stdinHandler 全双工改造；命令结果区（commandResultLines + 重绘）。

## 分期

- **S1** runSubagentLoop 可恢复 + SubagentSession + SessionManager 会话化 + 持久化 → 现有 subagent 测试全绿 + 新单测
- **S2** subagent_send 工具 + 拦截 → 单测覆盖守卫
- **S3** TUI 全双工 + 命令结果区 → 手动验证 + 单测
- **S4** subagent 总览视图 + 视图内输入 + 焦点切换 → 手动验证
- **S5** 全量测试 + 文档同步

## 设计约束（用户确认）

- 状态条无进度条
- n=next, p=previous
- 命令结果区固定底部、替换式刷新、限高 6 行、发送消息后清空
- 命令输出不进 scrollback（全双工/空闲一致）
