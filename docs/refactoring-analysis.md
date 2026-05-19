# 重构分析报告

> 创建于 2026-05-18 · 目标：模块拆分 → 文件瘦身 → 职责单一

## 当前文件行数统计

```
 262  src/core/types.ts          — 全部领域类型
 275  src/core/config.ts         — ConfigManager (Singleton)
 291  src/core/storage.ts        — Storage (Repository)
 250  src/core/api.ts            — ApiClient (Adapter) + 流式/非流式
 295  src/core/session.ts        — SessionManager (Facade) + 流式中断
1207  src/cli/chat-ui.ts         — ★★★ 怪物文件 ★★★
 179  src/cli/index.ts           — CLI 主程序 (Commander)
  11  src/index.ts               — 入口
  25  src/utils/event-loop.ts    — yieldEventLoop()
  38  src/utils/throttle.ts      — Throttle
 649  src/core/api.test.ts       — 测试
 431  src/core/session.test.ts   — 测试
 302  src/core/storage.test.ts   — 测试
 152  src/core/config.test.ts    — 测试
 106  src/cli/index.test.ts      — 测试
 115  src/utils/throttle.test.ts — 测试
----
4588  total (16 文件)
```

## 核心问题

### 1. `chat-ui.ts` (1207 行) — 职责爆炸

这个文件同时承担了 **7 个不同职责**，严重违反单一职责原则：

| 职责 | 行数范围 | 说明 |
|------|---------|------|
| ANSI 转义序列定义 | 全局常量 | `CURSOR_HOME`, `ERASE_LINE`, `ENTER_ALT_SCREEN` 等 |
| 状态机管理 | 全局类型 + 类属性 | `UIState`, `LiveStreamState`, 状态转换逻辑 |
| 输入事件处理 | 生命周期方法 | `handleKeyPress`, `handleEnter`, 输入队列 |
| 流式渲染控制 | 流式相关方法 | spinner 动画, `handleStreamEvent`, `interruptStream` |
| 终端布局渲染 | 渲染方法 | `fullDraw`, `drawStreamUpdate`, `printExitSummary` |
| 文本排版引擎 | 私有方法 | `wrapTextForInput`, `charDisplayWidth`, `strDisplayWidth` |
| 历史/命令处理 | 命令处理 | `/title`, `/clear`, `/exit`, 输入历史浏览 |

**具体表现**：
- `fullDraw()` + `drawStreamUpdate()` 混合了布局计算和 ANSI 输出
- 输入处理逻辑分散在 `handleKeyPress`, `handleEnter`, `processInputQueue` 三个方法中
- CJK 显示宽度计算函数与渲染代码紧耦合
- 1207 行让人工 review 极困难

### 2. `types.ts` (262 行) — 类型集中爆炸

所有类型堆在一个文件中：
- 消息类型（Message, MessageRole）
- Token 用量类型（TokenUsage, CostBreakdown）
- 会话类型（TurnRecord, SessionMeta, Session, SessionListItem）
- 配置类型（ProviderConfig, PricingConfig, AppConfig, ResolvedConfig）
- API 类型（ChatCompletionRequest, ChatCompletionResponse, StreamChunk）
- 流式事件类型（StreamEvent）
- 错误类型（ApiError）

**问题**：每次修改任何类型都需编辑这个文件，容易冲突。且 import 时无法精确表达"我只依赖配置类型"。

### 3. `session.ts` (295 行) — Facade 持续膨胀

SessionManager 已从纯协调层膨胀：
- 非流式发送 (`sendMessage`)
- 流式发送 (`sendMessageStream`) — 含中断处理 + 部分回复持久化
- 消息构建 (`buildMessages`) — 含 `interrupted` 过滤
- 会话生命周期 (`startNewSession`, `resumeSession`, `setTitle`)

**问题**：流式逻辑（中断处理、部分回复持久化）与基础对话生命周期混在一起。

### 4. `api.test.ts` (649 行) + `session.test.ts` (431 行)

测试文件大于被测试文件，主要因为：
- 每个测试重复构建 mock 工厂函数
- 流式测试需要复杂的 mock SSE stream 构造
- 测试数据硬编码在每个测试中

## 重构目标

```
源文件行数目标：
  core/ 模块：≤ 150 行/文件
  cli/  模块：≤ 200 行/文件
  测试文件：   ≤ 250 行/文件（随源文件拆分自然减小）
```

## 测试布局补充

当前仓库仍采用 `src/**/*.test.ts` 的同目录测试布局。若后续要分离测试和开发代码，建议先迁移测试文件，再继续做核心模块拆分：

1. 新建 `tests/` 目录并按 `src/` 的结构镜像
2. 调整 `vitest.config.ts` 的 `include`
3. 保持 `tsconfig.json` 只编译 `src/`
4. 再拆 `chat-ui.ts`、`session.ts` 等大文件

## 建议的目录结构

```
src/
├── index.ts                     # 入口 (保持 ~10 行)
│
├── types/                       # ★ 类型分离为独立模块
│   ├── index.ts                 #   重新导出
│   ├── chat.ts                  #   Message, MessageRole, TurnRecord
│   ├── session.ts               #   SessionMeta, Session, SessionListItem
│   ├── config.ts                #   ProviderConfig, PricingConfig, AppConfig, ResolvedConfig
│   ├── api.ts                   #   ChatCompletionRequest, ChatCompletionResponse, StreamChunk, ApiError
│   └── token.ts                 #   TokenUsage, CostBreakdown
│
├── core/                        # ★ 核心业务层
│   ├── config.ts                #   ConfigManager (Singleton, ~150 行)
│   ├── storage.ts               #   Storage (Repository, ~200 行)
│   ├── api-client.ts            #   ApiClient (Adapter, ~200 行)
│   ├── session.ts               #   SessionManager (Facade, ~150 行)
│   ├── stream-sender.ts         #   ★ 新增：流式发送逻辑（从 session.ts 拆出）
│   └── token-counter.ts         #   TokenCalculator (Phase 7, ~100 行)
│
├── cli/                         # ★ TUI 层模块化
│   ├── index.ts                 #   Commander 主程序 (~150 行)
│   ├── components/              #   ★ 新增：UI 组件
│   │   ├── ansi.ts              #     ANSI 转义序列 (常量 + 工具函数, ~50 行)
│   │   ├── display-lines.ts     #     对话渲染行缓冲区 (~80 行)
│   │   ├── input-panel.ts       #     输入面板组件 (CJK 换行, 光标定位, ~150 行)
│   │   ├── status-bar.ts        #     顶部信息栏 (~50 行)
│   │   └── spinner.ts           #     独立 Spinner 类 (~60 行)
│   ├── state/                   #   ★ 新增：状态管理
│   │   └── chat-state.ts        #     UIState 状态机 + LiveStreamState (~100 行)
│   ├── handlers/                #   ★ 新增：事件处理器
│   │   ├── input-handler.ts     #     键盘输入 + 命令解析 (~150 行)
│   │   └── stream-handler.ts    #     流式事件处理 (~120 行)
│   └── chat-ui.ts               #   ★ 主 TUI 类，组合上述组件 (~150 行)
│
├── utils/                       # 工具函数 (保持不变)
│   ├── event-loop.ts            #   yieldEventLoop()
│   └── throttle.ts              #   Throttle (帧率节流)
│
└── ... (测试文件随源文件拆分)
```

## 逐模块重构方案

### 模块 A: `types/` — 类型拆分

```
现状：src/core/types.ts  (262 行, 所有类型)
目标：src/types/*.ts      (每个 ~30-80 行)
```

**拆分规则**：
- `chat.ts` — `Message`, `MessageRole`, `TurnRecord`, `StreamEvent`
- `session.ts` — `SessionMeta`, `Session`, `SessionListItem`, `SessionData`
- `config.ts` — `ProviderConfig`, `ProvidersConfig`, `ModelPricing`, `PricingConfig`,
  `SystemPromptTemplate`, `SystemPromptConfig`, `ConfigPaths`, `ConfigDefaults`,
  `AppConfig`, `ResolvedConfig`
- `api.ts` — `ChatCompletionRequest`, `ChatCompletionResponse`, `ChatChoice`,
  `StreamDelta`, `StreamChunk`, `StreamOptions`, `ApiError`, `ApiErrorBody`
- `token.ts` — `TokenUsage`, `CostBreakdown`
- `index.ts` — 重新导出所有类型（兼容旧导入路径）

**注意**：需检查循环依赖。
- `TurnRecord` 依赖 `Message` 和 `TokenUsage` → 需从 `token.ts` 导入
- `Session` 依赖 `SessionMeta` 和 `TurnRecord` → 需从 `chat.ts` 导入
- 不存在循环依赖

**影响范围**：
- 所有 `import { ... } from './types.js'` 改为 `import { ... } from '../types/xxx.js'`
- 修改 5 个 core 源文件 + 5 个测试文件的 import

### 模块 B: `core/` — 流式逻辑分离

#### B1: `core/session.ts` (295 → 150 行)

**拆分方向**：将流式发送逻辑移至 `stream-sender.ts`

```
SessionManager 保留：
  - 会话生命周期 (startNewSession, resumeSession, getSession, setTitle)
  - 非流式发送 (sendMessage)
  - buildMessages() — 消息构建（与流式/非流式共享）

移出到 SessionStreamSender：
  - sendMessageStream() — 流式逻辑
  - 中断处理 + 部分回复持久化
```

**新类** `SessionStreamSender`：
```typescript
class SessionStreamSender {
  constructor(
    private storage: Storage,
    private client: ApiClient,
    private session: Session,
    private buildMessages: (content: string) => Message[],
  ) {}

  async sendMessageStream(
    userContent: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<TurnRecord | null> { ... }
}
```

**SessionManager 改动**：
```typescript
class SessionManager {
  async sendMessageStream(...): Promise<TurnRecord | null> {
    const sender = new SessionStreamSender(
      this.storage, this.client, this.session,
      (content) => this.buildMessages(content),
    );
    return sender.sendMessageStream(userContent, onEvent, signal);
  }
}
```

#### B2: `core/api.ts` (250 → 200 行) — 可选拆分

**现状**：`chat()` 和 `chatStream()` 在同一个类中。

**可选方案**：不拆分，因为两者共享构造函数参数和 URL 构建，内聚性合理。

**提炼**：可将 SSE 解析逻辑作为私有方法：
```typescript
private async *parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<StreamChunk> { ... }
```

#### B3: `core/storage.ts` (291 → 200 行) — 内部方法提炼

**现状**：`loadTurns()` 同时处理新旧两种格式（turns.json + turn-NNN.json）。

**提炼**：将旧格式兼容逻辑分离：
```typescript
// storage.ts — 核心存储逻辑
// legacy-compat.ts — turn-NNN.json 兼容加载
```

**同时**：将辅助方法重新组织：
- `readJSON<T>(path)` — 保持
- `writeJSON(path, data)` — 保持
- `ensureSessionsDir()` — 保持
- 路径生成方法 (`sessionDir`, `metaPath`, `turnsPath`) — 可抽象为 `SessionPaths` 类

### 模块 C: `cli/` — 1207 行怪物的拆分（核心）

#### C1: `cli/components/ansi.ts` — ANSI 转义序列

```typescript
// 从 chat-ui.ts 抽出
export const CSI = '\x1b[';

export const CURSOR_HOME = `${CSI}H`;
export const CLEAR_SCREEN = `${CSI}2J`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
export const ERASE_LINE = `${CSI}2K`;
export const ERASE_SCREEN_BELOW = `${CSI}0J`;
export const ENTER_ALT_SCREEN = `${CSI}?1049h`;
export const EXIT_ALT_SCREEN = `${CSI}?1049l`;

export function cursorTo(row: number, col: number = 0): string {
  return `${CSI}${row + 1};${col + 1}H`;
}

export function cursorUp(n: number): string {
  return `${CSI}${n}A`;
}
```

#### C2: `cli/components/spinner.ts` — Spinner 类

```typescript
export class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private interval = 80;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;

  start(onTick: (frame: string) => void): void { ... }
  stop(): void { ... }
  getFrame(): string { ... }
}
```

#### C3: `cli/components/input-panel.ts` — 输入面板

```typescript
export class InputPanel {
  private text = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private inputQueue: string[] = [];

  // CJK 相关
  charDisplayWidth(char: string): number { ... }
  strDisplayWidth(s: string): number { ... }
  wrapTextForInput(text: string, width: number): string[] { ... }

  // 输入操作
  insertChar(ch: string): void { ... }
  deleteChar(): void { ... }
  moveCursor(delta: number): void { ... }
  submit(): string { ... }
  navigateHistory(direction: -1 | 1): void { ... }
  queueInput(text: string): void { ... }
  dequeueInput(): string | null { ... }

  // 渲染
  calcHeight(termWidth: number): number { ... }
  calcCursor(inputHeight: number, termWidth: number): { row: number; col: number } { ... }
  render(termWidth: number): string[] { ... }
}
```

#### C4: `cli/components/display-lines.ts` — 对话渲染缓冲区

```typescript
export type LineColor = 'green' | 'gray' | 'white';

export interface RenderedLine {
  text: string;
  color: LineColor;
}

export class DisplayLines {
  private lines: RenderedLine[] = [];

  append(text: string, color: LineColor): void { ... }
  clear(): void { ... }
  getLines(maxLines: number): RenderedLine[] { ... }
}
```

#### C5: `cli/state/chat-state.ts` — 状态机

```typescript
export type UIState = 'idle' | 'sending' | 'streaming';

export interface LiveStreamState {
  reasoning: string;
  content: string;
  phase: 'sending' | 'reasoning' | 'content';
}

export class ChatState {
  private uiState: UIState = 'idle';
  private liveStream: LiveStreamState | null = null;
  private streamAbort: AbortController | null = null;

  getState(): UIState { ... }
  isIdle(): boolean { ... }
  isSending(): boolean { ... }
  isStreaming(): boolean { ... }

  startSending(): void { ... }
  startStreaming(): void { ... }
  resetToIdle(): void { ... }

  getLiveStream(): LiveStreamState | null { ... }
  createAbortController(): AbortController { ... }
  abortStream(): void { ... }
}
```

#### C6: `cli/handlers/input-handler.ts` — 输入事件处理

```typescript
export class InputHandler {
  constructor(
    private inputPanel: InputPanel,
    private chatState: ChatState,
    private onSendMessage: (content: string) => void,
    private onCommand: (cmd: string, arg: string) => void,
  ) {}

  handleKeyPress(key: KeyPress): void { ... }
  handleEnter(): void { ... }
  handleCtrlC(): void { ... }
  handleCtrlL(): void { ... }
  processInputQueue(): void { ... }
}
```

#### C7: `cli/handlers/stream-handler.ts` — 流式事件处理

```typescript
export class StreamHandler {
  constructor(
    private chatState: ChatState,
    private displayLines: DisplayLines,
    private onDrawUpdate: () => void,
    private renderThrottle: Throttle,
  ) {}

  handleEvent(event: StreamEvent): void { ... }
  private handleReasoningDelta(text: string): void { ... }
  private handleContentDelta(text: string): void { ... }
  private handleDone(usage: TokenUsage): void { ... }
  private handleError(error: string): void { ... }
}
```

#### C8: `cli/chat-ui.ts` (1207 → ~150 行)

重构后 ChatUI 变为组合者：

```typescript
export class ChatUI {
  private ansi: Ansi;           // 静态引用
  private state: ChatState;
  private display: DisplayLines;
  private input: InputPanel;
  private spinner: Spinner;
  private inputHandler: InputHandler;
  private streamHandler: StreamHandler;

  async start(): Promise<void> { ... }
  private fullDraw(): void { ... }
  private drawStreamUpdate(): void { ... }
  private printExitSummary(): void { ... }
}
```

### 模块 D: 测试文件

#### 测试拆分原则

| 源文件行数 | 测试文件行数 | 拆分方法 |
|-----------|------------|---------|
| chat-ui.ts 1207 | — | 每个新组件一个测试文件 |
| api.ts 250 | api.test.ts 649 | 将 mock 工厂函数抽离为 `test-utils.ts` |
| session.ts 295 | session.test.ts 431 | 同上 |

**新增测试文件**：
```
src/cli/components/input-panel.test.ts
src/cli/components/spinner.test.ts
src/cli/components/display-lines.test.ts
src/cli/state/chat-state.test.ts
src/cli/handlers/input-handler.test.ts
src/cli/handlers/stream-handler.test.ts
src/core/stream-sender.test.ts
```

## 影响评估

### 直接改动文件数

| 操作 | 文件数 |
|------|--------|
| **新建文件** | ~15 |
| **修改文件（import 重写）** | ~10 |
| **重写文件（chat-ui.ts 拆解）** | 1 → 8 |
| **保持不变** | ~3 (index.ts, event-loop.ts, throttle.ts) |

### 重构顺序建议（分阶段执行）

**Phase A — 类型拆分**（低风险，纯搬移）
```
1. 创建 src/types/ 目录 + 各子文件
2. 创建 src/types/index.ts（重新导出）
3. 更新所有 import 路径
4. 删除旧 src/core/types.ts
5. 验证：npm test 全通过
```

**Phase B — utils 和组件提取**（从 chat-ui.ts 拆分）
```
1. ansi.ts — ANSI 常量
2. spinner.ts — Spinner 类
3. display-lines.ts — 显示缓冲区
4. chat-state.ts — 状态机
5. input-panel.ts — 输入面板 + CJK 逻辑
6. 每个组件独立测试通过
```

**Phase C — handler 提取**
```
1. input-handler.ts — 输入事件处理
2. stream-handler.ts — 流式事件处理
3. ChatUI 精简为组合者
```

**Phase D — 流式逻辑从 session.ts 拆分**
```
1. stream-sender.ts — SessionStreamSender
2. SessionManager 改为委托调用
```

**Phase E — 测试拆分**
```
1. 抽离 mock 工厂到 test-utils.ts
2. 为每个新组件创建测试
3. 验证：npm test + coverage ≥ 80%
```

### 风险与注意事项

| 风险 | 概率 | 缓解 |
|------|------|------|
| import 循环依赖 | 低 | types/ 各文件无相互引用；core/ 保持单向依赖 |
| chat-ui.ts 拆解中遗漏逻辑 | 中 | 为每个方法写单元测试后再抽取 |
| 测试 mock 在不同文件间不一致 | 中 | 统一 test-utils.ts |
| 重构后覆盖率临时下降 | 高 | 新组件必配测试，保持 ≥ 80% |
| 与 Phase 7 (Token Calculator) 冲突 | 低 | Phase 7 是纯新增文件，不影响重构 |

## 总结

**当前状态**：16 文件，4588 行，1 个 1207 行的怪物文件 + 3 个 250-300 行的中型文件。

**目标状态**：~30 文件，每个 ≤ 200 行，类型/核心/TUI 三层清晰分离。

**核心策略**：先拆最小的风险最低的（类型 → 组件 → handler → 流式逻辑 → 测试），每个子阶段可独立验证测试。
