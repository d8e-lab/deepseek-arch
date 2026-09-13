/**
 * ConfigManager — 配置管理单例
 *
 * 职责：
 *   1. 加载 ~/.deepseek-arch/config.toml 主配置
 *   2. 解析 [paths] 段的文件跳转引用，加载 providers/pricing/system-prompt 配置
 *   3. 合并为完整的 ResolvedConfig
 *   4. 提供点号路径取值 (get) 与覆写 (set)
 *   5. 支持热重载 (reload)
 *
 * 用法：
 *   const cfg = await ConfigManager.getInstance().load();
 *   const apiKey = cfg.get("providers.deepseek.api_key");
 */

import { readFile, writeFile, mkdir, access, readdir, copyFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';

import type {
	AppConfig,
	ResolvedConfig,
	ProvidersConfig,
	PricingConfig,
	SystemPromptConfig,
	ConfigDefaults,
	MemoryConfig,
} from '../types/index.js';

/** 配置目录（默认 ~/.deepseek-arch） */
export const DEFAULT_CONFIG_DIR = resolve(homedir(), '.deepseek-arch');

/** 默认配置内容（首次运行自动创建；字符串模板保留注释，完整展示可配置项） */
const DEFAULT_MAIN_CONFIG: string = `# DeepSeek Arch 主配置
# 路径均为相对本文件目录（~/.deepseek-arch/）的相对路径
# 修改后重启生效；运行中可用 /model /provider /system 等命令写回 defaults 段。

[paths]
# 各配置文件/目录的位置（相对本文件目录；支持绝对路径）
providers = "./providers.toml"      # API 供应商配置（base_url/api_key/超时/重试）
pricing = "./pricing.toml"          # 模型价格表（同时作为 /model 候选列表数据源）
system_prompt = "./system-prompt.toml"  # System Prompt 模板（启动缺失时从项目根生成快照）
sessions = "./sessions"             # 会话数据目录

# ── 默认参数 ──────────────────────────────────────────
[defaults]
# 默认供应商（providers.toml 中定义的键名；/provider 切换写回）
provider = "deepseek"
# 默认模型（pricing.toml 中定义的模型名；/model 切换写回）
model = "deepseek-v4-pro"
# system prompt 模板名（system-prompt.toml 中的模板键；/system 切换写回）
system_prompt = "default"

# 生成参数：默认不设置（= 交由 API 侧默认值）。
# 注意：deepseek-v4 思考模式下 temperature 不生效。
# 取消注释即可自定义：
# temperature = 0.7     # 采样温度（0~2，值越大越随机）
# max_tokens = 8192     # 单次回复最大输出 tokens
# 推理强度：low / high / max（影响思考深度与耗时）
reasoning_effort = "high"
# 思考模式：enabled / disabled（disabled 关闭思考，直接输出）
thinking = "enabled"

# 运行时状态（/yolo /async 命令写回）
yolo = true             # YOLO 模式：自动批准工具执行（跳过确认；默认开启，可用 --no-yolo 或 /yolo 关闭）
async = false           # 子代理异步模式：spawn 立即返回，配合 wait/list_subagents

# 自动 compact（上下文超阈值时压缩历史，保留摘要）
auto_compact = true     # 是否启用自动压缩
auto_compact_threshold = 0.7  # 触发阈值（0~1，占 context_window 比例）
# 上下文窗口大小（tokens）：支持数字或带单位写法（K=千、M=百万、G=十亿，十进制）
context_window = "1M"

# ── 展示（可选）────────────────────────────────────────
# 三档预设：detail（完整实时输出）/ normal（think ≤4 行、结果 ≤6 行）/ short（极简）
# CLI 启动参数 --short/--normal/--detail 可临时覆盖本段 mode。
[display]
mode = "normal"         # 默认展示模式：short / normal / detail

# 各档位参数覆盖（可选；未覆盖字段沿用内置预设）。可配置键：
#   think_live_lines          实时 think 可见行数（超出折叠，Ctrl+O 查看完整）
#   show_live_tool_output     是否逐行展示工具实时输出（short 默认 false）
#   tool_result_max_lines     工具结果最多显示行数（0 = 不显示内容）
#   hide_non_file_tool_result 是否隐藏非文件修改工具的结果内容（short 默认 true）
# [display.overrides.short]
# think_live_lines = 2
# [display.overrides.normal]
# tool_result_max_lines = 8
# [display.overrides.detail]
# show_live_tool_output = true

# ── 记忆（memory）──────────────────────────────────────
# 让 agent 跨会话记住你的偏好/约定/边界；写入由后台 memory agent 完成。
# 存储位置（均不入版本控制）：
#   项目层 {workspace}/.deepseek-arch/memory/   全局层 ~/.deepseek-arch/memory/
[memory]
enabled = true                 # 总开关（/memory off 写回此处）
inject = true                  # 会话创建/resume 首轮把记忆清单注入 system prompt
max_inject_tokens = 800        # 清单注入预算（超出时用 recall_model 挑选相关行）
delta_inject_tokens = 200      # 会话内变化提醒的预算
master_min_confidence = 2      # 主代理可见的最低置信度（1 = 模糊条目，仅 memory agent 管理）
recall_model = "deepseek-v4-flash"   # 召回选择用模型
agent_model = "deepseek-v4-flash"    # 后台归纳代理用模型
agent_on_turn_end = true       # 每轮用户消息后异步归纳
agent_min_interval_sec = 30    # 同会话两次归纳最小间隔（秒）
agent_max_writes_per_run = 3   # 单次归纳最多写入条数
agent_max_input_turns = 3      # 归纳输入最多轮数（游标之后的保护上限）
agent_max_input_tokens = 6000  # 归纳输入 token 预算
agent_timeout_ms = 90000       # 单次归纳最长时长（毫秒）
notify_read_updates = true     # 「你读过的记忆被更新」是否提醒
lru_enabled = true             # 按使用情况主动维护：升降级 + 窗口换出 + 销毁倒计时
lru_decay_active_days = 90     # 闲置超过该「活动日」数 → 置信度降一级（活动日 = 程序被使用的天数）
lru_promote_uses = 2           # 累计被读/被重申该次数且最近有使用 → 升一级
lru_window_size = 200          # memory window：master 可见条目上限，超出按 LRU 换出最久未用者
lru_total_limit = 400          # 记忆总量上限（可见+候选）；只有超限时才把最久未用的候选标记为待销毁(conf 0)
lru_destroy_after_days = 180   # conf 0（待销毁）的销毁期限（活动日）；期间被触达即回到观察区(1)
lru_destroy_mode = "archive"   # 销毁方式：archive（移到 legacy/archive/）或 delete（物理删除）
`;

const DEFAULT_PROVIDERS: ProvidersConfig = {
	deepseek: {
		base_url: 'https://api.deepseek.com',
		api_key: '',
	},
};

const DEFAULT_PRICING: PricingConfig = {
	deepseek: {
		'deepseek-v4-pro': {
			input_cache_hit: 0.2,
			input_cache_miss: 6.0,
			output: 20.0,
			currency: 'CNY',
		},
		'deepseek-v4-flash': {
			input_cache_hit: 0.075,
			input_cache_miss: 2.25,
			output: 6.75,
			currency: 'CNY',
		},
	},
};

/**
 * [memory] 段代码默认值（与模板/DEFAULT_MAIN_CONFIG 保持一致）。
 * 既有安装的 config.toml 不含该段时，靠这里兜底 —— 保证 cfg.get('memory.*') 始终有值。
 */
const MEMORY_DEFAULTS: Required<MemoryConfig> = {
	enabled: true,
	inject: true,
	max_inject_tokens: 800,
	delta_inject_tokens: 200,
	master_min_confidence: 2,
	recall_model: 'deepseek-v4-flash',
	agent_model: 'deepseek-v4-flash',
	agent_on_turn_end: true,
	agent_min_interval_sec: 30,
	agent_max_writes_per_run: 3,
	agent_max_input_turns: 3,
	agent_max_input_tokens: 6000,
	agent_timeout_ms: 90_000,
	notify_read_updates: true,
	lru_enabled: true,
	lru_decay_active_days: 90,
	lru_promote_uses: 2,
	lru_window_size: 200,
	lru_total_limit: 400,
	lru_destroy_after_days: 180,
	lru_destroy_mode: 'archive',
};

/**
 * defaults 段中有明确默认值的键（与模板/README 一致）。
 * temperature/max_tokens 保持"未设置"（默认不传，交 API 侧默认；模板中为注释示例）。
 */
const DEFAULT_DEFAULTS: Partial<ConfigDefaults> = {
	reasoning_effort: 'high',
	thinking: 'enabled',
	yolo: true,
	async: false,
	auto_compact: true,
	auto_compact_threshold: 0.7,
	context_window: '1M',
};

/**
 * 解析 token 数量：支持纯数字或带单位写法（K=千、M=百万、G=十亿，十进制）。
 * 例：parseTokenSize("1M") → 1000000；parseTokenSize("256K") → 256000；parseTokenSize(5000) → 5000。
 * 无法解析时返回 undefined。
 */
export function parseTokenSize(value: number | string | undefined): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === 'number') return value;
	const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]?)$/i);
	if (!m) return undefined;
	const n = parseFloat(m[1]);
	const unit = m[2].toUpperCase();
	const mult = unit === 'K' ? 1_000 : unit === 'M' ? 1_000_000 : unit === 'G' ? 1_000_000_000 : 1;
	return Math.round(n * mult);
}

/**
 * 从项目根 `skill/` 目录复制全部 skill 文件到配置目录。
 * 定位方式与 readSystemPromptFile 一致（通过 import.meta.url 定位项目根）。
 * 已存在的文件跳过（用户可能自定义了）。
 */
async function copySkillDir(configDir: string): Promise<void> {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const projectRoot = resolve(__dirname, '..', '..');
	const srcDir = resolve(projectRoot, 'skill');

	let entries: string[];
	try {
		entries = await readdir(srcDir);
	} catch {
		return; // 项目无 skill 目录（npm 包剥离了非代码文件）→ 静默跳过
	}

	const destDir = resolve(configDir, 'skill');
	try {
		await mkdir(destDir, { recursive: true, mode: 0o700 });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!/\.skill\.md$/i.test(entry)) continue;
		const destPath = resolve(destDir, entry);
		try {
			await access(destPath); // 已存在 → 跳过（用户自定义优先）
			continue;
		} catch {
			// 不存在，继续
		}
		try {
			const content = await readFile(resolve(srcDir, entry), 'utf-8');
			await writeFile(destPath, content, { mode: 0o600 });
		} catch {
			// 单个文件复制失败不影响其他
		}
	}
}

/** 硬编码兜底——system_prompt.txt 找不到时使用 */
const FALLBACK_SYSTEM_PROMPT = `Reasoning Effort:
Absolute maximum with no shortcuts permitted.
You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.
Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.`;

/**
 * 从项目根目录下的 system_prompt.txt 读取默认 system prompt 文本。
 * 定位方式：通过 import.meta.url 向上找到项目根（src/core → ../../ 或 dist/core → ../../）。
 * 找不到文件时返回硬编码兜底。
 *
 * 仅用于启动时生成 system-prompt.toml 快照（见 ensureSystemPromptSnapshot）；
 * 运行时系统 prompt 一律以 system-prompt.toml 为准，不再直接读本文件。
 */
export async function readSystemPromptFile(): Promise<string> {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const projectRoot = resolve(__dirname, '..', '..');
	const txtPath = resolve(projectRoot, 'system_prompt.txt');

	try {
		const content = await readFile(txtPath, 'utf-8');
		return content.trim() || FALLBACK_SYSTEM_PROMPT;
	} catch {
		return FALLBACK_SYSTEM_PROMPT;
	}
}

/** 配置子树来源追踪 */
type SourceFile = 'main' | 'providers' | 'pricing' | 'system_prompt';

export class ConfigManager {
	private static instance: ConfigManager;

	private configDir: string;
	private loaded = false;
	private resolved: ResolvedConfig | null = null;
	/** 最近一次 load() 自动补全的 defaults 键（init 报告用） */
	private lastAddedDefaultsKeys: string[] = [];

	private constructor(configDir?: string) {
		this.configDir = configDir ?? DEFAULT_CONFIG_DIR;
	}

	/** 获取单例 */
	static getInstance(configDir?: string): ConfigManager {
		if (!ConfigManager.instance) {
			ConfigManager.instance = new ConfigManager(configDir);
		}
		return ConfigManager.instance;
	}

	/** 重置单例（测试用） */
	static resetInstance(): void {
		ConfigManager.instance = undefined as unknown as ConfigManager;
	}

	/** 确保配置目录存在，不存在则创建并写入默认配置 */
	async ensureConfigDir(): Promise<void> {
		try {
			await access(this.configDir);
		} catch {
			await mkdir(this.configDir, { recursive: true, mode: 0o700 });
		}
	}

	/** 解析相对于配置目录的路径 */
	private resolvePath(relativePath: string): string {
		return resolve(this.configDir, relativePath);
	}

	/** 加载 TOML 文件，不存在时返回 null */
	private async loadTomlFile<T>(filePath: string): Promise<T | null> {
		try {
			const raw = await readFile(filePath, 'utf-8');
			return tomlParse(raw) as T;
		} catch (err: any) {
			if (err?.code === 'ENOENT') return null;
			throw err;
		}
	}

	/** 写入 TOML 文件（支持对象序列化或原始字符串模板） */
	private async writeTomlFile(filePath: string, data: Record<string, unknown> | string): Promise<void> {
		const content = typeof data === 'string' ? data : tomlStringify(data);
		await writeFile(filePath, content, { mode: 0o600 });
	}

	/**
	 * 每次启动调用：确保 system-prompt.toml 存在。
	 * 缺失时从项目根 system_prompt.txt 读取内容，生成默认模板快照（模板名固定为 "default"）；
	 * 已存在则跳过（用户可能自定义了）。
	 */
	private async ensureSystemPromptSnapshot(relativePath: string): Promise<void> {
		const absPath = this.resolvePath(relativePath);
		try {
			await access(absPath);
			return; // 已存在（用户自定义或上次生成的快照）→ 跳过
		} catch {
			// 不存在 → 从项目根 system_prompt.txt 生成快照
		}
		const content = await readSystemPromptFile();
		const snapshot: SystemPromptConfig = { default: { content } };
		await this.writeTomlFile(absPath, snapshot as unknown as Record<string, unknown>);
	}

	/**
	 * 加载配置（幂等：已加载时直接返回，除非调用过 reload） 首次运行时自动创建默认配置文件。
	 */
	async load(): Promise<ConfigManager> {
		if (this.loaded) return this;

		await this.ensureConfigDir();

		// 1. 加载主配置
		const mainConfigPath = this.resolvePath('config.toml');
		let appConfig = await this.loadTomlFile<AppConfig>(mainConfigPath);

		if (!appConfig) {
			// 首次运行（或用户删除了 config.toml）：写入默认主配置。
			// providers.toml 含用户 API key——已存在时绝不覆盖（只缺失才补建默认模板），
			// pricing.toml 同理保留；system-prompt.toml 由下方 ensureSystemPromptSnapshot 统一处理。
			await this.writeTomlFile(mainConfigPath, DEFAULT_MAIN_CONFIG);
			if (!(await this.pathExists(this.resolvePath('providers.toml')))) {
				await this.writeTomlFile(
					this.resolvePath('providers.toml'),
					DEFAULT_PROVIDERS as unknown as Record<string, unknown>,
				);
			}
			if (!(await this.pathExists(this.resolvePath('pricing.toml')))) {
				await this.writeTomlFile(
					this.resolvePath('pricing.toml'),
					DEFAULT_PRICING as unknown as Record<string, unknown>,
				);
			}
			// 复制 skill 文件到配置目录（首次运行）
			await copySkillDir(this.configDir);
			// 从刚写入的模板重新解析（字符串模板含注释，需经 TOML 解析还原对象）
			const parsedConfig = await this.loadTomlFile<AppConfig>(mainConfigPath);
			if (!parsedConfig) throw new Error('默认配置写入失败，无法解析 config.toml');
			appConfig = parsedConfig;
		}

		// 2. 兼容旧配置：自动补全 defaults 缺失键（有明确默认值的键，与模板/README 一致）。
		//    temperature/max_tokens 保持"未设置"（默认不传，交 API 侧默认；模板中为注释示例）。
		//    已设置的值保留；写回会规范化文件（旧配置无注释可丢，新模板键齐不触发）。
		const added = this.applyMissingDefaults(appConfig);
		this.lastAddedDefaultsKeys = added;
		if (added.length > 0) {
			await this.writeTomlFile(mainConfigPath, appConfig as unknown as Record<string, unknown>);
		}

		// 3. 每次启动：确保 system-prompt.toml 存在——缺失时从项目根 system_prompt.txt
		//    生成快照（运行时一律以 toml 为准，不直接读 txt 或硬编码）
		await this.ensureSystemPromptSnapshot(appConfig.paths.system_prompt);

		// 4. 解析跳转引用
		const providersPath = this.resolvePath(appConfig.paths.providers);
		const pricingPath = this.resolvePath(appConfig.paths.pricing);
		const systemPromptPath = this.resolvePath(appConfig.paths.system_prompt);

		const [providers, pricing, systemPrompts] = await Promise.all([
			this.loadTomlFile<ProvidersConfig>(providersPath),
			this.loadTomlFile<PricingConfig>(pricingPath),
			this.loadTomlFile<SystemPromptConfig>(systemPromptPath),
		]);

		// 5. 合并
		this.resolved = {
			paths: appConfig.paths,
			defaults: appConfig.defaults,
			providers: providers ?? {},
			pricing: pricing ?? {},
			systemPrompts: systemPrompts ?? {},
			display: appConfig.display,
			// [memory]：代码默认值兜底（既有安装的 config.toml 没有该段也能正常工作）
			memory: { ...MEMORY_DEFAULTS, ...(appConfig.memory ?? {}) },
		};

		this.loaded = true;
		return this;
	}

	/** 热重载 */
	async reload(): Promise<ConfigManager> {
		this.loaded = false;
		this.resolved = null;
		return this.load();
	}

	/**
	 * 显式初始化/迁移配置：
	 * - 缺失的 config.toml 用默认模板生成（含完整注释）
	 * - defaults 缺失键自动补全（保留已有值）
	 * - 缺失的 providers/pricing 引用文件用默认模板补建
	 * - force=true 时先备份现有 config.toml（.bak）再重新生成
	 * 返回本次操作报告（供 CLI init 子命令展示）。
	 */
	async init(force = false): Promise<InitReport> {
		await this.ensureConfigDir();
		const mainConfigPath = this.resolvePath('config.toml');
		const existed = await this.pathExists(mainConfigPath);

		let backupPath: string | null = null;
		if (force && existed) {
			backupPath = `${mainConfigPath}.bak`;
			await copyFile(mainConfigPath, backupPath);
			await rm(mainConfigPath, { force: true });
		}

		// 强制重新加载（绕过幂等，重新解析 + 补全；load 会重设 resolved）
		this.loaded = false;
		await this.load();
		const addedDefaults = [...this.lastAddedDefaultsKeys];
		this.lastAddedDefaultsKeys = [];

		// 确保引用文件存在（load 只在首次生成；init 补建后续被删的）
		const providersPath = this.resolvePath(this.resolved?.paths.providers ?? 'providers.toml');
		const pricingPath = this.resolvePath(this.resolved?.paths.pricing ?? 'pricing.toml');
		const createdFiles: string[] = [];
		if (!(await this.pathExists(providersPath))) {
			await this.writeTomlFile(providersPath, DEFAULT_PROVIDERS as unknown as Record<string, unknown>);
			createdFiles.push(this.shortName(providersPath));
		}
		if (!(await this.pathExists(pricingPath))) {
			await this.writeTomlFile(pricingPath, DEFAULT_PRICING as unknown as Record<string, unknown>);
			createdFiles.push(this.shortName(pricingPath));
		}

		return {
			configDir: this.configDir,
			created: !existed || force,
			forceBackup: backupPath,
			addedDefaults,
			createdFiles,
		};
	}

	/** 补全 appConfig.defaults 缺失键（有默认值的），返回补全的键名列表 */
	private applyMissingDefaults(appConfig: AppConfig): string[] {
		const defaults = appConfig.defaults ?? {};
		const defaultsRecord = defaults as unknown as Record<string, unknown>;
		const missing = Object.entries(DEFAULT_DEFAULTS).filter(
			([k]) => defaultsRecord[k] === undefined,
		);
		for (const [k, v] of missing) {
			defaultsRecord[k] = v;
		}
		appConfig.defaults = defaults;
		return missing.map(([k]) => k);
	}

	private async pathExists(p: string): Promise<boolean> {
		try {
			await access(p);
			return true;
		} catch {
			return false;
		}
	}

	private shortName(p: string): string {
		return p.startsWith(this.configDir) ? p.slice(this.configDir.length + 1) : p;
	}

	/**
	 * 点号路径取值，如 get("providers.deepseek.base_url")
	 * 返回 undefined 表示路径不存在。
	 */
	get<T = unknown>(path: string): T | undefined {
		if (!this.resolved) return undefined;
		const parts = path.split('.');
		let current: unknown = this.resolved;
		for (const part of parts) {
			if (current === null || current === undefined) return undefined;
			if (typeof current !== 'object') return undefined;
			current = (current as Record<string, unknown>)[part];
		}
		return current as T;
	}

	/**
	 * 设置配置值并持久化回对应文件。
	 * 支持的顶层键：defaults, providers, pricing, systemPrompts（映射到 system-prompt.toml）
	 */
	async set(path: string, value: unknown): Promise<void> {
		await this.load();
		if (!this.resolved) throw new Error('配置未加载');

		const parts = path.split('.');
		if (parts.length < 2) {
			throw new Error(`路径至少需要 2 层，如 "defaults.model"`);
		}

		const root = parts[0];
		// 确定写入文件及路径处理方式：
		// - config.toml 内含 paths/defaults 两个子表，写入时需保留 root 路径
		// - 独立文件 (providers/pricing/system-prompt) 文件顶层即为对应数据，需剥离 root
		const fileMap: Record<string, { file: string; stripRoot: boolean }> = {
			paths: { file: 'config.toml', stripRoot: false },
			defaults: { file: 'config.toml', stripRoot: false },
			providers: { file: this.resolved.paths.providers, stripRoot: true },
			pricing: { file: this.resolved.paths.pricing, stripRoot: true },
			systemPrompts: { file: this.resolved.paths.system_prompt, stripRoot: true },
			memory: { file: 'config.toml', stripRoot: false },
		};

		const entry = fileMap[root];
		if (!entry) {
			throw new Error(`不支持的配置段: ${root}`);
		}

		// 读取目标文件
		const absPath = this.resolvePath(entry.file);
		const data = (await this.loadTomlFile<Record<string, unknown>>(absPath)) ?? {};

		// 写入嵌套值（根据文件类型决定是否剥离根键）
		const dataPath = entry.stripRoot ? parts.slice(1) : parts;
		this.setNested(data, dataPath, value);

		await this.writeTomlFile(absPath, data);

		// 更新内存
		this.setNested(this.resolved as unknown as Record<string, unknown>, parts, value);
	}

	private setNested(obj: Record<string, unknown>, path: string[], value: unknown): void {
		let current = obj;
		for (let i = 0; i < path.length - 1; i++) {
			if (!(path[i] in current) || typeof current[path[i]] !== 'object') {
				current[path[i]] = {};
			}
			current = current[path[i]] as Record<string, unknown>;
		}
		current[path[path.length - 1]] = value;
	}

	/** 获取当前已解析的完整配置（只读） */
	getResolved(): ResolvedConfig | null {
		return this.resolved;
	}

	/** 获取配置目录路径 */
	getConfigDir(): string {
		return this.configDir;
	}

	/** 获取会话存储目录完整路径 */
	getSessionsDir(): string {
		return this.resolvePath(this.resolved?.paths.sessions ?? 'sessions');
	}
}

/** init() 操作报告（CLI init 子命令展示用） */
export interface InitReport {
	configDir: string;
	/** 本次是否创建了 config.toml（首次或 force 重新生成） */
	created: boolean;
	/** force 时的备份路径（未 force 或原本不存在时为 null） */
	forceBackup: string | null;
	/** 自动补全的 defaults 键名 */
	addedDefaults: string[];
	/** 本次补建的缺失引用文件（相对配置目录） */
	createdFiles: string[];
}