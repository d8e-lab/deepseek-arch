# 浏览器反爬虫机制调研 + 多标签页处理方案

> 调研日期：2026-07-11 · 作者：subagent research · 基于 deepseek-arch v1.3.7

---

## 目录

1. [反爬虫机制与对抗方案](#1-反爬虫机制与对抗方案)
   - [1.1 自动化浏览器被检测的原因](#11-自动化浏览器被检测的原因)
   - [1.2 各项对抗手段分析](#12-各项对抗手段分析)
   - [1.3 推荐方案（按优先级排序）](#13-推荐方案按优先级排序)
   - [1.4 代码实现示例](#14-代码实现示例)
2. [多标签页场景分析](#2-多标签页场景分析)
   - [2.1 当前架构的问题](#21-当前架构的问题)
   - [2.2 CDP 模式的多标签页分析](#22-cdp-模式的多标签页分析)
   - [2.3 多标签页管理方案](#23-多标签页管理方案)
   - [2.4 推荐实现路径](#24-推荐实现路径)
   - [2.5 代码实现示例](#25-代码实现示例)
3. [总结与实施路线图](#3-总结与实施路线图)

---

## 1. 反爬虫机制与对抗方案

### 1.1 自动化浏览器被检测的原因

Playwright 控制的 Chromium 会被网站通过以下特征识别为自动化工具：

#### 1.1.1 `navigator.webdriver` 标志（最显著）

Playwright 在启动的浏览器中会设置 `navigator.webdriver = true`。网站通过简单的 JS 检查即可发现：

```javascript
// 网站端的检测
if (navigator.webdriver) {
  // 拒绝访问 / 返回空白页
}
```

默认 Playwright 会设置此标志，且无法通过 launch args 关闭。

#### 1.1.2 User-Agent 包含 "HeadlessChrome"

Headless 模式下 User-Agent 示例：
```
Mozilla/5.0 ... Chrome/... HeadlessChrome/...
```

网站可以检查 `HeadlessChrome` 标记。

#### 1.1.3 `window.chrome` 对象差异

- 真实 Chrome 有完整的 `window.chrome` 对象（含 `app`, `runtime`, `loadTimes` 等）
- Headless Chromium 可能缺少部分属性
- Playwright 启动的 browser context 默认设置 `window.chrome` 为 `undefined`

#### 1.1.4 WebDriver 属性泄漏

Playwright (via CDP) 会设置多个 WebDriver 相关属性：

| 检测点 | 说明 |
|--------|------|
| `navigator.webdriver` | 最直接，Playwright 默认置 true |
| `navigator.plugins` 长度 | Headless 可能返回 0 |
| `navigator.languages` | 缺少或异常 |
| `navigator.hardwareConcurrency` | 可能异常（如返回 2） |

#### 1.1.5 浏览器指纹（canvas / WebGL / fonts）

Headless 模式使用的渲染后端与真实浏览器不同：

- **Canvas fingerprint**：Headless 使用 SwiftShader 软件渲染，canvas.toDataURL() 输出与 GPU 渲染不同
- **WebGL**：`renderer` 字段返回 `"SwiftShader"` 而非真实 GPU 型号
- **Fonts**：Headless 环境预装字体较少，`document.fonts` 返回列表短
- **Screen resolution**：Headless 默认 800×600，而真实浏览器通常更大

#### 1.1.6 行为模式检测

- 鼠标无真实移动路径（Playwright click 是瞬间跳跃到目标位置）
- 滚动模式不自然（直接 JS evaluate 跳转 vs 真实用户手势滚动）
- 导航后无延迟立即执行操作（人类需要几百毫秒反应时间）

#### 1.1.7 Chrome DevTools Protocol 连接检测

某些高级反爬（如 Cloudflare 5秒盾的高级模式）可以检测到 CDP 连接的存在。

### 1.2 各项对抗手段分析

#### 1.2.1 Chromium launch args 参数（低开销 · 部分有效）

**当前已使用的 args：**
- `--no-sandbox`
- `--disable-setuid-sandbox`
- `--disable-dev-shm-usage`

**建议新增的 args：**

| 参数 | 作用 | 备注 |
|------|------|------|
| `--disable-blink-features=AutomationControlled` | **关键！** 移除 `navigator.webdriver` 的 AutomationControlled 特性 | Playwright 1.61 支持 |
| `--disable-automation` | 禁用自动化提示栏 | Chromium 专属 |
| `--disable-infobars` | 隐藏 "Chrome is being controlled" 提示 | 已不推荐，用上面的替代 |
| `--window-size=1920,1080` | 设置窗口大小，避免默认 800×600 | 与 viewport 配合 |
| `--start-maximized` | 最大化窗口 | 仅 headed 模式有效 |
| `--lang=zh-CN` (或 en-US) | 设置浏览器语言 | 影响 Accept-Language |

**注意：** `--disable-blink-features=AutomationControlled` 是 Playwright 1.61 (Chromium 130+) 中唯一官方提供的"去自动化标志"手段。但仅靠此参数不足以完全隐藏。

#### 1.2.2 `page.addInitScript()` 覆写检测点（推荐 · 低成本高效）

在每个页面加载前注入脚本，覆写关键检测属性：

```javascript
// 注入脚本（在每个页面加载前执行）
() => {
  // 1. 覆写 navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
  });

  // 2. 完善 window.chrome 对象（headless 模式下可能缺失）
  if (!window.chrome) {
    window.chrome = {
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
      runtime: { connect: () => {}, sendMessage: () => {} },
      loadTimes: () => {},
      csi: () => {},
    };
  }

  // 3. 覆写 navigator.plugins（非必要，但有助于某些检测）
  // 已存在则保留，不存在则补充空数组

  // 4. 覆写 permissions.query 避免暴露 Automation
  const originalQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(desc) {
    if (desc.name === 'notifications') {
      return Promise.resolve({ state: 'granted' });
    }
    return originalQuery.call(this, desc);
  };
}
```

**有效性评估：** 对大多数反爬（包括 Cloudflare 基础检测、一般 JS 检测）**效果显著**。但对 Cloudflare 5秒盾高级模式、reCAPTCHA v3 等需要真实用户行为模式的场景，仍可能失败。

#### 1.2.3 playwright-stealth npm 包（不推荐）

| 指标 | 评估 |
|------|------|
| 当前状态 | 自 2024 年初基本停更，最后一次更新针对 playwright 1.41 |
| 与本项目兼容性 | 本项目使用 `playwright@^1.61.1`，存在 API 不兼容风险 |
| 依赖尺寸 | 引入多个额外的 patch 脚本，增加 node_modules 体积 |
| 功能 | 提供 20+ 补丁，涵盖 webdriver、chrome 对象、permissions、plugins 等 |
| 风险 | 部分补丁可能干扰正常 Playwright 行为，导致调试困难 |

**结论：不推荐引入。** 自实现 `addInitScript` 覆盖核心检测点已覆盖 80% 的反爬场景，而 playwright-stealth 的额外 20% 收益与维护成本不成正比。

#### 1.2.4 CDP 模式连接真实浏览器（最推荐 · 效果最佳）

**原理：** 通过 `--cdp http://host:9222` 连接到宿主机上已有的真实 Edge/Chrome，Playwright 仅通过 CDP 协议控制标签页，不启动新的 Chromium 进程。

**优势：**
- ✅ 使用用户真实的浏览器进程，拥有完整的用户配置文件、Cookie、登录态
- ✅ `navigator.webdriver = false`（真实浏览器不会设置此标志）
- ✅ User-Agent 为真实浏览器 UA，不含 "HeadlessChrome"
- ✅ 完整的 `window.chrome` 对象
- ✅ 真实的 Canvas/WebGL 指纹（使用用户 GPU 渲染）
- ✅ 真实的字体列表、插件列表
- 可以绕过 Cloudflare 基础盾和大部分 JS 检测

**劣势：**
- ❌ 依赖用户在宿主机预先启动 Edge/Chrome（`--remote-debugging-port=9222`）
- ❌ WSL2 环境下需要配置端口转发（宿主机 localhost 不会自动映射到 WSL2）
- ❌ 部分高级 Cloudflare 盾（如 JS challenge + 行为分析）仍可能失败
- ❌ 连接断开时无法自动重连（用户关闭了宿主机浏览器）

**适用场景：** 本项目的主要目标场景——用户在 WSL2 中运行 deepseek-arch，宿主机 Windows 有 Edge。这是**最具可操作性的有效方案**。

#### 1.2.5 Headed 模式的效果

| 方面 | 效果 |
|------|------|
| User-Agent | ✅ 改善，不会再出现 "HeadlessChrome" |
| Canvas/WebGL | ❌ 可能仍使用 SwiftShader（取决于 launch 配置） |
| `navigator.webdriver` | ❌ 仍然为 true |
| 行为检测 | ❌ 鼠标点击仍为瞬间跳跃 |
| Cloudflare 5秒盾 | ⚠️ 部分改善，但不能完全绕过 |

**结论：** Headed 模式是**辅助手段**，不能单独解决问题。必须与 `addInitScript` 和其他参数配合使用。

#### 1.2.6 设置合理的浏览器上下文参数

以下参数应在 `browser.newContext()` 时设置，**当前代码已部分实现**：

| 参数 | 建议值 | 当前状态 | 重要性 |
|------|--------|---------|--------|
| `viewport` | `{ width: 1920, height: 1080 }` | ✅ 已设 1280×720 | 高 |
| `userAgent` | 最新的 Chrome 稳定版 UA | ❌ 未设置（使用默认） | 高 |
| `locale` | `'zh-CN'` 或 `'en-US'` | ❌ 未设置 | 中 |
| `timezoneId` | `'Asia/Shanghai'` 或用户时区 | ❌ 未设置 | 中 |
| `geolocation` | 合适的坐标 | ❌ 未设置 | 低 |
| `permissions` | `['geolocation']` 等 | ❌ 未设置 | 低 |
| `colorScheme` | `'light'` | ❌ 未设置 | 低 |
| `deviceScaleFactor` | `1` 或 `2` | ❌ 未设置 | 低 |

**特别注意 User-Agent：** Playwright 1.61 headless chromium 的默认 UA 包含 `HeadlessChrome`。应手动设置为最新 Chrome 稳定版 UA：

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36
```

### 1.3 推荐方案（按优先级排序）

结合本项目特点（终端工具、用户主要在 WSL2、依赖轻量级），推荐按以下优先级实施：

#### 🥇 第一优先：CDP 模式强化（最有效 · 最少代码变更）

**理由：** CDP 模式连接到宿主机真实 Edge/Chrome 可以规避绝大多数自动化检测手段，因为使用的是用户真实的浏览器进程。

**实施建议：**
1. 在 `--cdp` 参数的帮助文本和错误提示中，提供更清晰的 Windows 端 Edge 启动指引
2. 自动检测 WSL2 中的 `host.docker.internal` (或 `host.containers.internal`) 来简化 CDP 连接
3. 增加 `cdpUrl` 的自动探测（尝试多个常见 IP 和端口）

#### 🥈 第二优先：addInitScript + launch args（通用场景保底）

**理由：** 对于不使用 CDP 模式的用户（如在 Linux 原生环境中），这是成本最低、收益最高的方案。几个参数 + 一段注入脚本，即可绕过大多数基础反爬。

**实施建议：**
1. 增加 `--disable-blink-features=AutomationControlled` 和 `--disable-automation` 参数
2. 在 `launch()` 方法中增加 `page.addInitScript()` 覆写 `navigator.webdriver`、`window.chrome` 等
3. 设置合理的 viewport、userAgent、locale 等 context 参数

#### 🥉 第三优先：User-Agent 和上下文参数优化

**理由：** 无需额外依赖，只需在 `browser.newContext()` 时传入参数即可。与其他方案配合效果更好。

#### ❌ 不推荐：playwright-stealth / puppeteer-extra 等第三方隐藏库

**理由：** 维护状态差、与当前 Playwright 版本兼容风险大、增加依赖体积。自实现覆盖核心检测点更可控。

### 1.4 代码实现示例

以下代码展示如何在当前 `browser-state.ts` 中集成推荐的对抗方案：

#### 修改 `launch()` 方法中的 args

```typescript
// ── 模式 B: 本地启动 Chromium ───────────────────
const channel = process.platform === 'win32' ? 'msedge' : 'chromium';
const headed = browserConfig?.headed ?? process.env.BROWSER_HEADED === '1';
const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || '';

const launchOptions: Record<string, unknown> = {
  headless: !headed,
  channel,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    // 新增：移除自动化控制标志
    '--disable-blink-features=AutomationControlled',
    '--disable-automation',
  ],
};
```

#### 修改 `newContext()` 参数

```typescript
const contextOptions: Record<string, unknown> = {
  acceptDownloads: true,
  viewport: { width: 1920, height: 1080 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  colorScheme: 'light',
  // deviceScaleFactor: 1,  // 可选
};
```

#### 新增 `addInitScript` 注入

```typescript
// 在创建 page 后立即注入
this.page = await this.context.newPage();

// 注入反检测脚本（仅在本地启动 Chromium 时需要）
if (!cdpUrl) {
  await this.page.addInitScript(() => {
    // 1. 覆写 navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });

    // 2. 补充 window.chrome 对象
    if (typeof window.chrome === 'undefined') {
      (window as any).chrome = {
        app: {
          isInstalled: false,
          InstallState: {},
          RunningState: {},
        },
        runtime: {
          connect: () => {},
          sendMessage: () => {},
        },
        loadTimes: () => {},
        csi: () => {},
      };
    }

    // 3. 覆写 permissions 查询
    if (typeof Permissions !== 'undefined') {
      const originalQuery = Permissions.prototype.query;
      Permissions.prototype.query = function(desc: any) {
        if (desc.name === 'notifications') {
          return Promise.resolve({ state: 'granted', onchange: null });
        }
        return originalQuery.call(this, desc);
      };
    }

    // 4. 覆写 plugins 长度（可选）
    if (navigator.plugins.length === 0) {
      // 某些网站检查 plugins 长度
      // 实际应用中不建议修改，因为可能会暴露更多特征
    }
  });
}
```

> **注意：** `addInitScript` 在 CDP 模式下**也应该使用**，因为部分网站可能会通过 CDP 连接的标签页检测自动化特征。

---

## 2. 多标签页场景分析

### 2.1 当前架构的问题

当前 `BrowserState` 设计的核心约束：

```
BrowserState
  ├── this.browser:  Browser | null    (单浏览器实例)
  ├── this.context:  BrowserContext | null  (单上下文)
  └── this.page:     Page | null       (单标签页)
```

所有浏览器工具（navigate/click/scroll/snapshot/type/pressKey/navigateBack）都通过 `state.getPage()` 获取 `this.page` 进行操作。这意味着：

**问题 1：多标签页完全不受支持**

- 如果用户通过 `page.evaluate(() => window.open(...))` 打开了新标签页，`this.page` 仍然指向旧标签页
- 如果用户在 CDP 模式下操作宿主机浏览器手动打开新标签页，`this.page` 不会感知
- 模型无法同时查看两个标签页的内容

**问题 2：当前上下文隔离策略对 CDP 模式的影响**

```
CDP 连接流程：
  chromium.connectOverCDP(cdpUrl)
    → 返回 Browser 对象（代表宿主机浏览器）
      → browser.newContext()    ← 创建独立上下文（新 cookie jar）
        → context.newPage()     ← 在独立上下文中创建新标签页
```

这种方式创建的标签页：
- **在宿主机浏览器中不可见**（因为使用了独立的 BrowserContext）
- 模型不会干扰用户在宿主机上已打开的标签页
- 但也**无法访问用户已有的登录态**（Cookie 隔离）

> **关键发现：** 当前 CDP 模式使用 `browser.newContext()` 创建的是**隔离的隐身上下文**。如果需要访问用户已有的登录态，应使用 `browser.newPage()`（不创建新 context）或者直接使用已有 context 中的页面。

**问题 3：没有页面切换能力**

即使模型发现链接后会打开新标签页（通过 Ctrl+click 或 `window.open`），也没有工具可以：

- 列出所有已打开的标签页
- 切换到特定标签页
- 关闭特定标签页

### 2.2 CDP 模式的多标签页分析

CDP 模式连接到宿主机浏览器后，`browser.contexts()` 会返回宿主机浏览器中已有的所有 BrowserContext，包括：

```typescript
// 连接到宿主机浏览器
const browser = await chromium.connectOverCDP(cdpUrl);

// 获取所有已有的 context（包括用户默认会话）
const contexts = browser.contexts();

// 获取某个 context 中的所有标签页
const pages = contexts[0]?.pages() ?? [];

// 在已有 context 中打开新标签页（复用登录态）
const newPage = await contexts[0].newPage();
```

**重要区分：**

| 方式 | 代码 | 效果 |
|------|------|------|
| **隔离上下文** | `browser.newContext()` + `context.newPage()` | 创建隐身窗口标签页，cookie 隔离，宿主不可见 |
| **共享上下文** | `contexts[0].newPage()` | 在用户默认上下文中创建标签页，复用登录态，宿主可见 |
| **直接新建** | `browser.newPage()` | 使用默认上下文（可能不存在），行为取决于 CDP 连接方式 |

**当前代码使用** `browser.newContext()` + `context.newPage()`（隔离上下文方式）。这对于不想干扰用户标签页的场景是安全的，但**限制了复用登录态的能力**。

### 2.3 多标签页管理方案

#### 方案 A：单标签页 + 显式创建与销毁（推荐短期实施）

**思路：** 保持当前的单 page 架构不变，但提供显式的标签页管理工具。

**新增工具：**
- `browser_new_tab(url?)` — 创建新标签页并切换到它，关闭旧标签页（或者保留在后台）
- `browser_close_tab` — 关闭当前标签页，切换到上一个

**优点：**
- 代码改动最小，不需要重构 BrowserState 的数据结构
- 模型可以明确控制"什么时候开新标签页"
- 与当前所有工具的 `state.getPage()` 模式兼容

**缺点：**
- 无法同时"查看"两个标签页（模型仍需交替切换）
- 无法枚举当前所有标签页

**对工具的调整：**
- `getPage()` 返回当前活跃的 page，仍然只有一个
- 新增 `activePage` 指针，`new_tab` 和 `close_tab` 切换此指针
- 切换标签页时自动快照新页面

#### 方案 B：Page 列表 + 切换工具（推荐中期实施）

**思路：** 将 `BrowserState` 改造为管理 **Page 列表**，新增标签页操作工具。

```
BrowserState
  ├── this.browser:  Browser | null
  ├── this.context:  BrowserContext | null
  ├── this.pages:    Page[]           ← 多个标签页
  └── this.activePageIndex: number    ← 当前活跃标签索引
```

**新增工具：**
- `browser_list_tabs` — 列出所有标签页（标题 + URL + 索引）
- `browser_switch_tab(index)` — 切换到指定标签页
- `browser_new_tab(url?)` — 创建新标签页
- `browser_close_tab(index?)` — 关闭标签页

**优点：**
- 模型可以灵活管理多个标签页
- 可以从页面 A 获取信息，切换到页面 B 操作，再切换回 A
- 不浪费已打开的页面（避免重复 navigation）

**缺点：**
- 需要重构 `BrowserState`，改动较大
- 需要确保所有工具通过 `getPage()` 返回当前活跃页面
- 标签页数量管理（防止打开过多标签页占用内存）

#### 方案 C：不管理多标签页，保持简化（保守方案）

**思路：** 保持当前设计，不提供任何多标签页支持。模型如果需要打开新页面，直接在当前标签页 navigate。

**优点：**
- 零改动
- 模型逻辑简单：一个页面 = 一个会话的专注点

**缺点：**
- 无法同时查看对比两个页面内容
- 用户手动打开标签页后，模型无法感知
- 如果模型用 `window.open` 打开了新标签页，当前标签页失去焦点，工具操作可能不生效

### 2.4 推荐实现路径

结合本项目的 Agent Loop 使用模式（模型自主调用工具），推荐分阶段实施：

#### 阶段一：修复 CDP 上下文策略

**问题：** 当前 CDP 模式使用 `browser.newContext()` 创建隔离上下文，无法复用宿主机浏览器的登录态。

**建议：** 增加一个选项 `--cdp-share-session`（或默认改为共享上下文），使模型可以访问用户已有的登录态。

```typescript
// CDP 模式下使用共享上下文（复用登录态）
if (shareSession) {
  const contexts = this.browser.contexts();
  if (contexts.length > 0) {
    // 使用已有上下文，可访问用户登录态
    this.context = contexts[0];
    this.page = await this.context.newPage();
  } else {
    // 没有已有上下文，创建新的
    this.page = await this.browser.newPage();
  }
} else {
  // 隔离上下文（当前行为）
  this.context = await this.browser.newContext({...});
  this.page = await this.context.newPage();
}
```

#### 阶段二：实现方案 A（单标签页 + 显式创建/关闭）

**目标：** 用最小改动，让模型可以控制标签页生命周期。

#### 阶段三：评估是否需要方案 B（Page 列表切换）

**判断标准：** 如果实际使用中模型频繁需要同时关注多个页面（如"对比产品A和产品B的价格"），则实施方案 B。

### 2.5 代码实现示例

#### 方案 A 的 BrowserState 改造

```typescript
class BrowserState {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Page[] = [];           // 多个标签页
  private activeIndex: number = 0;       // 当前活跃标签索引
  private downloadDir: string = '';
  private closed = false;
  private cleanupRegistered = false;
  private _lastUrl: string = '';
  private _isCdpMode: boolean = false;

  /** 获取当前活跃的 Page */
  async getPage(): Promise<Page> {
    if (this.closed) throw new Error('Browser has been closed');

    // 如果当前标签页有效，直接返回
    if (this.pages.length > 0 && this.pages[this.activeIndex]?.isClosed() === false) {
      return this.pages[this.activeIndex];
    }

    // 尝试找第一个有效的标签页
    for (let i = 0; i < this.pages.length; i++) {
      if (!this.pages[i].isClosed()) {
        this.activeIndex = i;
        return this.pages[i];
      }
    }

    // 所有标签页都关闭了 → 重新启动
    await this.launch();
    return this.pages[0];
  }

  /** 创建新标签页 */
  async newTab(url?: string): Promise<number> {
    const page = await this.context!.newPage();
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    this.pages.push(page);
    this.activeIndex = this.pages.length - 1;
    return this.activeIndex;
  }

  /** 切换到指定索引的标签页 */
  async switchTab(index: number): Promise<boolean> {
    if (index < 0 || index >= this.pages.length) return false;
    if (this.pages[index].isClosed()) return false;
    this.activeIndex = index;
    return true;
  }

  /** 关闭标签页 */
  async closeTab(index?: number): Promise<void> {
    const idx = index ?? this.activeIndex;
    if (idx < 0 || idx >= this.pages.length) return;
    try { await this.pages[idx].close(); } catch { /* ignore */ }
    this.pages.splice(idx, 1);
    // 调整 activeIndex
    if (this.pages.length === 0) {
      this.activeIndex = -1;
    } else if (this.activeIndex >= this.pages.length) {
      this.activeIndex = this.pages.length - 1;
    }
  }

  /** 列出所有标签页 */
  listTabs(): Array<{ index: number; title: string; url: string; active: boolean }> {
    return this.pages.map((page, idx) => ({
      index: idx,
      title: page.title().catch(() => ''),
      url: page.url(),
      active: idx === this.activeIndex,
    }));
  }

  // 修改 launch 中的创建页面部分
  private async launch(): Promise<void> {
    // ... 原有启动逻辑 ...
    
    // 创建第一个标签页
    this.pages = [];
    this.activeIndex = 0;
    const page = await this.context!.newPage();
    this.pages.push(page);

    // 注入反检测脚本
    if (!this._isCdpMode) {
      await page.addInitScript(antiDetectionScript);
    }

    // 下载处理
    page.on('download', async (download) => { /* ... */ });
  }
}
```

#### 新增工具：browser_new_tab

```typescript
// src/tools/browser-new-tab.ts
export const browserNewTabTool: Tool = {
  name: 'browser_new_tab',
  description: '创建新标签页。可选指定 URL，不指定则打开空白页。创建后自动切换到新标签页并返回快照。',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '新标签页导航到的 URL（可选，不填则开空白页）',
      },
    },
  },
  requiresConfirm: false,

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params.url ? String(params.url).trim() : undefined;
    try {
      const state = getBrowserState();
      const index = await state.newTab(url);
      const snapshot = await state.buildSnapshot();
      return { content: `Opened new tab #${index}\n\n${snapshot}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: '', error: `New tab failed: ${msg}` };
    }
  },
};
```

#### 新增工具：browser_close_tab

```typescript
// src/tools/browser-close-tab.ts
export const browserCloseTabTool: Tool = {
  name: 'browser_close_tab',
  description: '关闭当前标签页。如果有其他标签页，自动切换到上一个标签页并返回快照。',
  parameters: {
    type: 'object',
    properties: {},
  },
  requiresConfirm: false,

  async execute(_params: Record<string, unknown>): Promise<ToolResult> {
    try {
      const state = getBrowserState();
      await state.closeTab();
      const snapshot = await state.buildSnapshot();
      return { content: `Tab closed. Remaining tabs: ${state.listTabs().length}\n\n${snapshot}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: '', error: `Close tab failed: ${msg}` };
    }
  },
};
```

---

## 3. 总结与实施路线图

### 反爬虫对抗方面

| 优先级 | 措施 | 复杂度 | 效果 | 代码位置 |
|--------|------|--------|------|---------|
| **P0** | 完善 CDP 模式文档和体验 | 低 | 🌟🌟🌟🌟🌟 | CLI help + 文档 |
| **P1** | 增加 launch args | 低 | 🌟🌟 | `browser-state.ts` launch() |
| **P1** | 添加 addInitScript | 低 | 🌟🌟🌟🌟 | `browser-state.ts` launch() |
| **P2** | 优化 context 参数 (UA/viewport/locale/timezone) | 低 | 🌟🌟 | `browser-state.ts` newContext() |
| **P3** | 支持共享上下文的 CDP 模式 | 中 | 🌟🌟🌟🌟 | `browser-state.ts` launch() |
| ❌ | playwright-stealth | 高 | 🌟（不可靠） | 不引入 |

### 多标签页管理方面

| 阶段 | 措施 | 复杂度 | 优先级 |
|------|------|--------|--------|
| **阶段一** | 修复 CDP 上下文策略（共享/隔离选项） | 低 | 高 |
| **阶段二** | 方案 A：新增 `browser_new_tab`/`browser_close_tab` 工具 | 中 | 中 |
| **阶段三** | 方案 B：Page 列表 + `browser_list_tabs`/`browser_switch_tab` | 高 | 低 |
| **保守** | 保持现状，依赖模型单标签页导航 | 无 | — |

### 推荐的首次实施范围（预计 ~2 小时工作量）

1. **`browser-state.ts`**：
   - 增加 2 个 launch args
   - 添加 `addInitScript` 注入（仅非 CDP 模式）
   - 优化 context 参数（UA、locale、timezone、更大的 viewport）
   - 增加多标签页基础数据结构（`pages[]` + `activeIndex`）

2. **新建 `src/tools/browser-new-tab.ts`** 和 **`browser-close-tab.ts`**：
   - 各一个工具文件 + barrel 注册

3. **更新 `docs/browser-tools.md`**：
   - 记录新工具
   - 更新配置参数说明

---

### 附录：参考资源

- [Playwright — BrowserContext.newPage()](https://playwright.dev/docs/api/class-browsercontext#browser-context-new-page)
- [Playwright — Browser.newContext()](https://playwright.dev/docs/api/class-browser#browser-new-context)
- [Playwright — connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [navigator.webdriver — W3C WebDriver spec](https://www.w3.org/TR/webdriver/#interface)
- [Cloudflare bot detection technologies](https://developers.cloudflare.com/bots/)
- [undetected-chromedriver (Python) — 参考思路](https://github.com/ultrafunkamsterdam/undetected-chromedriver)
