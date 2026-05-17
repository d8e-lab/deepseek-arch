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

### Phase 6 — 对话恢复 ✅ (2026-05-18)

- [x] 6.1 resume 子命令实现
- [x] 6.2 无参数：展示会话列表（序号、标题、轮次、更新时间）+ 用户输入序号选择
- [x] 6.3 --id 精确匹配 + 未找到时报错退出（exit 1）
- [x] 6.4 --name 精确匹配 + 未找到时报错退出（exit 1）
- [x] 6.5 退出时显示恢复命令（ChatUI.printExitSummary 已实现）
- [x] 6.6 resume 单元测试（10 tests, 含 --id/--name 错误处理 + 无参数列表/空列表）

---

## 待完成

### Phase 4 — 流式输出

- [ ] 4.1 SSE 流式解析（text/event-stream）
- [ ] 4.2 reasoning_content 流式接收与终端展示
- [ ] 4.3 usage 信息从最后一个 chunk 提取
- [ ] 4.4 流式输出单元测试

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

## 版本历史

| Tag | 内容 |
|-----|------|
| v0.1.0 | 项目骨架：CLI + ConfigManager + 类型定义 + 文档 |
| v0.2.0 | SQLite 存储层：sessions/messages/token_usage 三表 CRUD |
| v0.2.1 | **重构**：文件系统存储（sessions 目录 + turn JSON），移除 better-sqlite3 |
| v0.2.2 | Phase 6: resume 功能（--id/--name/无参数列表选择），Storage 单文件 turns.json，tool role 预留 |
| v0.3.0 | 修复 resume 显示 bug（历史回合渲染），Storage 仅保留最后一轮 usage |
