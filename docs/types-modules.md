# types/ 模块文档

> 创建于 2026-05-18 · 类型模块拆分后的完整文档

## 模块定位

类型模块在重构后从旧的单文件类型定义拆分为 `src/types/` 目录（6 个文件，总计 ~300 行）。所有类型**零行为**（只有接口定义），唯一的类是 `ApiError`（继承 Error）。

## 目录结构

```
src/types/
├── index.ts     # 重新导出所有类型（兼容旧 import 路径）
├── chat.ts      # 消息与对话
├── session.ts   # 会话
├── config.ts    # 配置
├── api.ts       # API 请求/响应 + ApiError 类
└── token.ts     # Token 用量与费用
```

## 文件间依赖关系

```
token.ts  ─── (无依赖)
   ↑
chat.ts  ─── 依赖 token.ts (TurnRecord 使用 TokenUsage)
   ↑
session.ts ─ 依赖 chat.ts + token.ts (Session 使用 TurnRecord + lastUsage)
   ↑
api.ts ──── 依赖 chat.ts + token.ts (ChatChoice 使用 Message, response 使用 TokenUsage)
   ↑
config.ts ── (无依赖)
```

无循环依赖。

---

## `src/types/token.ts`（30 行）

**用途**：独立的 Token 用量和费用类型，不依赖其他类型文件。

### 类型清单

| 类型 | 种类 | 用途 |
|------|------|------|
| `TokenUsage` | interface | DeepSeek API 响应中 `usage` 段的类型定义，记录输入/输出/cache命中/miss 的 token 数量 |
| `CostBreakdown` | interface | 费用计算结果，包含命中/未命中/输出三项费用拆分 + 总费用 + 缓存命中率 |

### CostBreakdown 内部

```typescript
interface CostBreakdown {
  cacheHitCost: number;    // 缓存命中 token 费用 (CNY)
  cacheMissCost: number;   // 缓存未命中 token 费用 (CNY)
  outputCost: number;      // 输出 token 费用 (CNY)
  totalCost: number;       // 本轮总费用
  cacheHitRate: number;    // 缓存命中率 0-1
  usage: TokenUsage;       // 引用的 TokenUsage
}
```

### 被哪些文件引用

```
← chat.ts       (TurnRecord.usage?: TokenUsage, StreamEvent.usage?: TokenUsage)
← session.ts    (SessionMeta.lastUsage?: TokenUsage)
← api.ts        (ChatCompletionResponse.usage?, StreamChunk.usage?)
← storage.ts    (saveTurn 参数, getTurns 返回)
← session.ts    (sendMessage 内部)
```

---

## `src/types/chat.ts`（62 行）

**用途**：消息和对话的类型定义，是所有 API 调用和存储的基石。

### 类型清单

| 类型 | 种类 | 用途 |
|------|------|------|
| `MessageRole` | type (字面量联合) | `'system' \| 'user' \| 'assistant' \| 'tool'`，限制消息角色值 |
| `Message` | interface | 单条对话消息，是 APIClient.chat() 和 chatStream() 的请求体基本单元 |
| `TurnRecord` | interface | 一轮完整对话的持久化记录（用户输入 + 助手回复 + token 用量 + 费用 + 中断标记） |
| `StreamEvent` | interface | SessionManager.sendMessageStream() 回调事件，ChatUI 据此增量更新渲染 |

### Message 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `MessageRole` | 必填，标识消息来源 |
| `content` | `string` | 必填，消息正文 |
| `reasoning_content?` | `string` | 可选，模型的思维链。持久化后发送回 API 以命中 DeepSeek 的 prompt kv-cache |
| `tool_call_id?` | `string` | 预留，agent tool call |
| `name?` | `string` | 预留，工具名称 |

### TurnRecord 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `turn` | `number` | 从 1 递增的轮次序号 |
| `user` | `Message` | 用户本轮输入（role 固定为 user） |
| `assistant` | `{ id, role, content, reasoning_content? }` | 内联的assistant消息，含 API response id |
| `usage?` | `TokenUsage` | 可选。仅在最后一轮保留，历史轮次被 saveTurn 清空 |
| `cost_rmb` | `number` | 本轮费用 ¥，Phase 7 前为 0 |
| `created_at` | `string` | ISO 8601 时间戳 |
| `interrupted?` | `boolean` | true 表示被用户中断的不完整轮次，buildMessages 会跳过 |

### StreamEvent 类型说明

| type | text? | usage? | error? | 触发时机 |
|------|-------|--------|--------|---------|
| `reasoning_delta` | 模型思考增量文本 | — | — | 收到 SSE chunk 的 reasoning_content |
| `content_delta` | 模型回复增量文本 | — | — | 收到 SSE chunk 的 content |
| `done` | — | 完整 TokenUsage | — | SSE 流结束（含 [DONE] 标记） |
| `error` | — | — | 错误描述 | API 错误 / 重试耗尽 / 用户中断 |

### 被哪些文件引用

```
← session.ts       (StreamEvent 定义在此?  不，在 chat.ts，session.ts import 后重新 export)
← session.ts       (sendMessage/sendMessageStream 返回 TurnRecord | null)
← api.ts           (chat/chatStream 参数使用 Message[])
← storage.ts       (saveTurn/getTurns 使用 TurnRecord)
← chat-ui.ts       (Message, ChatCompletionResponse — 后者在 api.ts 中)
```

---

## `src/types/session.ts`（39 行）

**用途**：会话级别类型，描述整个对话的结构。

### 类型清单

| 类型 | 种类 | 用途 |
|------|------|------|
| `SessionMeta` | interface | 会话元数据，保存在 meta.json 中 |
| `SessionListItem` | interface | 列表展示项（resume 子命令无参数时的表格展示） |
| `Session` | interface | 完整会话 = 元数据 + 所有轮次 + 可选系统提示 |
| `SessionData` | type 别名 | `= Session`，兼容旧名 |

### SessionMeta 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | UUID v4，会话唯一标识 |
| `title` | `string` | 会话标题，/title 命令修改 |
| `created_at` | `string` | 创建时间 |
| `updated_at` | `string` | 最后修改时间（每次 saveTurn 或 updateTitle 更新） |
| `turnCount` | `number` | 轮次数，由 saveTurn 维护 |
| `totalCost` | `number` | 累计费用 ¥，各轮 cost_rmb 累加 |
| `lastUsage?` | `TokenUsage` | 最后一轮用量，exitSummary 时直接读 meta 无需加载全量 turns |

### 被哪些文件引用

```
← storage.ts       (全部：CRUD 操作)
← session.ts       (getSession, resumeSession 返回 Session)
```

---

## `src/types/config.ts`（62 行）

**用途**：配置系统类型，与 ConfigManager 的 TOML 文件结构一一对应。

### 类型清单

| 类型 | 种类 | 对应 TOML 文件 |
|------|------|---------------|
| `ProviderConfig` | interface | providers.toml 中单个供应商 |
| `ProvidersConfig` | type | `Record<string, ProviderConfig>`，整个 providers.toml |
| `ModelPricing` | interface | pricing.toml 中单个模型价格 |
| `PricingConfig` | type | `Record<string, Record<string, ModelPricing>>`，整个 pricing.toml |
| `SystemPromptTemplate` | interface | system-prompt.toml 中单个模板 |
| `SystemPromptConfig` | type | `Record<string, SystemPromptTemplate>`，整个 system-prompt.toml |
| `ConfigPaths` | interface | config.toml 的 `[paths]` 段 |
| `ConfigDefaults` | interface | config.toml 的 `[defaults]` 段 |
| `AppConfig` | interface | 整个 config.toml = paths + defaults |
| `ResolvedConfig` | interface | 合并所有 TOML 后的完整内存配置 |

### 引用关系

```
← config.ts (ConfigManager 的 load/resolved/get/set 方法全部使用这些类型)
```

---

## `src/types/api.ts`（88 行）

**用途**：DeepSeek Chat Completion API 的请求/响应格式，以及错误类型。

### 类型清单

| 类型 | 种类 | 用途 |
|------|------|------|
| `ChatCompletionRequest` | interface | POST 请求体格式（model + messages + stream + 可选参数） |
| `StreamDelta` | interface | 流式响应中 choice.delta 的格式 |
| `ChatChoice` | interface | 单条 choice（非流式：message；流式：delta） |
| `ChatCompletionResponse` | interface | 非流式完整响应体 |
| `StreamChunk` | interface | 流式 SSE 的 data 行解析结果 |
| `StreamOptions` | interface | 流式调用配置（超时、重试、中断信号） |
| `ApiErrorBody` | interface | API 错误响应的 JSON body |
| `ApiError` | **class** | API 错误的运行时表示（HTTP status + 可选错误码） |

### ApiError 类说明

```
extends Error
└─ name = 'ApiError'
└─ status: number        // HTTP 状态码（401, 429, 500 等）
└─ code?: string         // DeepSeek 错误码（如 "invalid_api_key"）
```

区分 ApiError 和普通 Error：
- **ApiError** → HTTP 4xx，不重试，直接向上抛
- **普通 Error** → 网络错误/超时/5xx，触发重试机制

### 被哪些文件引用

```
← api.ts          (ApiClient 使用全部 API 类型)
← session.ts      (ChatCompletionResponse, StreamChunk)
← chat-ui.ts      (ChatCompletionResponse)
← api.test.ts     (ApiClient, ApiError, 类型引用)
```

---

## `src/types/index.ts`（57 行）

**用途**：重新导出所有类型。提供单一入口 `../types/index.js`，兼容旧 import 路径。

### 导出策略

- 所有 interface/type → `export type { ... }`
- `ApiError`（class）→ `export { ApiError }`（值导出）

### 新路径映射

| 旧路径 | 新路径 |
|--------|--------|
| `../core/types.js` | `../types/index.js` |
| `./types.js` | `../types/index.js` |

若需精确导入（不引入未使用的类型），可直接引用子文件：

```typescript
import type { Message } from '../types/chat.js';
import { ApiError } from '../types/api.js';
```
