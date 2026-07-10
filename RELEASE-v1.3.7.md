# DeepSeek Arch v1.3.7 — Windows Edge 浏览器支持

> Windows 平台开箱即用，自动检测 Microsoft Edge

## 🤖 平台自适应浏览器启动

之前 deepseek-arch 在本地启动浏览器时**硬编码使用 Chromium**，Windows 用户如果没有安装 Chromium 就会启动失败。

**v1.3.7 自动判断操作系统**：

| 平台 | 浏览器 | 
|------|--------|
| 🪟 Windows | Microsoft Edge（内置） |
| 🐧 Linux/macOS | Chromium |

现在 Windows 用户**无需额外安装 Chromium**，系统内置的 Edge 就能正常使用全套浏览器工具（导航、点击、表单填写、滚动等）。

### 仍然支持 CDP 连接宿主机 Edge

如果你在 WSL2 中使用，依然可以通过 `--cdp` 参数连接到 Windows 宿主机上已打开的 Edge：

```bash
deepseek-arch chat --cdp http://127.0.0.1:9222
```

---

## 📦 安装

```bash
# Arch Linux (AUR)
yay -S deepseek-arch

# npm 全局安装
npm install -g deepseek-arch

# 从源码
git clone https://github.com/d8e-lab/deepseek-arch.git
cd deepseek-arch
npm install && npm run build
```
