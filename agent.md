# DeepSeek Arch — 模型行为约定

> 每次任务开始前，请先阅读本文。

## 开发守则

1. **设计先行**：编码前完成设计工作，遵循面向对象设计模式。
2. **代码质量**：注意封装与耦合，保持模块职责单一。每个模块须配备对应的单元测试，核心模块覆盖率 ≥ 80%。
3. **Git 规范**：积极提交，commit message 说明变更内容；大功能更新打 version tag（语义化版本 vMAJOR.MINOR.PATCH）。
4. **Wiki 维护**：每次更新及时维护 `docs/` 下的项目文档，方便其他开发者上手。
5. **TODO与readme 同步**：任务拆解完成后更新 `TODO.md`和`README.md`，保持与当前进度一致。
6. **配置外置**：避免硬编码，所有可配置项放入 `~/.deepseek-arch/` 下的 TOML 文件。
7. **安全约束**：
   - 禁止修改 `/mnt` 和根目录 `/`
   - 仅允许读写 home 目录（用于配置和对话存储）
   - 工作目录内的文件操作无限制
8. **制表符缩进**：尽量使用缩进长度为4的制表符

## Git 工作流

**启动新功能/修改前**：
1. `git stash` — 暂存当前工作区未提交的修改（如果有）
2. `git checkout -b feature/<name>` — 从 main 创建功能分支
3. 在分支上执行所有修改

**开发过程中**：
- 每完成一个逻辑步骤后 `git add` + `git commit`，保持 commit 粒度小、可回溯
- commit message 以中文描述变更内容和原因
- 不修改已发布的历史（不 rebase 已 push 的 commit）

**完成开发后**：
- 运行 `npm test` 确保全部测试通过
- `git checkout main && git merge feature/<name>` 合并回 main
- 仅在用户明确批准后执行 merge

**依赖 git 回滚**：
- 不额外做文件快照/备份
- 修改后的文件通过 `git diff` 查看变更
- 回滚通过 `git checkout -- <file>`（未提交）或 `git revert`（已提交）

**禁止操作**（需用户明确确认）：
- `git reset --hard` — 丢失未提交工作区修改，不可恢复
- `git clean -fd` — 删除未跟踪文件，不可恢复
- `git push --force` — 覆盖远端历史
- `git branch -D` — 强删分支（未 merge）

## 文件修改工具设计原则

1. **精确字符串匹配**：编辑文件使用 `old_string` + `new_string` 精确匹配替换（不用行号）。
2. **乐观并发**：不预检查文件变更；`old_string` 未找到或不唯一时报错，让模型重新读取。
3. **预览后确认**：所有写工具执行前生成 diff 预览，用户看过变更后再确认写入。
4. **原子写入**：先写临时文件再 rename，防止崩溃时写一半。
5. **不备份**：不创建 `.bak` 快照；依赖 git 管理变更历史。

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript (ESM) |
| CLI | Commander.js |
| 数据库 | better-sqlite3 |
| 配置 | TOML（smol-toml，支持文件间跳转引用） |
| 测试 | vitest + @vitest/coverage-v8 |
| 终端样式 | chalk |

## 测试约定

- 测试文件统一放在独立的 `tests/` 目录下，镜像 `src/` 的目录结构
- 测试文件命名为 `<module>.test.ts`
- 核心模块覆盖率目标：lines/branches/functions/statements ≥ 80%
- 运行：`npm test`（单次）、`npm run test:watch`（持续）
- vitest 配置只扫描 `tests/**/*.test.ts`

## 配置体系

```
~/.deepseek-arch/
├── config.toml           # 主配置（含 [paths] 文件跳转）
├── providers.toml        # 模型供应商
├── pricing.toml          # 价格（¥/1M tokens）
├── system-prompt.toml    # System Prompt 模板
└── sessions/             # 文件系统会话数据
```

> 说明：当前代码实际使用 `sessions/` + `turns.json` 文件存储，不再使用 SQLite。文档以源码为准。

## 版本信息

- 作者：helcksun
- 包名：deepseek-arch
- 当前版本：v0.4.0
- 默认模型：deepseek-v4-pro
