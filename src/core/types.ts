/**
 * 核心类型定义 — deepseek-arch
 *
 * 所有领域模型集中定义在此文件，避免循环依赖。
 * 类型命名遵循 PascalCase；接口只描述数据结构不含行为。
 */

// ─── 消息与对话 ─────────────────────────────────────

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant';

/** 单条对话消息 */
export interface Message {
  /** 角色：system / user / assistant */
  role: MessageRole;
  /** 消息正文 */
  content: string;
  /**
   * 模型思维链内容（reasoning_content）
   * 持久化以命中供应商的 prompt kv-cache
   */
  reasoning_content?: string;
}

/** 持久化消息（含数据库元数据） */
export interface MessageRecord extends Message {
  id: number;
  session_id: string;
  created_at: string; // ISO 8601
}

// ─── Token 用量与费用 ────────────────────────────────

/** DeepSeek API 返回的 usage 段 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** 缓存命中 token 数 */
  prompt_cache_hit_tokens?: number;
  /** 缓存未命中 token 数 */
  prompt_cache_miss_tokens?: number;
}

/** 持久化 token 用量记录 */
export interface TokenUsageRecord extends TokenUsage {
  id: number;
  message_id: number;
  cost_rmb: number;
  created_at: string;
}

/** 费用计算结果 */
export interface CostBreakdown {
  /** 缓存命中 token 费用 */
  cacheHitCost: number;
  /** 缓存未命中 token 费用 */
  cacheMissCost: number;
  /** 输出 token 费用 */
  outputCost: number;
  /** 本轮总费用 (CNY) */
  totalCost: number;
  /** 缓存命中率 (0-1) */
  cacheHitRate: number;
  /** 本轮 token 用量 */
  usage: TokenUsage;
}

// ─── 会话 ────────────────────────────────────────────

/** 会话元数据（不含消息体） */
export interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** 完整会话（含消息记录 + token 记录） */
export interface Session {
  meta: SessionMeta;
  messages: MessageRecord[];
  tokenUsages: TokenUsageRecord[];
}

/** 会话列表项（用于 resume 列表展示） */
export interface SessionListItem {
  index: number;
  id: string;
  title: string;
  updated_at: string;
  messageCount: number;
}

// ─── 配置 ────────────────────────────────────────────

/** 单一模型供应商 */
export interface ProviderConfig {
  base_url: string;
  api_key: string;
}

/** 各供应商配置映射 */
export type ProvidersConfig = Record<string, ProviderConfig>;

/** 单模型价格（单位：CNY / 1M tokens） */
export interface ModelPricing {
  input_cache_hit: number;
  input_cache_miss: number;
  output: number;
  currency: string;
}

/** 供应商 → 模型 → 价格 */
export type PricingConfig = Record<string, Record<string, ModelPricing>>;

/** System Prompt 模板 */
export interface SystemPromptTemplate {
  content: string;
}

export type SystemPromptConfig = Record<string, SystemPromptTemplate>;

/** 配置文件跳转引用 */
export interface ConfigPaths {
  providers: string;
  pricing: string;
  system_prompt: string;
  db: string;
}

/** 默认配置 */
export interface ConfigDefaults {
  provider: string;
  model: string;
  /** system prompt 模板名 */
  system_prompt: string;
}

/** 主配置（config.toml） */
export interface AppConfig {
  paths: ConfigPaths;
  defaults: ConfigDefaults;
}

/** 完整有效配置（合并所有引用文件后） */
export interface ResolvedConfig {
  paths: ConfigPaths;
  defaults: ConfigDefaults;
  providers: ProvidersConfig;
  pricing: PricingConfig;
  systemPrompts: SystemPromptConfig;
}

// ─── API ─────────────────────────────────────────────

/** DeepSeek Chat Completion 请求体 */
export interface ChatCompletionRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

/** DeepSeek Delta (流式) */
export interface StreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
}

/** DeepSeek Choice */
export interface ChatChoice {
  index: number;
  message?: Message;
  delta?: StreamDelta;
  finish_reason: string | null;
}

/** DeepSeek Chat Completion 响应体 */
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: TokenUsage;
}
