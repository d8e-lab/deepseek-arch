# DeepSeek Arch — 模型行为约定

> 每次任务开始前，请先阅读本文。

## 开发守则

1. **设计先行**：编码前完成设计工作，遵循面向对象设计模式。
2. **代码质量**：注意封装与耦合，保持模块职责单一。每个模块须配备对应的单元测试，核心模块覆盖率 ≥ 80%。
3. **Git 规范**：积极提交，commit message 说明变更内容；大功能更新打 version tag（语义化版本 vMAJOR.MINOR.PATCH）。
4. **Wiki 维护**：及时更新 `docs/` 下的项目文档，方便其他开发者上手。
5. **TODO 同步**：任务拆解完成后更新 `TODO.md`，保持与当前进度一致。
6. **配置外置**：避免硬编码，所有可配置项放入 `~/.deepseek-arch/` 下的 TOML 文件。
7. **安全约束**：
   - 禁止修改 `/mnt` 和根目录 `/`
   - 仅允许读写 home 目录（用于配置和对话存储）
   - 工作目录内的文件操作无限制
8. **制表符缩进**：尽量使用缩进长度为4的制表符

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

- 当前仓库仍采用源文件同目录测试，命名为 `<module>.test.ts`
- 如果后续迁移到独立 `tests/` 目录，需要同步更新 `vitest.config.ts`、`tsconfig.json` 和 README
- 核心模块覆盖率目标：lines/branches/functions/statements ≥ 80%
- 运行：`npm test`（单次）、`npm run test:watch`（持续）

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
