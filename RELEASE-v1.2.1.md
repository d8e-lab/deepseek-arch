# Release v1.2.1

## v1.2.1 — plan_on/save_plan 工具（2026-06）

### 新增

- **`plan_on` 工具**：模型判断任务复杂时主动调用，注入结构化编码规划框架（Comprehend → Orient → Decide → Self-check → Act → Verify），指导模型分阶段完成复杂任务的拆解与执行
- **`save_plan` 工具**：用户确认计划后调用，将规划文档持久化到 `<workspace>/.plans/<name>.md`，`requiresConfirm: true` 确保用户可见写入内容
- **skill 文件自动部署**：首次运行时将 `skill/plan.skill.md` 复制到 `~/.deepseek-arch/skill/`，用户可自定义
- **system prompt 指引**：在现有 Task Workflow 中补充 `plan_on` 和 `save_plan` 的使用时机

### v1.1.0 → v1.2.0 的增量（未单独发版，合并到 v1.2.1）

#### 新功能

- **Shell 流式输出**：`execute_command` 改用 `spawn` 实现实时流式渲染，支持 `\r` 进度条（200ms 超时兜底），TUI 实时显示 stdout/stderr
- **交互式命令拦截**：自动检测 vim/top/python 等交互式命令，阻止无 TTY 执行
- **粘贴增强**：多行粘贴自动折叠为 `#N` 标记（≥5 行），小于 5 行直接展开；跨平台 `\r\n` 归一化；Backspace 原子删除整个标记
- **Shell 命令模式**：输入 `!` 进入 shell 模式（粉紫色背景），执行结果注入对话上下文但不可见
- **Markdown 表格渲染**：终端 box-drawing 格式美化 markdown 表格
- **/help /context /yolo 命令**：查看帮助/会话上下文/切换 YOLO 模式
- **/yolo 模式**：跳过所有工具执行确认（auto-approve），通过 CLI `--yolo` 或 `/yolo` 命令切换
- **clear 子命令**：删除除最近 10 条外的所有会话

#### 改进

- Tool 接口新增可选 `onOutput` 回调 + `StreamEvent.tool_output` 类型
- 输入区域：`!` 保留在输入框可见，退格删光后自动退出 shell 模式恢复灰色背景
- TUI 渲染：InputEditor 支持显示宽度软换行，超长行不再被截断

#### 修复

- `!` 执行时去掉前导感叹号
- 修正 CLI 测试入口路径为 `dist/cli/index.js`
- Phase 3 增加前置 git 分支/commit 强制步骤，防止跳过安全网直接改代码

---

## v1.0.0 → v1.1.0

### 新功能

- **/model 命令**：在对话中切换模型（`deepseek-v4-flash` / `deepseek-v4-pro`）
- **KV Cache 监控**：Agent loop 轮间缓存命中率记录 + 日志文件 + 验证脚本
- **文件 staleness 检查**：防止模型基于过时内容编辑文件
- **Agent loop 消息序列持久化**：精确回放 KV cache 前缀，命中缓存提升性能
- **Resume 改进**：使用持久化的 system prompt 而非重建，恢复缓存命中能力

### 改进

- InputEditor 软换行支持
- 移除废弃的 ChatUI 及相关组件（减少约 1000 行死代码）
- 中断路径与拒绝路径对齐：Ctrl+C 中断工具执行与用户拒绝走同一路径

### 修复

- Ctrl+C 中断 shell 工具执行
- tool error 不回传给模型的路径问题
- raw mode TUI 输入区域内容上移和重复渲染 bug
- edit_file 匹配失败时附带诊断信息
- npm 包包含 system_prompt.txt
