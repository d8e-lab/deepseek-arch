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

- **全屏 TUI**：独立终端界面，灰底多行输入面板（Ctrl+Enter 换行），三色渲染（用户绿/think灰/回复白），中文原生支持
- **流式输出**：SSE 实时增量渲染，spinner 动画提示等待，ESC/Ctrl+C 中断模型输出
- **异步交互**：流式输出期间不阻塞输入，支持输入队列（等待标识），发送后立即继续编辑
- **超时重试**：可配置请求超时（默认 120s）与自动重试（指数退避，默认 2 次）
- **多轮对话**：自动持久化 turn JSON（含 `reasoning_content` 命中 kv-cache）
- **会话管理**：/title 命名、/clear 清屏、退出显示恢复命令
- **对话恢复**：按 ID 或标题恢复历史会话（`resume` 子命令）
- **Token 统计**：实时记录 token 消耗、缓存命中/未命中、命中率
- **配置外置**：TOML 文件管理，支持文件间跳转引用
- **安全隔离**：操作范围限于 home 目录和项目工作目录

## 命令行

```
deepseek-arch [options] [command]

Options:
  -V, --version     版本信息（含作者、日期）
  -h, --help        帮助信息

Commands:
  chat [options]    开始新对话（全屏 TUI）
  resume [options]  恢复历史对话

chat 命令可用快捷键：
  Enter           发送消息
  Ctrl+Enter/J    换行
  Ctrl+C          退出
  Ctrl+L          清屏
  /exit           退出
  /clear          清屏
  /title <name>   命名会话
```

## 配置

首次运行自动在 `~/.deepseek-arch/` 创建默认配置：

```
~/.deepseek-arch/
├── config.toml           # 主配置（含 [paths] 文件跳转）
├── providers.toml        # API 密钥与地址
├── pricing.toml          # 模型价格（¥/1M tokens）
├── system-prompt.toml    # System Prompt 模板
└── sessions/             # 对话数据（文件系统存储）
    └── <uuid>/
        ├── meta.json
        └── turn-NNN.json
```

配置 `~/.deepseek-arch/providers.toml` 中的 `api_key` 后即可使用。

---

## 开发

> 开发前请先阅读 [agent.md](./agent.md) 了解行为约定。

### 环境要求

| 组件 | 最低版本 |
|------|---------|
| Node.js | ≥ 18（推荐 v24） |
| npm | ≥ 9 |

### 从源码构建

```bash
git clone <repo-url>
cd deepseek-arch
npm install
npm run build          # TypeScript → dist/
```

### 运行

```bash
# 开发模式（直接运行编译结果）
npm run build && node dist/index.js --help

# 持续编译（修改后自动重新编译）
npm run dev

# 在另一个终端运行
node dist/index.js chat
```

### 调试

```bash
# Node.js 内置调试器 + Chrome DevTools
node --inspect-brk dist/index.js chat

# 调试测试文件
npx vitest --inspect-brk src/core/config.test.ts
```

然后在 Chrome 打开 `chrome://inspect` 连接调试器。

### 测试

```bash
# 单次运行全部测试
npm test

# 持续监听模式（文件变更自动重跑）
npm run test:watch

# 覆盖率报告
npm run test:coverage
```

覆盖率报告输出到 `coverage/` 目录，用浏览器打开 `coverage/index.html` 查看。

### 项目结构

```
src/
├── index.ts                # 入口
├── cli/
│   ├── index.ts            # Commander CLI 主程序
│   ├── index.test.ts       # CLI e2e 测试
│   ├── chat-ui.ts          # 全屏 TUI 对话界面
│   └── commands/           # 子命令实现（待完成）
├── core/
│   ├── types.ts            # 领域类型定义
│   ├── config.ts           # ConfigManager（TOML 单例）
│   ├── config.test.ts      # ConfigManager 测试
│   ├── storage.ts          # Storage（文件系统 Repository）
│   ├── storage.test.ts     # Storage 测试
│   ├── api.ts              # ApiClient（DeepSeek API 适配器）
│   ├── api.test.ts         # ApiClient 测试
│   ├── session.ts          # SessionManager（Facade）
│   ├── session.test.ts     # SessionManager 测试
│   └── token-counter.ts    # TokenCalculator（Phase 7）
├── utils/                  # 工具函数
docs/                       # 模块设计文档
data/                       # 运行时数据（git-ignored）
```

---

## 发行（打包分发）

### 方式一：npm link（开发/本地使用）

```bash
npm run build
npm link                  # 注册全局命令 deepseek-arch
deepseek-arch --version   # 任意目录可用
npm unlink -g             # 卸载
```

### 方式二：npm pack（生成 .tgz）

```bash
npm run build
npm pack                  # 生成 deepseek-arch-0.2.1.tgz
npm install -g ./deepseek-arch-0.2.1.tgz   # 安装
```

### 方式三：单文件可执行（实验性）

使用 [Bun](https://bun.sh) 或 [pkg](https://github.com/vercel/pkg) 打包为独立可执行文件：

```bash
# Bun（推荐，跨平台）
bun build src/index.ts --compile --outfile deepseek-arch

# 或使用 esbuild 打包
npx esbuild src/index.ts --bundle --platform=node --outfile=dist/bundle.js
node dist/bundle.js --version
```

### 方式四：发布到 npm

```bash
npm run build
npm publish --access public
```

用户安装：`npm install -g deepseek-arch`

### 发布前检查清单

- [ ] 更新 `package.json` 版本号
- [ ] 更新 `src/cli/index.ts` 中的 `VERSION` / `RELEASE_DATE` 常量
- [ ] 全量测试通过：`npm test`
- [ ] 覆盖率达标：`npm run test:coverage`
- [ ] `git tag vX.Y.Z` 并推送

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript (ESM) |
| CLI | Commander.js |
| 存储 | node:fs/promises（文件系统 JSON） |
| 配置 | TOML（smol-toml） |
| 测试 | vitest + @vitest/coverage-v8 |
| UUID | uuid |

---

## 文档

| 文件 | 内容 |
|------|------|
| [agent.md](./agent.md) | 模型行为约定（开发守则、安全约束） |
| [TODO.md](./TODO.md) | 任务清单 + 版本历史 |
| [docs/architecture.md](./docs/architecture.md) | 整体架构设计 |
| [docs/config.md](./docs/config.md) | ConfigManager 设计 |
| [docs/storage.md](./docs/storage.md) | Storage 文件系统设计 |
| [docs/cli.md](./docs/cli.md) | CLI 设计 |
| [docs/types.md](./docs/types.md) | 类型体系设计 |

## 版本

- 作者：helcksun
- 当前版本：v0.4.0
- 许可证：MIT
