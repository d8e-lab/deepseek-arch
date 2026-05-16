# DeepSeek Arch

> DeepSeek Terminal Agent — Linux 终端 AI 助手

基于 Node.js + TypeScript 的终端对话工具，支持调用 DeepSeek API 进行多轮对话，
持久化保存对话历史（含 thinking 内容以命中 kv-cache），Token 消耗统计与费用计算。

## 快速开始

```bash
# 安装依赖
npm install

# 编译
npm run build

# 首次运行（自动创建默认配置文件 ~/.deepseek-arch/）
node dist/index.js --version

# 查看帮助
node dist/index.js --help
```

## 功能概览

- **多轮对话**：持久化保存完整对话历史（含 `reasoning_content`），命中供应商 prompt kv-cache
- **对话恢复**：按 ID 或标题恢复历史会话（`resume` 子命令）
- **Token 统计**：实时记录 token 消耗、缓存命中/未命中、命中率、费用（¥）
- **配置外置**：TOML 文件管理，支持文件间跳转引用，避免硬编码
- **安全隔离**：仅操作 home 目录和项目工作目录

## 命令行

```
deepseek-arch [options] [command]

Options:
  -V, --version     版本信息（含作者、日期）
  -h, --help        帮助信息

Commands:
  chat [options]    开始新对话
  resume [options]  恢复历史对话
```

## 配置

首次运行自动在 `~/.deepseek-arch/` 创建默认配置：

```
~/.deepseek-arch/
├── config.toml           # 主配置
├── providers.toml        # API 密钥与地址
├── pricing.toml          # 模型价格
├── system-prompt.toml    # System Prompt 模板
└── data.db               # SQLite 对话数据
```

配置 `~/.deepseek-arch/providers.toml` 中的 `api_key` 后即可使用。

## 开发

> 开发前请先阅读 [agent.md](./agent.md) 了解行为约定。

```bash
# 运行测试
npm test

# 持续测试
npm run test:watch

# 覆盖率
npm run test:coverage
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript (ESM) |
| CLI | Commander.js |
| 数据库 | better-sqlite3 |
| 配置 | TOML（smol-toml） |
| 测试 | vitest + @vitest/coverage-v8 |

## 版本

- 作者：helcksun
- 当前版本：v0.1.0
- 许可证：MIT
