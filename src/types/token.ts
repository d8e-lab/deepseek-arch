/**
 * Token 用量与费用相关类型
 */

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
