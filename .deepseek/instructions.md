# DeepSeek Arch — 项目交接文档

> 最后更新：2026-05-18 · v0.4.0
> 作者：helcksun
> 下次恢复时请先阅读本文。

## 项目简介

**deepseek-arch** — Linux 终端 AI 助手，Node.js + TypeScript (ESM)，调用 DeepSeek API 进行多轮对话。

## 当前进度

已完成：Phase 1-6 + Phase 4（跳跃执行）
待完成：Phase 7 (Token统计/费用计算)、Phase 8 (完善/覆盖率)

### 已完成阶段

| Phase | 版本 | 内容 |
|-------|------|------|
| 1 | v0.1.0 | 项目骨架、CLI、ConfigManager、类型定义 |
| 2 | v0.2.1 | 文件系统存储层（Repository 模式） |
| 3 | — | ApiClient (非流式) |
| 5 | — | SessionManager (Facade)、ChatUI 全屏 TUI |
| 6 | v0.2.2 | resume 对话恢复 |
| **4** | **v0.4.0** | **流式输出 — 本阶段产出** |

## v0.4.0 流式输出 —— 架构详述

### 新增/修改的核心文件

```
src/core/types.ts          ← 新增 StreamChunk、StreamOptions；TurnRecord.interrupted?
src/core/api.ts            ← 新增 chatStream() (AsyncGenerator, SSE 解析, 超时, 重试)
src/core/session.ts        ← 新增 sendMessageStream() + StreamEvent 导出；buildMessages 跳过 interrupted
src/core/storage.ts        ← saveTurn() 支持 interrupted 参数
src/cli/chat-ui.ts         ← 状态机(IDLE/SENDING/STREAMING)、增量渲染、spinner、ESC中断、输入队列
src/cli/index.ts           ← VERSION → 0.4.0, RELEASE_DATE → 2026-05-18
```

### 数据流（流式）

```
用户 Enter → handleEnter()
  → UIState = SENDING + liveStream + startSpinner()
  → sessionManager.sendMessageStream(msg, onEvent, signal)
    → apiClient.chatStream(messages, { signal, timeoutMs: 120s, maxRetries: 2 })
      → fetch POST (stream: true) → ReadableStream reader → SSE 逐行解析
        → yield StreamChunk (delta.content / delta.reasoning_content)
  → handleStreamEvent(event):
      reasoning_delta → liveStream.reasoning += text → drawStreamUpdate()
      content_delta  → liveStream.content += text → drawStreamUpdate()  (首次切换 STREAMING + 停 spinner)
      done           → appendLine 到 displayLines + token 摘要 → UIState = IDLE
      error          → 显示错误或 [已中断]
  → 流完成/中断后处理输入队列

中断流程：
  ESC 或 Ctrl+C → interruptStream() → AbortController.abort()
  → sendMessageStream catch → 保存 interrupted=true 的 turn → 显示 [已中断]
  → 该轮次不会被 buildMessages() 包含（下轮请求跳过）
```

### ChatUI 状态机

```
IDLE ──Enter──► SENDING (spinner 旋转)
                   │
                   ├── first reasoning_delta → phase=reasoning
                   ├── first content_delta  → STREAMING (停 spinner)
                   │
                   ├── done  → IDLE
                   ├── error → IDLE
                   └── ESC/Ctrl+C → abort → IDLE
```

流式期间：
- 普通按键 → 继续编辑输入框
- Enter → 加入输入队列 (`inputQueue`)，显示 `⏳ 等待中 (N 条)...`
- Ctrl+C/ESC → 中断流式输出
- /exit, /clear 等命令 → 排队等待流式完成后执行

### 关键类型

```typescript
// SSE 流式块
interface StreamChunk {
  id: string; object: string; created: number; model: string;
  choices: ChatChoice[];  // ChatChoice.delta 含 reasoning_content / content
  usage?: TokenUsage;
}

// 流式调用选项
interface StreamOptions {
  timeoutMs?: number;     // 默认 120_000
  maxRetries?: number;    // 默认 2 (指数退避, 4xx 不重试)
  signal?: AbortSignal;   // 用户中断
}

// 流式事件回调
interface StreamEvent {
  type: 'reasoning_delta' | 'content_delta' | 'done' | 'error';
  text?: string;
  usage?: TokenUsage;
  error?: string;
}

// 轮次记录（新增字段）
interface TurnRecord {
  // ...原有字段
  interrupted?: boolean;  // true = 中断的不完整轮次，不发送给 API
}
```

### 设计决策

1. **中断后部分回复**：保留在显示中（标记 `[已中断]`），持久化为 `interrupted:true`，不作为下轮上下文
2. **中断快捷键**：ESC 或 Ctrl+C。流式期间 Ctrl+C 不退出程序
3. **输入队列**：流式期间可继续编辑/发送，queue 在流完成后依次处理
4. **增量渲染**：`drawStreamUpdate()` 只重绘分隔线以下区域，不闪屏
5. **Spinner**：braille 字符动画 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`，80ms 间隔

### 测试覆盖

```
5 files, 91 tests passed
├── src/core/config.test.ts  12 tests
├── src/core/storage.test.ts 25 tests
├── src/core/session.test.ts 20 tests  (含 5 流式)
├── src/core/api.test.ts     24 tests  (含 10 流式)
└── src/cli/index.test.ts    10 tests
```

## 下一步：Phase 7 — Token 统计 + 费用计算

### 待实现

1. **TokenCalculator 类** (`src/core/token-counter.ts`)
   - 从 pricing.toml 读取价格 (CNY / 1M tokens)
   - 输入价格分 cache_hit / cache_miss 两档
   - 输出价格

2. **费用计算函数**
   - `costRmb = (hitTokens * hitPrice + missTokens * missPrice + outputTokens * outputPrice) / 1_000_000`

3. **集成点**
   - `SessionManager.sendMessageStream()` — 已预留 `costRmb = 0`
   - `SessionManager.sendMessage()` — 同样预留
   - 替换两个 `costRmb = 0` 为实际计算

4. **退出汇总展示** (`ChatUI.printExitSummary()`)
   - 输入 / 输出 / cache命中 / cache未命中 / 命中率 / 本轮费用 / 累计费用

### 涉及的修改文件

| 文件 | 变更 |
|------|------|
| `src/core/token-counter.ts` | **新建** — TokenCalculator 类 |
| `src/core/token-counter.test.ts` | **新建** — 单元测试 |
| `src/core/session.ts` | 注入 TokenCalculator，替换 `costRmb = 0` |
| `src/core/session.test.ts` | 更新测试（mock TokenCalculator） |
| `src/cli/chat-ui.ts` | `printExitSummary()` 接入 TokenCalculator 展示 |
| `src/cli/index.ts` | `resume` action 和 `chat` action 注入 TokenCalculator |

### 需要关注的现有代码位置

```
src/core/session.ts:112   costRmb = 0  (sendMessage 非流式)
src/core/session.ts:202   costRmb = 0  (sendMessageStream 流式完成)
src/core/session.ts:246   costRmb: 0   (sendMessageStream 中断保存)
src/cli/chat-ui.ts:258    printExitSummary() — 当前只显示 sessionId + 恢复命令
```

### 配置 (pricing.toml)

```toml
[deepseek."deepseek-v4-pro"]
input_cache_hit = 0.10    # ¥/1M tokens
input_cache_miss = 1.00
output = 2.00
currency = "CNY"
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js v24 + TypeScript ESM |
| CLI | Commander.js v14 |
| HTTP | fetch (built-in) |
| 配置 | smol-toml |
| 存储 | node:fs/promises (JSON 文件) |
| 终端 | chalk v5 + ANSI 转义序列 |
| 测试 | vitest v4 |
