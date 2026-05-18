# 架构设计

> 最后更新：2026-05-18 · v0.4.0

## 概述

deepseek-arch 是一个 Linux 终端 AI 助手，基于 Node.js + TypeScript (ESM)，通过 DeepSeek API 进行多轮对话，支持流式输出和异步交互。

## 分层架构

```
┌─────────────────────────────────────────────────┐
│                  CLI Layer                       │
│  Commander.js: --version, --help, chat, resume   │
│  src/cli/index.ts                                │
│  ChatUI: 全屏 TUI + 流式状态机 + 输入队列         │
│  src/cli/chat-ui.ts                              │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│             SessionManager (Facade)              │
│  协调 ApiClient + Storage + TokenCalculator      │
│  流式: sendMessageStream → onEvent 回调           │
│  src/core/session.ts (Phase 5)                   │
└──┬──────────────┬──────────────┬────────────────┘
   │              │              │
┌──▼──────┐ ┌─────▼──────┐ ┌────▼───────────┐
│ConfigMgr│ │  Storage   │ │  ApiClient     │
│(Singleton│ │(Repository)│ │  (Adapter)     │
│TOML r/w) │ │JSON 文件   │ │  fetch + SSE   │
└─────────┘ └────────────┘ └────┬───────────┘
                                │
                     ┌──────────▼──────────┐
                     │  TokenCalculator    │
                     │  费用计算 + 缓存统计  │
                     │  (Phase 7 — 待实现)  │
                     └─────────────────────┘
```

**依赖方向**：CLI → SessionManager → {ConfigManager, Storage, ApiClient, TokenCalculator}。无循环依赖。

## 模块职责

| 模块 | 文件 | 职责 | 状态 |
|------|------|------|------|
| **CLI (Commander)** | `src/cli/index.ts` | Commander.js 命令行解析，注册子命令 | ✅ |
| **ChatUI** | `src/cli/chat-ui.ts` | 全屏 TUI，流式状态机 (IDLE/SENDING/STREAMING)，输入队列，ANSI 渲染，Spinner | ✅ |
| **ConfigManager** | `src/core/config.ts` | TOML 多文件加载，文件跳转引用，持久化读写 | ✅ |
| **Storage** | `src/core/storage.ts` | 文件系统存储，sessions 目录 + 单文件 turns.json | ✅ |
| **Types** | `src/core/types.ts` | 全部领域类型定义（无行为） | ✅ |
| **ApiClient** | `src/core/api.ts` | DeepSeek Chat Completion API 调用，非流式 + 流式 (SSE 解析) | ✅ |
| **SessionManager** | `src/core/session.ts` | 对话生命周期管理（Facade），非流式 + 流式发送 | ✅ |
| **TokenCalculator** | `src/core/token-counter.ts` | 费用计算、缓存命中率 | ❌ Phase 7 |

## 设计模式

| 模式 | 应用 |
|------|------|
| **Singleton** | ConfigManager — 全局唯一配置实例 |
| **Repository** | Storage — 封装数据访问，隐藏存储细节 |
| **Facade** | SessionManager — 统一入口，协调多个子系统 |
| **Adapter** | ApiClient — 封装第三方 API，隔离变化 |
| **状态机** | ChatUI — IDLE → SENDING → STREAMING → IDLE |

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
| 测试 | vitest v4 | 单元测试 + e2e |
| 覆盖率 | @vitest/coverage-v8 | 目标 ≥ 80% |

## ChatUI 流式状态机

```
IDLE ── Enter ──► SENDING (spinner 旋转)
                    │
                    ├── first reasoning_delta  → phase=reasoning
                    ├── first content_delta   → STREAMING (停 spinner)
                    │
                    ├── done  → IDLE (显示 token 摘要)
                    ├── error → IDLE
                    └── ESC/Ctrl+C → abort → IDLE + 标记 `[已中断]`
```

流式期间：
- 普通按键 → 继续编辑输入框
- Enter → 加入输入队列 (`inputQueue`)，显示 `⏳ 等待中 (N 条)...`
- Ctrl+C/ESC → 中断流式输出
- /exit, /clear 等命令 → 排队等待流式完成后执行

## 中断处理

中断的不完整轮次保留在显示（标记 `[已中断]`），持久化为 `interrupted: true`，不会被 `buildMessages()` 包含进下一轮请求。

## 当前测试覆盖

| 文件 | 测试数 | 状态 |
|------|--------|------|
| `src/core/config.test.ts` | 12 | ✅ |
| `src/core/storage.test.ts` | 25 | ✅ |
| `src/core/session.test.ts` | 20 (含 5 流式) | ✅ |
| `src/core/api.test.ts` | 24 (含 10 流式) | ✅ |
| `src/cli/index.test.ts` | 10 | ✅ |
| **总计** | **91** | ✅ |
