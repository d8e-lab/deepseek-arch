# CLI 组件文档

> 创建于 2026-05-18 · 从 chat-ui.ts (1207 行) 拆分后的组件文档

## 目录结构

```
src/cli/
├── index.ts                  # Commander CLI 主程序（不变）
├── chat-ui.ts                # 精简后主类（1207 → 659 行）
├── components/
│   ├── ansi.ts               # ANSI 转义序列常量与工具（39 行）
│   ├── spinner.ts            # Spinner 等待动画（60 行）
│   ├── display-lines.ts      # 对话渲染缓冲区（51 行）
│   └── input-panel.ts        # 输入面板（226 行）
└── state/
    └── chat-state.ts         # 流式状态机（117 行）
```

---

## `src/cli/components/ansi.ts`（39 行）

**性质**：纯常量 + 函数，零类，零状态。

### 常量

| 名称 | 值 | 用途 |
|------|----|------|
| `CSI` | `\x1b[` | Control Sequence Introducer，所有 ANSI 序列的前缀 |
| `CURSOR_HOME` | `${CSI}H` | 光标回 (1,1) |
| `CLEAR_SCREEN` | `${CSI}2J` | 清屏 |
| `HIDE_CURSOR` | `${CSI}?25l` | 隐藏光标 |
| `SHOW_CURSOR` | `${CSI}?25h` | 显示光标 |
| `ERASE_LINE` | `${CSI}2K` | 清除当前行 |
| `ERASE_SCREEN_BELOW` | `${CSI}0J` | 清除光标以下所有行 |
| `ENTER_ALT_SCREEN` | `${CSI}?1049h` | 进入备用缓冲区（全屏 TUI 入口） |
| `EXIT_ALT_SCREEN` | `${CSI}?1049l` | 退出备用缓冲区（恢复终端原始内容） |
| `RESET_BG` | `${CSI}49m` | 重置背景色 |
| `BG_GRAY` | `${CSI}48;5;236m` | 灰底（色号 236） |

### 函数

#### `cursorTo(row, col)`

```
签名: (row: number, col?: number): string
示例: cursorTo(3, 5) → "\x1b[4;6H"
```

实现：`return \`\x1b[${row + 1};${col + 1}H\``。参数从 0 开始计数，ANSI 协议从 1 开始，所以统一 +1。

#### `cursorUp(n)`

```
签名: (n: number): string
```

实现：`return \`\x1b[${n}A\``

### 被哪些文件引用

```
← chat-ui.ts (全量导入，所有渲染方法使用)
```

---

## `src/cli/components/spinner.ts`（60 行）

**性质**：单类，无外部依赖。

### 内部常量

```typescript
FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
DEFAULT_INTERVAL = 80; // ms
```

### 类：`Spinner`

#### 实例状态

| 成员 | 类型 | 初始值 | 说明 |
|------|------|--------|------|
| `timer` | `Timer \| null` | `null` | setInterval 的返回值，stop 时 clear 掉 |
| `frameIdx` | `number` | `0` | 当前帧在 frames 数组中的索引 |
| `frames` | `string[]` | `FRAMES` | 可覆写（暂未开放 setter） |
| `interval` | `number` | `DEFAULT_INTERVAL` | 帧间隔 |

#### 方法

| 方法 | 签名 | 实现 |
|------|------|------|
| `start(onTick)` | `(onTick: (frame: string) => void): void` | 幂等（已有 timer 直接 return）。`frameIdx = 0` → `setInterval` 每 interval ms 递增 frameIdx → 回调 `onTick(this.getFrame())` |
| `stop()` | `(): void` | `clearInterval(this.timer)` → `this.timer = null` |
| `getFrame()` | `(): string` | `return this.frames[this.frameIdx]` |
| `isRunning()` | `(): boolean` | `return this.timer !== null` |

### 调用时序

```
ChatUI.handleEnter()
  → state.startSending()
  → spinner.start((frame) => drawStreamUpdate())
    → setInterval(frameIdx递增, 每80ms)
      → drawStreamUpdate() 写入 spinner 帧
  → 收到第一个 content_delta
    → spinner.stop()
```

### 被哪些文件引用

```
← chat-ui.ts (import { Spinner })
```

---

## `src/cli/components/display-lines.ts`（51 行）

**性质**：单类，纯数据容器。

### 导出类型

| 名称 | 种类 | 值 |
|------|------|----|
| `LineColor` | type | `'green' \| 'gray' \| 'white'` |
| `RenderedLine` | interface | `{ text: string, color: LineColor }` |

### 类：`DisplayLines`

#### 实例状态

| 成员 | 类型 | 说明 |
|------|------|------|
| `lines` | `RenderedLine[]` | 私有数组，全部渲染行的 FIFO 存储 |

#### 方法

| 方法 | 签名 | 实现 |
|------|------|------|
| `append(text, color)` | `(text: string, color: LineColor): void` | `this.lines.push({ text, color })`。无上限，被 ChatUI `getVisibleLines` 截取 |
| `clear()` | `(): void` | `this.lines = []` |
| `getVisible(visibleCount)` | `(visibleCount: number): RenderedLine[]` | `length <= visibleCount` → 返回全量。否则 `slice(length - visibleCount)` |
| `getAll()` | `(): RenderedLine[]` | `return [...this.lines]`（浅拷贝返回） |
| `length` | getter | `return this.lines.length` |

### 被哪些文件引用

```
← chat-ui.ts (import { DisplayLines, type LineColor })
```

---

## `src/cli/state/chat-state.ts`（117 行）

**性质**：单类，封装状态机 + 流式累积内容 + 中断控制。

### 导出类型

| 名称 | 种类 | 值 |
|------|------|----|
| `UIState` | type | `'idle' \| 'sending' \| 'streaming'` |
| `LiveStreamState` | interface | `{ reasoning: string, content: string, phase: 'sending' \| 'reasoning' \| 'content' }` |

### 类：`ChatState`

#### 实例状态

| 成员 | 类型 | 初始值 | 说明 |
|------|------|--------|------|
| `_uiState` | `UIState` | `'idle'` | 当前 UI 状态 |
| `_liveStream` | `LiveStreamState \| null` | `null` | 流式累积内容，非 null = 进行中 |
| `_streamAbort` | `AbortController \| null` | `null` | 中断控制器 |

#### 方法

##### UI 状态组

| 方法 | 签名 | 实现 |
|------|------|------|
| `get uiState()` | getter: `UIState` | `return this._uiState` |
| `isIdle()` | `(): boolean` | `this._uiState === 'idle'` |
| `isSending()` | `(): boolean` | `this._uiState === 'sending'` |
| `isStreaming()` | `(): boolean` | `this._uiState === 'streaming'` |
| `startSending()` | `(): void` | 设置 `_uiState='sending'`，创建初始 `_liveStream = { reasoning: '', content: '', phase: 'sending' }` |
| `startStreaming()` | `(): void` | 设置 `_uiState='streaming'`，`_liveStream.phase = 'content'` |
| `resetToIdle()` | `(): void` | 设置 `_uiState='idle'`, `_liveStream = null` |

##### 流式累积组

| 方法 | 签名 | 实现 |
|------|------|------|
| `get liveStream()` | getter: `LiveStreamState \| null` | 返回 `_liveStream` |
| `addReasoningDelta(text)` | `(text: string): void` | 如果当前 `phase === 'sending'` → 切换到 `'reasoning'`。追加 text 到 `reasoning` |
| `addContentDelta(text)` | `(text: string): void` | 追加 text 到 `content`（注意：不切换 phase，由外部 `handleStreamEvent` 调用 `startStreaming`） |

##### 中断组

| 方法 | 签名 | 实现 |
|------|------|------|
| `get streamAbort()` | getter: `AbortController \| null` | 返回 `_streamAbort` |
| `createAbortController()` | `(): AbortController` | 创建新 AbortController，保存引用并返回 |
| `abortStream()` | `(): void` | `this._streamAbort?.abort()` |
| `releaseAbortController()` | `(): void` | `this._streamAbort = null` |

#### 被 ChatUI 调用的时序

```
// 发送消息
state.startSending()          → uiState='sending', liveStream 初始化
  → state.addReasoningDelta() → phase='reasoning'
  → state.startStreaming()    → uiState='streaming', phase='content'
  → state.addContentDelta()   → content 累积
  → state.resetToIdle()       → 完成

// 中断
state.createAbortController() → 创建 AbortController
  → state.abortStream()        → 触发中断
  → state.releaseAbortController()

// 查询
state.isIdle() / isSending() / isStreaming()
state.liveStream              → 读取当前累积内容
```

### 被哪些文件引用

```
← chat-ui.ts (import { ChatState })
```

---

## `src/cli/components/input-panel.ts`（226 行）

**性质**：单类 + 3 个导出纯函数。

### 导出函数

#### `charDisplayWidth(char)`

```
签名: (char: string): number
```

实现：取 `char.codePointAt(0)`，检查是否落在 CJK 区间（Unicode 范围：CJK Unified Ideographs, Compatibility, Extension A/B, Radicals, Symbols, Fullwidth Forms）。CJK/全角 → 2，否则 → 1。

覆盖的 Unicode 范围：

| 范围 | 名称 |
|------|------|
| `0x4E00-0x9FFF` | CJK Unified Ideographs |
| `0x3400-0x4DBF` | CJK Extension A |
| `0xF900-0xFAFF` | CJK Compatibility |
| `0x2E80-0x2EFF` | CJK Radicals |
| `0x3000-0x303F` | CJK Symbols |
| `0xFF00-0xFFEF` | Halfwidth/Fullwidth |
| `0x20000-0x2FFFF` | CJK Extension B+ |

#### `strDisplayWidth(s)`

```
签名: (s: string): number
```

实现：遍历每个字符，调用 `charDisplayWidth` 累加。

#### `wrapTextForInput(text, width)`

```
签名: (text: string, width: number): string[]
```

实现：

1. `width <= 0 || text.length === 0` → `['']`
2. 遍历字符：
   - `\n` → 自然断行
   - 累加 `charDisplayWidth`，超 `width` 则断行
3. 最后一行非空 → 入 result
4. 返回 `string[]`（每行长度 ≤ width 显示宽度）

**注意**：这个函数只负责按显示宽度断行，不处理输入面板（无 `> ` 前缀）。

### 类：`InputPanel`

#### 实例状态

| 成员 | 类型 | 初始值 | 说明 |
|------|------|--------|------|
| `_text` | `string` | `''` | 当前编辑文本 |
| `_cursorPos` | `number` | `0` | 光标位置（字符索引，非字节） |
| `_history` | `string[]` | `[]` | 已发送消息历史 |
| `_historyIndex` | `number` | `-1` | 当前历史浏览索引（-1 = 新输入） |
| `_queue` | `string[]` | `[]` | 流式期间暂存的待发送消息 |

#### 方法

##### 文本操作

| 方法 | 签名 | 实现 |
|------|------|------|
| `get text()` | getter | `return this._text` |
| `get cursorPos()` | getter | `return this._cursorPos` |
| `clear()` | `(): void` | `_text='', _cursorPos=0` |
| `setText(text)` | `(text: string): void` | 设值和光标到末尾 |
| `insertChar(ch)` | `(ch: string): void` | 在光标位置插入字符，光标后移 |
| `deleteChar()` | `(): void` | 删除光标前一个字符（Backspace） |
| `deleteForward()` | `(): void` | 删除光标处字符（Delete） |
| `moveCursor(delta)` | `(delta: number): void` | 加减 cursorPos，限界 `[0, text.length]` |
| `insertNewline()` | `(): void` | 调用 `insertChar('\n')` |

##### 提交与历史

| 方法 | 签名 | 实现 |
|------|------|------|
| `submit()` | `(): string` | 空文本返回 `''`。保存到 `_history`，重置 index，调用 `clear()`，返回原文本 |
| `navigateHistory(dir)` | `(dir: -1 \| 1): void` | -1=向上（更旧），1=向下（更新）。首次向上时保存当前文本到 index。在 `_history` 范围内移动，超出回到新输入 |

##### 输入队列

| 方法 | 签名 | 实现 |
|------|------|------|
| `get hasQueue()` | getter: `boolean` | `_queue.length > 0` |
| `get queueLength()` | getter: `number` | `_queue.length` |
| `enqueue(text)` | `(text: string): void` | `_queue.push(text)` |
| `dequeue()` | `(): string \| null` | `_queue.shift() ?? null` |
| `clearQueue()` | `(): void` | `_queue = []` |

##### 布局计算

| 方法 | 签名 | 实现 |
|------|------|------|
| `calcHeight(termWidth)` | `(termWidth: number): number` | 用 `wrapTextForInput` 计算换行后的行数，上限 `MAX_INPUT_HEIGHT`（10） |
| `calcCursor(inputHeight, termWidth)` | `(inputHeight: number, termWidth: number): { cursorRow, cursorCol }` | 从 0 遍历到 `_cursorPos`，计算字符累计显示宽度和换行后的行列位置。列位置在 `promptLen` 基础上偏移 |

### 被哪些文件引用

```
← chat-ui.ts (import { InputPanel, charDisplayWidth, strDisplayWidth })
```

---

## ChatUI 主类（`src/cli/chat-ui.ts`，659 行）

**性质**：组合者模式主类，组合 5 个组件 + 1 个工具类 (Throttle)。

### 组件组合关系

```
ChatUI
├── state: ChatState          — 状态机 + 流式累积 + 中断
├── display: DisplayLines     — 对话渲染缓冲区
├── input: InputPanel         — 输入编辑 + 历史 + 队列 + CJK
├── spinner: Spinner          — 等待动画
├── renderThrottle: Throttle  — 60fps 渲染节流
└── config: ConfigManager     — 配置读取
    └── sessionManager: SessionManager — 对话门面
```

### 新文件

| 文件名 | 重构前（内联） | 重构后（导入） |
|--------|---------------|---------------|
| ANSI 常量 | 10 个 const + 1 个 function | `./components/ansi.js` |
| Spinner 定时器 | 2 个成员 + 2 个方法 | `./components/spinner.js` |
| DisplayLines | `RenderedLine[]` 数组 + 1 个方法 | `./components/display-lines.js` |
| 状态机 | `UIState` + `LiveStreamState` + 13 个成员 | `./state/chat-state.js` |
| 输入面板 + CJK | 7 个成员 + 6 个方法 | `./components/input-panel.js` |

### 方法清单

| 方法 | 行数 | 职责 |
|------|------|------|
| `constructor` | 3 | 保存依赖 |
| `start` | 55 | 终端初始化 + SessionManager初始化 + 事件绑定 |
| `cleanup` | 8 | 恢复终端原始模式 |
| `enterAltScreen` / `exitAltScreen` | 2+2 | 备用缓冲区切换 |
| `startRawMode` | 4 | stdin raw 模式设置 |
| `updateTermSize` | 4 | 读取终端尺寸 |
| `handleResize` | 4 | SIGWINCH 处理 |
| `handleKeyPress` | 7 | 状态机分发：IDLE → handleIdleKeyPress、非IDLE → handleStreamingKeyPress |
| `handleIdleKeyPress` | 92 | 空闲期所有键处理（命令、输入、历史、导航） |
| `handleStreamingKeyPress` | 60 | 流式期键处理（中断、队列、编辑） |
| `handleEnter` | 43 | 提交消息 → 启动流式发送 |
| `processInputQueue` | 12 | 流完成后处理队列 |
| `handleStreamEvent` | 45 | 流式事件 → 状态机更新 + 渲染 |
| `interruptStream` | 17 | 中断 → spinner 停止 + abort + 回显部分内容 |
| `fullDraw` | 60 | 全量终端重绘 |
| `drawStreamUpdate` | 52 | 增量重绘（仅流式区域 + 输入面板） |
| `renderInputPanel` | 32 | 灰底输入面板渲染（含换行） |
| `getVisibleLines` | 6 | 从 display 截取可见行 |
| `colorize` | 8 | chalk 三色染色 |
| `printExitSummary` | 16 | 退出时显示恢复命令 |
