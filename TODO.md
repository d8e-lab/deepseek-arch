# TODO — 持久化任务清单

> 最后更新：2026-05-18

## 已完成

### Phase 1 — 项目骨架 (v0.1.0)

- [x] 1.1 初始化 npm 项目（package.json, tsconfig.json, vitest.config.ts）
- [x] 1.2 安装核心依赖（commander, smol-toml, uuid, chalk, vitest）
- [x] 1.3 创建目录结构 + .gitignore
- [x] 1.4 定义核心类型（types.ts）
- [x] 1.5 实现 ConfigManager + 单元测试（12 tests）
- [x] 1.6 CLI 入口（--version, --help, chat/resume 子命令骨架）+ e2e 测试（8 tests）
- [x] 1.7-1.9 文档（agent.md, TODO.md, README.md）
- [x] 1.10 默认配置文件模板（~/.deepseek-arch/*.toml）
- [x] 1.11 Git init + v0.1.0 tag

### Phase 2 — 文件系统存储层 (v0.2.0 → v0.2.1)

- [x] 2.1 实现 Storage 类（Repository 模式）/ 23 tests
- [x] 2.2 文件系统存储：sessions/<id>/meta.json + turn-NNN.json
- [x] 2.3 移除 better-sqlite3、toml 依赖 / 纯 node:fs/promises
- [x] 2.4 类型重构：TurnRecord 替代 MessageRecord/TokenUsageRecord
- [x] 2.5 ConfigManager: paths.db → paths.sessions
- [x] 全量 43 tests passed / v0.2.1

### Phase 3 — API 客户端 ✅ (2026-05-17)

- [x] 3.1 实现 ApiClient 类（fetch + 非流式 Chat Completion）
- [x] 3.2 从 ConfigManager 读取 provider/base_url/api_key/model
- [x] 3.3 单轮对话功能（发送消息、接收回复）
- [x] 3.4 ApiClient 单元测试（14 tests）

### Phase 5 — 多轮对话 + 持久化 ✅ (2026-05-17)

- [x] 5.1 SessionManager（Facade 模式，协调 ApiClient + Storage）— 15 tests
- [x] 5.2 对话循环（全屏 TUI + 原始模式输入，/exit /clear /title 命令）— ChatUI
- [x] 5.3 每轮对话自动保存为 turn JSON（含 reasoning_content）
- [x] 5.4 system prompt 从配置加载 — SessionManager.setSystemPrompt()
- [x] 5.5 SessionManager 单元测试（15 tests）

### Phase 4 — 流式输出 ✅ (2026-05-18)

- [x] 4.1 SSE 流式解析（text/event-stream）— ApiClient.chatStream() + 超时 + 重试
- [x] 4.2 reasoning_content 流式接收与终端增量展示 — ChatUI 状态机 + spinner
- [x] 4.3 usage 信息从最后一个 chunk 提取
- [x] 4.4 流式期间异步交互 — ESC/Ctrl+C 中断 + 输入队列 + 等待标识
- [x] 4.5 流式输出单元测试 — ApiClient (10 tests) + SessionManager (5 tests)

### Phase 6 — 对话恢复 ✅ (2026-05-18)

- [x] 6.1 resume 子命令实现
- [x] 6.2 无参数：展示会话列表（序号、标题、轮次、更新时间）+ 用户输入序号选择
- [x] 6.3 --id 精确匹配 + 未找到时报错退出（exit 1）
- [x] 6.4 --name 精确匹配 + 未找到时报错退出（exit 1）
- [x] 6.5 退出时显示恢复命令（ChatUI.printExitSummary 已实现）
- [x] 6.6 resume 单元测试（10 tests, 含 --id/--name 错误处理 + 无参数列表/空列表）

---

## 待完成

### Phase 7 — Token 统计 + 费用计算

- [ ] 7.1 TokenCalculator 实现（从 pricing.toml 读取价格）
- [ ] 7.2 缓存命中率计算（hit / (hit + miss)）
- [ ] 7.3 费用计算（¥，精度 4 位小数）
- [ ] 7.4 退出时展示汇总：输入/输出/cache命中/cache未命中/命中率/本轮费用/累计费用
- [ ] 7.5 TokenCalculator 单元测试

### Phase 8 — 完善

- [ ] 8.1 模块设计文档（docs/architecture.md 等）
- [ ] 8.2 边界情况处理 + 错误提示优化
- [ ] 8.3 整体测试 + 覆盖率验证（≥ 80%）

---

### Phase 9 — 测试目录分离 + ModelProvider 抽象 ✅ (2026-05-19)

- [x] 9.1 测试文件从 `src/` 迁移到独立 `tests/` 目录（6 文件）
- [x] 9.2 `vitest.config.ts` 扫描范围改为 `tests/**/*.test.ts`
- [x] 9.3 新增 `ModelProvider` 接口 (`src/core/model-provider.ts`)
- [x] 9.4 新增 `MockProvider` 实现 (`src/core/mock-provider.ts`)
- [x] 9.5 `ApiClient` 实现 `ModelProvider` 接口
- [x] 9.6 `SessionManager` 从依赖 `ApiClient` 改为依赖 `ModelProvider`
- [x] 9.7 MockProvider 单元测试（26 tests）
- [x] 9.8 修复 2 个预存测试 bug
- [x] 9.9 文档同步（README, agent.md, docs/architecture.md, docs/refactoring-analysis.md）
- [x] 全量 117 tests passed，`tsc --noEmit` 零错误

### Phase 10 — Agent Loop + Tool Calling ✅ (2026-06-05)

- [x] 10.1 Tool 接口定义（`src/tools/types.ts`）— Tool/ToolResult/ToolCallRecord
- [x] 10.2 Shell 工具实现 — sudo 禁止、目录限制、10min 超时、输出截断
- [x] 10.3 Barrel file 注册模式（`src/tools/index.ts`）
- [x] 10.4 API 类型扩展 — `tools`/`tool_choice`/`tool_calls`/`ToolCall` 等
- [x] 10.5 Agent Loop — `sendMessageStream` 内 while 循环（最多 25 轮）
- [x] 10.6 用户确认机制 — requiresConfirm + onConfirm 回调 + y/N 提示
- [x] 10.7 拒绝执行后终止 agent loop
- [x] 10.8 Tool Calls 持久化 — Storage.saveTurn 写入 tool_calls, resume 重建
- [x] 10.9 TUI 四色渲染 — cyan 工具调用/结果, 竖线框区分
- [x] 10.10 文档更新 — README/TODO/docs/architecture.md

- [x] 9.1 测试文件从 `src/` 迁移到独立 `tests/` 目录（6 文件）
- [x] 9.2 `vitest.config.ts` 扫描范围改为 `tests/**/*.test.ts`
- [x] 9.3 新增 `ModelProvider` 接口 (`src/core/model-provider.ts`)
- [x] 9.4 新增 `MockProvider` 实现 (`src/core/mock-provider.ts`)
- [x] 9.5 `ApiClient` 实现 `ModelProvider` 接口
- [x] 9.6 `SessionManager` 从依赖 `ApiClient` 改为依赖 `ModelProvider`
- [x] 9.7 MockProvider 单元测试（26 tests）
- [x] 9.8 修复 2 个预存测试 bug
- [x] 9.9 文档同步（README, agent.md, docs/architecture.md, docs/refactoring-analysis.md）
- [x] 全量 117 tests passed，`tsc --noEmit` 零错误

---

## 版本历史

| Tag | 内容 |
|-----|------|
| v0.1.0 | 项目骨架：CLI + ConfigManager + 类型定义 + 文档 |
| v0.2.0 | SQLite 存储层：sessions/messages/token_usage 三表 CRUD |
| v0.2.1 | **重构**：文件系统存储（sessions 目录 + turn JSON），移除 better-sqlite3 |
| v0.2.2 | Phase 6: resume 功能（--id/--name/无参数列表选择），Storage 单文件 turns.json，tool role 预留 |
| v0.3.0 | 修复 resume 显示 bug（历史回合渲染），Storage 仅保留最后一轮 usage |
| v0.4.0 | Phase 4: 流式输出 (SSE) — 增量渲染、spinner、ESC中断、输入队列、超时重试 |
| v0.5.0 | Phase 10: Agent Loop + Tool Calling — shell 工具、用户确认、barrel file 注册、cyan 竖线渲染 |
