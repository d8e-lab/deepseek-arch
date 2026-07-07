# Browser CDP 连接测试报告

状态: **已修复 (fix/windows-compat-and-interrupt)** | 创建: 2026-07-07

> 修复内容：
> - `src/tools/shell.ts`: 平台检测 → Windows 上使用 `powershell.exe -Command`
> - `src/tools/utils.ts`: `checkPath` 路径分隔符修复 → 用 `path.isAbsolute()` 替代硬编码 `/`
> - `src/tools/utils.ts`: 交互命令检测平台适配
> - 详见 `.deepseek-arch/plans/windows-compat-interrupt-fix.md`

┌────────────────────┬─────────────────────────────────────────────┬──────────────────────────┐
│ 测试               │ 命令                                        │ 结果                     │
├────────────────────┼─────────────────────────────────────────────┼──────────────────────────┤
│ 启动 Edge 调试模式 │ `start msedge --remote-debugging-port=9222` │ `spawn /bin/bash ENOENT` │
│ 查找 Edge 路径     │ `where msedge`                              │ `spawn /bin/bash ENOENT` │
│ 查找 cmd           │ `where cmd`                                 │ `spawn /bin/bash ENOENT` │
│ Python 环境检测    │ `python -c ...`                             │ `spawn /bin/bash ENOENT` │
│ 进程查询           │ `tasklist //FI "PID eq 7160"`               │ `spawn /bin/bash ENOENT` │
└────────────────────┴─────────────────────────────────────────────┴──────────────────────────┘

**全部失败，错误一致。** 工具硬编码了 `/bin/bash` 作为 shell 解释器，Windows 上没有这个二进制文件。

---

### 被测工具：`browser_navigate`

┌──────┬─────────────────────────────────────┬───────────────────────────────────────┐
│ 尝试 │ 目标                                │ 错误                                  │
├──────┼─────────────────────────────────────┼───────────────────────────────────────┤
│ 1    │ https://arxiv.org (port 9222)       │ `socket hang up`                      │
│ 2    │ https://arxiv.org (port 9222, 重试) │ `connect EADDRINUSE 127.0.0.1:9222`   │
│ 3    │ https://arxiv.org (port 9223)       │ `connect ECONNREFUSED 127.0.0.1:9223` │
└──────┴─────────────────────────────────────┴───────────────────────────────────────┘

端口 9222 实际被 `svchost` (PID 7160) 占用，非浏览器。

---

### 被测工具：`browser_snapshot`

```
Snapshot failed: CDP connection failed (http://127.0.0.1:9222)
```
与 `browser_navigate` 同一底层失败路径。

---

### 被测工具：`read_file` / `write_file`

```
read_file("README.md")         → "path outside workspace: README.md"
read_file("sglang/README.md")  → "path outside workspace: sglang/README.md"
search_content(".")            → 正常返回结果
```

`search_content` 能访问工作区文件，但 `read_file`/`write_file` 报路径越界——工作区根目录解析不一致。

---

### 用户手动诊断流程

用户充当了代理执行层，手动完成了本应自动化的诊断：

```
Test-NetConnection -Port 9222       → TcpTestSucceeded: True
netstat -ano | findstr :9222         → PID 7160, svchost
Get-Process -Id 7160                 → svchost
Test-NetConnection -Port 9223        → TcpTestSucceeded: False
curl http://127.0.0.1:9222/json/version  → 连接被意外关闭
```

---

### 主要 Bug

**`execute_command` 硬编码 `/bin/bash`**

- 现象：所有命令在 Windows 上均报 `spawn /bin/bash ENOENT`
- 影响：无法执行任何 shell 命令——无法启动浏览器、查询端口、验证进程、自动化任何步骤
- 修复方向：检测 `process.platform`，在 Windows 上用 `cmd.exe /c` 或 `powershell.exe -Command`

### 次要 Bug

**`read_file`/`write_file` 的工作区根目录与 `search_content` 不一致**

- `search_content(".")` 正确解析到 `D:\programme`
- 但 `read_file`/`write_file` 引用同一路径时被拒绝

---

### 结论

该 harness agent 在 Windows 上不具备浏览器控制能力。`execute_command` 的 shell 执行层是 Linux-only 实现，导致整个 CDP 浏览器自动化路径在此平台上完全不可用。这不是配置问题，而是代码缺陷。