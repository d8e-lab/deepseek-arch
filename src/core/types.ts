/**
 * 核心类型定义 — deepseek-arch
 *
 * 所有领域模型集中定义在此文件，避免循环依赖。
 * 类型命名遵循 PascalCase；接口只描述数据结构不含行为。
 */

// ─── 消息与对话 ─────────────────────────────────────

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

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
  /**
   * 工具调用 ID（为 agent tool call 预留）
   */
  tool_call_id?: string;
  /** 工具名称（为 agent tool call 预留） */
  name?: string;
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

/** 一轮对话（user + assistant + usage + cost） */
export interface TurnRecord {
  /** 轮次序号（从 1 开始） */
  turn: number;
  /** 用户消息 */
  user: Message;
  /** 助手回复 */
  assistant: {
    /** API 返回的 response id */
    id: string;
    role: 'assistant';
    content: string;
    reasoning_content?: string;
  };
  /** Token 用量 */
  usage?: TokenUsage;
  /** 本轮费用 (CNY) */
  cost_rmb: number;
  /** 创建时间 */
  created_at: string;
}

/** 会话元数据（不含消息体） */
export interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** 轮次数 */
  turnCount: number;
  /** 累计费用 (CNY) */
  totalCost: number;
  /** 最后一轮对话的 token 用量（用于退出汇总，无需加载全量 turns） */
  lastUsage?: TokenUsage;
}

/** 会话列表项（用于 resume 列表展示） */
export interface SessionListItem {
  index: number;
  id: string;
  title: string;
  updated_at: string;
  turnCount: number;
}

/** 完整会话（含所有轮次） */
export interface Session {
  meta: SessionMeta;
  turns: TurnRecord[];
  systemPrompt?: string;
}

/** 加载会话时使用的会话数据 */
export type SessionData = Session;

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
  /** 会话存储目录（相对于配置目录） */
  sessions: string;
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

// ─── 错误 ─────────────────────────────────────────────

/** API 错误响应（JSON body） */
export interface ApiErrorBody {
  message?: string;
  type?: string;
  code?: string;
}

/** API 调用错误 */
export class ApiError extends Error {
  /** HTTP 状态码 */
  status: number;
  /** API 错误码（如 "invalid_api_key"） */
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}