/**
 * Types — 重新导出所有领域类型
 *
 * 兼容旧导入路径：import { Message } from '../types/index.js'
 */

// ─── chat ────────────────────────────────────────────
export type {
	MessageRole,
} from './chat.js';
export type {
	Message,
	TurnRecord,
	StreamEvent,
	RoundUsage,
	ReviewVerdict,
} from './chat.js';

// ─── session ─────────────────────────────────────────
export type {
	SessionMeta,
	Session,
	SessionListItem,
	SessionData,
} from './session.js';

// ─── config ──────────────────────────────────────────
export type {
	ProviderConfig,
	ProvidersConfig,
	ModelPricing,
	PricingConfig,
	SystemPromptTemplate,
	SystemPromptConfig,
	ConfigPaths,
	ConfigDefaults,
	AppConfig,
	ResolvedConfig,
} from './config.js';

// ─── api ─────────────────────────────────────────────
export type {
	ChatCompletionRequest,
	ToolDefinition,
	ToolCallDelta,
	ToolCall,
	StreamDelta,
	ChatChoice,
	ChatCompletionResponse,
	StreamChunk,
	StreamOptions,
	ApiErrorBody,
} from './api.js';
export {
	ApiError,
} from './api.js';

// ─── token ───────────────────────────────────────────
export type {
	TokenUsage,
	CostBreakdown,
} from './token.js';
