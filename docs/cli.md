# CLI 设计

> 最后更新：2026-06-11 · 实现文件：`src/cli/index.ts`, `src/cli/tui/app.ts`, `src/cli/tui/input-editor.ts`

## 概述

基于 Commander.js v14 的命令行接口，提供全局选项和子命令。`chat` 子命令启动内联 TUI（`TuiApp`），不使用 alternate screen，支持流式输出、多行输入（软换行 + CJK 感知）、中断、输入队列等异步交互。旧版全屏 `ChatUI`（alternate screen）保留作为备选。

## 入口

```
src/index.ts  →  src/cli/index.ts (run)
```

`src/index.ts` 是 npm bin 入口，调用 `run()` 并处理致命错误。

## 全局选项

| 选项 | 输出 |
|------|------|
| `-V, --version` | `deepseek-arch v0.4.0`<br>`作者: helcksun`<br>`发布日期: 2026-05-18` |
| `-h, --help` | 全局帮助（含子命令列表） |

## 子命令

### chat

```
deepseek-arch chat [options]

开始新对话（全屏 TUI）

Options:
  --title <name>  设置对话标题
  -h, --help      显示 chat 命令帮助
```

启动全屏对话界面，包含：

- **多行输入面板**：灰底，Enter 发送，Ctrl+Enter/J 换行
- **三色渲染**：用户输入（绿），模型思考（灰），模型回复（白）
- **流式输出**：SSE 实时增量渲染，首次 content_delta 自动切换显示模式
- **Spinner 动画**：braille 字符 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`，80ms 间隔
- **ESC/Ctrl+C 中断**：中断流式输出，保留部分内容标记 `[已中断]`
- **输入队列**：流式期间可继续编辑/发送，排队处理
- **快捷键**：

| 快捷键 | 功能 |
|--------|------|
| Enter | 发送消息 |
| Ctrl+Enter / Ctrl+J | 换行 |
| Ctrl+C / ESC | 中断流式（流式时）/ 退出程序（空闲时） |
| Ctrl+L | 清屏 |
| /exit | 退出 |
| /clear | 清屏 |
| /title \<name\> | 命名会话 |

### resume

```
deepseek-arch resume [options]

恢复历史对话。不带参数时展示对话列表供选择。

Options:
  --id <id>      按对话 ID 精确匹配
  --name <name>  按对话标题精确匹配
  -h, --help     显示 resume 命令帮助
```

**不带参数时：**
```
当前已有 2 个会话:

 1  │ 分析 Rust 内存模型    │  5 轮  │ 2026-05-17 14:30
 2  │ Python 性能优化       │  3 轮  │ 2026-05-17 10:00

输入序号恢复会话（留空取消）: _
```

**错误处理：**
- `--id` 无匹配 → `未找到会话: <id>`，exit 1
- `--name` 无匹配 → `未找到标题为 '<name>' 的会话`，exit 1

## ChatUI 流式状态机

```
IDLE ── Enter ──► SENDING (spinner 旋转)
                    │
                    ├── first reasoning_delta  → phase=reasoning
                    ├── first content_delta   → STREAMING (停 spinner)
                    │
                    ├── done  → IDLE (显示 token 摘要)
                    ├── error → IDLE
                    └── ESC/Ctrl+C → abort → IDLE + 标记 `[已中断]`
```

### 状态说明

| 状态 | 行为 |
|------|------|
| IDLE | 等待用户输入，所有快捷键正常响应 |
| SENDING | 请求已发出，等待首个 SSE chunk，spinner 旋转 |
| STREAMING | 正在接收模型回复，内容增量渲染，spinner 已停 |

### 流式期间交互

- 普通按键 → 继续编辑输入框（不丢失输入焦点）
- Enter → 加入输入队列 (`inputQueue`)，状态栏显示 `⏳ 等待中 (N 条)...`
- Ctrl+C/ESC → 触发 `AbortController.abort()`，中断流式
- /exit, /clear 等命令 → 排队等待流式完成后自动执行

## 退出提示格式

```
会话已保存 (id: a1b2c3d4)
──────────────────────────────────────
本轮 Token 消耗:
  输入: 1,234  (缓存命中: 800, 未命中: 434)
  输出: 567
  缓存命中率: 64.8%
  本次费用: ¥0.0123
  累计费用: ¥0.0456
──────────────────────────────────────
恢复此会话:
  deepseek-arch resume --id a1b2c3d4
```

> 注：费用计算（Phase 7）当前输出 `¥0`，集成 TokenCalculator 后展示实际费用。

## 版本信息

版本号硬编码在 `package.json`、`src/cli/index.ts` 和 `src/cli/chat-ui.ts` 中：

```typescript
// src/cli/index.ts
const PACKAGE_VERSION = '1.0.1';

// src/cli/chat-ui.ts
const VERSION = '1.0.1';
```

发版时同步更新这三处。

## 测试

10 个 e2e 测试，通过 `execSync` 运行编译后的 CLI 验证输出：

- `--version` 包含版本号、作者、日期
- `-V` 等价于 `--version`
- `--help` 包含 chat 和 resume 子命令
- `-h` 等价于 `--help`
- `chat` 无参数时运行 action（非 TTY 报错退出）
- `chat --help` 显示 `--title`
- `resume --help` 显示 `--id` 和 `--name`
- `resume` 无参数时运行 action（显示会话列表或空提示）
- `resume --id` 不存在的会话报错退出
- `resume --name` 不存在的会话报错退出

测试在 `beforeAll` 中执行 `npx tsc` 确保代码已编译。
