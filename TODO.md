# TODO — 持久化任务清单

> 最后更新：2026-05-16

## 已完成 (Phase 1)

- [x] 1.1 初始化 npm 项目（package.json, tsconfig.json, vitest.config.ts）
- [x] 1.2 安装核心依赖
- [x] 1.3 创建目录结构 + .gitignore
- [x] 1.4 定义核心类型（types.ts）
- [x] 1.5 实现 ConfigManager + 单元测试
- [x] 1.6 CLI 入口（--version, --help, 子命令骨架）+ e2e 测试
- [x] 1.7-1.9 文档（agent.md, TODO.md, README.md）
- [x] 1.10 默认配置文件模板
- [x] 1.11 Git init + v0.1.0 tag

## Phase 2 — SQLite 存储层

- [ ] 2.1 实现 Storage 类（Repository 模式）
- [ ] 2.2 sessions 表 CRUD
- [ ] 2.3 messages 表 CRUD（含 reasoning_content）
- [ ] 2.4 token_usage 表 CRUD
- [ ] 2.5 Storage 单元测试

## Phase 3 — API 客户端

- [ ] 3.1 实现 ApiClient 类（fetch + 非流式）
- [ ] 3.2 单轮对话功能
- [ ] 3.3 ApiClient 单元测试

## Phase 4 — 流式输出

- [ ] 4.1 SSE 流式解析
- [ ] 4.2 reasoning_content 流式接收
- [ ] 4.3 流式输出单元测试

## Phase 5 — 多轮对话 + 持久化

- [ ] 5.1 SessionManager（Facade 模式）
- [ ] 5.2 对话循环（readline）
- [ ] 5.3 实时保存对话历史（含 think 内容）
- [ ] 5.4 SessionManager 单元测试

## Phase 6 — 对话恢复

- [ ] 6.1 resume 子命令实现
- [ ] 6.2 无参数：展示列表 + 序号选择
- [ ] 6.3 --id 精确匹配 + 错误处理
- [ ] 6.4 --name 精确匹配 + 错误处理
- [ ] 6.5 resume 单元测试

## Phase 7 — Token 统计 + 费用计算

- [ ] 7.1 TokenCalculator 实现
- [ ] 7.2 缓存命中率计算
- [ ] 7.3 费用计算（¥）
- [ ] 7.4 退出时显示统计 + 恢复命令
- [ ] 7.5 TokenCalculator 单元测试

## Phase 8 — 完善

- [ ] 8.1 项目 Wiki（docs/）
- [ ] 8.2 边界情况处理
- [ ] 8.3 整体测试 + 覆盖率验证
