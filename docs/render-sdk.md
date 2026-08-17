# Render SDK（渲染 SDK）

> 状态：v1.4.0 引入（重构自 `src/cli/tui/`，见 [render-sdk-refactor.md](./render-sdk-refactor.md)）

## 是什么

无 I/O 的渲染组件库：输入数据 + 终端宽度 → 输出 **ANSI 字符串行数组**。

- **无 I/O**：不直接操作 `process.stdout`/`process.stdin`（终端接入由表示层负责）
- **纯计算**：所有函数/类可独立测试，不依赖 TTY
- **组件化**：对话渲染、markdown 表格、输入编辑器、选择器均为可复用组件

## 引用方式

```ts
import { ConversationView, wrapText, InputEditor, Selector, dim } from 'deepseek-arch/render';
```

同包导出路径：`package.json` → `"./render": "./dist/render/index.js"`

## API 清单

### 对话渲染（`conversation.ts`）

| 导出 | 类型 | 说明 |
|---|---|---|
| `ConversationView` | class | 按轮次渲染对话历史（user → think → reply），`render(turns, cols)` / `renderToText(turns, cols)` |
| `wrapText(text, maxWidth)` | fn | 按显示宽度折行（CJK 感知） |
| `truncateThink(content, maxLines?)` | fn | 截断 think 内容到指定行数，返回 `{ display, isTruncated }` |

### Markdown 表格（`markdown.ts`）

| 导出 | 类型 | 说明 |
|---|---|---|
| `MarkdownTableRenderer` | class | 检测 markdown 表格块并格式化为 box-drawing；`feed(text)` 返回渲染行 |

### 输入编辑器（`input-editor.ts`）

| 导出 | 类型 | 说明 |
|---|---|---|
| `InputEditor` | class | 多行输入编辑器：缓冲/光标/历史/粘贴/命令补全；按键由外部喂入（`handleKey`），渲染由 `getDisplayLines()` 提供 |

### 选择器（`selector.ts`）

| 导出 | 类型 | 说明 |
|---|---|---|
| `Selector<T>` | class | 交互式选择器（↑↓/Enter/数字快捷键）；**stdout 通过注入的 `SelectorIO` 写入** |
| `SelectorIO` | interface | `{ write(s: string): void; getCols(): number }` — 由表示层注入 |

```ts
const sel = new Selector(options, terminalIO, 'Choose:');
const result = await sel.select(getHandler, setHandler);
```

### ANSI 工具（`ansi.ts`）

| 导出 | 说明 |
|---|---|
| `dim` / `cyan` / `green` / `yellow` / `red` / `bold` / `grayBg` | 颜色样式 |
| `GRAY_BG_START` / `GRAY_BG_END` / `PINK_BG_START` / `PINK_BG_END` / `GREEN_BG_START` / `RED_BG_START` | 背景色常量 |
| `renderDiffLine(line, indent)` | diff 行着色（+/−/@@） |
| `isWideChar` / `charDisplayWidth` / `strDisplayWidth` | CJK 显示宽度 |
| `stripAnsi(text)` | 剥离 ANSI 序列 |
| `truncateByWidth(str, maxWidth)` | 按显示宽度截断 |
| `padToWidth(str, targetWidth)` | 填充到目标宽度 |
| `formatToolCallSummary(name, args)` | 工具调用紧凑摘要 |

### 类型（`types.ts`）

`AppState`（枚举）、`ScreenCapture`、`TurnCaptureInfo`、`ToolCallCaptureInfo`、`InputAreaCapture`、`CaptureScreenFn`

## 消费示例

### 表示层（TUI）如何注入终端 I/O

```ts
// src/presentation/terminal.ts（表示层）
import type { SelectorIO } from '../render/selector.js';

export const terminalIO: SelectorIO = {
	write: (s: string) => process.stdout.write(s),
	getCols: () => getTermSize().cols,
};
```

### 无头渲染（测试/未来 GUI 可用）

```ts
// 纯文本渲染（GUI 复用路径）
const view = new ConversationView();
const lines = view.renderToText(turns, 80);
const plain = lines.map(stripAnsi);
```

## 分层关系

```
core（对话引擎）← 事件流/命令 → presentation（表示层：状态机 + 终端 I/O + 组装）
                                          ↓ 引用
                                   render（本 SDK，无 I/O）
```

**依赖方向**：`presentation → render`，`tools → render`。`render/` 内零 `process.*` 引用。
