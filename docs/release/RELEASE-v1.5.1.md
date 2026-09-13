# DeepSeek Arch v1.5.1

> 修复 Linux 上安装后 `pty.node` 加载失败导致 CLI 直接崩溃的问题 —— 现在开箱即用，无需手动编译。

## 🔧 Bug 修复

### Linux 安装后崩溃（`Failed to load native module: pty.node`）

**现象**：通过 npm 全局安装后，运行 `deepseek-arch`（甚至 `deepseek-arch --help`）直接报错退出。

**原因**：底层 PTY 依赖（node-pty）官方包未提供 Linux 预编译二进制，需要在安装时现场编译；当安装环境跳过编译步骤（如 `ignore-scripts` 配置）或缺少编译工具链时，安装虽成功但运行即崩溃。

**修复**：
- 发布包现在**内置 Linux 预编译二进制**（N-API，兼容 Node 8+ 所有版本），npm 与 AUR 安装后开箱即用，不再依赖本地编译环境
- 即使极端环境下二进制仍不可用（如非 x64 架构），CLI 也不会崩溃——相关功能会返回清晰的错误提示和修复指引，其余功能（chat、工具、浏览器等）完全正常

## 📦 安装

```bash
# Arch Linux (AUR)
yay -S deepseek-arch

# npm
npm install -g deepseek-arch
```

> 已安装旧版本的用户：`npm install -g deepseek-arch@latest` 升级即可，无需额外操作。
