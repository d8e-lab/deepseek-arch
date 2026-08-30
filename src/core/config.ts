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

import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
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
} from '../types/index.js';

/** 配置目录（默认 ~/.deepseek-arch） */
export const DEFAULT_CONFIG_DIR = resolve(homedir(), '.deepseek-arch');

/** 默认配置内容（首次运行自动创建；字符串模板保留注释，完整展示可配置项） */
const DEFAULT_MAIN_CONFIG: string = `# DeepSeek Arch 主配置
# 路径均为相对本文件目录（~/.deepseek-arch/）的相对路径

[paths]
providers = "./providers.toml"
pricing = "./pricing.toml"
system_prompt = "./system-prompt.toml"
sessions = "./sessions"

# ── 默认参数 ──────────────────────────────────────────
[defaults]
provider = "deepseek"
model = "deepseek-v4-pro"
system_prompt = "default"
review_model = "deepseek-v4-flash"

# 生成参数：默认不设置（= 交由 API 侧默认值）。
# 注意：deepseek-v4 思考模式下 temperature 不生效。
# 取消注释即可自定义：
# temperature = 0.7
# max_tokens = 8192
reasoning_effort = "high"   # 推理强度：low / high / max
thinking = "enabled"        # 思考模式：enabled / disabled

# 运行时状态（/yolo /async 命令写回）
yolo = false
async = false

# 自动 compact（上下文超阈值时压缩）
auto_compact = true
auto_compact_threshold = 0.7
context_window = 1000000
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
			// 首次运行：写入默认配置文件（字符串模板保留注释）
			// system-prompt.toml 由下方 ensureSystemPromptSnapshot 统一处理
			// （缺失时从项目根 system_prompt.txt 生成快照），此处不重复创建。
			await this.writeTomlFile(mainConfigPath, DEFAULT_MAIN_CONFIG);
			await this.writeTomlFile(
				this.resolvePath('providers.toml'),
				DEFAULT_PROVIDERS as unknown as Record<string, unknown>,
			);
			await this.writeTomlFile(
				this.resolvePath('pricing.toml'),
				DEFAULT_PRICING as unknown as Record<string, unknown>,
			);
			// 复制 skill 文件到配置目录（首次运行）
			await copySkillDir(this.configDir);
			// 从刚写入的模板重新解析（字符串模板含注释，需经 TOML 解析还原对象）
			const parsedConfig = await this.loadTomlFile<AppConfig>(mainConfigPath);
			if (!parsedConfig) throw new Error('默认配置写入失败，无法解析 config.toml');
			appConfig = parsedConfig;
		}

		// 2. 每次启动：确保 system-prompt.toml 存在——缺失时从项目根 system_prompt.txt
		//    生成快照（运行时一律以 toml 为准，不直接读 txt 或硬编码）
		await this.ensureSystemPromptSnapshot(appConfig.paths.system_prompt);

		// 3. 解析跳转引用
		const providersPath = this.resolvePath(appConfig.paths.providers);
		const pricingPath = this.resolvePath(appConfig.paths.pricing);
		const systemPromptPath = this.resolvePath(appConfig.paths.system_prompt);

		const [providers, pricing, systemPrompts] = await Promise.all([
			this.loadTomlFile<ProvidersConfig>(providersPath),
			this.loadTomlFile<PricingConfig>(pricingPath),
			this.loadTomlFile<SystemPromptConfig>(systemPromptPath),
		]);

		// 4. 合并
		this.resolved = {
			paths: appConfig.paths,
			defaults: appConfig.defaults,
			providers: providers ?? {},
			pricing: pricing ?? {},
			systemPrompts: systemPrompts ?? {},
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