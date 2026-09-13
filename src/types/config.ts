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
	/** 上下文窗口大小（tokens）：数字或带单位写法（如 "1M"/"256K"，十进制），默认 1M */
	context_window?: number | string;
}

/** 单档展示参数覆盖（display.overrides.<mode>，snake_case 与 TOML 键一致） */
export interface DisplayOverrideConfig {
	/** 实时 think 可见行数（超出折叠，Ctrl+O 查看完整） */
	think_live_lines?: number;
	/** 是否逐行展示工具实时输出 */
	show_live_tool_output?: boolean;
	/** 工具结果最多显示行数（0 = 不显示内容） */
	tool_result_max_lines?: number;
	/** 是否隐藏非文件修改工具的结果内容（只显示调用与成败标记） */
	hide_non_file_tool_result?: boolean;
}

/** [display] 段：展示模式与各档位参数覆盖 */
export interface DisplayConfig {
	/** 默认展示模式：short / normal / detail（CLI flag 优先；缺省 normal） */
	mode?: string;
	/** 各档位参数覆盖（可选；未覆盖字段沿用内置预设） */
	overrides?: Partial<Record<'short' | 'normal' | 'detail', DisplayOverrideConfig>>;
}

/** [memory] 段：记忆机制（跨会话偏好/约定） */
export interface MemoryConfig {
	/** 总开关（默认 true） */
	enabled?: boolean;
	/** 会话创建/resume 首轮是否把记忆清单注入 system prompt（默认 true） */
	inject?: boolean;
	/** 清单注入预算（tokens，默认 800；超出时用 recall_model 挑选相关行） */
	max_inject_tokens?: number;
	/** 会话内变化提醒预算（tokens，默认 200） */
	delta_inject_tokens?: number;
	/** master 可见的最低置信度（默认 2；1 = 模糊条目，仅 memory agent 管理） */
	master_min_confidence?: number;
	/** 召回选择使用的模型（默认 deepseek-v4-flash） */
	recall_model?: string;
	/** 后台归纳代理使用的模型（默认 deepseek-v4-flash） */
	agent_model?: string;
	/** 是否在每轮用户消息后异步归纳（默认 true） */
	agent_on_turn_end?: boolean;
	/** 同会话两次归纳最小间隔（秒，默认 30） */
	agent_min_interval_sec?: number;
	/** 单次归纳最多写入条数（默认 3） */
	agent_max_writes_per_run?: number;
	/** 归纳输入最多轮数（游标之后的保护上限，默认 3） */
	agent_max_input_turns?: number;
	/** 归纳输入 token 预算（默认 6000） */
	agent_max_input_tokens?: number;
	/** 单次归纳最长时长（毫秒，默认 90000） */
	agent_timeout_ms?: number;
	/** 「你读过的记忆被更新」是否提醒（默认 true） */
	notify_read_updates?: boolean;
}

/** 主配置（config.toml） */
export interface AppConfig {
	paths: ConfigPaths;
	defaults: ConfigDefaults;
	/** [display] 段（可选） */
	display?: DisplayConfig;
	/** [memory] 段（可选） */
	memory?: MemoryConfig;
}

/** 完整有效配置（合并所有引用文件后） */
export interface ResolvedConfig {
	paths: ConfigPaths;
	defaults: ConfigDefaults;
	providers: ProvidersConfig;
	pricing: PricingConfig;
	systemPrompts: SystemPromptConfig;
	/** [display] 段（可选；缺失时用内置默认档 normal） */
	display?: DisplayConfig;
	/** [memory] 段（已合并代码默认值；缺失的键回退默认） */
	memory: MemoryConfig;
}
