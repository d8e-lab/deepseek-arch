# Storage 设计（文件系统）

> 最后更新：2026-05-17 · 实现文件：`src/core/storage.ts`

## 设计动机

原始设计使用 SQLite 三表（sessions/messages/token_usage），但在长上下文场景下，单条 assistant 消息的 `reasoning_content` 可达数十 KB，多轮对话后数据库迅速膨胀。重构为文件系统存储：

- 每个会话独立目录，每轮对话一个 JSON 文件
- 读取时按需加载指定轮次，不加载全库
- 零外部依赖，纯 `node:fs/promises`
- 便于手动查看/编辑/备份

## 目录结构

```
<configDir>/sessions/
└── <session-uuid>/
    ├── meta.json          # 会话元数据
    ├── turn-001.json      # 第 1 轮对话
    ├── turn-002.json      # 第 2 轮对话
    └── ...
```

### meta.json

```json
{
  "id": "a1b2c3d4-...",
  "title": "分析 Rust 内存模型",
  "created_at": "2026-05-17T12:00:00.000Z",
  "updated_at": "2026-05-17T12:30:00.000Z",
  "turnCount": 5,
  "totalCost": 0.0123
}
```

### turn-NNN.json

```json
{
  "turn": 1,
  "user": { "role": "user", "content": "解释 Rust 的 borrow checker" },
  "assistant": {
    "id": "chatcmpl-xxx",
    "role": "assistant",
    "content": "Rust 的 borrow checker 是...",
    "reasoning_content": "用户问 borrow checker，我应该从所有权概念开始..."
  },
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 500,
    "total_tokens": 1700,
    "prompt_cache_hit_tokens": 800,
    "prompt_cache_miss_tokens": 400
  },
  "cost_rmb": 0.0035,
  "created_at": "2026-05-17T12:00:05.000Z"
}
```

## 设计模式：Repository

Storage 封装所有文件 I/O，对外暴露语义化方法，调用方不感知存储细节。

```typescript
const store = new Storage(sessionsDir);
const meta = await store.createSession('我的对话');
const turn = await store.saveTurn(meta.id, userMsg, assistantMsg, usage, cost);
```

## API

### Sessions

| 方法 | 说明 |
|------|------|
| `createSession(title?)` | 创建目录 + meta.json，返回 SessionMeta |
| `getSession(id)` | 读取 meta + 所有 turn，返回完整 Session |
| `getSessionByName(name)` | 遍历目录，按标题精确匹配 |
| `listSessions()` | 列出所有会话（按 updated_at 降序） |
| `updateSessionTitle(id, title)` | 更新 meta.json 中标题 |
| `deleteSession(id)` | 删除会话目录（先检查存在性） |

### Turns

| 方法 | 说明 |
|------|------|
| `saveTurn(sessionId, user, assistant, usage, cost)` | 写入 turn-NNN.json，自动递增序号，更新 meta |
| `getTurns(sessionId)` | 读取目录下所有 turn-NNN.json |

### 费用

| 方法 | 说明 |
|------|------|
| `getTotalCost(sessionId)` | 从 meta.json 读取累计费用（由 saveTurn 维护） |

## 关键设计决策

### 轮次序号自动递增

`saveTurn()` 先读取现有 turn 文件数量，序号 = count + 1。文件名 `turn-NNN.json` 用 3 位填充（`String(n).padStart(3, '0')`），字母序即轮次顺序。

### meta 中的计数字段

`turnCount` 和 `totalCost` 由 `saveTurn()` 维护并写入 meta.json。`getTotalCost()` 直接读 meta 避免遍历所有 turn。

### 会话隔离

每个会话独立目录，删除即 `rm -rf` 目录。不同会话互不干扰。

### 错误处理

- 不存在的会话：`getSession()` 返回 null，`saveTurn()` 抛出 Error
- 不存在的目录：`readJSON()` 捕获 ENOENT 返回 null
- `deleteSession()` 先 `access()` 检查存在性（`rm -rf` 对不存在目录静默成功）

## 与 SQLite 版本对比

| 维度 | SQLite (v0.2.0) | 文件系统 (v0.2.1) |
|------|-----------------|-------------------|
| 依赖 | better-sqlite3 (native addon) | node:fs/promises (零外部依赖) |
| 膨胀风险 | 单表多轮后膨胀 | 每轮独立文件，按需读取 |
| 查询 | SQL JOIN | 目录遍历 + JSON.parse |
| 可手动查看 | 需要 sqlite3 CLI | 直接 cat/less |
| 备份 | 复制 .db 文件 | tar/rsync 目录 |
| 测试 | :memory: 内存数据库 | 临时目录 |

## 测试

23 个单元测试覆盖：Sessions CRUD（创建/获取/按名查找/列表/更新/删除）、Turns CRUD（保存/多轮递增/meta同步/空轮次）、费用统计、边界情况（50 轮大量读写、50KB 长内容、特殊字符、会话隔离）。
