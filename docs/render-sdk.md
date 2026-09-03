# Render SDK（渲染 SDK）

> 状态：v1.4.0 引入（重构自 `src/cli/tui/`，见 [render-sdk-refactor.md](./render-sdk-refactor.md)）；方案 A（v1.5.2 后）新增共享抽象 list / scroll / csi / markdown-text

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

### 可滚动选择列表（`list.ts`）

> 方案 A 新增：收敛「条目数组 + 选中索引 + 可见窗口 → 高亮行数组」逻辑（此前在 BottomArea 补全建议与 Selector 中重复实现），供 SuggestionPane / Selector 等复用。

| 导出 | 类型 | 说明 |
|---|---|---|
| `computeListWindow(total, selected, maxVisible)` | fn | 计算滚动窗口，返回 `{ start, end, beforeMore, afterMore }`——保证选中项始终在窗口内，并给出窗口上下被折叠的条目数 |
| `renderListLine(text, isSelected, width)` | fn | 渲染单行列表项：`▸` 选中前缀 + cyan 高亮 / dim 未选中，`padToWidth` 填充到目标宽度 |
| `renderSelectList(labels, selectedIndex, { maxVisible?, width })` | fn | 渲染完整可滚动列表为行数组（含 `... N more` 折叠提示）；调用方负责绘制与行数记账 |

### 滚动状态（`scroll.ts`）

> 方案 A 新增：收敛全屏/长列表视图的滚动记账（offset + followTail，此前在 Ctrl+O viewer 与 Ctrl+T subagents 视图重复实现 2 份）。

| 导出 | 类型 | 说明 |
|---|---|---|
| `ScrollState` | class | 可滚动区域状态：`offset`（当前视口起始行）/ `followTail`（是否跟随末尾）；总行数与可见行数经 `{ getTotal, getVisible }` 注入。方法：`reconcile(forceTail?)` 内容更新后校正（贴底或 clamp）、`by(dir)` 逐行滚动、`page(dir)` 翻页、`to(line)` 跳到指定行 |
| `ScrollStateOptions` | interface | `{ getTotal(): number; getVisible(): number }` |

### CSI 序列解析（`csi.ts`）

> 方案 A 新增：把按键数据流中 ESC 序列扫描（此前在 TuiApp.processChars / 全屏视图输入 / Selector 重复实现 3 份）收口为纯函数。

| 导出 | 类型 | 说明 |
|---|---|---|
| `parseCsiSequence(data, escIndex)` | fn | 从原始按键数据 `escIndex`（须指向 `\x1b`）处解析一个完整 CSI 序列（`ESC[` + 中间字节 + final 字节），返回 `{ seq, next }`——`seq` 为 final 序列（如 `'A'` / `'5~'`），`next` 为后续扫描位置；若 ESC 后不是 `[`（独立 ESC 退出键）返回 null |
| `CsiParseResult` | interface | `{ seq: string; next: number }` |

### Markdown 段落渲染（`markdown-text.ts`）

> 方案 A 新增：收敛「完整文本 → markdown 表格渲染 → 折行 → 可选缩进」逻辑（此前在 ConversationView 与 SubagentRecordView 重复实现 3 份）。

| 导出 | 类型 | 说明 |
|---|---|---|
| `renderMarkdownText(text, wrapWidth, prefix?)` | fn | 把一段完整 markdown 文本渲染为行数组（表格 box-drawing + ANSI-aware 折行 + 每行可选前缀）；适合一次性渲染完整内容块（历史对话 / 子代理记录），流式逐段喂入场景仍直接用 `MarkdownTableRenderer` |

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

### 子代理记录渲染（`subagent-record-view.ts`）

| 导出 | 类型 | 说明 |
|---|---|---|
| `SubagentRecordView` | class | 渲染 `SubagentRecord`（task/entries/result）为 ANSI 行；工具调用/结果/错误**复用主会话对话格式**（`● run` / `│` / `Error:`） |

```ts
import { SubagentRecordView } from 'deepseek-arch/render';
const lines = new SubagentRecordView().render(record, cols);
```

### 公共工具调用渲染（`conversation.ts`）

| 导出 | 说明 |
|---|---|
| `renderToolCallLine(name, args, durationMs?)` | `● run <name> <摘要> (Nms)` 工具调用行 |
| `renderToolResultLines(result)` | `│` 竖线工具结果行（最多 6 行） |
| `renderToolError(error)` | `[Denied]` / `Error:` 工具错误行 |

主会话 `ConversationView` 与 `SubagentRecordView` 共用上述函数，保证格式一致。

### 对话渲染选项

`ConversationView.render(turns, termWidth, { fullThink?: boolean })` —— `fullThink: true` 时 think 完整显示（Ctrl+O 全屏视图用），默认截断 4 行。

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
