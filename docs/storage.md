# Storage 设计（文件系统）

> 最后更新：2026-05-18 · 实现文件：`src/core/storage.ts`

## 设计动机

所有轮次写入单个 JSON 文件，仅最后一轮保留 token 用量以节省磁盘。零外部依赖，纯 `node:fs/promises`，便于手动查看和备份。

## 目录结构

```
<configDir>/sessions/
└── <session-uuid>/
    ├── meta.json          # 会话元数据（含 lastUsage）
    └── turns.json         # 全部轮次（数组格式）
```

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
