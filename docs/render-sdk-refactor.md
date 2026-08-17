# TUI → 渲染 SDK + 表示层 重构（需求澄清与实施方案）

> 状态：需求已确认，方案已评审，等待执行
> 日期：2026-08-16
> 关联分支：`feat/render-sdk`（待创建）

## 1. 背景与原始需求

当前 `src/cli/tui/` 是单体前端：`TuiApp`（2150 行）将**对话逻辑**与**终端渲染**深度耦合，直接操作 `process.stdin/stdout`。

用户原始诉求：

> 我想要把我的前端 tui 改成一个标准的 sdk，然后再由一个中间的展示层引用 sdk 实现具体的展示功能。

## 2. 需求澄清过程

### 2.1 第一轮理解（有偏差）

最初将需求理解为：SDK = **无头对话引擎**（把对话逻辑从 TUI 下沉），展示层 = 渲染 UI。

### 2.2 用户澄清（关键修正）

> 我想的 sdk 是指**负责前端渲染的组装件**，不知道我和你的理解有没有偏差。

修正后的理解：

| 层 | 职责 | 类比 |
|---|---|---|
| **渲染 SDK** | 可复用的"渲染零件"：对话渲染器、markdown、输入编辑器、选择器、ANSI 工具等 | 类似 ink（终端 React） |
| **表示层（Presentation Layer）** | 引用 SDK 零件组装出具体聊天界面；负责应用状态、事件订阅、终端接入 | 类似用 ink 写出的具体 App |
| **core（对话引擎）** | 既有底层，不动 | — |

> 术语说明：用户最初用的"展示层"即标准术语 **Presentation Layer（表示层/表现层）**。因该层还承担应用状态机、命令语义、事件编排等职责，也可称 **Application Layer**，正式名取 **Presentation Layer（表示层）**。

### 2.3 最终决策点确认

| 决策点 | 结论 |
|---|---|
| SDK 边界 | **渲染组件库**（负责前端渲染的组装件），输出 **(a) ANSI 字符串行数组** |
| SDK I/O | **完全无 I/O**（纯计算：状态 → 行数组），SDK 内不允许 `process.*` 引用 |
| 输入处理 | stdin 监听 / raw mode / 按键解析归**表示层** |
| 消费者范围 | 短期 = 重构后的 TUI；**未来预留 GUI**（本次不做 GUI，3.2 已砍） |
| 交付形态 | **不独立 npm 包**，同包新导出路径（`deepseek-arch/render`） |
| 兼容性 | **硬性要求**：`chat`/`resume` 行为与视觉 100% 保持、现有测试全绿 |

## 3. 现状分析（代码盘点）

### 3.1 `src/cli/tui/` 结构

| 文件 | 行数 | 职责 | 终端 I/O |
|---|---|---|---|
| `app.ts` | 2150 | TuiApp 单体：状态机 + 渲染 + 输入 + 流式 + 工具确认 + shell 模式 + 自我交互 + 全屏视图 + 搜索 + 命令补全 | ✅ 直接操作 stdout/stdin |
| `conversation.ts` | 223 | ConversationView / wrapText / truncateThink（对话渲染） | ❌ 纯渲染 |
| `renderer.ts` | 253 | 25 个导出：颜色/宽度/diff/工具摘要（纯计算）+ 光标/清屏/尺寸（I/O） | ⚠️ 混合 |
| `input-editor.ts` | 631 | 多行输入编辑器（缓冲 + 光标 + 渲染，按键外部喂入） | ❌ 无 |
| `markdown.ts` | 216 | MarkdownTableRenderer | ❌ 无（stdout 仅在注释示例） |
| `selector.ts` | 184 | 交互选择器（↑↓/Enter/数字快捷键） | ✅ 直接写 `process.stdout`（5 处）+ getTermSize/clearLine |
| `types.ts` | 84 | AppState / TuiConfig / ScreenCapture 等 | — |

### 3.2 耦合问题

1. **TuiApp 巨型化**：逻辑与渲染揉合，2150 行难以测试、难以复用；
2. **tools → cli/tui 反向依赖**（依赖方向错误）：
   - `src/tools/tui-capture.ts` → `cli/tui/types.js`
   - `src/tools/tui-render-preview.ts` → `cli/tui/conversation.js` + `renderer.js`
   - `src/tools/tui-session-capture.ts` → `cli/tui/types.js`（内联 import 类型）
   - `src/tools/tui-session-manager.ts` → `cli/tui/renderer.js` + `types.js`
3. **`src/index.ts` 不导出 TUI**：SDK 边界未定义；
4. **测试引用**：`tests/cli/tui/app-stream.test.ts`（252 行回归测试）、`renderer.test.ts`、`tests/cli/input-editor.test.ts`、`tests/tools/tui-capture.test.ts` 均引用 `cli/tui`。

### 3.3 关键发现（影响方案设计）

| # | 发现 | 处理 |
|---|---|---|
| 1 | `renderer.ts` 25 个导出中 **19 个纯计算**（dim/cyan/stripAnsi/strDisplayWidth/renderDiffLine/formatToolCallSummary/truncateByWidth/padToWidth/isWideChar/charDisplayWidth…）+ **6 个终端 I/O**（getTermSize/onResize/offResize/光标控制/清屏系列） | 拆分为 `render/ansi.ts`（纯计算）+ `presentation/terminal.ts`（I/O） |
| 2 | `Selector` 直接 `process.stdout.write`（render/clearDisplay 内 5 处）+ 依赖 `getTermSize`/`clearLine` | 违反"SDK 无 I/O"→ 将 stdout 抽象为**注入的 `out` 对象**（微改造） |
| 3 | `InputEditor`/`conversation`/`markdown` **无直接 I/O** | 可原样平移进 SDK |
| 4 | `AppState` 枚举被 `ScreenCapture` 引用（render 类型） | `AppState` 归 `render/types.ts`（保证依赖方向 presentation → render） |
| 5 | `TuiConfig` 只被表示层消费 | 归 `presentation/types.ts` |
| 6 | `app-stream.test.ts` mock stdout 验证流式渲染行为 | 迁移后必须继续通过 = 行为保持的自动验证资产 |

### 3.4 agent 自主验证前端展示能力链现状（2026-08-16 盘点）

| 链路 | 工具 | 状态 |
|---|---|---|
| 主会话内验证（`--debug`） | `tui_capture` / `tui_render_preview` | ✅ 可用（capture 要求 IDLE，设计如此） |
| 子会话 PTY 验证 | `tui_session_start`/`send`/`read`/`capture`/`stop`/`list` | ⚠️ 代码完整但**不可达**：仅注册进 `SELF_INTERACTION_TOOLS`（`getAllTools({ selfInteraction: true })` 才注入），而 CLI 无 `--self-interaction` 入口、`TuiApp.setSelfInteraction()` 无调用方 |
| PTY 端到端测试 | `tests/pty/streaming.test.ts` | ❌ 损坏：依赖已删除的 `--mock` 参数和 `dist/index.js` 路径（见 open-issues 测试遗留 #1） |

→ 重构保留该能力链主体（5 个工具文件的 import 更新已在 T6 覆盖），T10/T11 负责补齐"不可达/损坏"部分。

## 4. 目标架构

```
deepseek-arch (npm 包)
├── src/core/            # 对话引擎（不动）
├── src/render/          # ★ 渲染 SDK（从 cli/tui 提炼，无 I/O）
│   ├── conversation.ts  #   ConversationView / wrapText / truncateThink
│   ├── markdown.ts      #   MarkdownTableRenderer
│   ├── ansi.ts          #   颜色/宽度/diff/formatToolCallSummary/stripAnsi（纯计算）
│   ├── input-editor.ts  #   InputEditor（缓冲+光标+渲染，按键由外部喂入）
│   ├── selector.ts      #   Selector（stdout 通过注入 out 对象，无直接 I/O）
│   ├── types.ts         #   ScreenCapture / TurnCaptureInfo / AppState 等渲染类型
│   └── index.ts         #   barrel export（Phase 2）
├── src/presentation/    # ★ 表示层（引用 render 组装界面）
│   ├── terminal.ts      #   终端 I/O：raw mode/stdin/resize/光标直写 stdout
│   ├── types.ts         #   TuiConfig 等表示层配置
│   └── tui-app.ts       #   TuiApp 瘦身：状态机/命令语义/事件订阅/双工队列/shell模式
├── src/cli/index.ts     # 组装器（改 import 路径）
└── src/tools/           # 改 import 路径（tools → render，清理反向依赖）
```

**依赖方向**：`cli → presentation → {render, core}`，`tools → render`，`presentation → render`。`render/` 内零 `process.*` 引用。

## 5. 模块拆解明细

### 5.1 进 SDK（`src/render/`）

| 源文件 | 目标 | 改动 |
|---|---|---|
| `conversation.ts` | `render/conversation.ts` | 平移；import `renderer.js` → `ansi.js` |
| `markdown.ts` | `render/markdown.ts` | 平移 |
| `renderer.ts`（纯计算部分） | `render/ansi.ts` | 拆分；导出名不变 |
| `input-editor.ts` | `render/input-editor.ts` | 平移；import `renderer.js` → `ansi.js` |
| `selector.ts` | `render/selector.ts` | 平移 + **stdout 抽象为注入 `out: { write(s: string): void }`** |
| `types.ts`（渲染类型） | `render/types.ts` | `ScreenCapture`/`TurnCaptureInfo`/`ToolCallCaptureInfo`/`InputAreaCapture`/`CaptureScreenFn`/**`AppState`** |

### 5.2 进表示层（`src/presentation/`）

| 内容 | 来源 | 说明 |
|---|---|---|
| `terminal.ts` | `renderer.ts`（I/O 部分） | getTermSize / onResize / offResize / 光标 / 清屏 / raw mode |
| `types.ts` | `cli/tui/types.ts`（TuiConfig） | 表示层配置 |
| `tui-app.ts` | `app.ts` | import 全部改到 render/ + terminal.ts；Selector 实例化传注入 out |

### 5.3 引用更新（不改逻辑）

| 文件 | 改动 |
|---|---|
| `src/cli/index.ts` | `TuiApp` → `../presentation/tui-app.js`；`TuiConfig` → `../presentation/types.js` |
| `src/tools/tui-capture.ts` | types → `../render/types.js` |
| `src/tools/tui-render-preview.ts` | conversation/renderer → `../render/conversation.js` + `../render/ansi.js` |
| `src/tools/tui-session-capture.ts` | 内联 import types → `../render/types.js` |
| `src/tools/tui-session-manager.ts` | renderer/types → `../render/ansi.js` + `../render/types.js` |
| `tests/cli/tui/app-stream.test.ts` | app → `presentation/tui-app.js`；types → `render/types.js`；renderer → `render/ansi.js` |
| `tests/cli/tui/renderer.test.ts` | renderer → `render/ansi.js`（可改名 ansi.test.ts） |
| `tests/cli/input-editor.test.ts` | input-editor → `render/input-editor.js` |
| `tests/tools/tui-capture.test.ts` | types → `render/types.js` |

### 5.4 删除与导出（Phase 2）

- 删除整个 `src/cli/tui/`（迁移完成后）；
- `src/render/index.ts` barrel export：ConversationView / wrapText / truncateThink / MarkdownTableRenderer / ansi 全量 / InputEditor / Selector / SelectOption / render 类型；
- `package.json` exports 增加 `"./render": "./dist/render/index.js"`。

## 6. 关键设计决策

1. **renderer.ts 拆分**：纯计算进 `render/ansi.ts`（SDK），终端 I/O 进 `presentation/terminal.ts`（表示层），**导出名保持不变**，避免牵连大量调用方；
2. **Selector I/O 注入**：构造签名增加可选/必选 `out: { write(s: string): void }`，内部 `process.stdout.write` → `this.out.write`，`clearLine()` → `this.out.write('\x1b[2K')`，`getTermSize().cols` → 注入尺寸或由 out 提供。表示层传入 `process.stdout` 包装。这是"SDK 无 I/O"硬性要求的必要代价；
3. **AppState 归属**：因 `ScreenCapture.appState` 引用它，归 `render/types.ts`，保证 render 不被 presentation 反向依赖；
4. **TuiConfig 归属**：纯表示层配置，归 `presentation/types.ts`；
5. **未来 GUI 预留**：`ConversationView.renderToText` 保持同时输出纯文本与 ANSI 两种能力（stripAnsi 由调用方处理），GUI 可复用纯文本路径（本次不实施，仅设计预留）。

## 7. 兼容性保障策略

1. **先平移、后整理**：Phase 1 只做"文件搬家 + import 改路径"，一行逻辑不改；
2. 迁移后立即全量测试（现有 119 条 + TUI 回归测试更新路径）；
3. 手工验收清单：`chat` 新会话、`resume` 恢复、流式输出、think 折叠、工具确认、shell 模式、双工（流式中 Enter）、`/model` 选择器、Ctrl+O 全屏视图、命令补全、自我交互；
4. TUI 侧测试薄弱处补测试：`render/` 纯函数（ConversationView/wrapText/ansi/InputEditor）纳入单元测试覆盖。

## 8. 实施计划

### Phase 1 — 平移重构（行为不变）

| # | 子任务 | 验收 | 委派 |
|---|---|---|---|
| T1 | 拆分 `renderer.ts` → `render/ansi.ts` + `presentation/terminal.ts`（导出名不变） | tsc 通过；导出清单一致 | 自己做 |
| T2 | 平移 `conversation`/`markdown`/`input-editor`/`types` → `render/` | 内容逐字节一致（仅 import 行不同） | 自己做 |
| T3 | `Selector` → `render/selector.ts` + stdout 注入抽象 | SDK 内零 `process.*`；行为等价 | 自己做 |
| T4 | `app.ts` → `presentation/tui-app.ts`（import 改路径 + Selector 注入） | 逻辑零改动 | 自己做 |
| T5 | 创建 `presentation/terminal.ts` + `presentation/types.ts` | tsc 通过 | 自己做 |
| T6 | 更新 `src/cli/index.ts` + `src/tools/` 5 文件 import | 无 `cli/tui` 引用 | 可委派 subagent |
| T7 | 更新 `tests/` 5 文件 import | 全量测试绿 | 可委派 subagent |
| T8 | 删除 `src/cli/tui/`；tsc + 全量测试 + 手工验收 | 编译零错误；测试全绿 | 自己做 |
| T10 | CLI 增加 `--self-interaction` 选项：`loadMasterTools` 传 `{ selfInteraction: true }`，`TuiApp.setSelfInteraction(true)` | `tui_session_*`（PTY 子会话工具链）可被模型调用 | 可委派 subagent |
| T11 | 修复 `tests/pty/streaming.test.ts`（给 CLI 接 MockProvider 后重建 PTY 测试） | PTY 测试绿 | 可委派 subagent |

**里程碑 M1**：结构重构完成，行为 100% 保持；**agent 自主验证前端展示能力链补齐**（主会话内 + PTY 子会话双链路可达）。

### Phase 2 — SDK 标准化

| # | 子任务 | 验收 | 委派 |
|---|---|---|---|
| T9 | `render/index.ts` barrel + package.json `./render` 导出 + 补 render 单元测试 + `docs/render-sdk.md` | 外部可 `import ... from 'deepseek-arch/render'` | docs/测试可委派 |

**里程碑 M2**：SDK 可被第三方独立引用。

### Phase 3 — GUI 预留（已砍，仅记录）

原 3.1/3.2（验证纯文本渲染可被 GUI 复用 + GUI 原型）经用户确认**不做**。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `renderer.ts` 拆分时"纯计算"与"终端直写"函数互相引用 | 拆分前已列全 25 个导出归属；`ansi.ts` 只依赖纯函数 |
| TuiApp 2150 行迁移中 import 遗漏 | Phase 1 只平移不改逻辑；tsc 编译错误兜底 |
| Selector 注入改造引入行为回归 | 改动点集中（5 处 stdout.write + getTermSize/clearLine）；app-stream 回归测试覆盖 |
| TUI 侧无测试、行为回归难发现 | 手工验收清单 + Phase 2 补 render 单元测试 |
| tools/tests 引用遗漏 | 已用 grep 全量盘点 10 个引用文件 |

## 10. 验收标准（最终）

- [ ] `chat` / `resume` 行为与视觉 100% 保持（手工验收清单全过）
- [ ] `tsc` 编译零错误
- [ ] 全量测试绿（含迁移后的 TUI 回归测试）
- [ ] `src/` 中无任何 `cli/tui` 引用残留
- [ ] `render/` 内无 `process.*` 引用（grep 验证）
- [ ] package.json 导出 `./render`，外部可引用
