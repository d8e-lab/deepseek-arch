# Playwright 版本与浏览器二进制不匹配 — Agent 调用浏览器工具全部失败

> ⚠️ **进行中（2026-08-20）— 未 close**
> - **已修复（立即措施）**：为当前 Playwright 版本运行 `npx playwright install chromium` 下载匹配的浏览器二进制，全局安装的 deepseek-arch 浏览器工具已恢复
> - **已修复（报错改进）**：`src/tools/browser-state.ts` 按错误类型分类提示——二进制缺失时直接指引 `npx playwright install chromium`，不再误导为"系统 Chromium 未安装"
> - **待决策（开放项）**：`package.json` 中 `playwright: ^1.61.1` 是否收紧为 `~1.61.1`（防止未来升级后再次发生）——**用户 2026-08-20 明确暂不决策**，需进一步权衡版本灵活性与稳定性

**类型**: 依赖版本漂移（Dependency Version Drift）
**发现日期**: 2026-08-19
**当前基线**: `feat/render-sdk` @ `b16ee40`
**涉及文件**: `src/tools/browser-state.ts`（报错改进）、`package.json`（依赖声明，待定）、`~/.cache/ms-playwright/`（浏览器二进制缓存）

---

## 现象

Agent 在会话中调用 `browser_navigate` 时返回：

```
Error: Navigation failed: Browser launch failed: Chromium is not available.
  Install system Chromium:    sudo pacman -S chromium
  Or download Playwright's:   npx playwright install chromium
  Or connect to a running browser via CDP
```

**所有**浏览器工具（navigate/snapshot/click/type/scroll/press_key/navigate_back）同步失效。Agent 只能回退到 `curl` 等替代手段。

## 根因

1. 全局安装的 `deepseek-arch@1.3.8` 声明依赖 `"playwright": "^1.61.1"`（宽松范围）
2. 2026-08-07 `npm install -g` 时，`^1.61.1` 被 npm 解析到当时最新版 **playwright 1.62.1**
3. Playwright 的浏览器二进制**按版本一一对应**（每个 Playwright 版本要求特定 revision 的 Chromium）：

   | Playwright | Chromium revision | 本机缓存 |
   |:---|---|:---:|
   | 1.61.0 / 1.61.1 | chromium-1228 | ✅ 存在（2026-07-03） |
   | 1.62.1 | **chromium-1234** | ❌ **缺失** |

4. 运行 `deepseek-arch`（全局命令）→ Agent 调浏览器 → playwright 1.62.1 找不到 chromium-1234 →
   `Executable doesn't exist at .../chromium-1234/chrome-linux64/chrome`
5. `browser-state.ts` 的 `isMissingBrowser` 判定把该错误与"未装 Chromium"混为一谈，给出误导性提示（"Install system Chromium: sudo pacman -S chromium"），导致排查方向错误

> 注：源码项目 `node_modules/` 中 playwright 锁定为 1.61.1（package-lock.json），缓存 chromium-1228 匹配，因此**源码运行正常**；只有全局安装的 1.3.8（无 lock，解析到 1.62.1）失败。这也是"直接测试能跑、Agent 里却失败"的迷惑点来源。

## 复现步骤

```bash
# 1. 全局安装 deepseek-arch（npm install -g 时会拉取最新 playwright ^1.61.1 → 1.62.x）
npm install -g ./deepseek-arch-1.3.8.tgz

# 2. 不运行 npx playwright install chromium，直接启动浏览器工具
deepseek-arch chat
# → Agent 调用 browser_navigate 报 "Browser launch failed: Chromium is not available."

# 3. 命令行复现（省略报错包装，看原始错误）
node -e "const {chromium}=require('playwright'); chromium.launch({channel:'chromium'}).catch(e=>console.error(e.message.split('\n')[0]))"
# → browserType.launch: Executable doesn't exist at /home/helck/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
```

## 影响范围

- 全局安装（`npm install -g` / AUR 预编译包）的 deepseek-arch
- 任何 `playwright` 依赖声明为 `^` 且升级后未重跑 `npx playwright install` 的环境
- 源码运行（有 package-lock.json 锁定）不受影响

## 修复

### 立即修复（已执行）

```bash
# 在全局 deepseek-arch 目录下，用其自身的 playwright 版本下载匹配浏览器
cd ~/.nvm/versions/node/v24.15.0/lib/node_modules/deepseek-arch
npx playwright install chromium
```

验证通过：全局 playwright 1.62.1 + chromium-1234 可正常启动，Agent 浏览器工具恢复。

### 报错改进（已执行）

`src/tools/browser-state.ts` 的 launch catch 块按错误类型细分提示：

| 错误特征 | 新提示方向 |
|:---|:---|
| `Executable doesn't exist` | Playwright 浏览器二进制缺失 → **`npx playwright install chromium`**（附缺失路径） |
| `cannot open shared object file` | 系统依赖缺失 → `sudo pacman -S chromium` / `npx playwright install-deps chromium` |
| `Failed to launch browser` | 环境问题（headed 无 DISPLAY、沙箱）→ 尝试 headless / install-deps |
| 其他 | 原样输出首行错误 |

## 开放项（版本宽松问题 — 用户待决策，未 close）

> 用户 2026-08-20 明确：版本是否收紧**暂不决策**，需要再权衡"版本灵活更新 vs 浏览器二进制匹配稳定性"。以下为备选方案分析，供决策参考。

1. **方案 A（推荐）：`package.json` `"playwright": "^1.61.1"` → `"~1.61.1"`**
   - 允许 1.61.x patch 更新（bugfix/安全修复照常获取）
   - 锁定 minor：不会自动跳到 1.62+（本次事故根源）
   - 依据：Playwright 同 minor 内 patch 版本浏览器 revision 不变（实测 1.61.0/1.61.1 均为 chromium-1228），只有跨 minor（1.61 → 1.62）才换浏览器（1234）
   - 影响：功能无感（本项目只用 launch/connectOverCDP/ariaSnapshot 等稳定 API）；手动升 minor 时才需重跑 `npx playwright install chromium`
2. **方案 B（保持现状 `^1.61.1`）**：完全灵活，但每次升级 minor 后必须记得 `npx playwright install chromium`，否则浏览器工具失效（报错已改进，可直接自愈）
3. **方案 C（精确 `1.61.1`）**：最保守，连 patch 更新都拿不到，不推荐

**无论选哪个方案**：
- 升级纪律：任何 Playwright minor 升级后必须运行 `npx playwright install chromium`
- 报错提示（已落实）：即使未来再发生，报错会直接给出修复命令，无需人工排查
