# 架构设计

> 最后更新：2026-06-10 · v0.6.0

## 概述

deepseek-arch 是一个 Linux 终端 AI 助手，基于 Node.js + TypeScript (ESM)，通过 DeepSeek API 进行多轮对话，支持流式输出和 Agent Loop + Tool Calling。

## 分层架构

```
┌──────────────────────────────────────────────────────────┐
│                      CLI Layer                            │
│  Commander.js: --version, --help, chat, resume            │
│  src/cli/index.ts                                         │
│  TuiApp: 内联 TUI + 流式渲染 + 工具确认                    │
│  src/cli/tui/app.ts                                       │
└────────────┬─────────────────────────────────┬───────────┘
             │                                 │
┌────────────▼──────────────┐  ┌───────────────▼───────────┐
│     SessionManager (Facade │  │      Tools (Barrel File)  │
│     + Agent Loop)          │  │  src/tools/               │
│  sendMessageStream → while │  │  ├── types.ts (Tool接口)  │
│  循环处理 tool_calls        │  │  ├── shell.ts             │
│  onConfirm 回调             │  │  └── index.ts (注册)      │
│  src/core/session.ts       │  └───────────────────────────┘
└──┬───────────┬──────────┬──┘
   │           │          │
┌──▼──┐  ┌────▼───┐  ┌──▼──────────────────┐
│Conf │  │Storage │  │ModelProvider (接口)   │
│igMgr│  │(Repo)  │  │src/core/model-       │
│(Sing│  │JSON文件 │  │provider.ts           │
│leton│  └────────┘  └──┬────────┬──────────┘
└─────┘                 │        │
              ┌─────────▼┐  ┌───▼───────────┐
              │ApiClient │  │  MockProvider  │
              │fetch+SSE │  │  本地伪装      │
              └──────────┘  └───────────────┘
```

**依赖方向**：CLI → SessionManager + Tools。SessionManager → {ConfigManager, Storage, ModelProvider}。Tools 无内部依赖。ApiClient/MockProvider 实现 ModelProvider 接口。无循环依赖。

## 模块职责

| 模块 | 文件 | 职责 | 状态 |
|------|------|------|------|
| **CLI (Commander)** | `src/cli/index.ts` | Commander.js 命令行解析，注册子命令，加载 Tools | ✅ |
| **TuiApp** | `src/cli/tui/app.ts` | 内联 TUI，流式渲染，工具确认 (y/N)，diff 着色 | ✅ |
| **ConfigManager** | `src/core/config.ts` | TOML 多文件加载，文件跳转引用，持久化读写 | ✅ |
| **Storage** | `src/core/storage.ts` | 文件系统存储，sessions 目录 + turns.json（含 tool_calls） | ✅ |
| **Types** | `src/types/` | 全部领域类型定义（含 ToolDefinition/ToolCall 等 API 类型） | ✅ |
| **ApiClient** | `src/core/api.ts` | DeepSeek Chat Completion API，非流式 + SSE 流式，tools 传递 | ✅ |
| **SessionManager** | `src/core/session.ts` | Facade + Agent Loop + preview→confirm→execute 流程 | ✅ |
| **Tools** | `src/tools/` | Barrel file 注册，5 个工具（shell/read/search/write/edit） | ✅ |
| **TokenCalculator** | `src/core/token-counter.ts` | 费用计算、缓存命中率 | ❌ Phase 7 |

## 设计模式

| 模式 | 应用 |
|------|------|
| **Singleton** | ConfigManager — 全局唯一配置实例 |
| **Repository** | Storage — 封装数据访问，隐藏存储细节 |
| **Facade** | SessionManager — 统一入口，协调多个子系统 + Agent Loop |
| **Adapter** | ApiClient — 封装第三方 API，隔离变化 |
| **Barrel File** | src/tools/index.ts — 统一注册工具，新增只需一行 export |
| **状态机** | TuiApp — IDLE → SENDING → STREAMING → CONFIRMING → IDLE |

## 数据流

### 非流式 (sendMessage)

```
用户输入 (CLI)
  │
  ▼
SessionManager.sendMessage(content)
  │
  ├─► buildMessages(content)  → 构建消息队列 (system + 历史 + 当前)
  ├─► ApiClient.chat(messages) → POST 请求
  ├─► Storage.saveTurn(...)   → 持久化 turn JSON
  └─► 返回 TurnRecord
```

### 流式 (sendMessageStream)

```
用户 Enter → ChatUI.handleEnter()
  │
  ├─► UIState = SENDING, spinner 启动
  ├─► sessionManager.sendMessageStream(content, onEvent, signal)
  │     │
  │     ├─► buildMessages(content)       → 跳过 interrupted 轮次
  │     ├─► apiClient.chatStream(messages, { signal, timeout, retries })
  │     │     │
  │     │     ├─► fetch POST (stream: true) → ReadableStream reader
  │     │     ├─► SSE 逐行解析 → yield StreamChunk
  │     │     └─► chunks → ChatUI 增量渲染 + spinner 停止
  │     │
  │     ├─► onEvent(reasoning_delta)      → 灰度追加思考文本
  │     ├─► onEvent(content_delta)        → UIState = STREAMING
  │     ├─► onEvent(done)                 → 持久化 turn + token 显示
  │     ├─► onEvent(error)                → 错误处理 / 中断回显
  │     └─► AbortController 中断          → 持久化 interrupted=true
  │
  ├─► 流完成后处理输入队列
  └─► UIState = IDLE
```

### Agent Loop (Tool Calling)

```
用户输入 → TuiApp.sendMessageStream()
  │
  ├─► sessionManager.sendMessageStream(content, onEvent, signal, onConfirm)
  │     │
  │     ├─► buildMessages(content)        → system + 历史（含 tool_calls 重建） + 当前
  │     └─► Agent Loop (最多 25 轮):
  │           │
  │           ├─► apiClient.chatStream(messages, { tools, signal })
  │           │     ├─► reasoning_delta   → onEvent → 灰度显示
  │           │     ├─► content_delta     → onEvent → 白色显示
  │           │     └─► tool_calls delta  → accumulateToolCalls()
  │           │
  │           ├─► 无 tool_calls → 持久化 turn → onEvent(done) → 结束
  │           │
  │           └─► 有 tool_calls:
  │                 ├─► onEvent(tool_call_start) → TUI 渲染 [T: xxx]
  │                 ├─► requiresConfirm? → onConfirm() → y/N 确认
  │                 ├─► 拒绝 → 终止 agent loop（不发送回模型）
  │                 ├─► tool.execute(args) → onEvent(tool_result)
  │                 ├─► 结果 push 到 messages → 继续循环
  │                 └─► 超过 25 轮 → 截断 → 持久化
  │
  └─► 持久化 turn（含 tool_calls[] 记录）
```

**确认流程**：`requiresConfirm: true` 的工具执行前，SessionManager 通过 `onConfirm` 回调询问 TUI。TUI 暂时接管 stdin，显示 `Execute? [y/N]`，等待单字符输入。拒绝后 agent loop 立刻终止，已执行的 tool 结果保留在上下文中。

## 配置体系

```
~/.deepseek-arch/
├── config.toml           # 主配置（含 [paths] 文件跳转）
├── providers.toml        # 模型供应商 base_url + api_key
├── pricing.toml          # 各模型价格（¥/1M tokens）
├── system-prompt.toml    # System Prompt 模板
└── sessions/             # 会话数据目录
    └── <uuid>/
        ├── meta.json     # 会话元数据 (含 lastUsage)
        └── turns.json    # 全部轮次单文件 (替代旧 turn-NNN.json 格式)
```

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js v24 + TypeScript ESM | `"type": "module"` |
| CLI | Commander.js v14 | 子命令、--help、--version |
| 配置 | smol-toml | TOML 解析与序列化 |
| 存储 | node:fs/promises | JSON 文件读写，零外部依赖 |
| HTTP | fetch (built-in) | SSE 流式解析，超时/重试 |
| UUID | uuid v14 | 会话 ID 生成 |
| 终端 | chalk v5 | 彩色输出，ANSI 转义序列 |
| 测试 | vitest v4 | 单元测试 + e2e（当前测试文件仍与源码同目录） |
| 覆盖率 | @vitest/coverage-v8 | 目标 ≥ 80% |

## TuiApp 状态机

```
IDLE ── Enter ──► SENDING
                    │
                    ├── reasoning_delta   → STREAMING
                    ├── content_delta     → STREAMING
                    │
                    ├── tool_call_start   → 渲染 [T: xxx]
                    ├── 需要确认? → CONFIRMING → y/N
                    │
                    ├── tool_result       → cyan 竖线渲染结果
                    ├── done              → IDLE (显示 token)
                    ├── error             → IDLE
                    └── Ctrl+C            → abort → IDLE + `[已中断]`
```

## 中断处理

中断的不完整轮次保留在显示（标记 `[已中断]`），持久化为 `interrupted: true`，不会被 `buildMessages()` 包含进下一轮请求。

## 当前测试覆盖

| 文件 | 测试数 | 状态 |
|------|--------|------|
| `tests/core/config.test.ts` | 12 | ✅ |
| `tests/core/storage.test.ts` | 25 | ✅ |
| `tests/core/session.test.ts` | 16 | ✅ |
| `tests/core/api.test.ts` | 24 | ✅ |
| `tests/core/mock-provider.test.ts` | 26 | ✅ |
| `tests/cli/index.test.ts` | 11 | ⚠️ 待更新 |
| `tests/utils/throttle.test.ts` | 4 | ✅ |
| **总计** | **119** | ✅ |
