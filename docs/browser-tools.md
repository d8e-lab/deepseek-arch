# 浏览器工具设计文档

> 创建于 2026-07-03 · v1.2.1

## 概述

为 Agent 新增 8 个浏览器交互工具，基于 Playwright 库 (npm)，赋予纯文本语言模型浏览网页、点击链接、填写表单、滚动页面等能力。

核心设计约束：**纯文本模态，无视觉能力**。模型通过 Playwright 的 `ariaSnapshot()` 方法获取页面的结构化文本表示（ARIA 无障碍树），而非截图。

## 安装

浏览器工具需要 Chromium 浏览器：

```bash
# Arch Linux
sudo pacman -S chromium

# 源码运行（npm i 后 playwright 自动下载）
# npx playwright install chromium  # 如需单独安装

# 或不安装浏览器，连接宿主机已有的 Edge/Chrome
# deepseek-arch chat --cdp http://127.0.0.1:9222
```

## 设计原则

### 1. 纯文本优先

模型没有视觉能力，页面感知完全依赖 Playwright 的 ARIA 无障碍树。输出格式为 YAML 风格文本：

```
- heading "Example Domain" [level=1]
- paragraph: This domain is for use in documentation examples.
- paragraph:
  - link "Learn more":
    - /url: https://iana.org/domains/example
```

所有可见文本内容（包括非交互元素的纯文本）都保留在输出中，确保模型不会遗漏信息。

### 2. 工具即原子操作

每个浏览器工具封装一个原子操作，模型通过 Tool Calling 调用。不引入独立的 Agent Loop 或 subagent——模型自己编排步骤。

```
sendMessageStream → agent loop (max 25 rounds)
  ├── LLM → browser_navigate(url)
  ├── Tool result (snapshot)
  ├── LLM → browser_click(text="Learn more")
  ├── Tool result (snapshot)
  └── LLM → 读取内容 → 总结
```

### 3. 自动快照

导航 (navigate)、点击 (click)、后退 (navigate_back)、滚动 (scroll) 等改变页面状态的操作，执行后自动返回页面快照，省去一次额外的 `browser_snapshot` 调用。输入 (type) 不自动快照——适合连续填写多个字段。

| 工具 | 自动快照 | 理由 |
|------|:--------:|------|
| browser_navigate | ✅ | 页面全新，必须看 |
| browser_click | ✅ | 点击后页面通常变化 |
| browser_navigate_back | ✅ | 回到历史页面 |
| browser_scroll | ✅ | 显示新区域内容 |
| browser_press_key | ✅ | 按键可能触发提交/跳转 |
| browser_type | ❌ | 填字段不改变页面结构 |
| browser_snapshot | — | 本身就是快照 |

### 4. 多策略降级定位

`browser_click` 和 `browser_type` 采用多策略逐级降级：

**browser_click 定位策略：**
1. role + text → `page.getByRole(role, { name: text })`
2. 精确文本 → `page.getByText(text, { exact: true })`
3. 子串匹配 → `page.getByText(text)`
4. CSS 选择器 → `page.locator(text)`

**browser_type 定位策略：**
1. placeholder → `page.getByPlaceholder(placeholder)`
2. role + name → `page.getByRole(role, { name })`
3. label → `page.getByLabel(name)`
4. 通用 textbox（唯一输入框时）

### 5. 会话状态持久化

浏览器最后访问的 URL 在每个 turn 结束后自动保存到 `meta.json` 的 `lastBrowserUrl` 字段。resume 会话时自动导航到该 URL，模型无需重新 navigate。

---

## 工具定义

### browser_navigate

导航到指定 URL。

| 字段 | 值 |
|------|----|
| name | `browser_navigate` |
| requiresConfirm | `false` |
| 自动快照 | ✅ |

参数：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `url` | string | ✅ | 目标 URL，需包含协议（`https://...`） |

返回：`URL: <url>\nTitle: <title>\n\n<aria_snapshot>`

### browser_snapshot

获取当前页面的 ARIA 结构化文本快照。

| 字段 | 值 |
|------|----|
| name | `browser_snapshot` |
| requiresConfirm | `false` |
| 自动快照 | — |

参数：无

返回：当前页面的 ARIA 树文本表示。

### browser_click

点击页面元素。

| 字段 | 值 |
|------|----|
| name | `browser_click` |
| requiresConfirm | `false` |
| 自动快照 | ✅ |

参数：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `text` | string | ✅ | 元素文本（从 browser_snapshot 中获取） |
| `role` | string | 否 | ARIA role 去歧义，如 "link", "button" |

### browser_type

在输入框中输入文本。

| 字段 | 值 |
|------|----|
| name | `browser_type` |
| requiresConfirm | `false` |
| 自动快照 | ❌ |

参数：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `text` | string | ✅ | 要输入的文本 |
| `placeholder` | string | 二选一 | 输入框 placeholder 文字 |
| `name` | string | 二选一 | 输入框 accessible name |
| `role` | string | 否 | ARIA role 去歧义 |

返回：`Typed "<text>" into <target>`

### browser_press_key

在页面上按一个键盘键或快捷键组合。

| 字段 | 值 |
|------|----|
| name | `browser_press_key` |
| requiresConfirm | `false` |
| 自动快照 | ✅ |

参数：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `key` | string | ✅ | 键名，如 "Enter", "Escape", "Tab", "ArrowDown", "Control+a" |

支持的单键：Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp/Down, Space, F1-F12。

组合键格式：`Control+a`、`Control+Shift+End`。

### browser_scroll

滚动当前页面。

| 字段 | 值 |
|------|----|
| name | `browser_scroll` |
| requiresConfirm | `false` |
| 自动快照 | ✅ |

参数：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `direction` | string | 否 | `"down"`（默认）或 `"up"` |
| `amount` | string | 否 | `"page"`（默认，一整屏）或数字像素值如 `"500"` |

### browser_navigate_back

浏览器后退到历史记录的上一页。

| 字段 | 值 |
|------|----|
| name | `browser_navigate_back` |
| requiresConfirm | `false` |
| 自动快照 | ✅ |

参数：无

---

## CLI 参数

浏览器行为通过 CLI 参数控制，优先级高于环境变量：

| 参数 | 说明 |
|------|------|
| `--browser` | 显示浏览器窗口（默认 headless） |
| `--cdp <url>` | 连接宿主机浏览器，如 `--cdp http://127.0.0.1:9222` |

示例：

```bash
deepseek-arch chat --browser
deepseek-arch chat --cdp http://127.0.0.1:9222
deepseek-arch resume <id> --cdp http://172.30.80.1:9222
```

对应环境变量（不传参数时回退）：

| 变量 | 说明 |
|------|------|
| `BROWSER_HEADED=1` | 显示浏览器窗口（等价于 `--browser`） |
| `BROWSER_CDP=http://...` | CDP 连接地址（等价于 `--cdp`） |
| `https_proxy` | 代理地址，本地启动 Chromium 时生效 |

### CDP 连接（宿主机 Edge）

Windows 宿主机上启动 Edge 的远程调试端口后，WSL2 中的 agent 可通过 CDP 连接复用宿主机浏览器。

**Windows 端：**
```powershell
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```

**WSL2 端：**
```bash
BROWSER_CDP=http://172.30.80.1:9222 deepseek-arch chat
```

连接后创建独立上下文，不干扰用户现有标签。

---

## 浏览器生命周期

```
进程启动                         进程退出
  │                               │
  ├── 首次工具调用                  ├── process.on('exit')
  │   └── launch()                 │   └── close()
  │       ├── BROWSER_CDP?         │       ├── page.close()
  │       │   → connectOverCDP()   │       ├── context.close()
  │       └── BROWSER_HEADED?      │       ├── browser.close()
  │           → headed/headless    │       └── stopViewServer()
  │       ├── newContext()         │
  │       └── newPage()            │
  │       └── _registerCleanup()   │
  │                                │
  ├── 页面崩/用户关闭窗口            │
  │   └── isConnected() → false    │
  │       → 自动清理并重启动        │
  │                                │
  ├── 每轮 turn 保存                │
  │   └── lastBrowserUrl → meta    │
  │                                │
  └── resumeSession()              │
      └── restoreUrl(lastUrl)      │
```

### 崩溃恢复

用户关闭 Chromium 窗口或浏览器崩溃时，下一次工具调用会自动检测并重新启动浏览器：

1. `getPage()` 检测 `page.isClosed()` 或 `!browser.isConnected()`
2. `launch()` 清理已断开的引用
3. 启动新 Chromium（空白页 `about:blank`）
4. 工具执行失败（元素不存在）
5. 模型收到错误，`browser_snapshot()` 看到空白页
6. 模型重新 `browser_navigate()` 继续

### 手动干预

用户可在浏览器窗口手动操作（点击链接、填表单等）。模型的下一次工具调用可能因页面状态变化而失败，但通过错误恢复机制可自动调整。

---

## 架构

```
SessionManager (agent loop)
    │
    ├── Tool Calling
    │   ├── browser_navigate(url)
    │   ├── browser_snapshot()
    │   ├── browser_click(text)
    │   ├── browser_type(text, placeholder)
    │   ├── browser_press_key(key)
    │   ├── browser_scroll(direction)
    │   └── browser_navigate_back()
    │
    └── 工具对应 Playwright API
        ├── page.goto()
        ├── page.ariaSnapshot()
        ├── page.getByText().click()
        ├── page.getByPlaceholder().fill()
        ├── page.keyboard.press()
        ├── page.evaluate('window.scrollBy()')
        └── page.goBack()
```

每个工具是一个独立的 `.ts` 文件，通过 barrel file `src/tools/index.ts` 注册。共享的浏览器实例由 `browser-state.ts` 管理（单例模式）。

---

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/tools/browser-state.ts` | 浏览器生命周期管理（单例） |
| `src/tools/browser-navigate.ts` | 导航工具 |
| `src/tools/browser-snapshot.ts` | 快照工具 |
| `src/tools/browser-click.ts` | 点击工具 |
| `src/tools/browser-type.ts` | 输入工具 |
| `src/tools/browser-press-key.ts` | 按键工具 |
| `src/tools/browser-scroll.ts` | 滚动工具 |
| `src/tools/browser-navigate-back.ts` | 后退工具 |
| `src/tools/index.ts` | barrel file 注册 |
