# 粘贴功能重构

> v1.2.0 · 2026-06-16

## 改动总览

| # | 改动 | 效果 |
|---|------|------|
| 1 | `\r` 清洗 | 跨平台粘贴显示正常 |
| 2 | 行数修正 | 标记行数准确 |
| 3 | <5 行直接展开 | 小粘贴用户可见可编辑 |
| 4 | #N 序号标识 | 多次粘贴可区分 |
| 5 | 原子删除 | Backspace/Delete 一键删除标记 |

**改动的文件**：`src/cli/tui/input-editor.ts`（+110 行）、`tests/cli/input-editor.test.ts`（新增 29 用例）、版本号文件 3 个。

## 新数据流

### 粘贴接收

```
handlePaste(text)
  │
  ├─ 1. 归一化换行：\r\n → \n，\r → \n
  │
  ├─ 2. 数行：trim 末尾 \n 后 split
  │
  ├─ 3. 分流：
  │    ├─ lineCount < 5  → 直接展开到 lines[]
  │    │    ├─ 光标前文本 + 粘贴首行
  │    │    ├─ splice 插入中间行
  │    │    └─ 粘贴末行 + 光标后文本
  │    │
  │    └─ lineCount ≥ 5  → 标记方案
  │         ├─ pasteSeq++
  │         ├─ pasteContents.push(text)
  │         └─ 插入 "[paste #N +M lines]"
  │
  └─ 4. clampScroll()
```

### 提交还原

```
buildSubmitContent()
  ├─ 正则 /\[paste #\d+ \+(\d+) lines\]/g
  ├─ 按出现顺序替换 pasteContents[i]
  └─ parts.join('\n')
```

### 原子删除

```
deleteBeforeCursor() / deleteAfterCursor()
  │
  ├─ findPasteMarkerAt(line, idx, side)
  │    ├─ 'left'（Backspace）：idx 在 (start, end] → 命中
  │    └─ 'right'（Delete）：  idx 在 [start, end) → 命中
  │
  ├─ 命中 → slice 移除整个标记字符串
  │         pasteContents.splice(order-1, 1)
  │         更新 cursorCol（仅 Backspace）
  │
  └─ 未命中 → 原有逐字符删除逻辑
```

**跨行场景**：

- 行首 Backspace：检查上行末尾是否有标记 → 有则删标记不合并行
- 行尾 Delete：检查下行开头是否有标记 → 有则删标记不合并行

## 新工作流（完整生命周期）

```
inputCycle()
  ├─ input.clear()  ← pasteSeq=0, pasteContents=[]
  │
  ├─ readUserInput()
  │    │
  │    ├─ 用户粘贴 3 行代码
  │    │   → handlePaste: 清洗 \r, lineCount=3 < 5
  │    │   → 直接展开到 lines: ["def foo():", "    pass", ""]
  │    │   → 用户可见，可编辑
  │    │
  │    ├─ 用户粘贴 50 行
  │    │   → handlePaste: 清洗 \r, lineCount=50 ≥ 5
  │    │   → pasteSeq=1, 标记 "[paste #1 +50 lines]"
  │    │   → 用户看到标记，可按 Backspace 整块删除
  │    │
  │    └─ 用户再粘贴 30 行
  │        → handlePaste: lineCount=30 ≥ 5
  │        → pasteSeq=2, 标记 "[paste #2 +30 lines]"
  │        → 两个标记可独立原子删除
  │
  ├─ buildSubmitContent()
  │   → "[paste #1 +50 lines] [paste #2 +30 lines]"
  │   → "50行内容 30行内容"
  │
  └─ sendMessageStream()
```

## 设计决策

### 为什么不做系统信息检测？

`\r` 问题的本质是换行符不统一。在 `handlePaste` 入口做 `\r\n → \n` 归一化是平台无关的方案——无论来源是 Linux、Windows 还是 WSL，进入内部表示后只有 `\n`。比引入 `system-info.ts` 做 OS 判断更简单，且不增加模块依赖。

### 为什么 5 行是阈值？

输入区域最多显示 5 行。5 行以下粘贴不会撑爆输入区域，直接展开收益最大；5 行及以上切换到标记方案。

### 为什么 #N 按插入顺序而非全局唯一？

`pasteSeq` 在每次 `clear()`（新输入周期）时归零。同一周期内的多次粘贴用 #1、#2 区分，跨周期重新从 #1 开始。`buildSubmitContent` 不依赖 #N 做映射，而是按标记**出现顺序**匹配 `pasteContents`——#N 仅为用户视觉标识。

### 原子删除为什么用 order 而非 #N？

标记在行内可能出现多个，`findPasteMarkerAt` 扫描正则匹配，返回第几个匹配（order）。删除时 `pasteContents.splice(order-1, 1)` 移除对应项。即使之后 #N 序号与实际位置不再对应，`buildSubmitContent` 仍按出现顺序替换，功能正确。

## 新增测试覆盖

| 类别 | 用例数 | 关键场景 |
|------|--------|---------|
| `\r` 清洗 | 3 | `\r\n`、孤立 `\r`、混合 |
| 行数统计 | 3 | 末尾无换行、有 `\n`、有 `\r\n` |
| <5 行直接粘贴 | 5 | 单行空框、单行光标中、多行空框、多行光标中、边界值 4 行 |
| ≥5 行标记 | 2 | 边界值 5 行、多次 #N 递增 |
| 混合粘贴 | 2 | 小+大、大+小 |
| 标记还原 | 2 | 单个、多个 #N |
| clear 重置 | 2 | pasteSeq 归零、pasteContents 清空 |
| 边界 | 2 | 纯换行粘贴、`\r\n\r\n` |
| 原子删除 | 8 | 标记内 Backspace、标记右 Backspace、标记内 Delete、标记左 Delete、跨行 Backspace、跨行 Delete、pasteContents 同步、普通字符不受影响 |
| **合计** | **29** | |
