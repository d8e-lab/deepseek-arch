# DeepSeek Arch v2.0.2

> 会话不会再被"跑不完的命令"卡死，常用命令也不再被无故拦截。

## 🖥️ 更稳的 shell 体验

**命令再也不会把会话卡住**

此前如果一条命令留下了后台进程（例如启动服务、跑一个后台任务），这个 shell 调用会**永久挂住**——界面一直显示执行中，只能强行中断。现在：

- 命令结束就立刻返回结果，不会再有"永久执行中"
- 超时或中断时，命令带起的**整个进程组**都会被清理，不再留下后台孤儿进程
- `!命令` 手动执行模式同样修复

**常用命令不再被拦截**

此前有一份"交互式命令"黑名单，`less`、`more`、`top`、`git log | less`、甚至带参数的 `ssh`/`gdb` 都会被直接拒绝。实际上这些命令在非交互环境下本来就能正常执行，黑名单已经**整体移除**：

- 分页查看：`git log | less`、`man` 风格的分页阅读
- 只读查看：`top -b -n 1`、`watch --version`、`gdb --version`
- REPL 与脚本混用：`python3`、`node`、`sqlite3` 等不再需要额外加参数才能跑

## 🧠 移除内置规划能力（破坏性变更）

- 删除 **`plan` skill** 与 **`save_plan` 工具**：规划不再由内建框架驱动，请直接描述任务或使用 `research` skill 做调研
- 对话压缩不再重新注入历史计划文档（`[Compact Plan]` 块取消）
- 如果你有脚本或提示词依赖 `save_plan` / `/plan`，需要移除对应调用

## 🔧 Bug 修复

- 修复：后台进程占用输出管道时，shell 工具调用永久无法返回
- 修复：超时只终止最外层 shell，子进程继续在后台运行
- 修复：`!命令` 模式下同样的卡死与进程残留问题

## 📦 安装

**Arch Linux（AUR）**

> ⚠️ AUR 尚未同步到 2.0.2，`yay -S deepseek-arch` 目前仍会装到旧版本。

**GitHub Release（推荐，无需 AUR）**

```bash
npm install -g https://github.com/d8e-lab/deepseek-arch/releases/download/v2.0.2/deepseek-arch-2.0.2.tgz
```

**源码安装**

```bash
git clone https://github.com/d8e-lab/deepseek-arch.git
cd deepseek-arch && npm install && npm run build
```
