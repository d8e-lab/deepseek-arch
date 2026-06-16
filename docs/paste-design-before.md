# 粘贴功能原始设计

> 创建于 2026-06-16 · 分析 v1.1.0 及之前版本

## 概述

粘贴功能由两部分协作完成：`TuiApp.handleInputData()` 负责解析终端的 bracketed paste 协议，`InputEditor.handlePaste()` 负责存储粘贴内容并在提交时还原。

## Bracketed Paste 协议

现代终端在粘贴时，用转义序列包裹粘贴内容以区分手打输入：

```
\x1b[200~ ...粘贴内容... \x1b[201~
```

`app.ts` 中设置 raw mode 时调用 `enableBracketedPaste()` 告知终端启用此协议。

## 数据流

### 粘贴接收（app.ts → input-editor.ts）

```
终端粘贴 → stdin 'data' 事件
  │
  ├─ 路径 A：bracketed paste（现代终端）
  │   handleInputData(data, resolve)
  │     ├─ 检测 \x1b[200~ → pasteMode = true
  │     ├─ pasteBuffer 累积 data chunk（可能跨多次 data 事件）
  │     ├─ 检测 \x1b[201~ → pasteMode = false
  │     └─ input.handlePaste(pasteBuffer)
  │         ├─ lineCount = text.split('\n').length
  │         ├─ pasteContents.push(text)          ← 原始文本入库
  │         └─ lines 中插入 "[paste +N lines]"    ← 占位标记
  │
  └─ 路径 B：非 bracketed paste（老终端）
      processChars(data, resolve)                ← 逐字符处理
        ├─ \r\n → insertNewline()               ← Windows 换行转软换行
        └─ 可打印字符 → insertChar()
```

### 提交还原（input-editor.ts）

```
用户按 Enter
  │
  ▼
buildSubmitContent()
  ├─ 遍历 lines
  ├─ 正则 /\[paste \+(\d+) lines\]/g 匹配占位标记
  ├─ line.replace(marker, pasteContents[pasteIdx++])
  └─ parts.join('\n') → 最终消息
```

### 完整生命周期

```
inputCycle()
  ├─ input.clear()           ← 清空 pasteContents, lines, 光标
  ├─ drawInputArea()
  ├─ readUserInput()         ← 用户在此周期内可打字、粘贴
  │    └─ ...多个 handleInputData 调用...
  ├─ buildSubmitContent()    ← 标记 → 实际文本
  └─ sendMessageStream()     ← 发送给模型
```

## 关键设计决策

### 为什么用占位标记而不是直接展开？

输入区域最多显示 5 行。粘贴 200 行代码时，直接展开会淹没输入区域、破坏渲染。占位标记 `[paste +200 lines]` 只占一行。

### 为什么 pasteContents 用数组？

支持同一输入周期内多次粘贴。数组按插入顺序存储，`buildSubmitContent` 按标记出现顺序替换——保证位置对应。

## 问题分析

### 问题 1：`\r` 未被清洗

**根因**：bracketed paste 捕获的原始字节直接存入 `pasteContents`，未做换行符归一化。WSL2 + Windows Terminal 粘贴的文本包含 `\r\n`，`\r` 被保留。

**传播路径**：

```
pasteBuffer = "line1\r\nline2\r\n"
  → pasteContents[0] 原样存储
  → buildSubmitContent() 原样还原
  → process.stdout.write('[You] ' + content)
  → 终端将 \r 解释为 carriage return
  → 行首覆盖，显示花屏
```

写入会话文件后，恢复对话时同样花屏。

**非 bracketed paste 不受影响**：`processChars` 中 `\r\n` 被显式转为 `insertNewline()`。

### 问题 2：行数统计 +1

**根因**：`text.split('\n').length` 把末尾空串计入行数。

```
"foo\nbar\n".split('\n') → ["foo", "bar", ""] → length=3
                                   ↑ 尾行空串
```

实际 2 行内容，显示 `[paste +3 lines]`。在 Windows Terminal 下粘贴几乎必然带末尾 `\r\n`，所以**总是 +1**。

### 问题 3：占位标记可被编辑破坏

标记 `[paste +N lines]` 是插在 `lines[]` 中的普通字符串，用户可以用 Backspace/Delete 逐字符破坏它。一旦正则不再匹配，对应的 `pasteContents[n]` 永久丢失。

```
用户粘贴 → 输入框显示 "[paste +50 lines]"
用户光标移到标记中间，按 Backspace → "[paste +5 lines"
                                           ↑ 缺 ]
buildSubmitContent() → 正则不匹配 → 50 行内容静默丢失
```

### 问题 4：占位标记正则可匹配用户手打文本

用户手打 `[paste +3 lines]` 这个字符串时，`buildSubmitContent` 会把它当作占位符替换——如果 `pasteContents` 中有残留内容就被错误注入，没有就被替换为空。

### 问题 5：小粘贴也用标记

粘贴 1-4 行时仍然显示 `[paste +1 lines]`，用户看不到粘贴的实际内容。粘贴 1 行代码本可直接展开在输入框。

## 受影响文件

| 文件 | 职责 |
|------|------|
| `src/cli/tui/app.ts` | Bracketed paste 协议解析、`processChars` 逐字符处理 |
| `src/cli/tui/input-editor.ts` | `handlePaste` 存储+标记、`buildSubmitContent` 还原、`deleteBeforeCursor/deleteAfterCursor` |
