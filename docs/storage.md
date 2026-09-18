# Storage 设计（文件系统）

> 最后更新：2026-09-15 · 实现文件：`src/core/storage.ts`、`src/core/memory-store.ts`

## 设计动机

所有轮次写入单个 JSON 文件，仅最后一轮保留 token 用量以节省磁盘。零外部依赖，纯 `node:fs/promises`，便于手动查看和备份。

## 目录结构

```
<configDir>/sessions/
└── <session-uuid>/
    ├── meta.json          # 会话元数据（含 lastUsage）
    ├── turns.json         # 全部轮次（v2 格式；分代时改用 turn_<gen>.json）
    ├── system-prompt.txt  # 会话创建时的 system prompt 快照（resume 复用，命中 KV cache）
    ├── memory-cursor.json # 记忆归纳游标（按会话；{ cursor: "N" }）
    ├── cache.log          # 缓存命中率日志（追加式）
    └── subagents/<name>/  # 子代理运行记录
        ├── meta.json      # 状态/时间/轮数/system prompt
        └── turn_0.json    # 逐轮运行（每轮自己的 messages delta + entries + status）
```

## 工作区 runtime 目录（`{workspace}/.deepseek-arch/`）

与上面的「配置/会话目录」（`~/.deepseek-arch/`）不同，**agent 在工作区内产生的所有 runtime 文件**
统一放在 `{workspace}/.deepseek-arch/` 下，**不参与版本控制**（仓库 `.gitignore` 已忽略）：

```
{workspace}/.deepseek-arch/
├── plan/                 # 规划文档（save_plan 写入；compact 从此处读回重注入）
├── memory/               # 项目层记忆（见下方"记忆目录布局"）
├── api-requests/         # API 镜像落盘（deepseek-arch api-monitor）
└── agent-file-state.json # 文件改动标记（read_file 后 mtime/size 记录，防陈旧编辑）
```

- `{workspace}` = `DEEPSEEK_ARCH_SESSION_CWD`（SessionManager 构造时锁定）→ 未设置时回退 `process.cwd()`；
  CLI 可用 `--workspace <dir>` 覆盖（须在进程启动早期生效）。
- 路径解析单一入口：`src/core/workspace-paths.ts`（`getRuntimeDir` / `getPlanDir` / `getMemoryDir` /
  `getApiRequestsDir` / `getFileStatePath`）。
- 全局层记忆是例外：放 `~/.deepseek-arch/memory/`（跨项目偏好），只能经 `memory_read` 工具读取
  （普通 `read_file` 受 workspace 沙箱限制读不到）。

### 记忆目录布局（项目层/全局层同构）

```
{workspace}/.deepseek-arch/memory/
├── manifest.json        **总表（harness 工作集）**：条目元数据 + usage + 活动日；进程内读写的唯一入口
├── MEMORY.md            派生索引：正式条目（confidence ≥ 阈值）；注入清单与之同源（renderManifestLine）
├── candidates.md        派生索引：候选区（confidence 0/1 = 待观察 / 待销毁），不注入
├── <slug>.md            主题文件：frontmatter（confidence/status/subject/type/tags/updated[/pinned]）+ 正文
├── state.json           旧版运行时状态（活动日/usage）——仅总表缺失时**一次性导入**，不再写入
├── audit.jsonl          追加式审计（write/merge/supersede/forget/use/pin/agent_run/lru/inject/error）
├── .memory.lock         写入互斥锁（跨进程；存在与否是瞬时的，不参与版本控制）
├── logs/yyyy/mm/dd.md   原始观察日志（`appendLog()` 有实现，当前无调用方 —— 见 docs/todo A4）
└── legacy/              用户手写笔记（无 frontmatter，不进索引）
    └── archive/         **销毁**的条目（`lru_destroy_mode = "archive"` 时移入此处；不物理删除）
```

**总表与工作集**（v3 起，见 `docs/memory-algorithm.md` §3.4/§4）：

```jsonc
{ "version": 1, "updatedAt": "...", "activeDayCount": 42, "lastActiveDate": "2026-09-15",
  "entries": [ /* 元数据，不含正文 */ ], "usage": { "<slug>": { "uses": 2, "lastUsedAt": "..." } } }
```

- 决策（可见性 / LRU / 召回 / 注入）只需要元数据 → 全部放总表，进程内作为**工作集**；
  **正文只存在 `<slug>.md`**，仅"读全文"时按需读取（单条上限 64KB，超出截断并提示）。
- 缺失/损坏时从主题文件**全量重建并写回**（自愈）；其它进程写入通过总表 mtime 检测重载。
- 写操作（写入/遗忘/结算/钉住）在层目录上取 `.memory.lock` 串行执行；读路径不取锁。
- **索引是派生的**：`MEMORY.md` / `candidates.md` 由工作集随时可重建（`rebuildIndex`），
  写入路径（`write`/`forget`/`setPinned`/`reconcile`）内部自动同步，调用方无需手动刷新。
- **"待销毁"= `confidence: 0`**（写在条目 frontmatter 里，可 grep）；销毁期限见 `lru_destroy_after_days`。
- 归纳游标**不再放在这里**：已改为按会话存放（`<sessionDir>/memory-cursor.json`），避免跨会话互相覆盖。
- 生命周期细节（活动日时钟、窗口/容量、档位升降级）见 `plan/memory-heartbeat-design.md` §4。

### meta.json

```json
{
  "id": "a1b2c3d4-...",
  "title": "分析 Rust 内存模型",
  "created_at": "2026-05-17T12:00:00.000Z",
  "updated_at": "2026-05-17T12:30:00.000Z",
  "turnCount": 5,
  "totalCost": 0.0123,
  "lastUsage": {
    "prompt_tokens": 1200,
    "completion_tokens": 500,
    "total_tokens": 1700
  }
}
```

### turns.json

```json
[
  {
    "turn": 1,
    "user": { "role": "user", "content": "解释 Rust 的 borrow checker" },
    "assistant": {
      "id": "chatcmpl-xxx",
      "role": "assistant",
      "content": "Rust 的 borrow checker 是...",
      "reasoning_content": "用户问 borrow checker，我应该从所有权概念开始..."
    },
    "cost_rmb": 0.0035,
    "created_at": "2026-05-17T12:00:05.000Z"
  }
]
```

> 仅最后一轮保留 `usage` 字段，历史轮次的 `usage` 在 `saveTurn` 时自动清空以减少冗余。

## 设计模式：Repository

Storage 封装所有文件 I/O，对外暴露语义化方法，调用方不感知存储细节。

```typescript
const store = new Storage(sessionsDir);
const meta = await store.createSession('我的对话');
const turn = await store.saveTurn(meta.id, userMsg, assistantMsg, usage, cost, interrupted);
```

## API

### Sessions

| 方法 | 说明 |
|------|------|
| `createSession(title?)` | 创建目录 + meta.json，返回 SessionMeta |
| `getSession(id)` | 读取 meta + 所有 turn，返回完整 Session（自动同步计数字段） |
| `getSessionByName(name)` | 遍历目录，按标题精确匹配 |
| `listSessions()` | 列出所有会话（按 updated_at 降序） |
| `updateSessionTitle(id, title)` | 更新 meta.json 中标题 |
| `deleteSession(id)` | 删除会话目录（先检查存在性） |

### Turns

| 方法 | 说明 |
|------|------|
| `saveTurn(sessionId, user, assistant, usage, cost, interrupted?)` | 写入 turns.json（追加 + 清空旧 usage），自动递增序号，更新 meta |
| `getTurns(sessionId)` | 从 turns.json 读取所有轮次 |

### 费用

| 方法 | 说明 |
|------|------|
| `getTotalCost(sessionId)` | 从 meta.json 读取累计费用（由 saveTurn 维护） |

## 关键设计决策

### 单文件 turns.json

`saveTurn()` 读取现有 turns.json（如不存在则创建空数组），追加新 turn，清空历史轮次的 `usage` 字段，写回文件。文件名固定为 `turns.json`。

### meta 维护统计

`saveTurn()` 更新 `meta.json` 中的 `turnCount`、`totalCost`、`lastUsage`。`getSession()` 自动校验 `turnCount` 是否匹配实际轮次数量，不一致时重新计算。

### 中断轮次

`saveTurn()` 接受可选的 `interrupted` 参数，持久化时写入 `interrupted: true`。中断轮次保留在显示中不会被发送回 API。

### 会话隔离

每个会话独立目录，删除即 `rm -rf` 目录。不同会话互不干扰。

### 错误处理

- 不存在的会话：`getSession()` 返回 null，`saveTurn()` 抛出 Error
- 不存在的目录：`readJSON()` 捕获 ENOENT 返回 null
- `deleteSession()` 先 `access()` 检查存在性

## 测试

25 个单元测试覆盖：Sessions CRUD（创建/获取/按名查找/列表/更新/删除）、Turns CRUD（单轮/多轮递增/saveTurn 清空旧 usage/meta同步/中断轮次持久化）、费用统计、边界情况（50 轮大量读写、50KB 长内容、特殊字符、会话隔离）。
