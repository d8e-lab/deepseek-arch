# DeepSeek Arch

> DeepSeek Terminal Agent — Linux 终端 AI 助手

基于 Node.js + TypeScript 的终端对话工具，支持调用 DeepSeek API 进行多轮对话，
持久化保存对话历史（含 thinking 内容以命中 kv-cache），Token 消耗统计与费用计算。
支持 Agent Loop + Tool Calling：模型可自主调用 shell、文件、浏览器等工具，结果自动送回继续对话。

## 快速开始

### Arch Linux

```bash
# 方式一：从 AUR 安装（审核通过后可用）
# yay -S deepseek-arch

# 方式二：makepkg 本地构建
git clone https://github.com/d8e-lab/deepseek-arch.git
cd deepseek-arch/aur
makepkg -si

# 方式三：干净 chroot 构建（推荐，隔离系统环境）
cd aur
extra-x86_64-build

# 可选依赖（增强功能）
sudo pacman -S chromium git ripgrep

# 首次运行（自动创建默认配置文件 ~/.deepseek-arch/）
deepseek-arch --version
```

### 从源码运行（通用）

```bash
# 安装依赖
npm install

# 编译
npm run build

# 首次运行（自动创建默认配置文件 ~/.deepseek-arch/）
node dist/cli/index.js --version

# 查看帮助
node dist/cli/index.js --help
```

### 浏览器工具前置条件

浏览器工具需要 Chromium 浏览器。根据安装方式选择：

```bash
# Arch Linux（pacman 安装）
sudo pacman -S chromium

# 源码运行（npm i 后自动下载）
# Playwright 会自动下载内置 Chromium，无需额外操作

# npm 全局安装（npm install -g）
npx playwright install chromium
```

也可以不安装 Chromium，改用 `--cdp` 参数连接到宿主机上已有的 Edge/Chrome：

```bash
deepseek-arch chat --cdp http://127.0.0.1:9222
```

### 可选依赖

| 包 | 用途 | 安装 |
|---|------|------|
| chromium | 浏览器工具（Playwright） | `sudo pacman -S chromium` |
| git | 版本控制集成 | `sudo pacman -S git` |
| ripgrep | 增强文件搜索 | `sudo pacman -S ripgrep` |

## 功能概览

- **Agent Loop**：模型可自主调用工具，工具结果自动送回模型继续对话（无轮次上限，由模型自主决定结束）
- **Tool Calling**：barrel file 注册模式，新增工具只需一个文件 + 一行 export
- **Shell 工具**：模型可直接执行 shell 命令（禁止 sudo，10min 超时），用户 y/N 确认后执行
- **文件编辑**：edit_file/write_file + diff 预览 + 原子写入 + staleness 检查
- **浏览器工具**：模型可自主打开网页、浏览内容、点击链接、填写表单、滚动页面、按键盘键，基于 Playwright（纯文本模态，无需视觉能力）
- **宿主机 Edge 集成**：通过 CDP 连接到 Windows 宿主机 Edge，复用登录态
- **Session 持久化**：浏览器最后访问的 URL 跨 session 持久化，resume 时自动恢复
- **流式输出**：SSE 实时增量渲染，Ctrl+C 中断模型输出；模型调用工具前正文实时显示，对话节奏自然
- **多轮对话**：自动持久化 turn JSON（含 `reasoning_content` 命中 kv-cache + `tool_calls` 记录）
- **上下文压缩**：`/compact` 命令 + 自动 compact——分代存储、结构化摘要、Read 文件重注入，磁盘保留全量历史
- **模型切换**：`/model` 命令切换模型（deepseek-v4-flash / deepseek-v4-pro，候选列表从配置动态生成）
- **对话恢复**：按 ID 或标题恢复历史会话（含工具调用上下文重建）
- **子代理系统**：`subagent_spawn` / `wait` / `list_subagents` / `subagent_cancel` / `subagent_send` 工具，独立消息上下文 + 受限工具集，支持并行与 `--async` 异步模式
- **子代理会话化（方案 B）**：子代理升级为可恢复会话——完整消息上下文保留，`subagent_send`（master 工具）或 Ctrl+T 视图内输入可向已完成/失败的子代理追加指令续跑；记录含完整消息持久化，resume 后可继续交互
- **Subagents 总览视图**：Ctrl+T 任意状态打开全屏实时视图（状态条 + 选中子代理输出 + 视图内输入），n/p/数字切换，master 转入后台静默执行，返回时补渲染
- **全双工输入**：模型输出期间 `/` 命令立即执行（结果固定显示在底部命令结果区），普通文本/`!shell` 排队不中断输出、结束后自动发送
- **Skill 机制**：模型可发现并调用技能（plan/release/research），frontmatter 元数据 + 目录加载 + 条件激活（触碰 docs/ 等路径自动出现）
- **YOLO 审查模型**：`--yolo` 下自动批准工具执行，并在 agent loop 自然终止处审查输出（stalled/deflecting 自动续答）
- **命令补全**：输入 `/` 触发命令补全，建议列表支持滚动浏览全部选项
- **Token 记录**：保存 API 返回的 `usage`，每轮记录 KV cache 命中率日志（5% 异常标记）
- **API 请求监听**：`--monitor` + `api-monitor` 子命令，完整记录发给 API 的请求体，排查上下文丢失
- **本地测试模式**：`--mock` 使用内置 MockProvider，无需 API key 即可体验
- **Windows 支持**：Windows 自动使用内置 Edge，PowerShell 命令执行
- **配置外置**：TOML 文件管理，支持文件间跳转引用
- **安全隔离**：操作范围限于 home 目录和项目工作目录

## 命令行

```
deepseek-arch [options] [command]

Options:
  -V, --version     版本信息
  -h, --help        帮助信息

Commands:
  chat [options]            开始新对话（全屏 TUI）
  resume [id]               列出所有会话或恢复指定会话
  clear                     删除除最近 10 条外的所有会话
  api-monitor [options]     启动 API 请求监听服务器（配合 --monitor）
  completion [shell]        生成 bash/zsh 补全脚本
```

### chat 命令快捷键

```
Enter           发送消息（输出期间输入进入等待队列，输出结束后自动发送）
Ctrl+J          换行
Ctrl+C          中断模型输出 / 退出
Ctrl+T          Subagents 总览视图（任意状态；流式期间 master 后台执行）
Ctrl+O          全屏对话浏览视图（完整 think/content）
```

### chat 命令斜杠命令

```
/model [name]       切换模型（无参时交互选择，候选从配置动态生成）
/provider [name]    切换供应商（写回 defaults.provider）
/system [name]      列出/切换 system prompt 模板（写回 defaults.system_prompt）
/review_model [name] 查看/设置 YOLO 审查模型（写回 defaults.review_model）
/async              切换子代理异步模式（写回 defaults.async）
/yolo               切换 YOLO 模式（写回 defaults.yolo）
/subagent [name]    查看子代理详情
/subagent_cancel    交互式取消子代理
/compact            压缩会话上下文（摘要 + 文件重注入，开启新分代）
/context            显示会话上下文与 token 用量
/help               显示命令列表
/exit               退出
!<shell cmd>        Shell 命令模式（输出对模型不可见）
```

### chat 命令可用参数

```
-r, --resume <id>     按 ID 或名称恢复会话
--browser             显示浏览器窗口（默认 headless）
--cdp <url>           连接宿主机浏览器（如 --cdp http://127.0.0.1:9222）
--yolo                跳过所有工具确认（自动批准 shell/edit）
--async               子代理异步模式（spawn 立即返回，配合 wait/list_subagents）
--debug               暴露 TUI 捕获/渲染预览工具（模型调试用）
--self-interaction    暴露子会话 PTY 工具（模型自主验证前端展示）
--mock                使用 MockProvider（本地测试，无需 API key）
--monitor <url>       镜像 API 请求到监听服务器
```

## 配置

首次运行自动在 `~/.deepseek-arch/` 创建默认配置：

```
~/.deepseek-arch/
├── config.toml           # 主配置（[paths] 文件跳转 + [defaults] 默认模型/provider/system）
├── providers.toml        # API 密钥与地址（可按供应商配置超时/重试）
├── pricing.toml          # 模型价格（¥/1M tokens）
├── system-prompt.toml    # System Prompt 模板快照（启动时缺失则从项目根 system_prompt.txt 自动生成；可自定义）
├── skill/                # 技能文件（首次运行从项目 skill/ 复制，用户可自定义）
└── sessions/             # 对话数据（文件系统存储）
    └── <uuid>/
        ├── meta.json           # 会话元数据（含 goal/currentGen 等）
        ├── turns.json          # 全部轮次（v2 格式：version + messages 数组恒存）
        ├── system-prompt.txt   # 会话 system prompt（resume 恢复 KV cache 前缀）
        ├── turn_{gen}.json     # compact 分代文件（每次 compact 开启新分代）
        └── subagents/          # 子代理执行记录（<name>.json + _index.json）
```

配置 `~/.deepseek-arch/providers.toml` 中的 `api_key`（或设置 `DEEPSEEK_API_KEY` 环境变量）后即可使用。

**System Prompt 来源**：每次启动检查 `~/.deepseek-arch/system-prompt.toml`，缺失时从项目根 `system_prompt.txt` 自动生成 `[default]` 模板快照；运行时一律以 `system-prompt.toml` 为准。修改 `system_prompt.txt` 后删除该 toml 即可在下次启动生效；也可直接编辑 toml 自定义模板，用 `defaults.system_prompt` 切换。

### 主要配置项（config.toml `[defaults]`）

| 键 | 默认值 | 说明 |
|---|---|---|
| `provider` | `deepseek` | 默认供应商 |
| `model` | `deepseek-v4-pro` | 默认模型 |
| `system_prompt` | `default` | system prompt 模板名 |
| `review_model` | `deepseek-v4-flash` | YOLO 审查模型 |
| `temperature` / `max_tokens` | 未设置 | 生成参数（deepseek-v4 思考模式下 temperature 不生效） |
| `reasoning_effort` | `high` | 推理强度 low/high/max |
| `thinking` | `enabled` | 思考模式开关 |
| `yolo` | `false` | YOLO 模式（`/yolo` 写回） |
| `async` | `false` | 子代理异步模式（`/async` 写回） |
| `auto_compact` | `true` | 自动 compact 开关 |
| `auto_compact_threshold` | `0.7` | 自动 compact 触发阈值（占上下文窗口比例） |
| `context_window` | `1000000` | 上下文窗口大小（tokens） |

供应商级配置（providers.toml）：`base_url`、`api_key`、`timeout_ms`（默认 120000）、`max_retries`（默认 2）。

---

## 开发

> 开发前请先阅读 [agent.md](./agent.md) 了解行为约定。

### 环境要求

| 组件 | 最低版本 |
|------|---------|
| Node.js | ≥ 18（推荐 v24） |
| npm | ≥ 9 |

### 从源码构建

```bash
git clone <repo-url>
cd deepseek-arch
npm install
npm run build          # TypeScript → dist/
```

### 运行

```bash
# 开发模式（直接运行编译结果）
npm run build && node dist/cli/index.js --help

# 持续编译（修改后自动重新编译）
npm run dev

# 在另一个终端运行
node dist/cli/index.js chat
```

### 调试

```bash
# Node.js 内置调试器 + Chrome DevTools
node --inspect-brk dist/cli/index.js chat

# 调试测试文件
npx vitest --inspect-brk tests/core/config.test.ts
```

然后在 Chrome 打开 `chrome://inspect` 连接调试器。

### 测试

```bash
# 单次运行全部测试
npm test

# 持续监听模式（文件变更自动重跑）
npm run test:watch

# 覆盖率报告
npm run test:coverage
```

覆盖率报告输出到 `coverage/` 目录，用浏览器打开 `coverage/index.html` 查看。

### 项目结构

```
src/
├── index.ts                # 库入口（export 类型/类）
├── cli/
│   └── index.ts            # Commander CLI 主程序（组装器）
├── render/                 # ★ 渲染 SDK（无 I/O，输出 ANSI 行数组，可独立引用 deepseek-arch/render）
│   ├── conversation.ts     # ConversationView 对话渲染 + 工具调用公共渲染
│   ├── markdown.ts         # MarkdownTableRenderer 表格渲染
│   ├── input-editor.ts     # 多行输入编辑器
│   ├── selector.ts         # 交互选择器（stdout 通过 SelectorIO 注入）
│   ├── subagent-record-view.ts # 子代理记录渲染（与主会话格式统一）
│   ├── ansi.ts             # ANSI 颜色/宽度/diff 纯函数
│   ├── types.ts            # ScreenCapture 等渲染类型
│   └── index.ts            # barrel export
├── presentation/           # ★ 表示层（引用 render 组装界面 + 终端 I/O）
│   ├── tui-app.ts          # TuiApp：状态机/命令语义/事件订阅/流式渲染
│   ├── terminal.ts         # 终端 I/O（raw mode/stdin/resize/光标）
│   └── types.ts            # TuiConfig
├── core/
│   ├── config.ts           # ConfigManager（TOML 单例，多文件加载 + set 写回）
│   ├── storage.ts          # Storage（文件系统 Repository，分代存储）
│   ├── api.ts              # ApiClient（DeepSeek API 适配器，实现 ModelProvider）
│   ├── model-provider.ts   # ModelProvider 接口（抽象层）
│   ├── mock-provider.ts    # MockProvider（本地伪装提供商）
│   ├── session.ts          # SessionManager（Facade + Agent Loop + 子代理会话管理）
│   ├── subagent.ts         # 子代理循环引擎（可恢复：接收 messages 返回最新队列）
│   ├── subagent-session.ts # SubagentSession 会话对象（方案 B：状态/消息/续跑/持久化）
│   ├── subagent-store.ts   # 子代理类型 re-export（原内存缓冲已由 SubagentSession 取代）
│   ├── compact.ts          # 上下文压缩核心（摘要生成 + 文件重注入 + 分代）
│   ├── skill.ts            # Skill 引擎（frontmatter 解析 + 加载 + 条件激活）
│   ├── reviewer.ts         # YOLO 审查模型（completed/stalled/deflecting/asking_user）
│   ├── api-monitor.ts      # API 请求监听服务器
│   ├── cache-log.ts        # KV cache 命中率日志
│   └── system-info.ts      # 环境信息采集（注入 system prompt）
├── tools/
│   ├── types.ts            # Tool 接口（name, description, parameters, execute）
│   ├── shell.ts            # Shell 执行工具
│   ├── read-file.ts        # 文件读取工具
│   ├── search-content.ts   # 内容搜索工具
│   ├── write-file.ts       # 文件写入工具
│   ├── edit-file.ts        # 精确编辑工具
│   ├── skill.ts            # Skill 调用工具
│   ├── save-plan.ts        # 计划保存工具
│   ├── browser-*.ts        # 浏览器工具（navigate/snapshot/click/type/press-key/scroll/back）
│   ├── browser-state.ts    # Playwright 浏览器单例管理
│   ├── subagent-spawn.ts   # 子代理生成工具
│   ├── subagent-wait.ts    # 子代理等待工具
│   ├── subagent-list.ts    # 子代理列表工具
│   ├── subagent-cancel.ts  # 子代理取消工具
│   ├── subagent-send.ts    # 子代理追加指令工具（向已完成/失败子代理续跑）
│   ├── tui-*.ts            # TUI 调试工具（capture/render-preview/session 系列）
│   └── index.ts            # Barrel file（统一注册所有工具）
├── types/
│   ├── index.ts            # 类型重新导出
│   ├── chat.ts             # 消息与对话类型（含 StreamEvent）
│   ├── session.ts          # 会话类型（含分代 currentGen）
│   ├── subagent.ts         # 子代理领域类型
│   ├── config.ts           # 配置类型
│   ├── api.ts              # API 请求/响应类型
│   └── token.ts            # Token 用量类型
├── utils/
│   ├── event-loop.ts       # 事件循环让出（流式期间保持响应）
│   ├── throttle.ts         # 流式渲染节流
│   └── turn-utils.ts       # TurnRecord 派生字段辅助
skill/                       # 技能文件（plan/release/research .skill.md）
docs/                        # 模块设计文档
```

测试文件统一放在独立的 `tests/` 目录下，镜像 `src/` 的目录结构：

```
tests/
├── cli/
│   ├── index.test.ts
│   ├── input-editor.test.ts
│   └── tui/                 # app-stream / renderer
├── core/                    # api / api-monitor / compact / config / mock-provider /
│                            # session / session-skill-activation / skill / storage /
│                            # subagent / subagent-store
├── pty/                     # streaming（PTY 集成测试）
├── render/                  # conversation / markdown / subagent-record-view
├── tools/                   # edit-file / line-diff / skill / skill-confirm / skill-fork /
│                            # tui-capture / tui-render-preview / write-file
└── utils/
    └── throttle.test.ts
```

测试总数：**28 个测试文件，约 350 条测试用例**。设计文档见 [docs/test-separation-and-mock-provider.md](./docs/test-separation-and-mock-provider.md)。

---

## 工具系统（Tools）

模型可通过 Tool Calling 调用工具。采用 barrel file 注册模式：

| 工具 | 名称 | 说明 |
|------|------|------|
| Shell 执行 | `execute_command` | 在会话目录执行 shell 命令（需用户 y/N 确认，禁止 sudo，10min 超时） |
| 读取文件 | `read_file` | 读取文本文件，支持 offset/limit 分段读取 |
| 内容搜索 | `search_content` | 多关键词 OR 搜索，上下文行显示，glob 过滤 |
| 写入文件 | `write_file` | 创建/覆盖文件，diff 预览后确认，原子写入 |
| 精确编辑 | `edit_file` | 精确字符串替换（不用行号），唯一性检查，diff 预览后确认 |
| 技能调用 | `skill` | 调用任意已发现技能（plan/release/research），支持 requires-confirm / fork 子代理 |
| 保存计划 | `save_plan` | 规划文档写入 `.plans/<name>.md` |
| 导航 | `browser_navigate` | 打开指定 URL，自动返回页面快照 |
| 后退 | `browser_navigate_back` | 浏览器后退，自动返回页面快照 |
| 快照 | `browser_snapshot` | 获取当前页面 aria 结构化快照（文本格式） |
| 点击 | `browser_click` | 通过文本/role 定位并点击元素，自动返回快照 |
| 输入 | `browser_type` | 通过 placeholder/name 定位输入框并填入文本 |
| 按键 | `browser_press_key` | 发送键盘指令（Enter/Escape/ArrowDown/Tab 等） |
| 滚动 | `browser_scroll` | 滚动页面（方向+像素/page），自动返回快照 |
| 子代理生成 | `subagent_spawn` | 生成隔离子代理执行任务（`--async` 时立即返回） |
| 等待子代理 | `wait` | 等待一个或多个子代理完成并取回结果 |
| 列出子代理 | `list_subagents` | 列出活跃子代理状态 |
| 取消子代理 | `subagent_cancel` | 取消指定子代理（'all' 取消全部） |

调试/测试工具（需 `--debug` 或 `--self-interaction` 启用）：

| 工具 | 名称 | 说明 |
|------|------|------|
| TUI 捕获 | `tui_capture` | 获取当前 TUI 屏幕结构化快照（`--debug`） |
| 渲染预览 | `tui_render_preview` | 离线预览渲染效果（`--debug`） |
| 子会话 PTY | `tui_session_*` | 启动/交互/读取子 TUI 实例（`--self-interaction`） |

### 新增工具

1. 创建 `src/tools/xxx.ts`，导出具名 `Tool` 对象
2. 在 `src/tools/index.ts` 加一行 `export { xxxTool } from './xxx.js';`

```typescript
import type { Tool, ToolResult } from './types.js';

export const xxxTool: Tool = {
  name: 'my_tool',
  description: '工具描述（模型可见）',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresConfirm: false,
  async execute(params): Promise<ToolResult> {
    return { content: 'result' };
  },
};
```

**确认机制**：`requiresConfirm: true` 的工具（如 shell）执行前会弹出 `Execute? [y/N]` 确认。拒绝执行后拒绝消息写入上下文，模型可感知并调整策略。

### 浏览器配置

浏览器行为通过 CLI 参数控制：

```
deepseek-arch chat --browser                  # 显示浏览器窗口
deepseek-arch chat --cdp http://host:9222     # 连接宿主机 Edge
deepseek-arch resume <id> --cdp http://...    # resume 时也可用
```

对应环境变量（不传参数时回退）：

| 变量 | 说明 |
|------|------|
| `BROWSER_HEADED=1` | 显示浏览器窗口（等价于 `--browser`） |
| `BROWSER_CDP=http://...` | CDP 连接地址（等价于 `--cdp`） |
| `https_proxy` | 代理地址（本地启动 Chromium 时生效） |

优先级：CLI 参数 > 环境变量 > 默认值（headless）。

---

## 发行（打包分发）

### 方式一：npm link（开发/本地使用）

```bash
npm run build
npm link                  # 注册全局命令 deepseek-arch
deepseek-arch --version   # 任意目录可用
npm unlink -g             # 卸载
```

### 方式二：npm pack（生成 .tgz）

```bash
npm run build
npm pack                  # 生成 deepseek-arch-1.4.1.tgz
npm install -g ./deepseek-arch-1.4.1.tgz   # 安装
```

### 方式三：单文件可执行（实验性）

使用 [Bun](https://bun.sh) 或 [pkg](https://github.com/vercel/pkg) 打包为独立可执行文件：

```bash
# Bun（推荐，跨平台）
bun build src/index.ts --compile --outfile deepseek-arch

# 或使用 esbuild 打包
npx esbuild src/index.ts --bundle --platform=node --outfile=dist/bundle.js
node dist/bundle.js --version
```

### 方式四：Arch Linux（本地构建）

```bash
# 直接构建安装
git clone https://github.com/d8e-lab/deepseek-arch.git
cd deepseek-arch/aur
makepkg -si

# 干净 chroot 构建（推荐，确保可复现）
cd aur
extra-x86_64-build

# 或用项目脚本
./build-pkg.sh -i
```

**依赖一览**：

| 类型 | 包 | 说明 |
|------|----|------|
| 运行时 | `nodejs>=18` | Node.js 运行时 |
| 构建 | 无 | 预编译 tarball，零 `makedepends` |
| 可选 | `chromium` | 浏览器工具 |
| 可选 | `git` | 版本控制 |
| 可选 | `ripgrep` | 增强搜索 |

**版本跟踪**：`aur/.nvchecker.toml` 配置了 GitHub Release 自动检测，运行 `nvchecker -c aur/.nvchecker.toml` 可检查更新。

### 方式五：发布到 npm

```bash
npm run build
npm publish --access public
```

用户安装：`npm install -g deepseek-arch`

### 发布前检查清单

- [ ] 更新 `package.json` 版本号
- [ ] 更新 `src/cli/index.ts` 中的 `PACKAGE_VERSION` 常量
- [ ] 更新 `aur/PKGBUILD` 中的 `pkgver` 和 `pkgrel`
- [ ] 全量测试通过：`npm test`
- [ ] 生成预编译 tarball：`./scripts/build-prebuilt-tarball.sh`
- [ ] 把输出的 sha256 填入 `aur/PKGBUILD` 的 `sha256sums`
- [ ] 运行 `cd aur && makepkg --printsrcinfo > .SRCINFO` 更新元信息
- [ ] `git tag vX.Y.Z` 并推送
- [ ] 上传预编译 tarball 到 GitHub Release

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript (ESM) |
| CLI | Commander.js |
| 存储 | node:fs/promises（文件系统 JSON，分代存储） |
| 配置 | TOML（smol-toml） |
| 浏览器 | Playwright（Chromium / CDP 连接 Edge） |
| 渲染 | chalk（ANSI 着色）+ 自研 render SDK（纯函数，可独立引用 `deepseek-arch/render`） |
| PTY | node-pty（self-interaction 子会话） |
| 测试 | vitest + @vitest/coverage-v8 |
| UUID | uuid |

---

## 文档

| 文件 | 内容 |
|------|------|
| [agent.md](./agent.md) | 模型行为约定（开发守则、安全约束） |
| [SKILL_MECHANISM.md](./SKILL_MECHANISM.md) | Skill 机制说明 |
| [docs/architecture.md](./docs/architecture.md) | 整体架构设计 |
| [docs/config.md](./docs/config.md) | ConfigManager 设计 |
| [docs/storage.md](./docs/storage.md) | Storage 文件系统设计（分代存储） |
| [docs/types-modules.md](./docs/types-modules.md) | 类型拆分设计 |
| [docs/test-separation-and-mock-provider.md](./docs/test-separation-and-mock-provider.md) | 测试目录分离 + 伪装模型提供商设计 |
| [docs/cli.md](./docs/cli.md) | CLI 设计 |
| [docs/types.md](./docs/types.md) | 类型体系设计 |
| [docs/file-edit-tools.md](./docs/file-edit-tools.md) | 文件修改工具设计（write/edit + diff + 确认流程） |
| [docs/browser-tools.md](./docs/browser-tools.md) | 浏览器工具设计（工具定义 + 环境变量 + 生命周期） |
| [docs/subagent-design.md](./docs/subagent-design.md) | 子代理系统设计 |
| [docs/render-sdk.md](./docs/render-sdk.md) | Render SDK 说明 |
| [docs/system-prompt.md](./docs/system-prompt.md) | System Prompt 组装与调试 |
| [docs/testing.md](./docs/testing.md) | 测试指南（含 PTY 集成测试） |
| [docs/interaction-cmd.md](./docs/interaction-cmd.md) | 交互命令设计 |
| [docs/goal-tool-design.md](./docs/goal-tool-design.md) | Goal 工具设计（目标锚定 + reviewer 配合） |
| [docs/subagent-followup-research.md](./docs/subagent-followup-research.md) | subagent 追加指令可行性调研 |
| [docs/audit-config-command-sync.md](./docs/audit-config-command-sync.md) | 配置↔命令↔配置文件同步缺口审计 |

### 内置技能（Skill）

| 技能 | 文件 | 说明 |
|------|------|------|
| plan | `skill/plan.skill.md` | 编码任务规划与自检框架（复杂度评估 → 拆解 → 确认 → 执行） |
| release | `skill/release.skill.md` | 版本发布全流程 |
| research | `skill/research.skill.md` | 独立技术调研（隔离子代理执行，不占用主对话上下文） |
| docs | `docs.skill.md` | 文档维护规范（条件激活：触碰 docs/ 路径时出现） |

---

## 更新日志

### v1.4.1 — 渲染与交互体验

- Render SDK 架构升级（`deepseek-arch/render` 独立导出）
- 子代理详情统一（格式与主会话完全一致）、Ctrl+O 全屏视图
- 命令补全支持滚动浏览、正文实时显示（工具调用前先输出文字）
- 浏览器启动错误分类指引、`--mock` 本地测试模式、`--self-interaction` 自主验证工具

### v1.4.0 — Skill 机制重构（测试版）

- skill 工具 + frontmatter 元数据（name/description/when_to_use/aliases/context/paths）
- 目录加载 + listing 注入 system prompt + 条件激活 + fork 子代理执行
- 动态确认（requires-confirm）、规划框架增强（设计蓝图先行）

### v1.3.9 — 全屏视图与紧凑展示

- Ctrl+O 全屏对话浏览视图（完整 think/content）
- 工具调用紧凑展示

### v1.3.8 — 存储 v2

- turns.json 改为 version + messages 数组恒存（精确回放 API 消息前缀，命中 KV cache）

### v1.3.7 — Windows 支持

- 平台自适应浏览器启动（Windows 自动用 Edge）
- PowerShell 命令执行

### v1.3.6 — TUI 调试工具与自我交互

- `--debug`：tui_capture / tui_render_preview
- `--self-interaction`：tui_session_* PTY 工具链
- `--mock`：MockProvider

### v1.3.5 — 子代理系统

- subagent_spawn / wait / list_subagents / subagent_cancel
- 异步模式、独立取消生命周期、子代理详情视图

### v1.3.2 — AUR 预编译

- 预编译 tarball + AUR 打包

### v1.3.1 — YOLO 审查模型

- `--yolo` + reviewer（completed/stalled/deflecting/asking_user + 自动续答）

### v1.3.0 — 浏览器工具

- 8 个浏览器工具（navigate / snapshot / click / type / press_key / scroll / back）
- 纯文本模态（ariaSnapshot）、CDP 连接宿主机 Edge、URL 跨 session 持久化

### v1.2.1 — 规划与文档技能

- plan_on / save_plan 工具、shell 流式输出、粘贴增强、`!` shell 命令模式

### v1.1.0

- 工具注册改为 barrel file 模式、Agent Loop 流式重构、内联 TUI 改造

### v1.0.0

- 初始发布：DeepSeek API 对话、Shell 工具、文件编辑、持久化存储

---

## 版本

- 作者：helcksun
- 当前版本：v1.4.1
- 许可证：MIT
