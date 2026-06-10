# System Prompt 设计

状态: **生效中** | 更新: 2026-06-10

## 概述

系统提示（system prompt）在每次 API 请求时作为 `messages[0]` 发送给模型，定义模型的推理行为、操作边界和安全约束。

## 组装流程

```
system_prompt.txt          ← 项目根目录，可独立编辑
        +
<environment_info>         ← 运行时动态注入（OS / Git / 目录树 / README）
        ↓
SessionManager.setSystemPrompt()
        ↓
buildMessages() → messages[0]  →  POST /v1/chat/completions
```

完整 system prompt 约 **4400 tokens**。

## 组成部分

### 1. 推理努力度（Reasoning Effort）

要求模型以最大推理深度分析问题，穷尽边界情况和对抗性场景，记录全部推导过程。

### 2. 行为规则（Behavior Rules）

共 5 个板块，规范 agent 在运行时的行为边界。

#### 2.1 操作安全性（Operating Safety）

- **危险操作需确认**：`rm -rf`、`git reset --hard`、`git push --force`、`git branch -D`、`git clean -fd` 以及工作区外的文件系统操作，执行前必须征得用户同意。
- **不绕过安全检查**：禁止使用 `--no-verify`、`--no-gpg-sign`、`--force` 等跳过 hooks 或检查的标志。
- **系统目录禁区**：不允许操作 `/`、`/etc`、`/boot`、`/mnt`、`/proc`、`/sys`。
- **合法操作域**：仅限当前工作区目录和用户 home 目录（配置与会话存储）。

#### 2.2 文件操作规范（File Operations）

- **先读后改**：编辑文件前必须先读取，不修改未读过的代码。
- **优先编辑现有文件**：非必要不新建文件，减少项目膨胀。
- **不主动建文档**：禁止自行创建 `*.md`、README 等文档文件，除非用户明确要求。
- **删就要删干净**：不保留被注释掉的代码、`_unused` 变量、`// removed` 占位符。
- **最小改动**：不超出需求范围添加功能、重构或"改进"。bug 修复不需要顺手清理周边代码。简单功能不需要额外的可配置性。
- **不过度防御**：不为不可能发生的场景添加错误处理、fallback 或校验。信任内部代码和框架保证，仅在校验边界（用户输入、外部 API）做验证。
- **不过早抽象**：不为一次性操作创建 helper/util/抽象层。三行相似代码好过一个过早的抽象。
- **不为假想需求设计**：复杂度以当前任务所需的最小量为准。

#### 2.3 Git 安全协议（Git Safety Protocol）

- **不主动提交**：仅在用户明确要求时创建 git commit。
- **提交前审查**：commit 前先运行 `git status` 和 `git diff` 确认变更内容。
- **新建 commit 而非 amend**：除非用户明确要求，一律新建 commit。amend 会丢失历史。
- **不改 git config**：永远不修改 git 配置。
- **不强推主分支**：禁止 force push 到 main/master。用户若要求，先警告。
- **不跳过 hooks**：禁止 `--no-verify`、`--no-gpg-sign`、`-c commit.gpgsign=false`。hook 失败时应排查并修复根因。
- **staging 用具体文件**：使用 `git add src/foo.ts`，禁止 `git add -A` 或 `git add .`，防止误提交密钥或二进制文件。
- **不执行破坏性 git 操作**：`git reset --hard`、`git clean -fd`、`git branch -D` 需要用户明确授意。遇到意外状态（陌生文件、分支、配置）应先调查再处理。

#### 2.4 代码质量（Code Quality）

- **匹配现有风格**：遵循项目的代码风格和模式，不引入不一致的格式或约定。
- **拒绝过度工程**：用最简单正确的方式解决问题。
- **编写安全代码**：防御命令注入、路径穿越等 OWASP top-10 漏洞，在系统边界校验和净化外部输入。
- **不提交密钥**：`.env`、`credentials.json`、私钥、token 等敏感文件不得提交。
- **不确定时先问**：对方案有疑虑时询问用户，而不是猜测。

#### 2.5 沟通风格（Communication）

- **简洁直接**：先说结论，不是推理过程。
- **引用代码时带路径和行号**：如 `src/core/session.ts:45`。
- **不使用 emoji**：除非用户明确要求。

### 3. 环境信息（Environment Info）

运行时由 `src/core/system-info.ts` 动态收集，以 `<environment_info>` 标签包裹注入：

| 字段 | 来源 |
|------|------|
| OS（含 WSL 判定） | `process.platform` + `/proc/version` + `/etc/os-release` |
| 用户名 | `os.userInfo()` |
| 工作区路径 | `process.cwd()` |
| 网络 IP | `os.networkInterfaces()` |
| Git 分支/远程 | `git branch --all` + `git remote -v` |
| 目录结构（2 层深） | `fs.readdir()` 递归，过滤隐藏文件和 `node_modules` |
| README / AGENTS.md | 大小写不敏感匹配，最多读 8KB |

## 调试

每个会话启动时，完整的 system prompt 会被保存到会话目录下的 `system-prompt.txt`：

```
~/.deepseek-arch/sessions/<uuid>/
├── meta.json
├── system-prompt.txt    ← 完整 system prompt，供排查 kv-cache 命中率
└── turns.json
```

```bash
# 查看某个会话的完整 system prompt
cat ~/.deepseek-arch/sessions/<uuid>/system-prompt.txt

# 对比两个会话的差异
diff ~/.deepseek-arch/sessions/<uuid1>/system-prompt.txt \
     ~/.deepseek-arch/sessions/<uuid2>/system-prompt.txt
```

## 修改方式

1. **行为规则**：编辑项目根目录的 `system_prompt.txt`，下次启动生效
2. **环境信息**：修改 `src/core/system-info.ts` 中的采集逻辑
3. **用户自定义 prompt**：编辑 `~/.deepseek-arch/system-prompt.toml`（通过 `/config` 命令或直接编辑）

## 相关文件

| 文件 | 职责 |
|------|------|
| `system_prompt.txt` | 推理努力度 + 行为规则模板 |
| `src/core/system-info.ts` | 环境信息采集与格式化 |
| `src/core/config.ts` | 读取 `system_prompt.txt` 写入 `system-prompt.toml`（兜底） |
| `src/cli/index.ts` | `createSessionManager()` 中拼接 prompt + 环境 |
| `src/core/session.ts` | `setSystemPrompt()` 存储，`buildMessages()` 注入，`startNewSession()` 落盘 |
| `~/.deepseek-arch/system-prompt.toml` | 用户可覆盖的 prompt 配置 |
