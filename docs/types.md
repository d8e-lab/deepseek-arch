# 类型体系设计

> 最后更新：2026-05-17 · 实现文件：`src/core/types.ts`

## 设计原则

- **集中定义**：所有领域类型集中在 `types.ts`，避免循环依赖
- **纯数据结构**：interface 只描述数据形状，不含行为方法
- **PascalCase 命名**：类型名用 PascalCase，字段用 snake_case（与 API/JSON 一致）

## 类型分类

### 消息与对话

```typescript
type MessageRole = 'system' | 'user' | 'assistant';

interface Message {
  role: MessageRole;
  content: string;
  reasoning_content?: string;  // 模型思维链，持久化命中 kv-cache
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
  usage: TokenUsage;
  cost_rmb: number;
  created_at: string;
}

// 会话元数据
interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turnCount: number;
  totalCost: number;
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

## 类型演进历史

| 版本 | 变更 |
|------|------|
| v0.1.0 | 初始定义：Message, MessageRecord, TokenUsage, TokenUsageRecord, Session, SessionMeta, 配置接口, API 接口 |
| v0.2.1 | 移除 MessageRecord/TokenUsageRecord（SQLite 专用），新增 TurnRecord；Session 改用 turns[]；SessionMeta 新增 turnCount/totalCost；ConfigPaths.db → sessions |
