# DeepSeek Arch

> DeepSeek Terminal Agent — Linux 终端 AI 助手

基于 Node.js + TypeScript 的终端对话工具，支持调用 DeepSeek API 进行多轮对话，
持久化保存对话历史（含 thinking 内容以命中 kv-cache），Token 消耗统计与费用计算。
支持 Agent Loop + Tool Calling：模型可自主调用 shell 等工具，结果自动送回继续对话。

## 快速开始

```bash
# 安装依赖
npm install

# 编译
npm run build

# 首次运行（自动创建默认配置文件 ~/.deepseek-arch/）
node dist/cli/index.js --version

# 查看帮助
node dist/cli/index.js --help
```

## 功能概览

- **Agent Loop**：模型可自主调用 shell 等工具，工具结果自动送回模型继续对话（最多 25 轮）
- **Tool Calling**：barrel file 注册模式，新增工具只需一个文件 + 一行 export
- **Shell 工具**：模型可直接执行 shell 命令（禁止 sudo，10min 超时），用户 y/N 确认后执行
- **四色渲染**：用户绿 / Think 灰 / 模型白 / 工具调用 cyan 竖线框
- **流式输出**：SSE 实时增量渲染，ESC/Ctrl+C 中断模型输出
- **多轮对话**：自动持久化 turn JSON（含 `reasoning_content` 命中 kv-cache + `tool_calls` 记录）
- **会话管理**：/title 命名、/clear 清屏、退出显示恢复命令
- **对话恢复**：按 ID 或标题恢复历史会话（含工具调用上下文重建）
- **Token 记录**：保存 API 返回的 `usage`，为后续费用计算预留
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
        └── turns.json
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
npm run build && node dist/cli/index.js --help

# 持续编译（修改后自动重新编译）
npm run dev

# 在另一个终端运行
node dist/cli/index.js chat
```

### 调试

```bash
# Node.js 内置调试器 + Chrome DevTools
node --inspect-brk dist/cli/index.js chat

# 调试测试文件
npx vitest --inspect-brk tests/core/config.test.ts
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
├── index.ts                # 库入口（export 类型/类）
├── cli/
│   ├── index.ts            # Commander CLI 主程序
│   ├── chat-ui.ts          # 全屏 TUI 对话界面
│   └── tui/                # 内联 TUI
│       ├── app.ts          # TuiApp 主应用
│       ├── conversation.ts # 对话历史渲染
│       ├── input-editor.ts # 多行输入编辑器
│       ├── renderer.ts     # ANSI 渲染工具
│       └── types.ts        # TUI 类型
├── core/
│   ├── config.ts           # ConfigManager（TOML 单例）
│   ├── storage.ts          # Storage（文件系统 Repository）
│   ├── api.ts              # ApiClient（DeepSeek API 适配器，实现 ModelProvider）
│   ├── model-provider.ts   # ModelProvider 接口（抽象层）
│   ├── mock-provider.ts    # MockProvider（本地伪装提供商）
│   └── session.ts          # SessionManager（Facade + Agent Loop）
├── tools/
│   ├── types.ts            # Tool 接口（name, description, parameters, execute）
│   ├── shell.ts            # Shell 执行工具
│   └── index.ts            # Barrel file（统一注册所有工具）
├── types/
│   ├── index.ts            # 类型重新导出
│   ├── chat.ts             # 消息与对话类型
│   ├── session.ts          # 会话类型
│   ├── config.ts           # 配置类型
│   ├── api.ts              # API 请求/响应类型
│   └── token.ts            # Token 用量类型
├── utils/                  # 工具函数
docs/                       # 模块设计文档
data/                       # 运行时数据（git-ignored）
```

测试文件统一放在独立的 `tests/` 目录下，镜像 `src/` 的目录结构：

```
tests/
├── core/
│   ├── config.test.ts
│   ├── storage.test.ts
│   ├── api.test.ts
│   ├── session.test.ts
│   └── mock-provider.test.ts
├── cli/
│   └── index.test.ts
└── utils/
    └── throttle.test.ts
```

测试总数：**8 个测试文件，119 条测试用例**。设计文档见 [docs/test-separation-and-mock-provider.md](./docs/test-separation-and-mock-provider.md)。

---

## 工具系统（Tools）

模型可通过 Tool Calling 调用工具。采用 barrel file 注册模式：

| 工具 | 名称 | 说明 |
|------|------|------|
| Shell 执行 | `execute_command` | 在会话目录执行 shell 命令（需用户 y/N 确认，禁止 sudo，10min 超时） |
| 读取文件 | `read_file` | 读取文本文件，支持 offset/limit 分段读取 |
| 内容搜索 | `search_content` | 多关键词 OR 搜索，上下文行显示，glob 过滤 |
| 写入文件 | `write_file` | 创建/覆盖文件，diff 预览后确认，原子写入 |
| 精确编辑 | `edit_file` | 精确字符串替换（不用行号），唯一性检查，diff 预览后确认 |

### 新增工具

1. 创建 `src/tools/xxx.ts`，导出具名 `Tool` 对象
2. 在 `src/tools/index.ts` 加一行 `export { xxxTool } from './xxx.js';`

```typescript
import type { Tool, ToolResult } from './types.js';

export const xxxTool: Tool = {
  name: 'my_tool',
  description: '工具描述（模型可见）',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresConfirm: false,
  async execute(params): Promise<ToolResult> {
    return { content: 'result' };
  },
};
```

**确认机制**：`requiresConfirm: true` 的工具（如 shell）执行前会弹出 `Execute? [y/N]` 确认。拒绝执行后 Agent Loop 立刻终止，控制权交还用户。

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
- [ ] `chat-ui` 测试策略已确认：见 [docs/chat-ui-testing.md](./docs/chat-ui-testing.md)
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
| [docs/types-modules.md](./docs/types-modules.md) | 类型拆分设计 |
| [docs/test-separation-and-mock-provider.md](./docs/test-separation-and-mock-provider.md) | 测试目录分离 + 伪装模型提供商设计 |
| [docs/cli.md](./docs/cli.md) | CLI 设计 |
| [docs/types.md](./docs/types.md) | 类型体系设计 |
| [docs/file-edit-tools.md](./docs/file-edit-tools.md) | 文件修改工具设计（write/edit + diff + 确认流程） |

## 版本

- 作者：helcksun
- 当前版本：v1.0.1
- 许可证：MIT
