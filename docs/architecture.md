# 架构设计

> 最后更新：2026-05-17 · v0.2.1

## 概述

deepseek-arch 是一个 Linux 终端 AI 助手，基于 Node.js + TypeScript (ESM)，通过 DeepSeek API 进行多轮对话。

## 分层架构

```
┌─────────────────────────────────────────────────┐
│                  CLI Layer                       │
│  Commander.js: --version, --help, chat, resume   │
│  src/cli/index.ts                                │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│             SessionManager (Facade)              │
│  协调 ApiClient + Storage + TokenCalculator      │
│  src/core/session.ts (Phase 5)                   │
└──┬──────────────┬──────────────┬────────────────┘
   │              │              │
┌──▼──────┐ ┌─────▼──────┐ ┌────▼───────────┐
│ConfigMgr│ │  Storage   │ │  ApiClient     │
│(Singleton│ │(Repository)│ │  (Adapter)     │
│TOML r/w)│ │JSON 文件   │ │  fetch + SSE   │
└─────────┘ └────────────┘ └────┬───────────┘
                                │
                     ┌──────────▼──────────┐
                     │  TokenCalculator    │
                     │  费用计算 + 缓存统计  │
                     └─────────────────────┘
```

**依赖方向**：CLI → SessionManager → {ConfigManager, Storage, ApiClient, TokenCalculator}。无循环依赖。

## 模块职责

| 模块 | 文件 | 职责 | 状态 |
|------|------|------|------|
| **CLI** | `src/cli/index.ts` | Commander.js 命令行解析，注册子命令 | ✅ |
| **ConfigManager** | `src/core/config.ts` | TOML 多文件加载，文件跳转引用，持久化读写 | ✅ |
| **Storage** | `src/core/storage.ts` | 文件系统存储，sessions 目录 + turn JSON | ✅ |
| **Types** | `src/core/types.ts` | 全部领域类型定义（无行为） | ✅ |
| **ApiClient** | `src/core/api.ts` | DeepSeek Chat Completion API 调用 | ❌ Phase 3 |
| **SessionManager** | `src/core/session.ts` | 对话生命周期管理（Facade） | ❌ Phase 5 |
| **TokenCalculator** | `src/core/token-counter.ts` | 费用计算、缓存命中率 | ❌ Phase 7 |

## 设计模式

| 模式 | 应用 |
|------|------|
| **Singleton** | ConfigManager — 全局唯一配置实例 |
| **Repository** | Storage — 封装数据访问，隐藏存储细节 |
| **Facade** | SessionManager — 统一入口，协调多个子系统 |
| **Adapter** | ApiClient — 封装第三方 API，隔离变化 |

## 数据流

```
用户输入 (CLI)
  │
  ▼
SessionManager.sendMessage(content)
  │
  ├─► Storage.getTurns(sessionId)    → 加载历史
  ├─► ConfigManager.get("systemPrompts.xxx") → system prompt
  ├─► ApiClient.chat(messages)       → 调用 API
  ├─► TokenCalculator.calculate(usage) → 计费
  └─► Storage.saveTurn(...)         → 持久化
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
        ├── meta.json
        └── turn-NNN.json
```

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js v24 + TypeScript ESM | `"type": "module"` |
| CLI | Commander.js v14 | 子命令、--help、--version |
| 配置 | smol-toml | TOML 解析与序列化 |
| 存储 | node:fs/promises | JSON 文件读写，零外部依赖 |
| HTTP | fetch (built-in) | Phase 3 引入 |
| UUID | uuid v14 | 会话 ID 生成 |
| 终端 | chalk v5 | 彩色输出（待用） |
| 测试 | vitest v4 | 单元测试 + e2e |
| 覆盖率 | @vitest/coverage-v8 | 目标 ≥ 80% |

## 当前测试覆盖

| 文件 | 测试数 | 状态 |
|------|--------|------|
| `src/core/config.test.ts` | 12 | ✅ |
| `src/cli/index.test.ts` | 8 | ✅ |
| `src/core/storage.test.ts` | 23 | ✅ |
| **总计** | **43** | ✅ |
