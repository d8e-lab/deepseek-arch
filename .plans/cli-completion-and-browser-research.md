# 计划：CLI 补全 + 对话内命令补全 + 浏览器反爬虫调研

## 0. 复杂度快速评估

| 问题 | 答案 |
|------|------|
| 1. 涉及几个独立功能点/模块？ | **3大功能**：① CLI补全 ② 对话内命令补全 ③ 浏览器调研报告 |
| 2. 需修改 ≥3 个文件或变更核心接口？ | **是**（需修改 input-editor.ts、app.ts，新增文件） |
| 3. 存在不确定因素？ | **是**（Commander v14 的 .complete() 行为、浏览器反爬方案需验证） |
| 4. 是否有可独立执行的子任务？ | **是**（浏览器调研可独立） |
| **结论** | **复杂任务，需规划** |

---

## Phase 1 — 定位（调用链追踪）

### 功能1: CLI 子命令补全

```
用户输入: deepseek-arch ch<Tab>
  ↓
Shell 补全机制 (bash/zsh complete) 或 Commander 内建 .complete()
  ↓
补全为: deepseek-arch chat
```

当前 CLI 入口：`src/cli/index.ts`，使用 `commander@14`。
Commander v14 支持 `.complete()` 方法（v9+ 引入），可注册自定义补全。

### 功能2: 对话内命令补全

```
用户输入 / → 显示命令列表
用户输入 /m → 过滤显示 /model
用户按 ↑↓ → 切换选择
用户按 Tab/Enter → 补全选中
用户按 Enter 提交未知命令 → 显示 "Unknown command"
```

**数据流**：
```
process.stdin → TuiApp.processChars()
                  ↓ 检测到字符 '/' → 进入 commandSuggestion 模式
                  ↓ (而非等到 Enter 时才检查)
               InputEditor 仍然管理文本行
                  ↓
               TuiApp.renderInput() 渲染输入区域 + 建议列表
                  ↓
               用户按 ↑↓ → 切换 suggestionIndex
               用户按 Tab → 将选中建议写入 input
               用户按 Enter → buildSubmitContent → handleCommand()
                   ↓               ↓
               命令已识别        命令未识别
               执行命令          显示 "Unknown command: /xxx" + 不发送给模型
```

**影响文件**：
- `src/cli/tui/input-editor.ts` — 新增 suggestion 状态和导航方法
- `src/cli/tui/app.ts` — 修改 processChars/handleEscapeSeq，新增 suggestion 渲染逻辑，修改 handleCommand 返回值语义
- `src/cli/tui/types.ts` — 可能不需要改
- `src/cli/tui/renderer.ts` — 可能不需要改

### 功能3: 浏览器反爬虫调研 + 多标签页处理

纯调研 + 报告输出。不需要修改代码。

---

## Phase 2 — 决策与拆解

### 受影响文件清单

| 文件 | 改动类型 | 改动内容 |
|------|---------|---------|
| `src/cli/index.ts` | 新增 | CLI 补全注册（Commander .complete()） |
| `src/cli/tui/input-editor.ts` | 修改 | 新增 commandSuggestion 状态、导航方法 |
| `src/cli/tui/app.ts` | 修改 | 集成 suggestion 渲染、修改 handleCommand 语义 |
| `docs/browser-tools.md` | 新增 | 追加反爬虫方案和多标签页处理章节 |

### 子任务拆解

#### 子任务 A: CLI 补全（难度：低）
- **输入**：Commander v14 的 CLI 定义
- **输出**：注册到壳层的补全脚本（支持 bash/zsh）
- **方案**：Commander v14 的 `.complete()` 方法输出补全脚本，或生成单独补全文件
- **验收**：`deepseek-arch ch<Tab>` → `deepseek-arch chat`
- **风险**：低
- **可委派**：否（核心入口）

#### 子任务 B: 对话内命令补全（难度：高）
- **输入**：InputEditor 文本状态 + TuiApp 命令列表
- **输出**：用户输入时实时显示建议 + 补全 + 错误提示
- **方案**：
  1. InputEditor 新增 `suggestions: string[]`、`suggestionIndex: number`、`commandMode: boolean`
  2. TuiApp.processChars() 在检测到 `/` 且在第一行首列时进入 commandMode
  3. 在 commandMode 下：
     - 普通字符 → 更新过滤建议列表
     - ↑↓ → 切换 suggestionIndex
     - Tab → 补全当前选中命令（在光标后插入完整命令的剩余部分）
     - Enter → 检查命令是否有效，无效则显示错误
     - Backspace → 回到普通输入模式（如果输入框只剩 `/`）
     - ESC → 退出 commandMode，回到普通输入
  4. renderInput() 在 commandMode 下在输入区域下方渲染建议列表
  5. handleCommand() 对未知命令返回 false → 显示错误而非发送给模型
- **验收**：
  - 输入 `/` 立即显示命令列表（/model, /help, /context, /yolo, /async, /exit）
  - 输入 `/m` 过滤只显示 /model
  - ↑↓ 可切换高亮建议项
  - Tab 补全选中的命令到输入框
  - 输入 `/bad` + Enter → 显示 "Unknown command: /bad"
- **风险**：中（需处理与现有输入模式/粘贴模式的交互）
- **可委派**：否（与核心交互逻辑高度耦合）

#### 子任务 C: 浏览器反爬虫调研报告（难度：中）
- **输入**：当前 browser-state.ts 实现、Playwright 文档、社区实践
- **输出**：Markdown 文档报告
- **方案**：调研并记录到 docs/
- **验收**：提供可行的反反爬方案列表 + 多标签页处理说明
- **风险**：低
- **可委派**：**是**（独立调研任务，可 spawn subagent）

---

## Phase 2.5 — 自检表

| 检查项 | 结果 |
|--------|------|
| 是否理解用户所有需求点？ | ✅ CLI补全 + 对话内补全 + 错误命令提示 + 浏览器调研 |
| 是否明确了"不要什么"？ | ✅ 对话内补全不要改动 Selector 组件；CLI补全不要重写 commander 逻辑 |
| 是否识别了不明确点？ | ✅ 浏览器多标签页处理需进一步确认 |
| 是否识别了可委派子任务？ | ✅ 浏览器调研可委派 subagent |
| 是否最小化了改动量？ | ✅ 利用 InputEditor 现有架构，不引入新类 |
| 是否避免了过度设计？ | ✅ 命令补全列表硬编码（与现有 AVAILABLE_MODELS 一致） |
| 是否有测试计划？ | ⚠️ 因涉及 TUI 交互，测试以手动验收为主 |

---

## 最终计划

### Step 1: CLI 子命令/参数补全
在 `src/cli/index.ts` 中利用 Commander v14 的 `.complete()` 方法生成 bash/zsh 补全脚本。
也可以使用独立的 shell 补全文件。

### Step 2: 对话内命令补全（主要工作）
修改 `src/cli/tui/input-editor.ts` 和 `src/cli/tui/app.ts`：

**input-editor.ts 新增：**
- `commandMode: boolean` — 是否处于命令补全模式
- `suggestions: string[]` — 当前过滤后的建议列表
- `suggestionIndex: number` — 当前高亮的建议索引（-1 = 无选中）
- `availableCommands: string[]` —（由外部传入或在构造函数中设置）
- `enterCommandMode()` / `exitCommandMode()` — 进入/退出命令模式
- `updateSuggestions(prefix: string)` — 根据前缀过滤建议
- `navigateSuggestion(direction)` — 上下导航
- `getCurrentSuggestion()` — 获取当前选中建议文本

**app.ts 修改：**
- 定义 `AVAILABLE_COMMANDS` 列表（含 /model, /help, /context, /yolo, /async, /exit）
- `processChars()` — 增加命令模式检测逻辑：
  - 输入 `/` 且光标在第一行行首 → `input.enterCommandMode()`
  - 命令模式下字符输入 → `input.updateSuggestions()`
  - 命令模式下 ↑↓ → `input.navigateSuggestion()`
  - 命令模式下 Tab → 补全选中命令
  - 命令模式下 Enter → 检查有效性
  - 命令模式下 Backspace（只剩 /） → `input.exitCommandMode()`
  - 命令模式下 ESC → `input.exitCommandMode()`
- `renderInput()` — 在命令模式下，在输入区域下方额外渲染建议列表（类似 Selector 但内联）
- `handleCommand()` — 返回 false 时不发送给模型，而是显示 "Unknown command"

### Step 3: 浏览器反爬虫调研（委派 subagent）
spawn subagent 调查以下问题并输出调研文档：
1. Playwright/Chromium 自动化的反爬虫检测机制
2. 已有哪些对抗手段（stealth 插件、参数修改等）
3. 本项目的适用方案
4. 多标签页场景下当前行为分析

### Step 4: 集成与验证
- 编译通过
- 手动测试命令补全流程
- 生成调研文档

---

请确认以上计划，然后我将开始执行。
