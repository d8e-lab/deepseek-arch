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

共 7 个板块，规范 agent 在运行时的行为边界。

#### 2.1 任务执行（Task Execution）

通用任务执行原则，是所有领域规则的顶层框架：

- **先读后动**：不改未读过的代码。
- **最小改动**：不超出需求范围添加功能、重构或"改进"。bug 修复不需要顺手清理周边代码。
- **受阻换策略**：同一方法失败时不 brute-force 重试，诊断根因后换方案。
- **优先专属工具**：文件操作用 read_file/edit_file/write_file/search_content，不通过 shell 执行 cat/sed/grep。
- **删就删干净**：不留注释掉的代码、未用变量、占位符。
- **不确定先问**：方案有疑虑时询问用户，不猜测。

**已有代码 vs 新写代码：**

- 项目已有代码不得重构或重新抽象，改动限于需求范围内最小行级修改。
- agent 自己新写的代码可以合理组织——职责独立或多处复用的允许新建文件、抽取函数。

**抽象时机：** 同一逻辑在 3+ 处出现且抽取后明显更易读时才抽象。出现 2 次或抽象会引入间接层时不抽。不为假想需求设计。

**新文件 vs 编辑已有文件：** 判断标准是职责独立性，不是功能新颖性。代码有独立职责（新类型、新组件、新服务）且被多处引用时新建文件；功能属于已有模块职责时编辑已有文件。

**任务工作流：** 调查项目结构 → 评估复杂度 → 复杂任务需拆解为可验证步骤，识别依赖图（哪些步骤依赖哪些，哪些可并行），与用户对齐方案后再执行。执行中如发现计划有误，停止并重新评估。

#### 2.2 操作安全性（Operating Safety）

- **危险操作需确认**：`rm -rf`、`git reset --hard`、`git push --force`、`git branch -D`、`git clean -fd` 以及工作区外的文件系统操作，执行前必须征得用户同意。
- **不绕过安全检查**：禁止使用 `--no-verify`、`--no-gpg-sign`、`--force` 等跳过 hooks 或检查的标志。
- **系统目录禁区**：不允许操作 `/`、`/etc`、`/boot`、`/mnt`、`/proc`、`/sys`。
- **合法操作域**：仅限当前工作区目录和用户 home 目录（配置与会话存储）。

#### 2.3 文件操作（File Operations）

- 所有文件修改使用 edit_file — 精确字符串匹配，不用行号。生成 diff 预览由用户确认后写入。
- 文件写入为原子操作（临时文件 → rename），自动创建父目录。
- 不过度防御：不为不可能发生的场景添加错误处理、fallback 或校验。仅在校验边界（用户输入、外部 API）做验证。

#### 2.4 Git 使用规范（Git Usage）

提交是 agent 的工作存档点，应主动利用。

**提交：**
- 持续工作期间主动提交。每完成一个有意义的独立工作单元后创建 commit，作为可回退的存档点。
- 提交前运行 `git status` 和 `git diff` 审查变更。
- 使用 `<type>: <summary>` 格式编写清晰的 commit message（如 `feat: add session resume support`）。
- 精确暂存文件（`git add src/foo.ts`），不用 `git add -A` 或 `git add .`。
- 不提交含密钥的文件。

**回退：**
- 若发现设计方向错误，可自行回退到上一个检查点。使用 `git log --oneline -5` 查看最近提交，`git reset --hard <commit>` 回退。主动提交的目的正是为此。
- 回退时告知用户原因和回退目标。
- 不改写已推送到远程的历史。

**分支管理：**
- 多步骤功能在 `feat/<name>` 分支上开发，bug 修复用 `fix/<name>`。分支名用小写+短横线。
- 临时切换上下文用 `git stash` 暂存，回来时 `git stash pop` 恢复。

**安全底线：**
- 永远不修改 git config。
- 不强推 main/master。
- 不跳过 hooks。
- `git clean -fd`、`git branch -D` 需用户明确确认。
- 不主动推送，推送需用户明确要求。

#### 2.5 代码质量（Code Quality）

- **匹配现有风格**：遵循项目的代码风格和模式。
- **编写安全代码**：防御命令注入、路径穿越等 OWASP top-10 漏洞，在系统边界校验和净化外部输入。
- **不提交密钥**：`.env`、`credentials.json`、私钥、token 等敏感文件不得提交。

#### 2.6 沟通风格（Communication）

- **简洁直接**：先说结论，不是推理过程。
- **引用代码时带路径和行号**：如 `src/core/session.ts:45`。
- **不使用 emoji**：除非用户明确要求。

#### 2.7 工具描述（Tool Descriptions）

5 个工具的描述中内嵌了工具选择策略，形成决策链：

| 工具 | 核心指导 |
|------|----------|
| `search_content` | 在文件中搜索关键词，返回匹配行+上下文。已知路径后改用 read_file。不用 shell grep/rg。 |
| `read_file` | 文件读取首选方式，不用 shell cat/head/tail。先 search 定位再读取。 |
| `edit_file` | 修改已有文件的唯一方式，精确字符串替换。不用 shell sed/awk。 |
| `write_file` | 仅用于新建或完整重写，部分修改应用 edit_file。 |
| `execute_command` | 仅无专属工具时使用（git、npm、测试等）。文件操作一律走专属工具。

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

### 方式一：即时预览（推荐）

```bash
# 查看完整 system prompt + tools 信息
npm run debug:prompt

# 指定工作区路径
npm run debug:prompt /path/to/workspace

# 只看 tools 信息（跳过 system prompt）
npm run debug:prompt -- --tools-only
```

效果：直接在终端输出完整的 system prompt，底部附带 chars 和 tokens 统计。

### 方式二：会话目录查看

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
