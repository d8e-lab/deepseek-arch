# 类型体系设计

> 最后更新：2026-05-18 · 实现文件：`src/core/types.ts`

## 设计原则

- **集中定义**：所有领域类型集中在 `types.ts`，避免循环依赖
- **纯数据结构**：interface 只描述数据形状，不含行为方法
- **PascalCase 命名**：类型名用 PascalCase，字段用 snake_case（与 API/JSON 一致）

## 类型分类

### 消息与对话

```typescript
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';  // tool 为 agent 预留

interface Message {
  role: MessageRole;
  content: string;
  reasoning_content?: string;  // 模型思维链，持久化命中 kv-cache
  tool_call_id?: string;       // 工具调用 ID（为 agent tool call 预留）
  name?: string;               // 工具名称（为 agent tool call 预留）
}
```

### Token 用量与费用

```typescript
interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;   // 缓存命中
  prompt_cache_miss_tokens?: number;  // 缓存未命中
}

interface CostBreakdown {
  cacheHitCost: number;
  cacheMissCost: number;
  outputCost: number;
  totalCost: number;
  cacheHitRate: number;   // 0-1
  usage: TokenUsage;
}
```

### 会话

```typescript
// 一轮对话 = user + assistant + usage + cost
interface TurnRecord {
  turn: number;
  user: Message;
  assistant: {
    id: string;           // API response id (chatcmpl-xxx)
    role: 'assistant';
    content: string;
    reasoning_content?: string;
  };
  usage?: TokenUsage;     // 仅最后一轮携带用法统计
  cost_rmb: number;
  created_at: string;
  interrupted?: boolean;  // true = 中断的不完整轮次，不发送给 API
}

// 会话元数据
interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turnCount: number;
  totalCost: number;
  lastUsage?: TokenUsage; // 最后一轮用量，退出时展示无需加载全量 turns
}

// 完整会话
interface Session {
  meta: SessionMeta;
  turns: TurnRecord[];
  systemPrompt?: string;
}

// 会话列表项（resume 列表展示用）
interface SessionListItem {
  index: number;
  id: string;
  title: string;
  updated_at: string;
  turnCount: number;
}
```

### 配置

```typescript
// 供应商
interface ProviderConfig {
  base_url: string;
  api_key: string;
}
type ProvidersConfig = Record<string, ProviderConfig>;

// 价格
interface ModelPricing {
  input_cache_hit: number;
  input_cache_miss: number;
  output: number;
  currency: string;
}
type PricingConfig = Record<string, Record<string, ModelPricing>>;

// System Prompt
interface SystemPromptTemplate { content: string }
type SystemPromptConfig = Record<string, SystemPromptTemplate>;

// 配置路径（文件跳转）
interface ConfigPaths {
  providers: string;
  pricing: string;
  system_prompt: string;
  sessions: string;
}

// 主配置
interface AppConfig {
  paths: ConfigPaths;
  defaults: ConfigDefaults;
}

// 完整合并后配置
interface ResolvedConfig {
  paths: ConfigPaths;
  defaults: ConfigDefaults;
  providers: ProvidersConfig;
  pricing: PricingConfig;
  systemPrompts: SystemPromptConfig;
}
```

### API

```typescript
interface ChatCompletionRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

interface StreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
}

interface ChatChoice {
  index: number;
  message?: Message;
  delta?: StreamDelta;
  finish_reason: string | null;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: TokenUsage;
}
```

### 流式 API

```typescript
/** SSE 流式块（DeepSeek API text/event-stream 单条 data） */
interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: TokenUsage;
}

/** 流式调用选项 */
interface StreamOptions {
  timeoutMs?: number;      // 默认 120_000
  maxRetries?: number;     // 默认 2（指数退避，4xx 不重试）
  signal?: AbortSignal;    // 外部 AbortController（用户中断）
}
```

### 流式事件（SessionManager → ChatUI）

```typescript
/** 流式事件回调 */
interface StreamEvent {
  type: 'reasoning_delta' | 'content_delta' | 'done' | 'error';
  text?: string;           // 增量文本（reasoning_delta / content_delta）
  usage?: TokenUsage;      // token 用量（done 事件）
  error?: string;          // 错误信息（error 事件）
}
```

### 错误

```typescript
/** API 错误响应（JSON body） */
interface ApiErrorBody {
  message?: string;
  type?: string;
  code?: string;
}

/** API 调用错误 */
class ApiError extends Error {
  status: number;          // HTTP 状态码
  code?: string;           // API 错误码（如 "invalid_api_key"）
}
```

## 类型演进历史

| 版本 | 变更 |
|------|------|
| v0.1.0 | 初始定义：Message, MessageRecord, TokenUsage, TokenUsageRecord, Session, SessionMeta, 配置接口, API 接口 |
| v0.2.1 | 移除 MessageRecord/TokenUsageRecord（SQLite 专用），新增 TurnRecord；Session 改用 turns[]；SessionMeta 新增 turnCount/totalCost；ConfigPaths.db → sessions |
| v0.4.0 | 新增 StreamChunk, StreamOptions, StreamEvent 流式类型；TurnRecord.interrupted？中断支持；SessionMeta.lastUsage？延迟加载优化；Message.role 新增 'tool' 预留；Message.tool_call_id/name 预留字段；新增 ApiError/ApiErrorBody 错误类型；TurnRecord.usage 变更为可选（仅末轮保留） |
