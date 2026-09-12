# Memory 机制 + 心跳/唤起机制 详细设计稿

- 分支：`feature/subagent-lifecycle`（写作时 HEAD = `58f2e0c`）
- 需求来源：`plan/20260912Task.md`（第 6/7 条 + `## Memory` 段 + `## 心跳机制` 段）
- 设计者：设计子代理（**纯设计**：未改动任何源码/测试/配置，未做 git 操作）
- 参考材料声明：**过时设计稿 `plan/memory-mechanism.md` 已删除，本稿不引用、不恢复、不沿用其结论**。
  仓库中仍有 3 处残留引用需在实施时清理（见附录 B）。
- 所有“现有代码事实”均标注 `文件:行号`；未标注处为本稿新提出的设计决策。

---

## 目录

0. 阅读指南
1. 目标与不做
2. 现状事实与硬约束（实施前必读）
3. 存储结构
4. 置信度分级、衰减与淘汰
5. 去重与冲突调和
6. 注入机制（最关键）
7. memory agent
8. 面向用户的接口
9. 配置 schema
10. 心跳机制与 `chat --prompt`
11. 实施拆分建议
12. 开放问题

附录 A：reviewer（censor agent）移除清单
附录 B：`plan/memory-mechanism.md` 残留引用
附录 C：测试与验收
附录 D：跨批次协作注意事项

---

## 0. 阅读指南

| 章节 | 读者 | 一句话 |
|:--|:--|:--|
| 1 | 所有人 | 边界：做什么、明确不做什么 |
| 2 | 实现者 | **先读**：现有代码事实与 3 条硬约束（决定后面所有取舍） |
| 3–5 | 实现者 | 存储 / 置信度 / 去重冲突（数据层，可独立验证） |
| 6 | 实现者 | 注入机制（最关键，kv-cache 与预算） |
| 7 | 实现者 | memory agent（触发、工具、prompt、审计、并发） |
| 8–9 | 实现者 + 用户 | 用户接口 / 配置 schema |
| 10 | 运维 | 心跳：systemd/cron + `chat --prompt` 精确语义 |
| 11 | 所有人 | 实施拆分（依赖顺序 + 验收标准 + 并行性） |
| 12 | 用户 | **需要拍板的 6 个问题（带推荐答案）** |
| 附录 A–D | 实现者 | reviewer 移除清单 / 残留引用 / 测试建议 / 跨批次注意 |

---

## 1. 目标与「不做什么」

### 1.1 目标

1. **跨会话记忆**：默认开启，让 master agent 在相关任务上自动获得用户偏好与工作习惯（个性化），无需用户重复交代。
2. **两层记忆**：全局（`~/.deepseek-arch/memory/`，跨项目个人偏好）+ 项目（`{workspace}/.deepseek-arch/memory/`，本项目约定）。**不做**用户个人偏好第三层（决策 1）。
3. **自动写入 + 告知**：由 memory agent 在每轮结束后归纳（信号 A–F，`plan/20260912Task.md:18-25`），**不需要用户确认**，但写入后必须给出**不打扰**的一行提示「已更新记忆」（决策 2）。
4. **无向量检索**：本地无 embedding 能力 → 结构化条目 + 关键词/标签/路径匹配 + 置信度 + LRU（决策 3）。
5. **低上下文占用**：默认注入 ≤10 条 / ≤800 tokens，可配置（决策 4）；记忆本体**不常驻**对话，按需注入 / 按需工具检索。
6. **可被 agent 检索**：记忆文件必须能被 `read_file` / `search_content` / 专用 `memory_search` 工具查到（见 §2.2 的两条硬约束与对策）。
7. **替换 censor/reviewer**：删除 YOLO 的 stalled/deflecting 自动续跑审查（`src/core/reviewer.ts`、`src/core/session.ts:987-1012`、`defaults.review_model`、`/review_model`），该“每轮多花一次模型调用”的预算由 memory agent 接管（决策 5）。完整改动点见附录 A。
8. **定时唤起**：外部 cron/systemd timer 调 `deepseek-arch chat --prompt`（主）+ TUI 内定时器（备），**不常驻 daemon**（决策 6、7）。

### 1.2 明确不做（本期）

| # | 不做 | 理由 |
|:--|:--|:--|
| 1 | 用户个人偏好第三层 | 决策 1（两层） |
| 2 | 向量/embedding 检索、外部向量库 | 决策 3（本地无能力、禁新依赖；`package.json` 无相关依赖） |
| 3 | 常驻 daemon / 后台进程常开 | 决策 7（心跳用一次性进程 + 进程内定时器） |
| 4 | 记忆写入的用户确认弹窗 | 决策 2（改为写入后提示） |
| 5 | 记忆自动改写 system prompt | 会破坏会话内 kv-cache 前缀与 `system-prompt.txt` 快照语义（`src/core/session.ts:152`、`src/core/storage.ts:158`） |
| 6 | 子代理注入记忆 / 子代理写记忆 | 避免重复计费与并发写冲突；master 需要时可把相关偏好写进 task 文本 |
| 7 | `/memory edit` 交互式编辑、记忆图形界面、`/memory import` 导入旧 md | 直接编辑 `memory.jsonl` 即可（人类可读）；旧笔记只提示路径，不自动解析 |
| 8 | 跨机器同步 / 云备份 / 加密记忆库 | 超出范围；仅目录 `0o700` + 文件 `0o600`（对齐 `src/core/storage.ts:51`、`src/core/config.ts:256`） |
| 9 | 记忆参与 compact 摘要生成（把记忆喂给摘要模型） | 摘要与记忆职责分离；compaction 只做**重注入**（§6.5-P5） |
| 10 | 保留 `review_verdict` 事件与新审查器 | 决策 5；`review_verdict` 事件类型一并下线（附录 A） |

---

## 2. 现状事实与硬约束（实施前必读）

### 2.1 目录与存储现状

| 事实 | 证据 |
|:--|:--|
| 全局配置目录 `~/.deepseek-arch`（`0o700`） | `src/core/config.ts:32`、`src/core/config.ts:256` |
| 全局目录实有内容：`config.toml / providers.toml / pricing.toml / system-prompt.toml / skill/ / sessions/ / plans/` | 现场 `ls -la ~/.deepseek-arch` |
| 会话落盘 `sessions/<id>/{meta.json, turn_<gen>.json, system-prompt.txt, cache.log, subagents/}` | `src/core/storage.ts:4-13`、`:56`、`:71`、`:488`、`:493`、`src/core/cache-log.ts:120` |
| JSON 写入统一 `mode 0o600`、`JSON.stringify(x, null, 2)` | `src/core/storage.ts:97-100` |
| 追加日志先例：`appendFile` + 单行可 grep + 失败不阻塞 | `src/core/cache-log.ts:113-132` |
| 原子写先例：`tmp file → rename`（同文件系统内原子） | `src/tools/write-file.ts:107-113` |
| 项目 runtime 目录**已存在**：`{workspace}/.deepseek-arch/memory/`（内含 2 个手工 md：`2026-08-06-context-fix-session.md`、`2026-08-07-subagent-reconnect.md`）、`{workspace}/.deepseek-arch/plans/windows-compat-interrupt-fix.md` | 现场 `ls -la .deepseek-arch/memory .deepseek-arch/plans` |
| 上述 3 个文件**当前处于 git 跟踪状态**（未被 `.gitignore` 忽略） | `git ls-files .deepseek-arch` 输出 3 行；`.gitignore:1-53` 无 `.deepseek-arch` 条目 |
| `compact.ts` 已预留 memory 路径排除 | `src/core/compact.ts:39-40`：`EXCLUDED_PREFIXES = ['.plans/', 'memory/', '.memory/']` |
| `src/core/workspace-paths.ts` **尚不存在**（`getRuntimeDir()`/`getMemoryDir()` 由另一批次实现） | 现场 `ls src/core/` 无该文件；全仓 grep `workspace-paths\|getMemoryDir\|getRuntimeDir` 无命中 |

### 2.2 三个「必须绕开」的硬约束（本设计的直接依据）

**约束 A：全局记忆层对 agent 的文件工具不可见。**
`checkPath` 强制路径必须落在 `sessionCwd` 内，越界报 `path outside workspace`（`src/tools/utils.ts:34-46`）；`read_file`（`src/tools/read-file.ts:61`）与 `search_content`（`src/tools/search-content.ts:137`）都走它。
→ 结论：`~/.deepseek-arch/memory/`（homedir 下）**永远无法**被 agent 用 `read_file`/`search_content` 读到。
→ 对策：全局层必须通过 **① harness 注入** 或 **② 专用记忆工具**（core 内直接用 `node:fs`，不走 `checkPath`）暴露。**这是「必须有 `memory_search` 工具」的硬依据**，不是可选优化。

**约束 B：`search_content` 不遍历隐藏目录。**
`collectFiles` 目录分支有 `if (base.startsWith('.')) continue;`（`src/tools/search-content.ts:63`；`SKIP_DIRS` 另见 `src/tools/utils.ts:16-26`）。
→ 结论：从 workspace 根 `search_content(pattern)` **搜不到** `.deepseek-arch/memory/` 里的任何内容；只有显式传 `path: ".deepseek-arch/memory"` 才命中（此时遍历的是该目录**内部**文件，文件名不以 `.` 开头，不被跳过）。
→ 对策：注入块与 system prompt 里**写明显式可检索路径**（§6.4 的 `/memory path`、§8.1），并在 `memory_search` 工具描述里说明。

**约束 C：`ResolvedConfig` 合并是白名单，新增顶层段会被静默丢弃。**
`load()` 组装 `this.resolved` 时逐字段列举：`{ paths, defaults, providers, pricing, systemPrompts, display }`（`src/core/config.ts:362-369`）；`AppConfig` 类型只有 `paths/defaults/display`（`src/types/config.ts:94-99`）；`set()` 的 `fileMap` 只认 `paths|defaults|providers|pricing|systemPrompts`，其余抛「不支持的配置段」（`src/core/config.ts:490-501`）。
→ 结论：新增 `[memory]`/`[heartbeat]` **必须同时改 5 处**，否则「配置写了但读不到」或「`/memory off` 写不回」（§9.3 给精确清单）。

### 2.3 注入相关的现有机制（设计要复用的先例）

| 先例 | 位置 | 可复用点 |
|:--|:--|:--|
| 临时状态块拼在请求**末尾**、**不写入** `agentMessages`（保前缀稳定） | `src/core/session.ts:608`（注释）、`:886-890`（组装） | 记忆注入块的插入方式与「不落盘」策略 |
| 请求组装公式 | `src/core/session.ts:888-890`：`roundMessages = [...baseMessages, ...agentMessages, statusBlock?]`；`baseMessages` 末元素 = 当前用户消息（`:1532`） | 记忆块插入位置 = `baseMessages.length - 1` 之前（§6.5-P2） |
| 预算化 listing 注入 system prompt | `src/cli/index.ts:107-121`（`<skill_listing>`）、`src/core/skill.ts:507-546`（`buildSkillListing`，预算常量 `:78`） | 注入块的「预算截断 / 超预算降级」写法 |
| compact 重注入块 4 件套 | `src/core/compact.ts:360-379`（`buildCompactMessages`）、`src/core/session.ts:325-333`（读取 + 组装） | 第 5 类重注入块 `[Compact Memory]` 的挂载点 |
| 长上下文预算常量 | `src/core/compact.ts:25-37`（`MAX_RESTORE_FILES`、`POST_COMPACT_TOKEN_BUDGET=50000`、`SKILL_MAX_TOKENS=5000`、`SKILLS_TOKEN_BUDGET=25000`、`PLAN_MAX_TOKENS=5000`） | 记忆预算常量风格一致（`max_inject_tokens=800`） |
| token 估算/截断 | `src/core/compact.ts:66-76`（`estimateTokens`=utf8Bytes/3、`truncateTokens`） | 注入预算统一使用同一估算器 |
| 子代理循环引擎（可复用为 memory agent 引擎） | `src/core/subagent.ts:43`；**无轮次上限**：`:40` 注释、`:69` 死循环；取消标记 `:24`；abort 路径 `:70/:119/:167` | 引擎复用 + 必须外挂 watchdog（§7.6） |
| 异步后台任务与主 agent 解耦（独立 AbortController） | `src/core/session.ts:356-357`（I-1 注释）、`src/core/subagent-session.ts:61` | memory agent 不随主 agent 中断而死 |
| 完成事件推送 | `src/core/session.ts:1365`（`onEvent({type:'done'})`）、`src/presentation/tui-app.ts:1901`（TUI 消费） | memory agent 的触发锚点（TUI + headless 共用） |
| TUI 定时器先例 + 清理 | `src/presentation/tui-app.ts:109`（字段）、`:1466`（`setInterval` 400ms）、`:1490`、`:1636`（`clearInterval`） | 心跳定时器的资源管理写法 |
| TUI 命令写回配置先例 | `src/presentation/tui-app.ts:913-926`（`/async` → `configMgr.set('defaults.async', ...)`） | `/memory off` 写回 `memory.enabled` |
| 命令清单两处需同步 | `src/presentation/tui-app.ts:64`（`AVAILABLE_COMMANDS`）、`:792-806`（`/help` 表） | 新增 `/memory*` |
| 多进程写入先例（无锁、追加） | `src/core/cache-log.ts:113-132`（TUI/子代理/多会话并发写同一路径） | JSONL 追加可接受性的先例 |
| 工具白名单过滤先例 | `src/cli/index.ts:32-39`（`loadMasterTools` 过滤调试工具） | `chat --prompt` 的受限工具集（§10.4） |
| 非流式单轮 API **不含 agent loop** | `src/core/session.ts:496-552`（只调用一次 `provider.chat`） | `--prompt` 必须用 `sendMessageStream`（`:565`），不能用 `sendMessage` |
| 工具确认判据 | `src/core/session.ts:1114`：`(requiresConfirm \|\| dynamicConfirm) && onConfirm` 才询问 | `--prompt` 的「默认拒绝 / 默认自动批」开关落点（§10.4） |

### 2.4 已定决策对照（确认本稿无相反方案）

| 决策 | 本稿落点 |
|:--|:--|
| 1. 两层（全局 + 项目） | §3.1（路径）、§6.3（作用域加权）、§12-Q2（层间冲突） |
| 2. 写入免确认 + 必提示 | §7.9、§8.2、§8.3 |
| 3. 禁向量检索 | §5（去重）、§6.3（关键词/标签/路径 + 置信度 + LRU 公式） |
| 4. ≤10 条 / ≤800 tokens 可配置 | §6.3、§9.1（`max_inject_entries`/`max_inject_tokens`） |
| 5. 移除 reviewer | 附录 A（含 `defaults.review_model`、`/review_model`） |
| 6. 每轮触发，两种时序二选一 | §7.2（**选 (b)** 轮结束后异步） |
| 7. 心跳 = cron/systemd 主 + TUI 定时器备，无常驻 daemon | §10.1–§10.2、§10.6 |
| 8. `chat --prompt` 语义 | §10.3–§10.5 |
| 9. 项目层 `{workspace}/.deepseek-arch/memory/` | §3.1（与 `workspace-paths.ts` 对接） |

---

## 3. 存储结构

### 3.1 两层路径（确切）

```
# 全局层（个人跨项目偏好；配置目录相对路径 [paths].memory，默认 "./memory"）
~/.deepseek-arch/memory/
├── memory.jsonl           # 唯一事实源（追加日志，见 §3.3）
├── memory.archive.jsonl   # 折叠归档（status != active 的历史行）
├── audit.jsonl            # 审计日志（inject / write / agent_run / error / parse_error）
└── .lock/                 # 折叠互斥锁（目录形态，mkdir 原子；含 owner.json）

# 项目层（当前 workspace；路径由 workspace-paths.ts 的 getMemoryDir() 提供）
{workspace}/.deepseek-arch/memory/
├── memory.jsonl
├── memory.archive.jsonl
├── audit.jsonl
└── .lock/
```

- 全局层目录名可配置（`[paths].memory`，默认 `./memory`，与 `[paths].sessions` 同风格：`src/core/config.ts:44`、`src/types/config.ts:37-43`）；项目层路径固定由 `getMemoryDir()` 返回（决策 9）。
- **旧内容处置（迁移）**：现存 2 个手工 md 属「自由笔记」，与结构化解耦：
  - 不自动导入（内容不可靠映射到 `confidence/subject`）；
  - 保留原名共存（`*.md` 不参与折叠与检索，`memory.jsonl` 是唯一事实源）；
  - `/memory show` 末尾提示：`2 个 legacy 笔记未纳入记忆库：.deepseek-arch/memory/*.md`；
  - 结构化解所在文件固定为 `memory.jsonl`，**绝不复用** `*.md`。
- **编码/大小**：UTF-8 无 BOM；每条记录**单行 ≤ 4 KiB**（强制 `text ≤ 1000` 字符），确保 POSIX `O_APPEND` 单次写原子性（§3.6）。

### 3.2 文件格式取舍

| 方案 | 优点 | 缺点（决定性） |
|:--|:--|:--|
| **A. 单个 JSON 数组文件** | 结构天然、读一次即全量、字段无歧义 | ① 多进程（TUI + cron `--prompt` + memory agent）同时写 = 读-改-写，后写覆盖前写，**丢更新**；② 每次 `hits+1` 都要重写全文件；③ `search_content` 命中后返回的是整段 JSON 上下文，噪音大（违背「低上下文、好检索」） |
| **B. Markdown（每主题一文件，如现状 `.md`）** | 人读/git diff 友好、`search_content` 命中精准 | ① 结构化字段（confidence/hits/lastUsedAt/status）只能塞 frontmatter，更新一个计数 = 重写整个文件，同样丢更新；② 需要另建索引才能做 score 排序；③ 并发编辑极易冲突 |
| **C. JSONL 追加日志（选定）** | ① 追加即写，**无读-改-写** → 多进程天然安全（先例 `src/core/cache-log.ts:128`）；② 一条记录 = 一行 → `search_content` 命中一行即一条记忆，**上下文占用最小**；③ `grep`/`tail -f`/`jq` 全可用；④ 崩溃只损失最后一行（解析时跳过）；⑤ 折叠（fold）成本与「条数」而非「写入次数」相关 | ① 需要折叠逻辑（§3.5 给步骤）；② 单行长度受限（`text ≤1000` 字符约束解决）；③ 需要 `rev` 变化检测（`size+mtime` 哈希，§6.6） |

**结论：选 C（JSONL 追加日志 + 定期折叠）**，文件名 `memory.jsonl`（全局/项目各一份）；审计独立文件 `audit.jsonl` 以免污染检索结果。

### 3.3 append-only 语义（更新/删除/计数如何表达）

- **新增**：追加一条完整记录行（`op` 缺省为 `put`，语义「以最新行覆盖同 `id`」）。
- **更新**：追加同 `id` 的完整新记录（`updatedAt` 变新）→ 折叠时后写胜（LWW：`updatedAt` 最大者；相等取文件中靠后者）。
- **删除**：追加墓碑行 `{"op":"delete","id":"memo_xxx","at":"ISO","reason":"..."}` → 折叠时移除并归档。
- **LRU 命中计数**：追加**轻量 touch 行**，不做读-改-写：

```json
{"op":"touch","id":"memo_7f3a1b2c","at":"2026-09-12T09:00:00.000Z","sid":"0e94bdd5","turn":42}
```

折叠时：`hits = put.hits + distinct(sid,turn) 且 touch.at > put.updatedAt 的计数`；`lastUsedAt = max(put.lastUsedAt, max(touch.at))`。`(sid,turn)` 去重保证同一轮重复注入不重复计数。

⇒ **没有任何写路径需要读文件**，多进程并发写只依赖 `O_APPEND` 原子性 + 单行 ≤4 KiB。

### 3.4 字段定义（可直接照写）

`memory.jsonl` 每行一个 JSON 对象：

```jsonc
{
  "v": 1,                                  // schema 版本（必填）
  "op": "put",                             // "put" | "touch" | "delete"（put 可省略）
  "id": "memo_7f3a1b2c",                   // 必填，memo_ + 8 hex（crypto.randomBytes(4)）
  "scope": "project",                      // 必填，"global" | "project"
  "text": "提交信息用中文单行，不加 emoji",   // 必填，≤1000 字符，规范化后不得为空
  "subject": "git.commit_message",          // 必填，冲突判定键（点分命名空间，见 §5.3）
  "tags": ["git", "commit", "style"],       // 必填，1..6 个，小写，[a-z0-9_-]
  "paths": ["src/**"],                      // 可选，路径相关性 glob（gitignore 风格）
  "confidence": 3,                          // 必填，1|2|3（§4.1）
  "signal": "A",                            // 必填，A|B|C|D|E|F（plan/20260912Task.md:18-25）
  "hits": 7,                                // 折叠派生：被注入次数
  "createdAt": "2026-08-01T10:00:00.000Z",  // 必填，ISO UTC
  "updatedAt": "2026-09-10T09:12:00.000Z",  // 必填，ISO UTC（LWW 依据）
  "lastUsedAt": "2026-09-11T22:03:00.000Z", // 折叠派生：最后被注入时间（无则 = createdAt）
  "lastUsedTurn": 42,                       // 折叠派生：最后注入的轮次（可空）
  "source": {                               // 必填
    "kind": "memory_agent",                 // "user" | "master" | "memory_agent" | "manual"
    "sessionId": "0e94bdd5-349e-4520-a4ca-bf718b40d30f",
    "turn": 12,
    "model": "deepseek-v4-flash",           // 可选
    "runId": "mr_8f2c11"                    // 可选（memory agent 单次运行 id）
  },
  "status": "active",                       // 必填，"active" | "superseded" | "deprecated"
  "supersedes": ["memo_0a1b2c3d"],          // 可选：本条取代的旧条目 id
  "supersededBy": null,                     // 可选：被取代时填新 id
  "evolution": [                            // 可选：演化记录（§5.4）
    { "at": "2026-09-10T09:12:00.000Z", "from": "提交信息尽量详细", "to": "提交信息单行", "reason": "用户改为要求单行" }
  ],
  "evidence": ["以后提交信息都用中文"],      // 可选：原文片段，≤3 条、每条 ≤120 字符
  "remindAt": "2026-09-15T09:00:00.000Z",   // 可选：暂缓/到期提醒（信号 D）
  "pinned": false                           // 可选：true = 优先注入（仍占预算）
}
```

示例行（真实一行，写进文件时无缩进）：

```json
{"v":1,"op":"put","id":"memo_7f3a1b2c","scope":"project","text":"提交信息用中文单行，不加 emoji","subject":"git.commit_message","tags":["git","commit","style"],"paths":["src/**","docs/**"],"confidence":3,"signal":"A","hits":7,"createdAt":"2026-08-01T10:00:00.000Z","updatedAt":"2026-09-10T09:12:00.000Z","lastUsedAt":"2026-09-11T22:03:00.000Z","lastUsedTurn":42,"source":{"kind":"memory_agent","sessionId":"0e94bdd5","turn":12},"status":"active","supersedes":["memo_0a1b2c3d"],"evolution":[],"evidence":["以后提交信息都用中文"],"pinned":false}
```

- **`memory.archive.jsonl`**：同字段 + `"archivedAt"` + `"archiveReason": "superseded"|"deprecated"|"deleted"|"capacity"`。
- **`audit.jsonl`**：每行一个事件，`kind` 区分（示例见 §7.7）。
- **忽略规则**：折叠/读取**只读 `memory.jsonl`**；`*.archive.jsonl`、`audit.jsonl`、`*.md`、`.lock/` 一律不参与。
- **崩溃保护**：不可解析行跳过并追加 `{"kind":"parse_error",...}` 审计；连续 ≥5 行不可解析 → 中止折叠并写 `error` 审计（不删文件，人工介入）。

### 3.5 折叠（fold / compaction）算法

触发条件（任一）：`行数 > 2 × liveEntries + 50` 或 `文件字节 > 512 KiB`。

步骤：

1. 取锁：`mkdir(<scopeDir>/.lock)`；失败（`EEXIST`）→ 读 `.lock/owner.json`（`pid/startedAt`），`startedAt` 超 30 s 视为陈旧 → 删除后重试一次；仍失败 → **跳过本次折叠**（不影响读写，写仍走追加）。
2. 读取 `memory.jsonl` 全部行 → 按 `id` 归并（§3.3 规则）→ 得 `live[]`。
3. 容量与淘汰（§4.4）→ 被淘汰者移入归档。
4. 写临时文件 `memory.jsonl.tmp.<pid>`（`0o600`）→ `rename` 覆盖（同目录同文件系统，先例 `src/tools/write-file.ts:107-113`）。
5. 归档：`memory.archive.jsonl` 追加本次归档行（不重写）。
6. 释放锁（删除 `.lock` 目录）。
7. 追加审计 `{"kind":"fold","before":N,"after":M,"archived":K,"elapsedMs":T}`。
8. 任一步失败 → 追加 `{"kind":"error","where":"fold",...}`；**保留原文件**（追加日志永远是事实源，折叠只是压缩）。

### 3.6 并发写入策略（多进程 / 多会话）

| 场景 | 机制 |
|:--|:--|
| 追加写入（put/touch/delete） | `appendFile` 单次写一行的完整 buffer（先例 `src/core/cache-log.ts:128`）。POSIX 本地文件系统下 <4 KiB 的 `O_APPEND` 写是原子的 → **硬约束：单行 ≤ 4000 字节**（`text≤1000` 字符 + `evidence≤3×120` + 其它字段余量充足；写入前 `JSON.stringify` 后测长，超长先截 `evidence` 再截 `text`） |
| 读 | 全文件读 + fold（≤512 KiB → 单次读量级 ms）；读**不加锁**（追加日志读到的快照总是自洽前缀） |
| 折叠（重写整文件） | 目录锁：`mkdir` 成功 = 持锁（原子，`EEXIST` 即失败）；锁内写 `owner.json`；stale 30 s 强清（含二次确认 mtime 未变，防误删活锁）；`finally` 删除 `.lock`。拿不到锁 → 本次跳过折叠，写入不受影响 |
| 冲突语义 | **last-write-wins per id**：`updatedAt` 大者胜；同 `updatedAt` 文件靠后者胜（确定性） |
| 同一 id 被两进程同时新增不同内容 | 不会发生（`id` 由创建者随机生成）；同 `subject` 的并发合并由各自「读→判重→写」完成，允许**罕见重复条目**，由下一轮 memory agent 的 H/I 职责合并（§5.2） |
| 跨进程变更感知 | `getRev(scope) = sha1(size + ':' + floor(mtimeMs/1000))`，只 `stat` 不读全文（O(1)）；折叠改 mtime → 只导致一次**多余** delta 检查，delta 前置内容比较（§6.6-I4）会抑制无实质变化的注入 |

**为什么不用 flock 做写入**：写路径必须**永不失败**（记忆写入不能阻塞对话），追加是最简单可靠的原语；锁只用于「可以失败」的折叠路径。

### 3.7 容量上限与清理

| 项 | 默认 | 可配 | 超限行为 |
|:--|:--|:--|:--|
| 单层 `active` 条目数 | 500 | `max_active_entries` | 按无查询基线 `score0`（§4.4）升序淘汰至 500，标 `deprecated` 并归档 |
| 单文件字节 | 512 KiB | `max_file_bytes` | 触发折叠 |
| 单条 `text` | 1000 字符 | `max_text_chars` | 写入时截断（工具返回 `Warning: truncated`） |
| `evidence` / `tags` / `paths` / `evolution` | 3×120 字符 / 6 / 4 / 5 | 固定 | 截断丢弃最旧 |
| `audit.jsonl` | 1 MiB | `audit_max_bytes` | 轮转为 `audit-<yyyyMMddHHmmss>.jsonl`，保留最近 5 个 |
| `remindAt` 过期 | 180 天内有效 | `remind_grace_days` | 过期未处理 → 降级为普通条目（清空 `remindAt`）+ 审计 |

---

## 4. 置信度分级、衰减与淘汰

### 4.1 等级定义（对齐需求信号 A–F）

| 等级 | 含义 | 初始来源信号 | 判定标准（写实现时照抄） |
|:--|:--|:--|:--|
| **3 高** | 用户显式、可直接执行 | A 显式偏好陈述 / D 范围边界 / E 显式放弃 | 原话含「我希望/我喜欢/不要/以后/应该」或「X 先不动」或「放弃…」（`plan/20260912Task.md:20,23,24`） |
| **2 中** | 用户已确认或纠正 | B 否决/纠正 / C 决策确认 | 否定了 agent 做法并给替代方案；或「开始/按你说的做」后进入执行（`plan/20260912Task.md:21,22`） |
| **1 低** | 隐式、需累计 | F 重复模式 | 同类偏好第 1 次出现只打标；第 2 次同 `subject` 命中 → 升级为 2（`plan/20260912Task.md:25`） |

### 4.2 升级 / 降级规则

| 事件 | 规则 |
|:--|:--|
| 同 `subject` 重复观察（新 `text` 与旧条 `sim ≥ 0.72`，§5.2 判重） | `confidence = min(3, confidence + 1)`；`hits` 保留；`evidence` 追加原文（≤3） |
| 信号 F 累计达 2 次 | `confidence = max(2, ...)`（F 只能升到 2，永远不能只靠隐式到 3） |
| 显式条(3) 与旧条冲突（§5.3 判为矛盾） | 新条 `confidence = 3` 并取代旧条；旧条 `confidence = max(1, old-1)` 且 `status='superseded'` |
| 中性条(2) 与旧条(3) 冲突 | 新条 `confidence = 2` 且**不取代**旧条，改为两列并存 + 写 `evolution`，等下一次用户表态（避免中等强度推翻显式） |
| 用户否决已有记忆（「不，不要这样」） | 命中条目 `confidence = max(1, c-1)`；若 `c == 1` → `status='deprecated'` |
| 被 `superseded` 后用户又回到旧行为 | 旧条 `status='active'`、`confidence = min(3, 旧值+1)`、追加 `evolution`（「回归」），新条降级 |

### 4.3 衰减（只影响「有效值」，不落盘）

读取与排序使用**有效置信度**（避免每次注入都写盘）：

```
effectiveConfidence(e, now) = e.confidence × 0.5 ^ (Δdays(e.updatedAt, now) / HALF_LIFE_DAYS)
HALF_LIFE_DAYS = 180            // 可配 memory.decay_half_life_days
```

- 有效值 < 1.0 的条目**不再参与注入**（仍保留在库中，供 `/memory show`）。
- 时效项（§6.3）另有独立半衰期（`recency` 45 天、`usage` 14 天），二者不混用：180 天衡量「证据是否还成立」，45 天衡量「最近是否被提及」。
- 落盘式衰减只在折叠（§3.5）与每日首次运行时发生一次：`confidence = max(1, round(effectiveConfidence))`，并追加审计。

### 4.4 LRU 淘汰与删除阈值

无查询基线分（用于容量逐出与纯 LRU 判断）：

```
score0(e) = 0.5 × confNorm + 0.3 × recency + 0.2 × usage
            （三项定义同 §6.3；pinned 与「confidence=3 且 hits≥5」受保护不参与逐出）
```

| 条件 | 动作 |
|:--|:--|
| `hits == 0` 且 `age(createdAt) > 120 天` 且 `confidence ≤ 2` | `status='deprecated'`（归档） |
| `hits > 0` 但 `age(lastUsedAt) > 240 天` 且 `effectiveConfidence < 1.0` | `status='deprecated'` |
| `superseded` 且 `age(updatedAt) > 365 天` | 删除行（归档 `archiveReason='superseded'`） |
| `deprecated` 且 `age > 180 天` | 删除行（归档） |
| 单层超 `max_active_entries` | 按 `score0` 升序淘汰（保护项除外） |
| 显式删除（`/memory forget` / 工具 `op=delete`） | 立即墓碑，不受上述阈值约束；`confidence=3` 的条目**只能**由 `source.kind ∈ {user, manual}` 或 TUI 命令删除（memory agent 无权，§7.6） |

---

## 5. 去重与冲突调和（无 embedding 的可行近似）

### 5.1 规范化（Normalize）

```
norm(s) =
  s.trim()
   .replace(/\s+/g, ' ')                                    // 折叠空白
   .replace(/[，。；：、！？“”‘’（）【】《》,.;:!?"'()\[\]{}]/g, '')  // 中英标点
   .replace(/^(我希望|我喜欢|请|以后|应该|不要|别)/, '')      // 前缀语气词（保留语义核）
   .toLowerCase()

tokenSet(s) =
   ASCII 词（/[a-z0-9_+#.-]{2,}/g）
 ∪ CJK 二元组（连续 CJK 串的 bigram；长度 1 的 CJK 串取自身）
   （不用分词库：中文 2-gram 已足够做相似度）
```

### 5.2 相似度与判重阈值

```
sim(a, b) = 0.60 × Jaccard(tokenSet(norm(a.text)), tokenSet(norm(b.text)))
          + 0.25 × Jaccard(a.tags, b.tags)
          + 0.15 × (norm(a.text) === norm(b.text) ? 1
                   : norm(a.text).slice(0,24) === norm(b.text).slice(0,24) ? 1 : 0)
```

| `sim` | 判定 | 动作 |
|:--|:--|:--|
| 1.0（规范化文本完全相同） | 重复 | 直接合并 |
| ≥ 0.72 | 近重复 | 合并 |
| 0.45 – 0.72 | 疑似（同 `subject` 或 tag 交集非空时） | 交 memory agent 判「重复 / 矛盾 / 独立」（§5.3） |
| < 0.45 | 独立 | 新增条目 |

阈值 **0.72** 的取值理由：中文偏好句通常是「动宾 + 宾语」结构，bigram Jaccard 对「同一偏好换措辞」落在 0.6–0.85，对「不同偏好同主题」落在 0.2–0.45。0.72 能把「提交信息用中文」与「提交信息用中文单行」（≈0.78）合并，而不会误并「提交信息用中文」与「分支命名用 kebab-case」（≈0.15）。阈值写成配置（`dedup_merge_threshold` / `dedup_review_threshold`），上线后按审计里的 `sim` 分布调参。

**合并规则（保留哪个 id）**：

1. 保留 `confidence` 更高者的 `id`；相同则保留 `createdAt` 更早者的 `id`（用户已记住的 id 更稳定）。
2. `text`：取更具体的一条（字符数更长且包含旧文语义核）；被替换的文本进 `evolution`。
3. `tags`：并集，按「两集合都有 > 新条 > 旧条」排序取前 6；`paths` 并集取前 4。
4. `confidence = min(3, max(旧, 新) + (两者 signal 不同源 ? 1 : 0))`（避免同源重复升级）。
5. `hits`：折叠派生（touch 计数），不必手工相加。
6. `evidence`：并集取最近 3 条；`remindAt`：取更晚者。
7. 追加审计 `{"kind":"write","op":"merge","kept":id,"absorbed":id2,"sim":0.78}`。

### 5.3 冲突判定与 `subject` 键

`subject` 是「同一话题」的稳定键，由 memory agent 生成，必须来自**受控词表**（限制发散）：

```
git.commit_message | git.branch_naming | code.comment_language | code.style
reply.format | reply.length | reply.language | workflow.tooling
plan.granularity | test.strategy | scope.deferred | proposal.rejected | other.<free>
```

判定为**矛盾**的充分条件（memory agent 判 + 后处理兜底）：

1. 同 `subject`（或 tag 交集 ≥2）；且
2. 一方主张「要 X」，另一方主张「不要 X / 改成 Y」（LLM 判定，输出字段 `contradicts`，见 §7.4）；且
3. 两条 `norm(text)` 的 bigram Jaccard ≥ 0.30（避免「同 subject 讲不同侧面」被误判）。

处理：按 §4.2 的冲突行决定「取代 / 并存」。**层间冲突（global vs project）**：同 `subject` 时**项目层优先**（更具体），全局条目**不删除不降级**，仅在注入视图里屏蔽（§12-Q2）。

### 5.4 演化记录（Evolution）

取代时写进新条（旧条只保留 `supersededBy`）：

```json
{
  "id": "memo_9c8d7e6f",
  "text": "回答默认先给结论再给理由",
  "subject": "reply.format",
  "confidence": 3,
  "signal": "B",
  "supersedes": ["memo_1a2b3c4d"],
  "evolution": [
    { "at": "2026-07-01T08:00:00.000Z", "from": "回答要详细推导", "to": "回答先给结论", "reason": "用户否决了长推导" }
  ]
}
```

`/memory show <id>` 展示最近一条 `evolution`；注入块默认不展示（省 token）。

---

## 6. 注入机制（最关键）

### 6.1 三种候选时机的对比

> ⚠️ **本节结论已被 §12 R11 作废（2026-09-13）**：用户决定**禁止临时 user 消息**注入形态，
> 记忆注入统一走 **system prompt**（重装点 = 新会话 / compact / `/memory refresh`）。
> 下表保留作历史对比与代价量化方法，**不要再按 T2 实施**。

| 时机 | 实现位置 | 优点 | 缺点 | 结论 |
|:--|:--|:--|:--|:--|
| **T1 会话首轮注入（持久消息）** | `sendMessageStream` 首轮把块拼进 `agentMessages` | 只花一次 token；后续轮 / `resume` 都在前缀里 | ① 写进 `turn.messages`（`src/core/session.ts:1297`）会**污染用户消息回放/TUI 显示/compact 序列化**（`turnUserContent`，`src/core/compact.ts:319`）；② 记忆变化后整条前缀失效 → 全量 cache miss | 否决「持久化进 turns」形态 |
| **T2 每轮临时块（不落盘）** | `baseMessages` 内当前用户消息**之前**插入（组装点 `src/core/session.ts:886-890`） | ① 会话内位置固定 → 第 2 轮起该块本身也在缓存前缀内；② 不污染磁盘与 UI；③ 与 `buildStatusBlock` 同款先例（`src/core/session.ts:608`）；④ 记忆变化可即时生效 | 不落盘 ⇒ `resume` 后历史里没有旧记忆块（但 resume 首轮会重新注入，见 §6.2） | **采纳** |
| **T3 仅 compact 后注入** | `buildCompactMessages`（`src/core/compact.ts:360-379`）新增第 5 块 | compact 本身就是新前缀，代价最低 | 只在 compact 时生效；小会话（不 compact）永远无记忆 | 作为 T2 的**补充**，不单独使用 |

### 6.2 最终注入策略（三个触发条件，合成一个 `MemoryBlock`）

1. **进程激活首轮**（新会话首轮 / `resume` 后首轮 / `chat --prompt` 单轮）→ 注入 `mode="full"`（top-K）。
2. **记忆版本变化**（`rev` 变化且内容确有差异，§6.6-I4）→ 下一轮注入 `mode="delta"`（只含变化条目，预算 ≤ `delta_inject_tokens=200`）。
3. **compact 之后**（`compactContext`，`src/core/session.ts:302`）→ 下一轮重新注入 `mode="full"`（compact 前的前缀被摘要替换，块已不在上下文里）。

互斥优先：同一轮内若 (3) 成立则按 full 注入并清空 pending delta；(1) 优先于 (2)。`memory.inject_mode = "every-turn"` 时每轮都按 full 注入（不推荐，成本见 §6.6）。

### 6.3 选择算法（精确公式）

输入（每轮计算一次，纯函数）：

- `taskText`：当前用户消息 + 最近 `agent_max_input_turns=3` 轮用户消息（用 `turnUserContent`，`src/utils/turn-utils.ts`），拼成一个字符串，截断 2000 字符；
- `touchedPaths`：上一轮 `read_file|write_file|edit_file|search_content` 调用的 `path`/`glob` 参数（复用 `normalizePath` 思路，`src/core/compact.ts:79-84`）；
- `workspacePath`：`process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd()`（`src/core/session.ts:126-128`）；
- 视图：项目层 + 全局层合并（同 `subject` 时项目层屏蔽全局层）。

**硬过滤**（先做，不进打分）：

```
status === 'active'
且 effectiveConfidence ≥ 1.0            // §4.3
且 (remindAt 为空 或 now ≥ remindAt)     // 未到期提醒不注入；到期提醒走 §6.4 的 <memory-due>
```

**打分**（权重和为 1）：

```
rel  = 0.60 × kw + 0.25 × pathHit + 0.15 × tagHit
  kw      = |K(taskText) ∩ K(text)| / max(1, |K(text)|)      // K = tokenSet（§5.1）
  pathHit = 1 若 e.paths 中任一 glob 命中 touchedPaths 或 workspacePath 前缀，否则 0
            （e.paths 为空 → 0，不做惩罚项，避免无路径条目被系统性压低）
  tagHit  = |tags(e) ∩ tags(taskText)| / max(1, |tags(e)|)
            tags(taskText) 由固定小词表映射（≤30 项），示例：
            提交/commit/git → vcs；注释/命名/风格 → style；测试 → test；
            计划/plan → plan；命令/壳 → shell；浏览器 → browser；记忆 → memory

confNorm = (confidence - 1) / 2
recency  = 0.5 ^ (Δdays(updatedAt, now) / 45)
usage    = 0.5 ^ (Δdays(lastUsedAt, now) / 14)      // 从未注入 → 0.5（中性，不惩罚新条）

score = 0.45 × rel + 0.25 × confNorm + 0.15 × recency + 0.15 × usage
score = score × (scope === 'project' ? 1.15 : 1.00)   // 项目层更具体
score = score + (pinned ? 0.05 : 0)                   // pinned 温和抬升，不硬保证
score = score + (remindAt 已到期 ? 1.0 : 0)           // 到期提醒置顶
```

权重理由：`rel` 权重最高（0.45），因为「不相关的高置信度偏好」注入即噪音；`confNorm` 0.25 次之（用户明说的比推断的重要）；`recency` / `usage` 各 0.15 只做微调。所有权重与阈值进配置（§9.1），便于按审计数据调参。

**选取与截断**：

```
candidates = hits.filter(score ≥ score_floor(0.35))          // 硬地板：宁缺毋滥
order      = pinned 优先 → score 降序 → confidence 降序 → lastUsedAt 降序 → id 升序
take while (count < max_inject_entries(10))
            且 (tokens_so_far + tokens(entry) + blockOverhead(≈40) ≤ max_inject_tokens(800))
  其中 tokens(entry) = estimateTokens(渲染行文本)（src/core/compact.ts:66）
超预算截断顺序：先丢 score 最低的非 pinned 条目 → 再丢 pinned 中 score 最低者
最后兜底：若一条都放不下 → 只保留单条最优条目的前 200 字符（truncateTokens，src/core/compact.ts:71）
```

**输出字节稳定性（kv-cache 关键）**：选中集合确定后，**渲染顺序按 `id` 升序**，行内只含 `text/subject/tags/confidence/id`（**不含** `hits/lastUsedAt/updatedAt` 等易变字段）。这样「同一集合 → 同一字节」，只有集合变化才改前缀字节。

### 6.4 注入格式（Markdown 块，完整示例）

full 形态：

```
<memory scope="project+global" rev="f3a19c" mode="full" count="4">
偏好（按 id 排序，视为用户的既有约定，无需复述、不要与之冲突）：
- [memo_1a2b3c4d | conf=3 | #git #commit #style] 提交信息用中文单行，不加 emoji
- [memo_7f3a1b2c | conf=3 | #reply #format] 回答默认先给结论，再给理由
- [memo_5d4c3b2a | conf=2 | #code #comment #style] 代码注释用中文
- [memo_9e8f7a6b | conf=2 | #scope #deferred] 磁盘写入策略优化暂缓，等主体功能稳定后再做
用法：检索扩展用 memory_search；更新用 memory_write（无需用户确认，但用户可见）。
</memory>
```

delta 形态（≤200 tokens，只列变化）：

```
<memory scope="project" rev="9b8c7d" mode="delta" count="1">
记忆更新（自上次注入后变化）：
+ [memo_3c2b1a09 | conf=3 | #reply #format] 回答默认先给结论，再给理由（取代 memo_1a2b3c4d）
</memory>
```

到期提醒形态（**只在心跳/`--prompt` 轮**出现，普通 TUI 轮不注入，避免打断用户）：

```
<memory-due count="1">
到期提醒：
- [memo_4b5c6d7e | remindAt=2026-09-15T09:00:00.000Z] 磁盘写入策略优化——用户当时说"先不动"，可询问是否恢复推进
</memory-due>
```

格式约定：`[id | conf=N | #tag ...]`；`rev` 变化即代表集合变化；条目行按 `id` 升序；不写 `hits`/时间戳；首行 `mode` 标明 full/delta。

### 6.5 注入位置（对比与选择）

> ⚠️ **本节结论已被 §12 R11/R12 作废（2026-09-13）**：
> - 概览 → **system prompt**（`<memory_listing>` 段，重装点 = 新会话 / compact / `/memory refresh`）；
> - 会话内变化与动态召回 → **合并进当前 user 消息**的 `<system-reminder>`（不新开 user 消息）；
> - 下表 P2/P3/P5 **全部作废**，仅保留 P1/P4 的否决理由与对比思路。

| 候选位置 | 说明 | 结论 |
|:--|:--|:--|
| **P1 system prompt**（追加 `<memory_listing>`，像 skill listing `src/cli/index.ts:113-120`） | ① system prompt 被写入 `system-prompt.txt` 并在 `resume` 时**原样恢复**（`src/core/session.ts:152`、`:166-168`、`src/core/storage.ts:158`）→ 记忆会「冻结在会话创建时刻」；② 任何变化都让**整个会话前缀**失效（1M 上下文重算），代价最高；③ 偏好会被模型当硬约束 | **否决** |
| **P2 当前用户消息之前的临时 user 消息**（插入 `baseMessages.length-1`，不落盘） | 位置在 agent loop 内固定 → 第 2 轮起该块进缓存前缀；语义像「系统补充说明」；不污染磁盘/UI；与状态块同款先例（`src/core/session.ts:608`） | **采纳** |
| **P3 当前用户消息之后**（追加到 `roundMessages` 末尾） | 与状态块位置相同，可行；但块随 `agentMessages` 后移 → 每个 agent-loop 轮都是末尾 cache-miss | 次选（状态块已占尾部，避免两个尾部块互相挤动） |
| **P4 拼进用户消息正文前缀** | 会写进 `turn.messages[0].content` → TUI 回放（`turnUserContent`）、compact 序列化（`src/core/compact.ts:319`）都会带上记忆文本，污染且反复计费 | **否决** |
| **P5 compact 摘要块之后**（`buildCompactMessages`，`src/core/compact.ts:360-379`） | 作为 T2 的补充：compact 生成新前缀，此块天然属于新前缀 | **采纳（第 3 触发条件）** |

**最终位置**：

```
roundMessages = [ system,
                  ...历史轮 messages,                       // buildMessages(userContent)，末元素 = 当前用户消息（src/core/session.ts:1532）
                  <memory> 块,                              ← 注入点 = baseMessages.length - 1
                  当前 user 消息,
                  ...agentMessages,
                  statusBlock? ]                            // 既有子代理状态块（src/core/session.ts:886-890）
```

实现要点：`memoryBlock === null` 时拼接公式**退化为原式**，保证「无记忆 = 现状字节」（§6.6-I5）。

### 6.6 kv-cache 友好性（三条不变量 + 成本量化）

| 不变量 | 要求 | 依据/理由 |
|:--|:--|:--|
| **I1 记忆永不进 system prompt** | `<memory>` 只出现在 user 位置 | 否则 `resume` 恢复的旧 system prompt 与现行库冲突（`src/core/session.ts:166-168`） |
| **I2 记忆块不写入 `agentMessages` / 不写入 `turn.messages`** | 仅存在于当前进程的请求组装中 | 代码先例：状态块注释「不写 agentMessages——kv-cache 前缀稳定」（`src/core/session.ts:608`、`:886`） |
| **I3 同集合字节稳定** | 渲染按 `id` 升序；行内无计数/时间戳；`rev` 只在集合真变化时变 | 否则每轮文本微变即 cache miss |
| **I4 变化频率上限** | 同会话 `full` 注入 ≤1 次（首轮 / compact 后）；delta 每轮最多 1 次且**仅在集合差异非空时**发生 | 避免「每轮都变」退化为全 miss。`rev` 变化后需**读文件比对** `(id, updatedAt)` 集合，折叠导致的 `mtime` 变化不触发注入 |
| **I5 无记忆时不改变现有请求字节** | `memoryBlock === null` 时拼接退化为原式 | 保证「关闭记忆 = 现状」（回归测试断言） |

**成本量化**（用仓库现有价格表 `src/core/config.ts:103-118`，v4-pro：`input_cache_miss=6.0`、`input_cache_hit=0.2`、`output=20.0` CNY/1M）：

| 方案 | 每用户轮额外 input 成本 | 备注 |
|:--|:--|:--|
| **本设计**（800 tokens 块，位置在用户消息前） | 首轮：800 miss ≈ **¥0.0048**；后续 agent-loop 轮次该块已在缓存前缀内，仅新增内容 miss | 失效范围 = 块本身（一次） |
| 每轮尾部重复注入（P3） | 每 agent-loop 轮 800 miss → 10 轮 ≈ **¥0.048/用户轮** | 差 10 倍 |
| 放进 system prompt 且每轮刷新（P1） | 每次刷新导致整个前缀 miss（长会话可达 10 万 tokens）→ **¥0.6+/轮** | 不可接受 |

⇒ 结论：**记忆块 ≤800 tokens、注入 ≤1 次/会话 + delta 补丁，是「个性化」与「前缀稳定」的平衡点**；预算与阈值全部可配（§9.1）。

---

## 7. memory agent

### 7.1 职责（对齐需求 G–L）

| 触发点 | 本设计职责 | 实现要点 |
|:--|:--|:--|
| G 会话结束归纳 | 每用户轮结束后扫描最近 3 轮 → 提炼 1–3 条 | 只喂最近 N 轮（§7.8） |
| H 跨会话模式检测 | 新偏好与历史比对 → 重复提升置信度 | agent 主动 `memory_search`（同 `subject`/tag）；合并规则在 store 内（§5.2） |
| I 冲突调和 | 同 `subject` 矛盾 → 取代 + 演化记录 | 规则在 store 内实现（§5.3/§5.4），agent 只给判定 |
| J 相关性选择 | 注入 top-K | 由 harness 做（§6.3），agent **不参与**每轮注入（省 token、避免抖动） |
| K 时效管理 | `remindAt` 到期 → 提醒 | harness 侧 `listDue()` + 心跳注入 `<memory-due>`（§6.4）；TUI 侧底部提示（§10.6-4） |
| L 衰减清理 | 衰减/淘汰 | 折叠时批量执行（§4.3/§4.4），不依赖 agent |

### 7.2 触发时序：两种方案取舍 —— **选 (b)**

| 方案 | 时序 | 优点 | 缺点 |
|:--|:--|:--|:--|
| **(a) 用户消息发出后、master 该轮开始前** | `sendMessageStream` 入口 → 先跑 memory agent → 再跑 master | 本轮就能用上刚记忆的偏好 | ① **看不到 assistant 回复**，无法判定信号 B（否决需要「否定了 agent 做法」）与 C（确认后是否进入执行）——需求表 `plan/20260912Task.md:21-22` 明确依赖回复；② 给每轮增加**用户可感知的延迟**（一次额外 LLM 调用）；③ 与 master 争用同一 provider，且记忆更新会**改变本轮前缀**；④ 用户消息语义尚未落地时归纳，误判率高 |
| **(b) master 该轮结束后异步跑（选定）** | `done` 事件之后（`src/core/session.ts:1365`；TUI 消费点 `src/presentation/tui-app.ts:1901`） | ① 拿到完整「用户消息 + assistant 回复 + 工具轨迹」，B/C/D/E 判定准确；② 零用户可感延迟（后台）；③ 记忆变化在**下一轮**以 delta 生效，注入前缀稳定（§6.6）；④ TUI 与 `--prompt` 共用同一触发点，无需两套逻辑；⑤ 与「compact 前等待子代理收敛」（`src/core/session.ts:313-316`）同一思路：后台任务不阻塞前台 | ① 本轮无法使用「本轮新产生的偏好」——缓解：新偏好本来就写在用户消息里 master 直接可见；会话首轮已注入历史偏好；下一轮 delta 补齐；② 需要并发保护（§7.6） |

**结论：采用 (b)**，并补一条**冷启动规则**：会话首轮（含 `resume` 首轮）在 master 之前只做**纯本地只读选择**（§6.3，无 LLM 调用、<5 ms），保证首轮即个性化；此后每轮结束后异步归纳。

### 7.3 引擎

- **复用 `runSubagentLoop`**（`src/core/subagent.ts:43`）：已具备「循环 + 工具执行 + abort + usage 回调」，且被 `SubagentSession` 包装成会话对象（`src/core/subagent-session.ts:84-114`）。
- memory agent **不注册进 `this.subagents`**（不污染 `list_subagents` / `/subagent` 视图，也不参与 compact 前的等待收敛 `src/core/session.ts:313-316`）；由 `src/core/memory-agent.ts` 自持一个 `SubagentSession` 实例（独立 `AbortController`，先例 `src/core/session.ts:356-357`）。
- system prompt：**不使用**主会话 system prompt（不继承 skill listing / 环境上下文，省 token），用 §7.4 专用 prompt；**不拼** `SUBAGENT_APPEND_PROMPT`（`src/core/session.ts:53-63` 含「不要用 skill/save_plan」等无关约束）。

### 7.4 system prompt 草案（可直接落文件 `src/core/memory-agent-prompt.ts`）

```text
你是 deepseek-arch 的记忆维护代理。你的唯一职责是：阅读给定对话片段，判断其中是否存在
"用户偏好/约定/边界"，并把结论写入记忆库。

## 信号判定标准（置信度 1–3）

| 信号 | 识别方式 | 置信度 |
| A 显式偏好陈述 | 用户以"我希望/我喜欢/不要/以后/应该"开头，或明确说"记住" | 3 |
| B 否决/纠正 | 用户否定 agent 的做法并给出替代方案（"不对，应该…"） | 2 |
| C 决策确认 | 用户确认方案后进入执行（"开始"/"按你说的做"），且 assistant 随后确实执行 | 2 |
| D 范围/边界声明 | 用户划界限（"X 先不动"）→ 记 scope.deferred + remindAt（可从"下周/等Y完成后"推断） | 3 |
| E 显式放弃 | 用户主动放弃某方案（"放弃磁盘写入策略优化"） | 3 |
| F 重复模式 | 同一偏好第 2 次出现（不是同一轮内的重复） | 1（仅当库里已有同 subject 条目时才可升到 2） |

## 硬性规则
1. 最多输出 3 条 writes；宁少勿滥。技术事实、任务细节、临时上下文、agent 自己的推测都不是偏好，不要记。
2. 只记"跨会话仍有意义"的内容；一次性的操作指令（"帮我跑一下测试"）不记。
3. 每条必须给出 subject（受控词表）与 tags（1–6 个小写词）。可选 remindAt（ISO 8601 UTC）。
4. 写入前必须先调用 memory_search（同 subject 或 tag 关键词）检查是否已存在：
   - 已存在且同义 → op="update"，给出已有 id，不要新增；
   - 已存在但矛盾 → op="supersede"，给出被取代 id + reason；
   - 不存在 → op="add"。
5. 你无权删除 confidence=3 的条目，也无权 op="delete"（delete 只允许用于你自己本轮误写的低置信条目，
   且必须在 reason 里说明）。
6. 不要输出建议、不要说教、不要总结给用户看。只输出 JSON。

## 输出格式（严格 JSON，无 markdown 围栏、无多余文本）
{
  "writes": [
    {
      "op": "add" | "update" | "supersede",
      "id": "memo_xxx",              // update/supersede 必填
      "supersedes": ["memo_yyy"],    // supersede 必填
      "scope": "project" | "global", // project = 与本工作区有关；global = 通用个人偏好
      "text": "≤200 字的规范化陈述（祈使句/事实句，不要第一人称）",
      "subject": "reply.format",
      "tags": ["reply", "format"],
      "paths": ["src/**"],           // 可选
      "confidence": 1 | 2 | 3,
      "signal": "A" | "B" | "C" | "D" | "E" | "F",
      "remindAt": "2026-09-15T09:00:00.000Z",  // 可选
      "reason": "为什么这样判定（≤80 字）"
    }
  ],
  "contradicts": [ { "new": "memo_xxx", "old": "memo_yyy", "why": "≤60 字" } ],
  "skipped": [ { "candidate": "≤60 字", "why": "low_value|already_known|uncertain" } ],
  "notes": "≤200 字总结（仅供审计，不注入主对话）"
}
没有可写内容时输出 {"writes":[],"contradicts":[],"skipped":[],"notes":"..."}。
```

**解析兜底**：先 `JSON.parse`；失败则提取首个平衡的 `{...}` 再试一次；仍失败 → 审计 `{"kind":"error","where":"parse"}`，本轮不写（不重试，避免成本失控）。

### 7.5 工具集（受限）

memory agent 的工具集**显式白名单**（不复用 `getAllTools`，`src/tools/index.ts:130-138`）：

```
memory_search                # 只读，§7.5.1
memory_write                 # 受控写入，§7.5.2
read_file / search_content   # 只读文件（复用现有实现 src/tools/read-file.ts / search-content.ts）
```

明确**不提供**：`shell`、`write_file`、`edit_file`、`save_plan`、`browser_*`、`subagent_*`、`skill`、`wait`。

#### 7.5.1 `memory_search`

```jsonc
{
  "name": "memory_search",
  "description": "按关键词/标签/作用域检索已保存的用户记忆（全局层 + 当前项目层）。写入记忆前必须先检索去重。只读，无副作用。",
  "parameters": {
    "type": "object",
    "properties": {
      "query":          { "type": "string",  "description": "关键词（空格分隔，多词 AND；空 = 按标签/最近使用返回）" },
      "scope":          { "type": "string",  "enum": ["all", "project", "global"], "description": "默认 all" },
      "tags":           { "type": "array",   "items": { "type": "string" }, "description": "标签过滤（OR）" },
      "subject":        { "type": "string",  "description": "话题键精确过滤，如 git.commit_message" },
      "min_confidence": { "type": "integer", "minimum": 1, "maximum": 3, "description": "默认 1" },
      "include_inactive": { "type": "boolean", "description": "含 superseded/deprecated（查看演化用），默认 false" },
      "limit":          { "type": "integer", "minimum": 1, "maximum": 20, "description": "默认 8" }
    },
    "required": []
  },
  "requiresConfirm": false
}
```

返回（紧凑文本，一行一条，≤20 行）：

```
3 条命中（project=2, global=1）：
- memo_1a2b3c4d | conf=3 | project | #git #commit | hits=7 | 2026-09-11 | 提交信息用中文单行，不加 emoji
```

排序：与 `query` 的相关性（同一套 §6.3 公式，`rel` 权重升到 1）→ 置信度 → `lastUsedAt`。

#### 7.5.2 `memory_write`

```jsonc
{
  "name": "memory_write",
  "description": "新增/更新/取代/删除一条用户记忆（无需用户确认；写入后系统会提示用户「已更新记忆」）。同一 subject 的近重复会被自动合并，冲突会按规则取代旧条目。",
  "parameters": {
    "type": "object",
    "properties": {
      "op":         { "type": "string", "enum": ["add", "update", "supersede", "delete"] },
      "id":         { "type": "string", "description": "update/delete 必填的已有 id" },
      "supersedes": { "type": "array", "items": { "type": "string" }, "description": "supersede 时必填（被取代的旧 id）" },
      "scope":      { "type": "string", "enum": ["project", "global"] },
      "text":       { "type": "string", "description": "≤1000 字符的规范化陈述" },
      "subject":    { "type": "string", "description": "受控词表键（§5.3）" },
      "tags":       { "type": "array", "items": { "type": "string" }, "description": "1–6 个小写标签" },
      "paths":      { "type": "array", "items": { "type": "string" }, "description": "可选，相对 workspace 的 glob" },
      "confidence": { "type": "integer", "minimum": 1, "maximum": 3 },
      "signal":     { "type": "string", "enum": ["A", "B", "C", "D", "E", "F"] },
      "remindAt":   { "type": "string", "description": "可选，ISO 8601" },
      "reason":     { "type": "string", "description": "≤200 字，落审计" }
    },
    "required": ["op", "scope", "text", "subject", "tags", "confidence", "signal"]
  },
  "requiresConfirm": false
}
```

返回（工具结果文本，供模型自检）：

```
memory_write ok: action=merged kept=memo_1a2b3c4d absorbed=memo_7f3a1b2c sim=0.78 scope=project conf=3
（更新后 1 条 → 项目层记忆共 42 条）
```

失败 `error` 取值：`invalid_params`（缺字段/越界）、`not_found`（id 不存在）、`forbidden`（对 conf=3 执行 delete 且 source 非 user）、`duplicate_exact`（完全重复，已合并，无需写入）。

> `memory_write` 同时给 memory agent 与主代理使用（需求原文：`plan/20260912Task.md:14`「master agent 和 memory agent 都可以管理记忆」）。主代理版本的工具描述追加一句：「只在用户明确表达偏好/否决/边界时调用；不要因为完成任务顺手记录技术细节」。

### 7.6 触发点、并发与失败保护（精确）

```
触发锚点：TUI      = src/presentation/tui-app.ts:1901（case 'done'）之后
          headless = src/cli/index.ts 的 --prompt 流程内，turn 落盘之后（src/core/session.ts:1365 之后）
实现位置：SessionManager.afterTurnAsync(turn)   ← 新增方法，由上述两处调用（并在 sendMessageStream 尾部兜底）
```

| 保护 | 规则 |
|:--|:--|
| **同会话串行** | `SessionManager` 持 `private memoryAgentRunning: Promise<void> \| null`；已有在跑 → **直接跳过**（不排队，避免堆积），审计 `skipped:"busy"` |
| **最小间隔** | 同会话两次归纳间隔 ≥ `agent_min_interval_sec=30`，避免用户连发消息时连跑 |
| **轮次上限（关键）** | `runSubagentLoop` **无轮次上限**（`src/core/subagent.ts:40`）→ 外挂 watchdog：① `callbacks.onEntry` 统计 `type==='tool_call'` 条数，> `agent_max_tool_calls=8` → `controller.abort()`；② `setTimeout(agent_timeout_sec=90_000)` → `abort()`；③ 累计 tokens > `agent_max_tokens=20000` → `abort()`。abort 后返回 `SUBAGENT_CANCELLED`（`src/core/subagent.ts:24/70/119/167`） |
| **失败不阻塞** | 解析失败 / 超时 / API 错误 → 记 `audit error`，静默返回；**绝不**向用户抛错、不改当前轮状态（对齐 `src/core/session.ts:403` 的「持久化失败不阻塞」风格） |
| **不随主 agent 中断而死** | 独立 `AbortController`（先例 `src/core/session.ts:356-357`）；用户 Ctrl+C 只中断主 agent |
| **进程退出** | `TuiApp.cleanupRawMode()`（`src/presentation/tui-app.ts:451-458`）在已有清理中加入 `memoryAgent.abort()` + `clearInterval(heartbeatTimer)`；headless 用 `process.on('SIGINT'/'SIGTERM')` → abort（先例 `src/cli/index.ts:493-494`） |
| **部分写入** | `memory_write` 逐条追加，超时中断不会写坏文件（§3.3 追加语义） |
| **幂等** | `done` 是单次事件（`src/core/session.ts:1365`），同一 `(sessionId, turn)` 不会重复归纳 |
| **写入配额** | 单次归纳 ≤3 条（`agent_max_writes_per_run`），超出丢弃并审计 `skipped:'over_quota'` |
| **headless 限权** | 心跳/`--prompt` 轮产生的记忆 `confidence` 上限为 2（无人监督，不接受「显式」定级） |

### 7.7 审计落盘

**路径**：写在**作用域对应的 store 目录**（项目层 → `{workspace}/.deepseek-arch/memory/audit.jsonl`；若 agent 写了 global 条目，同时在 `~/.deepseek-arch/memory/audit.jsonl` 追加一条指针行）。
**格式**：JSONL，`kind` 区分，追加写（风格同 `src/core/cache-log.ts:113-132`）。示例：

```json
{"kind":"agent_run","at":"2026-09-12T10:00:00.000Z","runId":"mr_8f2c11","sid":"0e94bdd5","turn":12,"trigger":"turn_end","model":"deepseek-v4-flash","promptTokens":3210,"completionTokens":180,"elapsedMs":4210,"inputTurns":3,"writes":[{"op":"supersede","id":"memo_3c2b1a09","supersedes":["memo_1a2b3c4d"],"conf":3,"signal":"B"}],"skipped":[],"aborted":false}
{"kind":"inject","at":"2026-09-12T10:00:04.000Z","sid":"0e94bdd5","turn":13,"mode":"delta","rev":"9b8c7d","ids":["memo_3c2b1a09"],"tokens":62,"topScore":0.74}
{"kind":"write","at":"2026-09-12T10:00:00.500Z","op":"merge","kept":"memo_1a2b3c4d","absorbed":"memo_7f3a1b2c","sim":0.78,"by":"memory_agent"}
{"kind":"fold","at":"2026-09-12T10:00:05.000Z","before":1284,"after":412,"archived":9,"elapsedMs":37}
{"kind":"parse_error","at":"2026-09-12T10:00:05.100Z","file":"memory.jsonl","line":1283,"bytes":41}
{"kind":"error","at":"2026-09-12T10:00:06.000Z","where":"agent","message":"timeout after 90000ms","sid":"0e94bdd5","turn":12}
{"kind":"remind_due","at":"2026-09-12T10:00:07.000Z","ids":["memo_4b5c6d7e"],"surface":"tui_hint"}
```

**用途**：① 参数调优（`sim` 分布、score 分布、注入 token 分布）；② 排查「为什么这条没被注入」；③ 成本核算（`promptTokens/completionTokens`）；④ `/memory show --audit`。

### 7.8 token 成本控制

1. **只喂最近 `agent_max_input_turns=3` 轮**（用户消息 + assistant 最终回复 + 工具调用摘要），用 `turnUserContent` / `turnAssistantContent`（`src/utils/turn-utils.ts`），格式参考 compact 的序列化写法（`src/core/compact.ts:315-333`）。
2. **工具结果截断**：单条 ≤200 字符（`src/core/compact.ts:323` 同款策略）；一次归纳输入 ≤ `agent_max_input_tokens=6000`（`truncateTokens`，`src/core/compact.ts:71`）。
3. **按需检索**：不预先喂全部记忆；agent 自行 `memory_search`（通常 1–2 次调用）。
4. **模型选择**：`memory.agent_model` 默认 `""` → 用 `defaults.model`；推荐配 `deepseek-v4-flash`（价格 `src/core/config.ts:111-116`）。单次归纳成本估算 ≈ `3210×2.25/1e6 + 180×6.75/1e6 ≈ ¥0.0084`（每用户轮一次；若嫌贵，把 `agent_every_n_turns` 设为 2）。
5. **跳过条件**（不调用 LLM）：最近 3 轮用户消息总长 < 8 字符；或本轮用户消息与上轮 `sim ≥ 0.9`（重复提交）；或 `memory.agent_on_turn_end=false`。

### 7.9 写入后的用户提示（「已更新记忆」）

- 新增 StreamEvent 成员：`{ type: 'memory_updated'; updated?: number; ids?: string[]; scope?: 'project'|'global'|'both' }`（union 位置 `src/types/chat.ts:98-103`，字段加在 `:104-145` 区）。
- 通道：`done` 之后 `onEvent` 已离开 TUI 的流式回调作用域（`src/presentation/tui-app.ts:1712` 的闭包随 `sendMessageStream` 返回结束）→ 设计为 **`SessionManager.setMemoryNoticeCallback(cb)`**（懒绑定，先例 `setSubagentRunner` `src/cli/index.ts:96`），TUI 在构造时注册。
- TUI 展示（不打扰）：`this.writeOutputLine(dim('[memory] 已更新 2 条记忆（/memory show 查看）'))` —— 一行 dim、写 scrollback；不弹层、不改输入区、不中断任何流式输出。
- headless（`--prompt`）：stderr 一行 `[memory] updated 2`；`--quiet` 关闭（避免污染 stdout 契约，§10.3）。
- 主代理通过 `memory_write` 写入时：工具结果文本已含 `memory_write ok: ...`（模型可见）；TUI 在 `tool_result` 事件里对 `toolName==='memory_write'` 追加同一行 dim 提示。
- 频控：同会话 60 s 内最多提示 3 次，超出合并为计数。

---

## 8. 面向用户的接口

### 8.1 TUI 命令

| 命令 | 行为 | 落点 |
|:--|:--|:--|
| `/memory` | 等价 `/memory show`：状态摘要（层、条数、开关、上次注入、上次归纳、可检索路径、legacy 笔记提示） | `dispatchCommand`（`src/presentation/tui-app.ts:594` 起）新增分支，输出走 `cmdOut`（先例 `:789-812`） |
| `/memory show [kw] [--scope all\|project\|global] [--limit N]` | 列出条目：`id \| conf \| scope \| hits \| lastUsed \| text`（默认 10 行，≤20）；带 `kw` 时按相关性排序 | 同上（复用 core 的选择函数） |
| `/memory show --audit [N]` | 最近 N 条审计（默认 10） | 同上 |
| `/memory forget <id>` | 写墓碑 + 审计；`confidence=3` 允许（用户显式） | 同上 |
| `/memory on` / `/memory off` | 切换 `memory.enabled`：立即生效 + `configMgr.set('memory.enabled', bool)` 持久化 | 写回机制照抄 `/async`（`src/presentation/tui-app.ts:913-926`）；需 `fileMap` 支持（§9.3-C） |
| `/memory agent on\|off` | 只关/开自动归纳（仍注入） | `memory.agent_on_turn_end` |
| `/memory pin <id>` / `unpin <id>` | 加/去 `pinned` | 同上 |
| `/memory path` | 打印两层可检索路径（解决约束 B） | 同上 |

同时更新：`AVAILABLE_COMMANDS`（`src/presentation/tui-app.ts:64`）与 `/help` 表（`:792-806`）、`/context` 增一行 `Memory:`（`:827-835`）。

`/memory` 输出示例：

```
Memory
────────────────────────────────────────────
  enabled:      ON
  layers:       global(3 条) + project(42 条)
                全局 ~/.deepseek-arch/memory/memory.jsonl
                项目 .deepseek-arch/memory/memory.jsonl   ← search_content 需显式传 path
  inject:       ≤10 条 / ≤800 tokens（本会话已注入 3 次，上次 full rev=f3a19c）
  agent:        ON (turn_end, model=deepseek-v4-flash, 上次 12:04 更新 2 条)
  legacy:       2 个历史 md 笔记未纳入（.deepseek-arch/memory/*.md）
```

### 8.2 「已更新记忆」提示的形式（不打扰）

| 场景 | 展示 | 位置/形式 |
|:--|:--|:--|
| memory agent 归纳后有写入（TUI） | `dim('[memory] 已更新记忆：+1 ~1（/memory show 查看）')` | 单行 dim，写在 `done` 之后的 scrollback；**不弹窗、不动输入区、不暂停/不清屏**；与下一轮 `[You]` 行之间只隔一行 |
| 主代理直接 `memory_write` | 工具结果已含 `notice`（模型可见）；TUI 在 `tool_result` 分支识别 `toolName==='memory_write'` 时补一行 dim | 复用既有 tool_result 渲染分支，改动最小 |
| headless `--prompt` | stderr 一行 `[memory] updated 2 (+1 ~1)`；`--quiet` 关闭 | 不污染 stdout（§10.3） |
| 关闭 | `memory.write_notice = false` 或 `--no-memory` | — |

### 8.3 启动参数

| 参数 | 说明 |
|:--|:--|
| `--no-memory` | 完全关闭：不注入、不跑 agent、不注册记忆工具（优先级高于配置；写法照抄 YOLO：`options.yolo ?? cfg.get('defaults.yolo')`，`src/cli/index.ts:172-173`）。`chat` 与 `resume`（`src/cli/index.ts:316` 起）都要加 |
| `--memory-scope <all\|project\|global>` | 本次运行只用某一层（调试用，可选） |
| `--memory-model <name>` | 覆盖 `memory.agent_model`（可选） |
| `--quiet` | 关闭 `[memory]` stderr 提示（headless 用；TUI 下无效果） |

### 8.4 是否需要 `memory_search` 工具让 agent 主动检索 —— **需要，且是必选项**

三条硬依据：

1. **约束 A**（`src/tools/utils.ts:34-46`）：全局层 `~/.deepseek-arch/memory/` 对 `read_file`/`search_content` **完全不可达**；
2. **约束 B**（`src/tools/search-content.ts:63`）：即便项目层，从 workspace 根 `search_content` 也**搜不到隐藏目录**；
3. 需求原文要求 master 也能管理记忆（`plan/20260912Task.md:14`）。

补充设计：

- 工具描述里写明两个层的确切路径，以及「从根目录 `search_content` 搜不到隐藏目录」这一事实，避免 agent 反复试错；
- 返回刻意保持「一行一条 + id」，让 agent 需要全文时用 `read_file(".deepseek-arch/memory/memory.jsonl")`（项目层可达）；
- 全局层全文只能经 `memory_search`（core 内直接 `node:fs`，绕过沙箱）——这是**受控的唯一通道**，也是未来的脱敏检查点；
- 注册位置：主代理 `ALL_TOOLS`（`src/tools/index.ts:75-97`）追加 `memory_search` + `memory_write`；子代理 `SUBAGENT_TOOLS`（`:110-123`）**不**追加；memory agent 用 §7.5 白名单。

---

## 9. 配置 schema

### 9.1 完整字段与默认值

落在 **`config.toml`**（与 `[display]` 同级；`src/core/config.ts:35-94` 模板末尾追加两段）。理由：读取频繁、写入很少；直接走 `ConfigManager.get(path)` 现有机制（`src/core/config.ts:461`）；`[display]` 已是同风格先例（`src/core/config.ts:80-93`、`src/types/config.ts:85-91`）。

```toml
# ── 记忆（memory）──────────────────────────────────────
# 两层：全局 ~/.deepseek-arch/memory/ + 项目 {workspace}/.deepseek-arch/memory/
# 格式：JSONL 追加日志（memory.jsonl）+ 审计（audit.jsonl）
[memory]
enabled = true                  # 总开关（--no-memory 可临时关闭；/memory off 写回此键）
inject_mode = "first+delta"     # first+delta（推荐）| every-turn | compact-only
max_inject_entries = 10         # 单次注入条目上限
max_inject_tokens = 800         # 单次注入 token 预算（估算器同 src/core/compact.ts:66）
delta_inject_tokens = 200       # delta 块预算
score_floor = 0.35              # 低于此分不注入

# 选择权重（§6.3）
w_relevance = 0.45
w_confidence = 0.25
w_recency = 0.15
w_usage = 0.15
recency_half_life_days = 45     # 打分中的"最近是否被提及"半衰期
usage_half_life_days = 14       # 打分中的"使用热度"半衰期
project_scope_bonus = 1.15      # 项目层 scope 加成

# 去重/冲突（§5）
dedup_merge_threshold = 0.72
dedup_review_threshold = 0.45
dedup_prefix_chars = 24

# 生命周期（§4）
decay_half_life_days = 180      # 有效置信度半衰期
delete_idle_days = 120          # 零命中的自然过期
deprecate_idle_days = 240
max_active_entries = 500        # 单层 active 上限
max_text_chars = 1000           # 单条 text 上限（保证单行 <4KiB）
max_file_bytes = 524288         # 512 KiB → 触发折叠
legacy_notice = true            # 提示 .deepseek-arch/memory/*.md 未纳入

# memory agent（§7）
agent_on_turn_end = true        # 每用户轮结束后异步归纳
agent_every_n_turns = 1         # 每 N 轮归纳一次（2 = 省一半成本）
agent_model = ""                # "" = 用 defaults.model；推荐 deepseek-v4-flash
agent_max_input_turns = 3       # 只喂最近 N 轮
agent_max_input_tokens = 6000
agent_max_tool_calls = 8        # watchdog：工具调用条数上限 → abort
agent_max_rounds = 6            # watchdog：轮次语义上限（审计展示用）
agent_timeout_sec = 90          # watchdog：总超时 → abort
agent_max_tokens = 20000        # watchdog：单次归纳总 token 上限 → abort
agent_max_writes_per_run = 3    # 单次归纳最多写几条
agent_max_runs_per_session = 50
agent_min_interval_sec = 30     # 同会话两次归纳最小间隔
write_notice = true             # 写入后提示「已更新记忆」
audit = true                    # 写 audit.jsonl
audit_max_bytes = 1048576       # 1 MiB → 轮转

# ── 心跳（heartbeat / 唤起）────────────────────────────
[heartbeat]
tui_enabled = false             # TUI 内定时器（备）：默认关闭，避免与外部 cron 双重触发
tui_interval_min = 15           # TUI 定时器间隔（分钟）
tui_idle_min = 5                # 用户空闲至少 N 分钟才允许触发
tui_max_defer = 3               # 因"用户正在输入/流式未结束"跳过 N 次后放弃本次并写审计
tui_prompt = ""                 # TUI 心跳任务提示词；空 = 只处理到期提醒
prompt_default_timeout_sec = 600  # chat --prompt 默认超时
prompt_allowed_tools = ["read_file", "search_content", "memory_search", "memory_write"]
                                # chat --prompt 默认工具白名单（安全默认：无 shell/写入/浏览器）
prompt_deny_confirm = true      # --prompt 下对 requiresConfirm 工具默认拒绝（无人在场不可盲批）
prompt_max_tool_rounds = 20     # 心跳 agent loop 轮次上限（超出 abort，退出码 3）
include_reminders = true        # --prompt 时把到期 remindAt 注入 <memory-due>
session_name = "heartbeat"      # --session 默认名（按标题复用同一会话）
```

`[paths]` 段追加一项（可选但推荐）：

```toml
memory = "./memory"            # 全局层目录（相对配置目录；默认即 ~/.deepseek-arch/memory）
```

### 9.2 类型定义（可照写）

```ts
// src/types/config.ts 追加
export interface MemoryConfig {
  enabled?: boolean;                     // true
  inject_mode?: 'first+delta' | 'every-turn' | 'compact-only';
  max_inject_entries?: number;           // 10
  max_inject_tokens?: number;            // 800
  delta_inject_tokens?: number;          // 200
  score_floor?: number;                  // 0.35
  w_relevance?: number;                  // 0.45
  w_confidence?: number;                 // 0.25
  w_recency?: number;                    // 0.15
  w_usage?: number;                      // 0.15
  recency_half_life_days?: number;       // 45
  usage_half_life_days?: number;         // 14
  project_scope_bonus?: number;          // 1.15
  dedup_merge_threshold?: number;        // 0.72
  dedup_review_threshold?: number;       // 0.45
  dedup_prefix_chars?: number;           // 24
  decay_half_life_days?: number;         // 180
  delete_idle_days?: number;             // 120
  deprecate_idle_days?: number;          // 240
  max_active_entries?: number;           // 500
  max_text_chars?: number;               // 1000
  max_file_bytes?: number;               // 524288
  legacy_notice?: boolean;               // true
  agent_on_turn_end?: boolean;           // true
  agent_every_n_turns?: number;          // 1
  agent_model?: string;                  // ""
  agent_max_input_turns?: number;        // 3
  agent_max_input_tokens?: number;       // 6000
  agent_max_tool_calls?: number;         // 8
  agent_max_rounds?: number;             // 6
  agent_timeout_sec?: number;            // 90
  agent_max_tokens?: number;             // 20000
  agent_max_writes_per_run?: number;     // 3
  agent_max_runs_per_session?: number;   // 50
  agent_min_interval_sec?: number;       // 30
  write_notice?: boolean;                // true
  audit?: boolean;                       // true
  audit_max_bytes?: number;              // 1048576
}

export interface HeartbeatConfig {
  tui_enabled?: boolean;                 // false
  tui_interval_min?: number;             // 15
  tui_idle_min?: number;                 // 5
  tui_max_defer?: number;                // 3
  tui_prompt?: string;                   // ""
  prompt_default_timeout_sec?: number;   // 600
  prompt_allowed_tools?: string[];       // ["read_file","search_content","memory_search","memory_write"]
  prompt_deny_confirm?: boolean;         // true
  prompt_max_tool_rounds?: number;       // 20
  include_reminders?: boolean;           // true
  session_name?: string;                 // "heartbeat"
}
```

`AppConfig`（`src/types/config.ts:94-99`）与 `ResolvedConfig`（`:102-110`）各追加 `memory?: MemoryConfig; heartbeat?: HeartbeatConfig;`；`ConfigPaths`（`:37-43`）追加 `memory?: string;`（可选，保持旧配置兼容）。

### 9.3 必须同步修改的 5 个点（漏一个就出 bug —— 约束 C）

| # | 位置 | 改动 | 漏改后果 |
|:--|:--|:--|:--|
| A | `src/core/config.ts:362-369` | `this.resolved` 组装时带上 `memory` / `heartbeat` | **配置写了读不到**（静默丢弃，最难查） |
| B | `src/types/config.ts:94-99`、`:102-110` | `AppConfig` / `ResolvedConfig` 增字段 | TS 编译不过 / `get()` 返回 `undefined` |
| C | `src/core/config.ts:490-496` | `fileMap` 增 `memory: { file: 'config.toml', stripRoot: false }`、`heartbeat: { file: 'config.toml', stripRoot: false }` | `/memory off` 写回抛「不支持的配置段」（`:500`） |
| D | `src/core/config.ts:35-94` | `DEFAULT_MAIN_CONFIG` 模板追加 `[memory]` / `[heartbeat]` 段（含注释） | 新用户没有可编辑模板；旧用户靠代码 `??` 兜底 |
| E | `src/types/config.ts:37-43` + 模板 `[paths]`（`src/core/config.ts:39-44`） | 追加 `memory = "./memory"` | 全局层目录不可迁移（可接受，但建议加） |

**缺省值兜底**：`applyMissingDefaults` 只处理 `[defaults]` 段（`src/core/config.ts:431-442`），因此 `[memory]`/`[heartbeat]` 的空缺由读取处 `?? 默认值` 兜底——与 `display.mode` 的处理方式一致（`src/cli/index.ts:175`）。所有默认值**集中定义在一个地方**（建议新增 `src/core/memory-config.ts` 导出 `DEFAULT_MEMORY_CONFIG` / `DEFAULT_HEARTBEAT_CONFIG`），供 core 与 TUI 共用；本期**不做**「旧配置自动补全新段」（避免 `load()` 里多一段写文件逻辑）。

---

## 10. 心跳机制与 `chat --prompt`

### 10.1 形态总览（已定决策 7：不用常驻 daemon）

```
主：外部 cron / systemd --user timer
      └─ deepseek-arch chat --prompt "<任务提示>" [--session <name>] [--resume <id>] [--timeout N]
备：TUI 内定时器（默认关闭）→ 有待办/到期项时注入一个心跳轮
兜底：用户手动 `deepseek-arch chat --prompt '...'`（同一实现，零额外代码）
```

### 10.2 systemd / cron 示例

**systemd（推荐，含 `Persistent=true` 补跑）**——`~/.config/systemd/user/deepseek-arch-heartbeat.service`：

```ini
[Unit]
Description=deepseek-arch heartbeat (single non-interactive turn)
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/workspace/deepseek-arch
# --session：按标题复用同一会话（首次自动创建），避免每次心跳新建会话把 sessions/ 撑爆
# 默认只读白名单 [heartbeat] prompt_allowed_tools 生效；无人在场不批准确认类工具
ExecStart=/usr/bin/deepseek-arch chat --prompt "巡检：检查 plan/ 与 docs/todo/ 中是否有到期或阻塞项；有则给出具体下一步动作与验证方式；没有则只输出 NOOP。" --session heartbeat --timeout 900 --quiet
TimeoutStartSec=1000
StandardOutput=append:%h/.deepseek-arch/audit/heartbeat.log
StandardError=append:%h/.deepseek-arch/audit/heartbeat.err.log
```

`~/.config/systemd/user/deepseek-arch-heartbeat.timer`：

```ini
[Unit]
Description=Run deepseek-arch heartbeat every 30 minutes

[Timer]
OnCalendar=*:0/30
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
```

启用与查看：

```bash
systemctl --user daemon-reload
systemctl --user enable --now deepseek-arch-heartbeat.timer
systemctl --user list-timers | grep deepseek-arch
journalctl --user -u deepseek-arch-heartbeat -n 50
```

**crontab（WSL2 常见；注意 cron 的 PATH 极简）**：

```cron
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
*/30 * * * * cd /home/helck/workspace/deepseek-arch && /usr/bin/node /usr/lib/node_modules/deepseek-arch/dist/cli/index.js chat --prompt "巡检：plan/ 与 docs/todo/ 是否有到期项；有则给下一步动作，无则输出 NOOP。" --session heartbeat --timeout 900 --quiet >> $HOME/.deepseek-arch/audit/heartbeat.log 2>&1
```

注意：`src/cli/index.ts:1` 是 `#!/usr/bin/env node` → cron 环境必须能找到 `node`（上面显式用绝对路径）；WSL2 需先启动 cron 服务（`sudo service cron start`，本环境禁 sudo，属用户在主机侧操作）。

### 10.3 `chat --prompt` 精确语义

**用法**：

```
deepseek-arch chat --prompt <content>
                   [--resume <id|name>] [--session <name>] [--timeout <sec>] [--json]
                   [--tools a,b,c] [--all-tools [--allow-dangerous]] [--no-memory] [--quiet] [--verbose]
```

| 项 | 契约 |
|:--|:--|
| **交互性** | 完全不读 stdin：不进 raw mode、不构造 `TuiApp`（绕开 `src/cli/index.ts:212`/`:224` 的 TUI 路径）；`--prompt` 优先于「stdout 是 TTY」判断 |
| **executor** | 复用 `createSessionManager`（`src/cli/index.ts:66-128`）→ `sendMessageStream(content, onEvent, signal, onConfirm, /* reviewModelName：已移除 */)`；**不能用** `sendMessage()`（`src/core/session.ts:496-552` 无 agent loop，不执行工具） |
| **stdout** | **仅最终 assistant 正文**（原样 markdown；无 ANSI、无 think、无工具日志），结尾恰好一个 `\n`；空回复 → 输出空行并以 0 退出（审计写 `empty:true`） |
| **stdout（`--json`）** | 单行 JSON：`{"sessionId":"...","sessionTitle":"heartbeat","turn":13,"content":"...","usage":{"prompt_tokens":N,"completion_tokens":M,"total_tokens":T},"tools":[{"name":"read_file","ok":true}],"exitReason":"completed"}` |
| **stderr** | `[warn]`/`[error]`/`[memory]`/`[tool]` 诊断信息；`--quiet` 只保留 error；`--verbose` 增加注入与工具轨迹 |
| **退出码** | `0` 成功完成一轮；`1` 致命错误（配置/凭据缺失、会话不存在、API 失败）；`2` 用法错误（`--prompt` 缺内容、选项冲突）；`3` 超时 / 被中断 |
| **超时** | `--timeout` 默认 `[heartbeat].prompt_default_timeout_sec=600`；到期 `abort()` → 走既有中断路径保存 `interrupted=true` 的部分轮次（`src/core/session.ts:1367-1371`）→ 退出码 3（`--json` 时 `exitReason:"timeout"`） |
| **工具批准** | `onConfirm` 传 `undefined` = 全部自动批准（判据 `src/core/session.ts:1114` 的 `&& onConfirm &&`）。**本设计改为安全默认**：`--prompt` 下 `[heartbeat].prompt_deny_confirm=true` → 传 `() => Promise.resolve(false)`（拒绝一切需确认工具）；需要放权时显式 `--all-tools --allow-dangerous` |
| **yolo 表述** | 现状 `chat` 的 yolo 默认 true（`src/cli/index.ts:173` + 默认配置 `src/core/config.ts:68`）。`--prompt` 的「直接 yolo」= **无确认交互**（不会卡在等待输入）；是否允许危险工具由白名单 + `prompt_deny_confirm` 决定（§10.4） |
| **会话落盘** | 默认**新建会话**（标题由 `deriveSessionTitle` 派生，`src/core/session.ts:577-582`）；`--resume <id\|name>` 续用（`storage.getSession`/`getSessionByName`，先例 `src/cli/index.ts:202-211`）；**`--session <name>` = 按标题查，缺失则新建并设标题**（心跳必须用它，否则每次 tick 新建一个会话目录）。落盘格式与 TUI 完全一致（`turn_<gen>.json`，`src/core/storage.ts:71`）→ 心跳轮可在 TUI 里查看与续聊（刻意设计） |
| **会话成长** | 心跳会话同样受自动 compact 约束（`src/core/session.ts:951-968`）；文档建议按月轮转（`--session heartbeat-2026-09`） |
| **memory** | 默认参与注入 + 轮末归纳（与 TUI 一致）；`--no-memory` 关闭；`include_reminders=true` 时把到期 `remindAt` 以 `<memory-due>` 注入（§6.4），并在回复后清空该 `remindAt`（§7.6-K） |
| **与 heartbeat 的配合** | cron 只负责「何时唤醒 + 任务文本」；跑什么、能写什么，由 `[heartbeat]` 配置与白名单决定（cron 里不写危险提示词） |
| **0 轮保护** | 若因致命错误退出且未产生任何轮次 → 调 `discardEmptySession()`（`src/core/session.ts:209-215`），避免留空会话目录 |

### 10.4 `--prompt` 工具白名单（新增能力，安全默认）

- 默认白名单：`[heartbeat].prompt_allowed_tools = ["read_file","search_content","memory_search","memory_write"]` —— **不含** `shell` / `write_file` / `edit_file` / `save_plan` / `browser_*` / `subagent_*`。
- `--tools read_file,search_content,memory_write`：显式覆盖白名单。
- `--all-tools`：全量工具；必须同时给 `--allow-dangerous`，否则报用法错误退出 2（双开关防误触）。
- 实现方式：参照 `loadMasterTools` 的过滤模式（`src/cli/index.ts:32-39`），白名单外的工具**不进入 `toolsToDefinitions()`**（模型看不到，比「看到但被拒」更省 token 也更安全）。

### 10.5 无人在场时的风险与缓解

| 风险 | 具体场景 | 缓解 |
|:--|:--|:--|
| 破坏性操作 | prompt 诱导模型 `rm -rf` / 覆盖文件 | ① 默认白名单**不含 shell / 写文件**（§10.4）；② `prompt_deny_confirm=true` 拒绝一切确认类工具；③ 想放权需 `--all-tools --allow-dangerous`（文档标红） |
| 无限循环烧 token | agent loop 无轮次上限（`src/core/session.ts:885` 的 `for(round…)` 只受 `userDenied` 控制） | `--timeout` + `prompt_max_tool_rounds` + `max_prompt_tokens`；prompt 约定「无事项输出 NOOP」；生产建议调小 `defaults.max_tokens`（`src/types/config.ts:56`） |
| 会话无限膨胀 | 心跳复用同一会话 | 自动 compact（`src/core/session.ts:951-970`）+ 按月轮转建议 |
| 与用户并发操作同仓库 | 心跳改了正在编辑的文件 | 默认只读白名单；`--all-tools` 模式下 prompt 只做只读巡检 |
| 静默失败无人知晓 | API 挂了，cron 什么都没说 | 非零退出码 + cron/systemd 日志；文档给 `OnFailure=` / `\|\| notify-send` 示例 |
| 记忆被无人监督地污染 | 心跳轮写低质记忆 | headless 轮 `confidence` 上限 2（§7.6）；推荐 `[heartbeat]` 场景配 `--no-memory`（只注入不归纳），避免无人纠偏的自演化 |
| 输出被丢弃（用户不知道 agent 说了什么） | 日志文件没人看 | 建议 wrapper：`... --json \| jq -r '.content' \| notify-send "deepseek-arch" -`（文档给出） |

### 10.6 TUI 内定时器（备）行为

默认关闭（`tui_enabled=false`）。规格：

1. **生命周期**：`TuiApp.start()` 主循环前创建（`src/presentation/tui-app.ts:235` 之前），`cleanupRawMode()`（`:451-458`）里 `clearInterval`；字段与清理写法照抄 think 动画定时器（`:109`、`:1466`、`:1490`）——必须成对，否则进程不退出。
2. **间隔**：`tui_interval_min=15` 分钟（`setInterval(..., 15*60_000)`）。
3. **每 tick 判定链**（全部通过才触发）：

```
a. memory.enabled && heartbeat.tui_enabled
b. this.state === AppState.IDLE && this.abortController === null      // 不打断流式/确认态
   （AppState 定义 src/render/types.ts:9-16；abortController 字段 src/presentation/tui-app.ts:85）
c. this.input.isEmpty() === true                                      // 用户正在输入/有草稿 → 跳过，tuiDefer++
d. now - lastUserActivityMs ≥ tui_idle_min * 60_000                   // 空闲足够久
e. due = memory.listDue(now) 非空 或 heartbeat.tui_prompt 非空         // 无事可做 → 不唤醒（宁可不叫）
f. tuiDefer ≤ tui_max_defer（超出 → 记审计 kind=remind_due, surface=tui_dropped 并复位）
```

4. **用户正在输入时的处置**（问题点名）：**不抢输入、不插字符**。tick 只做 `tuiDefer++` + 底部一行 dim 提示（如 `[memory] 1 条提醒待处理（下次空闲自动执行，/memory 查看）`）；用户的下一次按键仍逐字符正常处理（未触碰 `stdinHandler`，`src/presentation/tui-app.ts:1114`）。
5. **触发方式（精确到实现）**：
   - 若此刻阻塞在 `readUserInput()`（`:1105`，被 `inputCycle` 在 `:489` await）：给 `readUserInput` 增加保存 resolver 的字段 `private inputResolver: ((v: string | null) => void) | null`（函数进入时赋值、返回前清空），tick 调 `this.inputResolver?.(HEARTBEAT_SENTINEL)`；`inputCycle` 在 `:500` 的 `content === null` 判定之后新增分支：
     ```
     if (content === HEARTBEAT_SENTINEL) { await this.runHeartbeatTurn(); continue; }
     ```
     其中 `const HEARTBEAT_SENTINEL = '\u0000heartbeat'`（含 NUL，正常键入不可能产生，见 `:1136` 附近对控制字符的处理）。注意 `:491-498` 的清屏/重绘照常执行，不会留残影。
   - 若不在阻塞态（刚跑完一轮、回到循环顶部）：直接 `this.nextMessage = heartbeatPrompt`（复用排队路径，`:470-482`）。
6. **心跳轮内容**：`[heartbeat] ` 前缀 + 到期条目摘要（模板固定，避免模型误读为用户指令）；首行由 TUI 加 `dim('[Heartbeat] 定时唤醒')`；该轮同样落盘（可见、可续）。
7. **与外部 cron 的关系**：默认 `tui_enabled=false`，文档明确「二选一」；两者同时开启 = 同一 workspace 两进程同时跑（追加写安全，但 token 双花）。
8. **为何不能互相替代**：TUI 定时器在 TUI 关闭时无效（cron 可跨终端、可被 systemd 管理）；`--prompt` 无法感知「用户正在打字」（TUI 定时器能 defer）。故保留两条路，默认只开 cron。

---

## 11. 实施拆分建议

> 依赖顺序自上而下；「可并行」= 与同批次其它任务无文件冲突。复杂度：S（半天）/ M（1–2 天）/ L（3–5 天）。每个子任务都必须保持「记忆关闭时行为与现状一致」（§6.6-I5），便于灰度与回滚。

| # | 子任务 | 目标 | 产出 | 验收标准 | 复杂度 | 可并行 |
|:--|:--|:--|:--|:--|:--|:--|
| **T0** | 路径基座 | 接入 `workspace-paths.ts` 的 `getRuntimeDir()/getMemoryDir()`（另一批次） | 完成路径解析；未就绪时用 `resolve(env.DEEPSEEK_ARCH_SESSION_CWD ?? cwd, '.deepseek-arch', 'memory')` 兜底 | 任意 cwd 下 `getMemoryDir()` 返回 `{workspace}/.deepseek-arch/memory`；目录自动创建（0o700） | S | 依赖外部批次，否则串行 |
| **T1** | 移除 reviewer（附录 A） | 删掉 YOLO 自动续跑审查 + `review_model` 配置/命令 | 按附录 A 17 项改动；`grep -rn "reviewModel\|reviewConversation\|review_verdict\|ReviewVerdict" src/ tests/ docs/` 除迁移说明外为空；`npm run build` 通过；`npm test` 绿 | M | 否（**建议第一个做**，减少后续接缝冲突） |
| **T2** | 记忆存储层 `src/core/memory-store.ts` | JSONL 追加（put/touch/delete）、fold、锁 + 原子折叠、`getRev`、容量逐出、审计 append；类型 `src/types/memory.ts` | 代码 + `tests/core/memory-store.test.ts` | ① ≥50 并发 append 后 fold 得到 0 重复、0 丢行；② 造一行非法 JSON → 仍能 fold 且写 `parse_error` 审计；③ 折叠后行数 = active 数；④ 锁被占时不损坏文件且写入仍成功；⑤ 单行 >4000 字节被截断（断言） | L | 否（T3/T5/T6 依赖其接口，接口需先冻结） |
| **T3** | 打分/去重/冲突 `src/core/memory-rank.ts`（纯函数） | §4 + §5 + §6.3 全部公式 | 代码 + `tests/core/memory-rank.test.ts` | 表格驱动 ≥25 例：置信度升降级全分支、衰减、淘汰阈值、`sim` 阈值边界（0.44/0.45/0.71/0.72）、同 subject 跨层屏蔽、`remindAt` 置顶、预算截断顺序、排序确定性 | M | 与 T5/T7 并行 |
| **T4** | 注入 `src/core/memory-inject.ts` + session 钩子 | §6.2/§6.5/§6.6；三触发（首轮 full / 变化 delta / compact 后 full），`memoryBlock===null` 时字节不变 | 代码 + `tests/core/memory-inject.test.ts` + 改 `src/core/session.ts`（`:886-890` 组装、`:959-960` compact 后置位）+ `src/core/compact.ts`（`buildCompactMessages` `:360-379` 加第 5 块；`EXCLUDED_PREFIXES` `:40` 补 `.deepseek-arch/memory/`） | ① 关闭记忆时 `roundMessages` 与现状 **byte-equal**（I5）；② 块位置 = `baseMessages.length-1` 且不出现在落盘 `turn.messages`；③ 连续 3 轮同集合 → 前缀长度与哈希不变（I3）；④ compact 后第一轮含块；⑤ 超预算按 §6.3 顺序截断 | L | 否（关键路径） |
| **T5** | memory agent `src/core/memory-agent.ts` + prompt 常量 | §7 全节（素材构造、trigger、watchdog、JSON 解析、审计、`setMemoryNoticeCallback`） | 代码 + `tests/core/memory-agent.test.ts`（用 `MockProvider`，`src/core/mock-provider.ts`） | ① 固定 JSON 回复 → 写入 1 条并按 §5 合并；② 幻觉/不可解析 → 静默失败 + `error` 审计，库不变；③ 超时 90s 与 `agent_max_tool_calls` 触发 abort；④ 同会话并发两轮 → 第二次审计 `skipped:'busy'`；⑤ 单次 >3 条写入被截断 | L | 与 T7 并行 |
| **T6** | 记忆工具 `src/tools/memory-search.ts` / `src/tools/memory-write.ts` | §7.5 schema + 注册（`ALL_TOOLS` `src/tools/index.ts:75-97` 追加两条；`SUBAGENT_TOOLS` `:110-123` 不加） | 代码 + `tests/tools/memory-tools.test.ts` | ① `memory_search` 能命中全局层（构造临时 HOME）；② `path`/`tags`/`subject` 过滤生效（搜索即低上下文：返回 ≤20 行）；③ `memory_write` 走 merge 而非新增（id 不变）；④ `forbidden`（对 conf=3 delete）；⑤ `getAllTools({includeSubagent:false})` 不含记忆工具 | M | T2 后即可（与 T5/T7 并行） |
| **T7** | 配置 schema（§9.3 五点） | 模板 + 类型 + `fileMap` + 合并 | 代码 + `tests/core/config.test.ts` 扩展 | ① `cfg.get('memory.max_inject_tokens') === 800`（防约束 C 回归）；② `cfg.set('memory.enabled', false)` 落盘到 config.toml 且不破坏其它段；③ 旧配置无 `[memory]` 时默认值生效；④ 首次运行生成的模板含两段 | S–M | 独立并行（建议与 T1 同批启动） |
| **T8** | TUI 接口（§8.1/§8.2/§10.6） | `/memory*` 命令、提示行、TUI 定时器、`memory_updated` 渲染 | 代码 + `tests/pty/memory.test.ts` | ① `/memory show` 输出条目；② 提示行在流式中不打断（断言输出序列）；③ 定时器在「正在输入」时**不**触发（defer 审计有记录）；④ 退出时定时器清理（无残留写 stdout） | L | 依赖 T4/T5/T6/T7 |
| **T9** | `chat --prompt`（§10.3/§10.4） | headless 单轮 + 退出码 + 白名单 + `--session/--json/--quiet` + 补全脚本（`src/cli/index.ts:511-533`、`:571-579`） | 代码 + `tests/cli/prompt.test.ts`（`--mock`） | ① stdout 仅含正文、无 `\x1b[`；② `--json` 单行可 `JSON.parse`；③ 退出码 0/1/2/3 各一例；④ `--session hb` 两次调用落同一会话（turnCount 递增）；⑤ 白名单外工具不可见（断言工具表）；⑥ 超时 → 码 3 且落盘 interrupted | L | 与 T8 并行（依赖 T7） |
| **T10** | 文档与运维模板 | `docs/memory.md`、`docs/heartbeat.md`（systemd/cron 模板 + `--prompt` 语义）、README 配置段、`docs/cli.md` 更新（该文件最后更新停在 2026-06-11，已过时） | 文档 | 文档含 §9/§10 的全部字段与 `文件:行号` 引用（遵循 `docs.skill.md:20` 维护规则）；示例可复制运行 | S | 并行 |
| **T11** | 收尾清理（附录 B） | 清理 3 处 `plan/memory-mechanism.md` 引用 | 改动 `docs/goal-tool-design.md:35`、`docs.skill.md:28` | `grep -rn "memory-mechanism" docs/ docs.skill.md` 为 0 | S | 并行 |

**推荐落地顺序（最小可回滚路径）**：`T1`（清障）→ `T7`（配置）→ `T0/T2`（存储）→ `T3`（算法）→ `T4`（注入；此时已端到端「记住」）→ `T5/T6`（agent + 工具）→ `T9`（心跳主形态）→ `T8`（TUI）→ `T10/T11`。

---

## 12. 开放问题（需用户拍板，≤6 条）

| # | 问题 | 推荐答案 |
|:--|:--|:--|
| **Q1** | 项目层 `{workspace}/.deepseek-arch/memory/` 是否随 git 提交？（现状：目录内 3 个文件**已被跟踪**，见 §2.1） | **提交**。项目层是「本仓库的约定」，团队共享价值大于风险；`sessions/`、`audit.jsonl`、`plan/` 一律 gitignore。落地：`.gitignore` 加 `.deepseek-arch/*` + 反向白名单 `!.deepseek-arch/memory/`，并在 `docs/memory.md` 注明「含敏感信息时自行 `git rm --cached`」 |
| **Q2** | 两层冲突（同 `subject`）时谁生效？ | **项目层优先**（更具体），且**不删除**全局条目，只在该 workspace 的注入视图里屏蔽（全局层在其它项目仍生效）；注入块头 `scope="project+global"` 已表达该语义 |
| **Q3** | 是否给主代理 `memory_write`（不只是 memory agent）？ | **给**（需求原文 `plan/20260912Task.md:14`），但工具描述限定「仅在用户明确表达偏好/否决/边界时调用」；写入后统一走「已更新记忆」提示，用户可 `/memory forget` 撤销 |
| **Q4** | TUI 内定时器默认开还是关？ | **默认关**（`tui_enabled=false`）：避免与 systemd/cron 双重触发导致 token 双花；需要 TUI 内唤醒的用户显式开启 |
| **Q5** | `{workspace}/.deepseek-arch/` 子目录命名与排除前缀（跨批次）：任务文档写 `plan`（`plan/20260912Task.md:6`），现网是 `plans`，而 `src/tools/save-plan.ts:15` 与 `src/core/compact.ts:279` 仍在写/读 `{workspace}/.plans/` | **统一为 `.deepseek-arch/plan/`**（按任务文档），并同步 `EXCLUDED_PREFIXES`（`src/core/compact.ts:40`）改为 `['.deepseek-arch/', '.plans/', 'memory/', '.memory/']`；同时确认由哪个批次改 `save-plan.ts` / `compact.ts:279`（避免两批次改同文件冲突） |
| **Q6** | 全局层对 agent 的可见性：只经 `memory_search` 工具，还是放宽 `checkPath` 让 `read_file` 也能读 `~/.deepseek-arch`？ | **只经 `memory_search`**。放宽 `checkPath`（`src/tools/utils.ts:34-46`）会让所有文件工具都能读 `~/.deepseek-arch`（含 `providers.toml` 中的 API key、`sessions/` 全部历史），安全上不可接受 |

---

## 附录 A：reviewer（censor agent）移除清单

目标（决策 5）：YOLO 的 stalled/deflecting 自动续跑审查完全移除；`defaults.review_model`、`/review_model` 一并处理掉。

| # | 文件:行号 | 现状 | 改动 |
|:--|:--|:--|:--|
| A1 | `src/core/reviewer.ts`（全文 114 行：prompt `:13`、`MAX_USER_INPUTS` `:36`、`reviewConversation` `:47`、`parseVerdict` `:87`） | 审查模型调用 | **删除文件** |
| A2 | `src/core/session.ts:19` | `import { reviewConversation }` | 删除 import |
| A3 | `src/core/session.ts:570` | `reviewModelName?: string` 形参 | 删除形参（调用方同步） |
| A4 | `src/core/session.ts:986-1012` | `if (reviewModelName && autoContinueCount < MAX_AUTO_CONTINUE)` 整块（`recentInputs` `:988-991`、`reviewConversation` 调用 `:993-998`、auto-continue prompt 注入 `:1000-1006`、`review_verdict` 事件 `:1008-1010`） | 整块删除 |
| A5 | `src/core/session.ts:598-599` | `let autoContinueCount = 0;` + `const MAX_AUTO_CONTINUE = 3;` | 删除（确认无其它引用） |
| A6 | `src/types/chat.ts:80` | `export type ReviewVerdict = ...` | 删除 |
| A7 | `src/types/chat.ts:101`、`:126-130` | StreamEvent 成员 `'review_verdict'` 与字段 `verdict/reviewReason/autoContinue` | 删除（全仓确认无其它引用） |
| A8 | `src/presentation/tui-app.ts:1829-1846` | `case 'review_verdict'` 渲染分支 | 删除 |
| A9 | `src/presentation/tui-app.ts:1924` | `this.yolo ? this.reviewModel : undefined`（`sendMessageStream` 第 5 实参） | 删除实参 |
| A10 | `src/presentation/tui-app.ts:77`、`:151`、`:768-783`、`:796`、`:831` | `reviewModel` 字段 / 初始化 / `/review_model` 命令 / help 表项 / `/context` 的 Review 行 | 全部删除（`/context` 该行可替换为 `Memory:`） |
| A11 | `src/presentation/tui-app.ts:64` | `AVAILABLE_COMMANDS` 含 `/review_model` | 删除该项，加入 `/memory*` |
| A12 | `src/core/config.ts:54-55`、`:125` | 模板 `review_model = "deepseek-v4-flash"` + `DEFAULT_DEFAULTS.review_model` | 删除模板行与默认值；**旧配置中残留的 `defaults.review_model` 键保留不动**（不主动清理用户文件，README 注明可删） |
| A13 | `src/types/config.ts:51-52` | `review_model?: string` + 注释 | 删除字段（A12 后旧 toml 仍含该键，多余键被忽略，安全） |
| A14 | `src/cli/index.ts:52-53`、`:62` | 读 `defaults.review_model` 并放进 `TuiConfig.reviewModel` | 删除 |
| A15 | `src/presentation/types.ts:17-18` | `TuiConfig.reviewModel` | 删除字段 |
| A16 | `docs/`（`docs/cli.md`、`docs/architecture.md` 等） | `/review_model`、censor agent 描述 | 同步修改（`docs.skill.md:20` 维护规则） |
| A17 | `tests/` | 若有 `reviewConversation` / `review_verdict` 引用 | `grep -rn "review" tests/` 后删除/改写 |

**回归风险（必须在 Release Notes 说明）**：`A4` 删除后，YOLO 下「模型 stalled/deflecting 不自动续跑」是**有意**的行为变化（决策 5）。腾出的「每轮一次额外 LLM 调用」预算由 memory agent 继承（成本量级相当，但用途从「干预本轮输出」变为「积累个性化」，不阻塞输出）。

---

## 附录 B：`plan/memory-mechanism.md` 残留引用（需清理，勿沿用其设计）

| 位置 | 内容 | 处置 |
|:--|:--|:--|
| `docs/goal-tool-design.md:35` | 「跨会话由 memory 机制草案承载，见 `plan/memory-mechanism.md`」 | 改为指向本稿 `plan/memory-heartbeat-design.md`，或删除该括号说明 |
| `docs.skill.md:28` | 用 `memory-mechanism.md` 作为命名示例 | 换成不指向已删文件的示例（如 `render-sdk.md`） |
| `.agent-file-state.json:686` | 工具状态缓存仍记录该文件路径 | `.gitignore:39` 已忽略该文件，属本地状态；无需提交，可留待工具自动清理 |

---

## 附录 C：测试与验收

| 层 | 用例要点 | 位置建议 |
|:--|:--|:--|
| 单元 | `memory-store`：并发追加、截断行、折叠幂等、锁超时、`rev` 变化、容量逐出 | `tests/core/memory-store.test.ts` |
| 单元 | `memory-rank`：置信度升降级全分支、衰减、淘汰、`sim` 阈值正反例、score 排序确定性 | `tests/core/memory-rank.test.ts` |
| 单元 | 注入：I5 字节不变、三触发条件、预算截断顺序、delta 仅含变化 | `tests/core/memory-inject.test.ts` |
| 单元 | agent：`MockProvider` 固定 JSON → 写入/合并/超时/解析失败/并发 `busy` | `tests/core/memory-agent.test.ts` |
| 单元 | 工具：schema 校验、`forbidden`、`not_found`、`SUBAGENT_TOOLS` 不含记忆工具 | `tests/tools/memory-tools.test.ts` |
| 集成 | kv-cache：连续多轮同集合 → 前缀稳定；结合 `src/core/cache-log.ts:27-68` 的 `verifyCacheHit`（阈值 5%，`:17`）断言 `cache.log` 无 `ANOMALY` | `tests/core/memory-kvcache.test.ts` |
| PTY | `/memory show` 渲染、写入提示行不打断流式、心跳定时器在「正在输入」时不触发 | `tests/pty/memory.test.ts`（沿用 `tests/pty/pty_helpers.py` 模式） |
| CLI | `chat --prompt`：stdout 契约、`--json`、退出码 0/1/2/3、白名单、`--session` 复用 | `tests/cli/prompt.test.ts`（`--mock`） |

---

## 附录 D：跨批次协作注意事项

1. **`src/core/workspace-paths.ts`（另一批次）**：本设计依赖 `getMemoryDir()`（项目层）与 `getRuntimeDir()`。若该批次尚未落地，先在 `memory-store` 内用 `resolve(process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd(), '.deepseek-arch', 'memory')` 兜底，待其落地后换成统一入口（避免双重实现）。
2. **任务第 6 条（runtime 目录迁移）** 会同时改 `src/tools/save-plan.ts`（`:15` 描述、写 `.plans/`）与 `src/core/compact.ts`（`:279` 读 `.plans/`、`:40` 排除前缀），与 Q5 直接相关；实施前需与该批次约定命名（`plan` vs `plans`）与 `EXCLUDED_PREFIXES` 最终形态，避免同文件冲突。
3. **`.deepseek-arch/` 的 git 策略（Q1）** 需在 `save_plan` 迁移落地时一并敲定，否则会出现「plan 被提交、memory 不提交」的半截状态。

---

## 12. 评审决议（2026-09-13，用户评审后修订）

> 本节是**实施依据**：与前面章节冲突时，以本节为准。配套讲解文档见 `plan/memory-design-explained.md`。

### R1 触发时序改为「用户消息发出后并发跑」（替换 §7.2 的结论）

原设计选 (b)「done 事件后异步」，理由是「看不到 assistant 回复就无法判定信号 B/C」。
评审提出改进并采纳：**memory agent 在用户发出消息后立即并发启动，输入 = 上一轮（用户消息 + assistant 最终回复）+ 本轮用户消息**。

- 拿到上一轮 assistant 回复 → B/C 判定依据仍然具备（否决/纠正、方案确认）；
- 零用户可感延迟：与主 agent 该轮并发，不阻塞；
- 记忆变化在**下一轮**以 delta 生效，注入前缀稳定；
- 触发锚点：`sendMessageStream` 入口（取代 `done` 事件 / `tui-app.ts:1901`）；`--prompt` 复用同一入口。
- 冷启动规则保留：会话首轮在 master 之前只做**纯本地只读选择**（无 LLM 调用），保证首轮即个性化。

**并发语义（评审确认）**：memory agent 与主 agent 并发，独立 `AbortController`；同会话 single-flight（已有在跑则跳过，不排队）；两次归纳间隔 ≥ `agent_min_interval_sec`。

### R2 输入范围收紧：不给工具轨迹、不给思维链（修订 §7.8）

- 输入只含：**用户消息 + assistant 最终回复**（上一轮 + 本轮），不含 `tool_calls` 摘要、不含 `reasoning_content`；
- 后果（明示）：信号 C「assistant 随后确实执行」不再可验证，C 的判定降级为「用户话术表达确认」；
- 保持：只喂最近 `agent_max_input_turns=3` 轮，输入 ≤ `agent_max_input_tokens`。

### R3 写入通道改为纯工具调用，删除严格 JSON 输出（替换 §7.4 的输出格式与解析兜底）

- `memory_write` 工具参数即结构化字段（`op/id/scope/text/subject/tags/paths/confidence/signal/remindAt/reason`）；
  工具描述中列出 `[memory]`/受控词表/不记清单，由 schema 约束；
- **不再要求 content 里输出 JSON**，也**不再有 parse 兜底分支**（少一类失败模式）；
- agent 的收尾文本（≤200 字）作为 `notes` 追加进审计（仅供审计，不注入主对话）；
- 失败（API 错误/超时/看门狗中止/工具校验失败）一律写审计 `kind:"error"`，且写日志本身不得抛错。

### R4 存储形态改为「主题 Markdown + 索引 + 追加日志」（替换 §3.2/§3.3 的单一 JSONL 方案）

参考 claude-code（`~/.claude/projects/<项目>/memory/`：`MEMORY.md` 索引 + 每主题 `.md` + `logs/yyyy/mm/dd.md`）：

```
{workspace}/.deepseek-arch/memory/
  index.md                     # 概览（注入用；由 store 从主题文件 frontmatter 生成）
  <slug>.md                    # 主题文件：frontmatter(id/subject/description/tags/scope/confidence/signal/paths/remindAt/created/updated) + 正文
  log/yyyy/mm/yyyy-mm-dd.md     # 追加式原始观察（不注入，可审计）
  audit.jsonl                   # 机器可读审计（agent_run/inject/write/fold/error/remind_due）
  legacy/                       # 用户手写旧笔记（原样保留，不被程序改写）
```

- frontmatter 词表参考 claude-code：`type ∈ user | feedback | project | reference`，`description` 用于相关性判断；
- 时效表达用**人话**（`today` / `3 days ago`）+ 陈旧告警（>1 天），不使用裸 ISO 时间戳（模型对日期算术不可靠）；
- 采纳 claude-code 的 **What NOT to save** 清单与 **drift caveat**（记忆是时间点观察，断言前先核对当前状态）；
- 检索：`memory_search` 返回**清单行**（`[type] slug (age): description` + 可读路径），需要全文再 `memory_read`/`read_file`；
- 保留确定性打分（§6.3 公式），不引入「便宜模型选文件」的额外调用；若召回质量不足再退回该方案。

### R5 注入：概览 + 两类变化提醒（扩展 §6.2）

| 触发 | 注入内容 |
|:--|:--|
| 会话开始（新会话 / resume 首轮 / `--prompt`） | 概览（top-K，≤ `max_inject_tokens`） |
| **概览变化**（新增/改写/遗忘） | 变化提醒（含变化条目，≤ `delta_inject_tokens`），在用户下一次发言的请求中带上 |
| **模型读过的记忆文件被更新** | 提醒：`你读过的 <path> 已更新（<age>）` —— 只对通过 `memory_read`/`read_file`/`memory_search` 命中过的路径生效 |
| compact 之后 | 重新注入完整概览 |

- 「读过的文件」集合来源：记录工具调用里的记忆路径（`memory_read` 参数、`read_file` 命中 memory 目录、`memory_search` 返回的 path），保存 `path → mtime`；文件 mtime 变化即视为更新；
- 概览行格式（评审倾向）：`- [subject](slug.md) — description (confidence N, updated <age>)`，**不注入 tags**；
- 与 §6.6 不变量保持一致：块不进 system prompt、不落盘、字节稳定（按 id 排序、无时间戳）。

### R6 用户提示：agent loop 结束后追加（确认 §7.9）

- 主 agent loop 结束（`done`）后追加一行 dim 提示（`[memory] 已更新 N 条（/memory show 查看）`），不打断流式、不弹层；
- 频控保留（同会话 60s ≤3 次，超出合并为计数）；headless 走 stderr 一行，`--quiet` 关闭。

### R7 可选增强：compact 后重建 system prompt

现状（已核对）：system prompt 只在 `startNewSession` 写一次（`src/core/session.ts:176-179`），请求时用内存值，**`resume` 时用磁盘快照覆盖**（`src/core/session.ts:191-194`）。

- 可选：`compactContext` 时用「当前配置 + 当前 skill listing」重建 system prompt，**并同步重写 `<session>/system-prompt.txt`**（否则下次 resume 又变回旧的）；
- 合法性：system 是消息数组首条，同一会话前后两段不同完全合法；compact 场景本来就要作废前缀，无额外缓存代价；
- 状态：不阻塞 memory 主体，作为独立小任务。

### R8 约束 B 的表述修正（§2.2-B）

`search_content` 跳过的是**递归时子目录名以 `.` 开头**的目录（`src/tools/search-content.ts:63`），搜索起点本身不受影响。

- 正确结论：从工作区根搜不到 `.deepseek-arch/memory/`；但显式传 `path: ".deepseek-arch/memory"` **可以**搜到（该目录内的文件名不以 `.` 开头）；
- 因此 B 不是「障碍」，而是「必须有专用工具 + 注入块写明可检索路径」的依据；
- 全局层（`~/.deepseek-arch/memory/`）受约束 A 影响，**只能**经 `memory_search`（core 内直接 `node:fs`）访问。

### R9 约束 C 的用户可见症状（§2.2-C 补充，便于验收）

- 症状 1：`config.toml` 里写了 `[memory] enabled=false` 但程序按默认值跑（读不到 → 用户觉得「我明明关了」）；
- 症状 2：`/memory off` 抛「不支持的配置段」（`set()` 的 `fileMap` 未包含 → 命令失败）；
- 验收：新增配置段后，`cfg.get('memory.enabled')` 与 `/memory off` 写回都必须可用（§9.3 五处清单）。

### R10 待用户拍板（阻塞实施的关键项）

1. 概览行粒度（是否给 confidence/tags）；
2. 「读过的记忆被更新」的判定范围（仅显式读过 vs 所有已注入条目）；
3. memory agent 的模型（跟随 `defaults.model` vs 固定便宜模型）；
4. 现存手写笔记（`.deepseek-arch/memory/*.md` 2 篇）是否做一次迁移归纳，还是永久作为 `legacy/`；
5. compact 后重建 system prompt（R7）是否本期一起做。

---

### R11 【用户决定，2026-09-13】注入统一走 system prompt；**T2/P2/P3/P5 作废**

**决议**：禁止「临时 user 消息」注入形态（原 §6.1 的 T2、§6.5 的 P2/P3/P5）；记忆注入**统一走 system prompt**，按 Claude Code 的方案实现（参考报告 `plan/claude-code-memory-reference.md`）。

| 层 | 载体 | 生效时机 |
|:--|:--|:--|
| **概览（index）** | **system prompt**（追加 `<memory_listing>` 段，风格同现有 `<skill_listing>`） | 会话创建时构建并落盘快照；**重装点** = 新会话 / `compactContext` / 显式 `/memory refresh` |
| **会话内变化** | 默认**不刷新**（接受过期）→ 由 ①模型自己 `memory_search` 拿最新 ②下一次重装点 ③`/memory refresh` 覆盖 | 同左 |

**为什么这个方案在缓存上不亏**（修正 §6.6 的表述）：

- 现状（`src/core/session.ts:176-179` 写快照、`:191-194` resume 复用）**没有任何"会话进行中改写 system prompt"的路径** → 记忆放进 system prompt 只会**过期**，不会造成缓存失效；
- 代价只出现在"重装的那一瞬间"：重装点 = 新会话（无更长前缀可作废，≈0）/ compact（前缀本来就被摘要替换，≈0）/ 会话中任意一轮（**全部历史作废**，禁止）。
- 因此 §6.6 原文「任何变化都让整个长前缀作废」仅在"存在 mid-session 重装点"时成立，**必须加此限定**；本方案通过把重装点绑在"前缀本来就要变"的时刻规避该代价。

**配套（必做）**：

1. `compactContext()` 重建 system prompt 时**同步重写 `<session>/system-prompt.txt`**（否则 resume 回退旧文本）——即 R7 由"可选"升为默认；
2. 概览会进 `system-prompt.txt` 快照（磁盘 + resume 复用）→ **禁止写入敏感内容**；resume 首轮必须用 delta/召回补齐差异；
3. 概览长度受 `max_inject_tokens` 约束（对齐 Claude Code 的 `MEMORY.md` ≤200 行/25KB 的"索引必须短"原则）；
4. 现有 `<skill_listing>` 的注入点与预算写法（`src/cli/index.ts:107-121`、`src/core/skill.ts:507-546`）可直接复用；
5. `resume` 时 system prompt 来自快照 → **新增 skill / 改模板对旧会话不生效**（既有行为，非本设计引入），故 `/memory refresh` 亦可顺带承担"刷新 system prompt"的职责（需一并重写快照）。

**作废标记**（阅读前文时以此为准）：

- §6.1 表格中 **T2（每轮临时块）** 与结论"采纳 T2"→ **作废**；
- §6.5 表格中 **P2 / P3 / P5** → **作废**；新的注入位置 = system prompt（`<memory_listing>` 段）；
- §6.6 的成本对比表（P1/P3 对比）**仅保留其量化方法**，结论行作废；
- §6.2 的"三触发条件 → user 位置块"改为：**重装点驱动**（新会话 / compact / `/memory refresh`）。

### R12 【用户决定】动态内容仍走消息层，但**合并**而非新开消息

虽然概览进 system prompt，但"具体记忆文件内容"与"变化提醒"若也进 system prompt，就等于每次都触发重装（R11 禁止的 mid-session 重装）。因此保留**消息层增量通道**，形态照 Claude Code：

- 载体：**合并进当前 user 消息**的 `<system-reminder>` 块（Claude Code 同款：`wrapMessagesInSystemReminder`，
  `claude-code/utils/messages.ts:3101`；其附件 `relevant_memories` 即这样注入，`utils/attachments.ts:2197-2241`）；
- **不新增独立 user 消息**（既满足"禁止 T2"，也避开"连续两条 `role:user`"在严格交替 provider 上的风险）；
- 不落盘：`buildMessages` 末尾的当前用户消息是**新对象**（`src/core/session.ts:1666-1667`），落盘用的是另一个对象
  `userMsg`（`:602`）→ 请求层改写不污染磁盘/TUI/compact；
- 内容：① 概览 delta（新增/改写/遗忘）② 「你读过的记忆文件被更新」提醒 ③（可选）按需召回的 top-1~2 条全文；
- 去重：采纳 Claude Code 的「已读过滤 + 已出示过滤」，且**compact 后去重集合自然重置**（附件随被压缩的 transcript 消失）。

> 若用户认为"消息层任何注入"都应禁止，则退化为「只在重装点更新」——此时需要明确接受：会话内新写入的记忆对本会话完全不可见（只能靠 `memory_search` 主动拉）。**待确认。**

### R13 参考报告与对照结论

新增 `plan/claude-code-memory-reference.md`：Claude Code 记忆机制的只读调研报告（含 `文件:行号` 证据、目录/文件形态、两条注入通道、缓存断点与"危险刷新 API"、抽取 agent 触发与提示词要点、陈旧治理、用户接口、与我们的对照表）。

从该调研**改主意**的两处：

1. 原 T2/P2（临时 user 消息）→ 废弃（R11/R12）；
2. 原 R7（compact 时重建 system prompt）"可选" → **升为默认**（依据：Claude Code 在 `/clear` 与 `/compact` 明确清段落缓存重算，
   `constants/systemPromptSections.ts:62-67`）。

建议额外采纳（非本次强制）：

- **"危险刷新"显式化**：若将来需要"每轮必须新鲜"的注入点，提供类似 `DANGEROUS_uncachedSystemPromptSection` 的显式 API 并强制写理由，
  避免后来者悄悄每轮刷新把缓存打穿；
- **陈旧提示**：概览行带人话时间（`today` / `3 days ago`）+ "记忆是时间点观察，断言前核对现状"（已列 R4，落实即可）。
