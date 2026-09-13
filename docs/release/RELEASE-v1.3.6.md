# DeepSeek Arch v1.3.6 — TUI 调试工具 & 自我交互模式

> 面向用户的新功能发布说明

## 🚀 新功能

### 1. TUI 调试工具（`--debug` 模式）

模型现在能"看见"TUI 的渲染效果了！启动时加 `--debug` 启用两个调试工具：

```bash
deepseek-arch chat --debug
```

**`tui_capture`** — 获取当前 TUI 屏幕的结构化快照。模型可以查看：
- 终端尺寸、App 状态
- 每轮对话的用户消息、think 行数、回复行数
- 工具调用详情
- 输入区域状态
- 诊断警告（如 think 截断）

**`tui_render_preview`** — 离线预览渲染效果。模型可以直接传入：
- 文本内容 + 标签样式（user/think/assistant）
- 会话数据文件路径（`turns.json`）
- 可选：终端宽度、是否保留 ANSI 码

**典型调试场景**：模型修改了渲染代码 → 调用 `tui_render_preview` 看看效果 → 发现截断/布局问题 → 修复 → 再次验证。

### 2. 自我交互模式（`--self-interaction`）

模型能启动子 TUI 实例并与之交互，自主验证渲染行为：

```bash
deepseek-arch chat --self-interaction
```

**`tui_session_start`** — 在 300×200 伪终端中启动子 chat 实例  
**`tui_session_send`** — 输入文本或按键到子会话  
**`tui_session_read`** — 读取子会话的原始输出（含 ANSI 码）  
**`tui_session_capture`** — 获取子会话的结构化 TUI 报告  
**`tui_session_list`** — 查看所有活跃子会话  
**`tui_session_stop`** — 终止子会话  

**典型调试工作流**：
1. 模型修改渲染代码 → `npm run build`
2. `tui_session_start` — 启动子实例（用 MockProvider，零 API 费用）
3. `tui_session_send` — 发送测试消息
4. `tui_session_capture` — 检查渲染效果
5. 发现问题 → 修复代码 → 重复 2-4

### 3. `--mock` 模式

```bash
deepseek-arch chat --mock
```

使用 MockProvider 替代真实 API，输出确定、零费用。适合：
- 测试 TUI 渲染行为
- 调试 UI/UX 问题
- 自动化测试场景

---

## 🔧 修复

- 修复 `getAllTools` 工具过滤逻辑反转（回归 bug）
- 修复 PTY 会话的 `readLastScreen` 始终返回空的问题（移除不适用于 inline 渲染的 lastFullRenderPos 跟踪）
- 修复 ANSI dim 分析在识别 think/content 分界时的精度问题

---

## 📦 安装

### Arch Linux (AUR)

```bash
# 审核通过后
yay -S deepseek-arch

# 或本地构建
cd aur
makepkg -si
```

### npm

```bash
npm install -g deepseek-arch
```

### 从源码

```bash
git clone https://github.com/d8e-lab/deepseek-arch.git
cd deepseek-arch
npm install
npm run build
node dist/cli/index.js chat
```

---

## 💡 提示

- 调试 TUI 渲染时，用 `--mock` 避免 API 费用
- 子会话默认用 MockProvider（通过 `tui_session_start { mock: false }` 可关闭）
- PTY 窗口尺寸为 300×200，覆盖绝大多数终端场景
