/**
 * 配置相关类型
 */

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
