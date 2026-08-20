/**
 * 配置相关类型
 */

/** 单一模型供应商 */
export interface ProviderConfig {
	base_url: string;
	api_key: string;
	/** 请求超时（毫秒），默认 120_000 */
	timeout_ms?: number;
	/** 最大重试次数，默认 2 */
	max_retries?: number;
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
	/** YOLO 审查模型名（默认 deepseek-v4-flash） */
	review_model?: string;
	/** 默认 temperature（思考模式下不生效） */
	temperature?: number;
	/** 默认 max_tokens（输出上限） */
	max_tokens?: number;
	/** 推理强度：low / high / max */
	reasoning_effort?: 'low' | 'high' | 'max';
	/** 思考模式：enabled / disabled */
	thinking?: 'enabled' | 'disabled';
	/** YOLO 模式（自动批准工具执行） */
	yolo?: boolean;
	/** 子代理异步模式 */
	async?: boolean;
	/** 自动 compact（上下文超阈值时自动压缩，默认开启） */
	auto_compact?: boolean;
	/** 自动 compact 触发阈值（0~1，占 context_window 比例，默认 0.7） */
	auto_compact_threshold?: number;
	/** 上下文窗口大小（tokens，DeepSeek v4 为 1_000_000） */
	context_window?: number;
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
