# Claude Code Skill 机制设计全解

> 基于 Claude Code 泄露源码（`d8e-lab/claude-code`）的深度逆向分析。
> 本文档梳理 skill 从"文件/代码定义"→"harness 捕捉"→"模型发现"→"执行"→"生命周期管理"的完整链路。

---

## 目录

1. [核心抽象：Skill 就是"给模型用的 slash command"](#1-核心抽象skill-就是给模型用的-slash-command)
2. [五种来源（source / loadedFrom）](#2-五种来源source--loadedfrom)
3. [加载层级与去重](#3-加载层级与去重)
4. [Skill 文件格式：YAML frontmatter + Markdown 正文](#4-skill-文件格式yaml-frontmatter--markdown-正文)
5. [Harness 捕捉链路：文件 → Command 对象](#5-harness-捕捉链路文件--command-对象)
6. [两种执行模型：inline 与 fork](#6-两种执行模型inline-与-fork)
7. [面向模型的接口：SkillTool](#7-面向模型的接口skilltool)
8. [元信息注入：模型从哪里知道有哪些 skill](#8-元信息注入模型从哪里知道有哪些-skill)
9. [动态发现与条件激活](#9-动态发现与条件激活)
10. [生命周期与状态管理](#10-生命周期与状态管理)
11. [安全设计](#11-安全设计)
12. [内置 skill 注册机制](#12-内置-skill-注册机制)
13. [附录：关键文件索引](#附录关键文件索引)

---

## 1. 核心抽象：Skill 就是"给模型用的 slash command"

Skill 在代码里**不是独立类型**，而是 `Command` 的一种 —— `type: 'prompt'`（`PromptCommand`）。

```ts
// types/command.ts
export type PromptCommand = {
  type: 'prompt'
  progressMessage: string
  contentLength: number          // 用于 token 估算
  argNames?: string[]
  allowedTools?: string[]        // 调用时注入的权限白名单
  model?: string                 // 模型覆盖
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  pluginInfo?: { pluginManifest; repository }
  hooks?: HooksSettings          // 调用时注册的 hooks
  skillRoot?: string             // skill 资源基础目录
  context?: 'inline' | 'fork'    // 执行模型（见 §6）
  agent?: string                 // fork 时使用的子代理类型
  effort?: EffortValue
  paths?: string[]               // 条件激活的 glob 模式（见 §9）
  getPromptForCommand(args, context): Promise<ContentBlockParam[]>
}
```

**本质**：skill 就是一段 Markdown 提示词 + YAML frontmatter 元数据。用户敲 `/xxx` 与模型调 `Skill` 工具走**同一条代码路径**（`processPromptSlashCommand`，`utils/processUserInput/processSlashCommand.tsx:817`）—— skill 只是由模型触发的 slash command。

Command 家族完整类型：`local`（纯逻辑命令）、`local-jsx`（渲染 Ink UI 的命令）、`prompt`（skill）。三者共享 `CommandBase` 字段：`name`、`description`、`aliases`、`whenToUse`、`isHidden`、`isEnabled`、`disableModelInvocation`、`userInvocable` 等。

---

## 2. 五种来源（source / loadedFrom）

| 来源 | 加载方式 | 说明 |
|---|---|---|
| `bundled` | `registerBundledSkill()` 程序化注册 | 编译进 CLI 二进制，`skills/bundled/` 下一个文件一个注册函数，用 `feature()` 编译期开关控制 |
| `skills` | 扫描 `.claude/skills/<name>/SKILL.md` | **官方目录格式，必须"目录 + SKILL.md"，不支持单文件** |
| `commands_DEPRECATED` | 扫描 `.claude/commands/` | 旧版兼容层，`transformSkillFiles` 把目录中的 SKILL.md 提升为命令 |
| `plugin` | marketplace 插件 | 带 `pluginInfo`（manifest + repository），名称可带 `plugin:namespace:name` 前缀 |
| `mcp` | MCP 服务器暴露 | 通过 `mcpSkillBuilders` 注册 `createSkillCommand`，规避循环依赖 |

```ts
// skills/loadSkillsDir.ts
export type LoadedFrom =
  | 'commands_DEPRECATED'
  | 'skills'
  | 'plugin'
  | 'managed'   // 策略托管（policySettings）
  | 'bundled'
  | 'mcp'
```

MCP skill 通过 write-once 注册表接入（`skills/mcpSkillBuilders.ts`）：`loadSkillsDir.ts` 模块初始化时把 `createSkillCommand` / `parseSkillFrontmatterFields` 注册进去，`mcpSkills.ts` 侧用 `getMCPSkillBuilders()` 取用 —— 纯类型依赖、无 import 边，避免 Bun 打包时的循环依赖崩溃。

---

## 3. 加载层级与去重

### 3.1 目录优先级

`getSkillDirCommands(cwd)`（`skills/loadSkillsDir.ts:638`，**memoize**）启动时并行从 5 个位置加载：

```
managed    -> <managed>/.claude/skills       (policySettings，可用 env 关闭)
user       -> ~/.claude/skills               (userSettings)
project    -> cwd 向上到 home 每层 .claude/skills  (projectSettings)
additional -> --add-dir 指定的目录
legacy     -> .claude/commands/              (skillsLocked 时跳过)
```

加载入口对应 `getSkillsPath()` 的映射：

```ts
case 'policySettings': return join(getManagedFilePath(), '.claude', dir)
case 'userSettings':   return join(getClaudeConfigHomeDir(), dir)
case 'projectSettings': return `.claude/${dir}`
case 'plugin':         return 'plugin'
```

### 3.2 去重：realpath 规范路径

用 `realpath()` 解析文件的**规范路径**做 key（而非 inode），专门处理 symlink 与重叠父目录导致的重复加载（文件系统无关，避免容器/NFS 的 inode 0 与 ExFAT 精度丢失问题）。首胜优先：先加载的 source 保留，后加载的同路径 skill 跳过并打日志。

### 3.3 --bare 模式

`--bare` 跳过全部自动发现（managed/user/project 目录遍历 + legacy commands-dir），**只加载显式 `--add-dir` 路径**。`skillsLocked`（`isRestrictedToPluginOnly`）仍然生效 —— --bare 不是策略绕过。

---

## 4. Skill 文件格式：YAML frontmatter + Markdown 正文

```
my-skill/
  SKILL.md
```

SKILL.md = 顶部 YAML frontmatter（`---` 包裹）+ Markdown 正文（调用时展开的提示词）。

```markdown
---
name: pdf                          # displayName（UI 显示名）
description: Extract text and structured data from PDF files
when_to_use: When the user needs to parse a PDF document
allowed-tools: Read, Grep, Glob
argument-hint: "[file path]"
arguments: "file"                  # 命名参数定义
model: sonnet                      # 模型覆盖；'inherit' = 继承会话模型
context: fork                      # fork 子代理执行（默认 inline）
agent: general-purpose             # fork 时的 agent 类型
effort: high                       # 思考力度覆盖
paths: docs/**/*.pdf               # 条件激活（gitignore 风格 glob）
hooks:
  PreToolUse:
    - matcher: Read
      hooks: [{ type: command, command: "echo $CLAUDE_PROJECT_DIR" }]
version: 1.0.0
user-invocable: true               # 是否允许用户 /xxx 调用
disable-model-invocation: false    # true = 模型不可见，只能用户手动调
shell: bash                        # !`cmd` 注入用的 shell（bash/powershell）
---
# PDF Skill
正文：给模型的完整指令……
```

### frontmatter 字段全表（`FrontmatterData` 类型）

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | displayName |
| `description` | string | 简介；缺失时从正文首行自动提取 |
| `when_to_use` | string | **给模型判断"何时用"的关键字段**，listing 中拼在简介后 |
| `allowed-tools` | string/string[] | 调用时注入 alwaysAllowRules 的工具白名单 |
| `argument-hint` | string | 参数提示（用户 UI） |
| `arguments` | string/string[] | 命名参数定义，用于 `$ARGUMENTS` 替换 |
| `model` | string | 模型覆盖；`inherit` = 继承 |
| `effort` | string/int | effort 覆盖（low/medium/high/max 或整数） |
| `context` | `'inline' \| 'fork'` | 执行模型 |
| `agent` | string | fork 时的 agent 类型 |
| `paths` | string/string[] | 条件激活 glob |
| `hooks` | HooksSettings | 调用时注册的 hooks（HooksSchema 校验） |
| `shell` | string | 内嵌 shell 命令的解释器（默认 bash） |
| `version` | string | 版本号 |
| `user-invocable` | bool | 默认 true |
| `disable-model-invocation` | bool | 默认 false |
| `hide-from-slash-command-tool` | bool | 对 SlashCommand 工具隐藏 |

---

## 5. Harness 捕捉链路：文件 → Command 对象

```
SKILL.md 文件
  │
  ├─ parseFrontmatter()                     utils/frontmatterParser.ts:130
  │    ├─ FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/ 切块
  │    ├─ parseYaml() 解析
  │    └─ 失败 fallback：quoteProblematicValues() 给 { } [ ] * # 等
  │        YAML 特殊字符加引号重试（让 glob 如 **\/*.{ts,tsx} 能解析）
  │
  ├─ parseSkillFrontmatterFields()          skills/loadSkillsDir.ts:185
  │    └─ frontmatter → Command 字段映射：
  │        description / whenToUse / allowedTools / model / effort /
  │        executionContext('fork') / agent / hooks / paths / shell …
  │
  └─ createSkillCommand()                   skills/loadSkillsDir.ts:270
       └─ 生成 { type:'prompt', name, description, whenToUse, …,
                  getPromptForCommand }     即 Command 对象，进注册表
```

**`getPromptForCommand` 的展开流程**（调用时执行，`loadSkillsDir.ts:344`）：

1. 前缀 `Base directory for this skill: <baseDir>`（模型可据此按需 Read/Grep 参考文件）
2. `substituteArguments()` —— `$ARGUMENTS` / 命名参数替换
3. `${CLAUDE_SKILL_DIR}` → skill 自身目录、`${CLAUDE_SESSION_ID}` → 会话 ID
4. `executeShellCommandsInPrompt()` —— 执行正文中的 `!` 命令注入
   **MCP skill 跳过此步**（远程不可信内容永不执行内嵌 shell）
5. 返回 `[{ type: 'text', text: finalContent }]`

---

## 6. 两种执行模型：inline 与 fork

由 frontmatter `context` 字段决定。

### 6.1 Inline（默认）——"内容展开进当前对话"

```
SkillTool.call()
  └─ processPromptSlashCommand()            processSlashCommand.tsx:817
       └─ getMessagesForPromptSlashCommand()
            └─ command.getPromptForCommand(args, ctx)  生成内容块
            └─ 结果作为带 <command-name> 标签的 meta user 消息注入对话
  └─ contextModifier() 副作用注入：
       ├─ allowedTools → 并入 alwaysAllowRules（免权限）
       ├─ model → 覆盖 mainLoopModel（保留 [1m] 窗口后缀）
       └─ effort → 覆盖 effortValue
```

- 模型在**现有上下文**里继续执行，消息永久进入对话
- 已加载的 skill 靠 `<command-name>` 标签识别，防止模型重复调用

### 6.2 Fork（`context: fork`）——"隔离子代理执行"

```
executeForkedSkill()                        SkillTool.ts:122
  ├─ createAgentId() + prepareForkedCommandContext()  独立上下文
  ├─ runAgent({ agentDefinition, promptMessages, model, override:{agentId} })
  │    └─ 隔离的 token 预算里跑完整轮
  ├─ 进度通过 onProgress 回传（skill_progress）
  ├─ extractResultText() 提取最终文本
  ├─ agentMessages.length = 0  释放中间消息内存
  └─ finally: clearInvokedSkillsForAgent(agentId)
```

- 子代理中间消息**全部丢弃**，只回传结果文本作为 tool_result
- 支持 `model` 覆盖、`effort` 覆盖、自定义 `agent` 类型
- 子代理同样能收到自己的 skill listing（`sentSkillNames` 按 agentId 隔离）

### 6.3 输出 schema（两种结果形态）

```ts
inline: { success, commandName, allowedTools?, model?, status:'inline' }
forked: { success, commandName, status:'forked', agentId, result }
```

---

## 7. 面向模型的接口：SkillTool

`tools/SkillTool/SkillTool.ts`（~1100 行），工具名 `Skill`：

```
输入: { skill: string, args?: string }
输出: inline 或 forked 结果（见 §6.3）
```

### 7.1 validateInput 五层校验

1. 格式合法（非空、去前导 `/`）
2. skill 存在（`getAllCommands` = 本地 + bundled + **MCP skills** 合并去重）
3. 未被 `disableModelInvocation`
4. 是 `type: 'prompt'`
5. （ant 实验）远程 `_canonical_<slug>` 拦截校验

### 7.2 权限模型（checkPermissions）

```
deny 规则 → allow 规则 → SAFE_SKILL_PROPERTIES 自动放行 → 否则 ask 用户
```

- 规则匹配支持 `name` 精确匹配与 `name:*` 前缀匹配
- **SAFE_SKILL_PROPERTIES 白名单**（`SkillTool.ts:875`）：只有全部属性都落在白名单内的 skill 自动放行；**任何未列属性默认要求权限（fail-closed）**，保证未来新增属性默认安全
- ask 时提供 `addRules` 建议（精确 + 前缀两条）

### 7.3 指令性 prompt

```
When users ask you to perform tasks, check if any of the available skills match.
When a skill matches the user's request, this is a BLOCKING REQUIREMENT:
invoke the relevant Skill tool BEFORE generating any other response.
- Available skills are listed in system-reminder messages in the conversation
- If you see a <command-name> tag in the current turn, the skill has ALREADY
  been loaded - follow the instructions directly instead of calling this tool
```

---

## 8. 元信息注入：模型从哪里知道有哪些 skill

### 8.1 完整链路

```
query.ts 主循环每次迭代 (query.ts:1580)      ← 每轮 tool round 都调用
  └─ getAttachmentMessages()                 attachments.ts:2937
       └─ getAttachments()                   attachments.ts:743
            └─ maybe('skill_listing', getSkillListingAttachments)   attachments.ts:875
                 ├─ getSkillToolCommands(cwd)   ← 过滤模型可调 skill
                 ├─ sentSkillNames 增量去重     ← 首轮全量，之后只发新增
                 ├─ formatCommandsWithinBudget() ← 预算化（见 §8.3）
                 └─ 产出 { type:'skill_listing', content, skillCount, isInitial }
       └─ createAttachmentMessage()
            └─ messages.ts:3728 skill_listing case：
                 wrapMessagesInSystemReminder(createUserMessage({
                   content: "The following skills are available for use with the Skill tool:\n\n" + listing,
                   isMeta: true
                 }))
```

模型最终看到的是挂在**用户回合上的 system-reminder 消息**（不是 system prompt）：

```
<system-reminder>
The following skills are available for use with the Skill tool:

- pdf: Extract text from PDFs - when to use: you need to parse a PDF
- ms-office-suite:excel: Work with Excel - ...
</system-reminder>
```

### 8.2 过滤规则（getSkillToolCommands，commands.ts:563）

```ts
cmd.type === 'prompt' && !cmd.disableModelInvocation && cmd.source !== 'builtin' &&
(cmd.loadedFrom === 'bundled' || 'skills' || 'commands_DEPRECATED' ||
 cmd.hasUserSpecifiedDescription || cmd.whenToUse)
```

- `disable-model-invocation: true` 的 skill **模型完全看不到**（只能用户 `/xxx`）
- 本地 skill 无 description 也能进（自动从首行提取）
- **plugin/MCP skill 必须有显式 description 或 whenToUse 才进列表**

### 8.3 预算控制（tools/SkillTool/prompt.ts）

| 常量 | 值 | 说明 |
|---|---|---|
| `SKILL_BUDGET_CONTEXT_PERCENT` | 1% | listing 只占 context window 的 1% |
| `DEFAULT_CHAR_BUDGET` | 8000 字符 | 200K × 4 chars/token × 1% |
| `MAX_LISTING_DESC_CHARS` | 250 | 每条描述硬截断，防浪费首轮 cache_creation token |
| `MIN_DESC_LENGTH` | 20 | 截断下限，低于则只剩名字 |

- 条目格式：`- {name}: {description} - {whenToUse}`
- **bundled skill 永不截断**，优先保证；普通 skill 按剩余预算均匀截断，极端情况只剩 `- name`
- `SLASH_COMMAND_TOOL_CHAR_BUDGET` env 可覆盖

### 8.4 增量与抑制

- `sentSkillNames`（per agentId）—— 首轮全量，之后只发新增（动态发现、`/reload-plugins` 后）
- `--resume`：transcript 已有 skill_listing 则 `suppressNextSkillListing()`（conversationRecovery.ts）
- **compact 后不重发**：注释明确"~4K tokens 重发是纯 cache_creation 浪费"，靠 `invokedSkills` 保留已用 skill 上下文
- 另有三个注入入口：`processUserInput.ts:503`（用户输入）、`processSlashCommand.tsx:897`（手动 /skill）、子代理（agentId 隔离）
- skill-search 开启时 listing 过滤为 bundled + MCP（`filterToBundledAndMcp`，>30 个退回 bundled-only）保证子代理 turn-0 可见性

---

## 9. 动态发现与条件激活

### 9.1 动态目录发现（discoverSkillDirsForPaths）

- 每次文件操作后，从文件目录**向上走到 cwd**（不含 cwd 本身，cwd 级启动时已加载），找 `.claude/skills`
- `dynamicSkillDirs` 记录已检查路径，避免重复 stat
- **跳过 gitignored 目录**（`isPathGitignored`）—— 防止 node_modules 里的 skill 静默加载
- 结果按路径深度排序，**深路径优先**

### 9.2 动态加载（addSkillDirectories）

- 深路径 skill 覆盖浅路径（reverse 顺序 set）
- 成功后 `skillsLoaded.emit()` 触发各模块清缓存
- 记录 `tengu_dynamic_skills_changed` 遥测

### 9.3 条件激活（activateConditionalSkillsForPaths）

带 `paths` frontmatter 的 skill 启动时**不暴露**，存于 `conditionalSkills`；当模型触碰匹配文件（`ignore` 库做 gitignore 风格匹配）时：

```
conditionalSkills → dynamicSkills（激活）
activatedConditionalSkillNames.add(name)   ← 会话内不清除
skillsLoaded.emit() → 下次 listing 增量注入
```

---

## 10. 生命周期与状态管理

### 10.1 invokedSkills（bootstrap/state.ts:1501）

```ts
type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string      // 展开后的完整内容
  invokedAt: number
  agentId: string | null
}
// key = `${agentId ?? ''}:${skillName}`
```

- 调用时 `addInvokedSkill()` 记录（含**展开后内容**）
- **跨 compact 保留 skill 上下文的关键**：压缩后可从缓存恢复完整内容
- `clearInvokedSkillsForAgent(agentId)` —— fork 执行完清理
- `clearInvokedSkills(preservedAgentIds)` —— compact 时保留主线程已用 skill

### 10.2 其他状态

- `recordSkillUsage(commandName)` —— 调用次数统计，用于 skill 建议排序
- hooks —— skill 可注册 hooks，调用时经 `HooksSchema` 校验后生效
- 条件 skill 的激活状态（`activatedConditionalSkillNames`）会话内跨缓存清除保留

---

## 11. 安全设计

| 层 | 措施 |
|---|---|
| 权限 | skill 调用本身走 ask/allow/deny；`SAFE_SKILL_PROPERTIES` 白名单 fail-closed |
| MCP | 远程不可信 skill **不执行内嵌 shell 命令**（`executeShellCommandsInPrompt` 仅非 MCP 执行） |
| 路径 | `${CLAUDE_SKILL_DIR}` 替换 + 权限上下文按 skill 注入 `allowedTools` |
| 文件提取 | bundled skill 参考文件提取：per-process nonce 目录 + 0o700/0o600 + `O_NOFOLLOW\|O_EXCL`，防符号链接攻击；**不 unlink+retry**（unlink 会跟随中间 symlink） |
| 动态发现 | gitignored 目录跳过；信任对话框是实际安全边界（fail-open 但有提示） |
| 条件匹配 | `ignore()` 匹配拒绝空串、`../` 逃逸、绝对路径 |

---

## 12. 内置 skill 注册机制

`skills/bundled/index.ts` 的 `initBundledSkills()` 启动时注册。**内置 skill 不是文件，是程序化注册**：

```ts
// skills/bundledSkills.ts
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  allowedTools?: string[]
  model?: string
  isEnabled?: () => boolean
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string>   // 参考文件，首次调用惰性提取到磁盘
  getPromptForCommand(args, ctx)
}
```

- 字段与 frontmatter **一一对应**（`description` 进 listing，`getPromptForCommand` 相当于正文）
- `feature()` 编译期开关控制（KAIROS、AGENT_TRIGGERS、BUILDING_CLAUDE_APPS 等）
- `files` 参数：首次调用时把附属参考文件提取到磁盘（带防符号链接攻击的写入），prompt 前缀 `Base directory for this skill: <dir>`，模型可按需 Read/Grep

现有内置 skill：update-config、keybindings-help、verify、debug、lorem-ipsum、skillify、remember、simplify、batch、stuck、dream（KAIROS）、hunter（REVIEW_ARTIFACT）、loop（AGENT_TRIGGERS）、schedule（AGENT_TRIGGERS_REMOTE）、claude-api、claude-in-chrome、run-skill-generator 等。

---

## 附录：关键文件索引

| 文件 | 职责 |
|---|---|
| `types/command.ts` | Command / PromptCommand 类型体系 |
| `skills/loadSkillsDir.ts` | 目录扫描、frontmatter 解析、createSkillCommand、动态发现、条件激活 |
| `skills/bundledSkills.ts` | bundled skill 注册与参考文件安全提取 |
| `skills/bundled/index.ts` | 内置 skill 初始化入口 |
| `skills/mcpSkillBuilders.ts` | MCP skill 注册表（避免循环依赖） |
| `tools/SkillTool/SkillTool.ts` | Skill 工具本体（校验/权限/执行） |
| `tools/SkillTool/prompt.ts` | listing 预算化与工具 prompt |
| `utils/attachments.ts` | skill_listing / dynamic_skill attachment 生成 |
| `utils/messages.ts` | attachment → system-reminder 消息转换 |
| `utils/frontmatterParser.ts` | YAML frontmatter 解析（含特殊字符 fallback） |
| `utils/processUserInput/processSlashCommand.tsx` | inline 执行路径（slash command 与 skill 共用） |
| `bootstrap/state.ts` | invokedSkills 状态（compact 保留） |
| `utils/argumentSubstitution.ts` | `$ARGUMENTS` / 命名参数替换 |
| `utils/promptShellExecution.ts` | 内嵌 `!` 命令执行（MCP 跳过） |
| `commands.ts` | getSkillToolCommands / getSlashCommandToolSkills 过滤 |

---

*文档基于 `d8e-lab/claude-code` 仓库源码分析整理，行号引用对应当时源码版本。*
