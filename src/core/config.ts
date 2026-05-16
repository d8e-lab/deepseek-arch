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

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';

import type {
  AppConfig,
  ResolvedConfig,
  ProvidersConfig,
  PricingConfig,
  SystemPromptConfig,
} from './types.js';

/** 配置目录（默认 ~/.deepseek-arch） */
export const DEFAULT_CONFIG_DIR = resolve(homedir(), '.deepseek-arch');

/** 默认配置内容（首次运行自动创建） */
const DEFAULT_MAIN_CONFIG: AppConfig = {
  paths: {
    providers: './providers.toml',
    pricing: './pricing.toml',
    system_prompt: './system-prompt.toml',
    sessions: './sessions',
  },
  defaults: {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    system_prompt: 'default',
  },
};

const DEFAULT_PROVIDERS: ProvidersConfig = {
  deepseek: {
    base_url: 'https://api.deepseek.com',
    api_key: '',
  },
};

const DEFAULT_PRICING: PricingConfig = {
  deepseek: {
    'deepseek-v4-pro': {
      input_cache_hit: 0.1,
      input_cache_miss: 1.0,
      output: 2.0,
      currency: 'CNY',
    },
  },
};

const DEFAULT_SYSTEM_PROMPTS: SystemPromptConfig = {
  default: {
    content: '你是一个有用的AI助手，运行在 Linux 终端中。回答应简洁、准确。',
  },
};

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

  /** 写入 TOML 文件 */
  private async writeTomlFile(filePath: string, data: Record<string, unknown>): Promise<void> {
    const content = tomlStringify(data);
    await writeFile(filePath, content, { mode: 0o600 });
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
      // 首次运行：写入所有默认配置文件
      await this.writeTomlFile(mainConfigPath, DEFAULT_MAIN_CONFIG as unknown as Record<string, unknown>);
      await this.writeTomlFile(
        this.resolvePath('providers.toml'),
        DEFAULT_PROVIDERS as unknown as Record<string, unknown>,
      );
      await this.writeTomlFile(
        this.resolvePath('pricing.toml'),
        DEFAULT_PRICING as unknown as Record<string, unknown>,
      );
      await this.writeTomlFile(
        this.resolvePath('system-prompt.toml'),
        DEFAULT_SYSTEM_PROMPTS as unknown as Record<string, unknown>,
      );
      appConfig = DEFAULT_MAIN_CONFIG;
    }

    // 2. 解析跳转引用
    const providersPath = this.resolvePath(appConfig.paths.providers);
    const pricingPath = this.resolvePath(appConfig.paths.pricing);
    const systemPromptPath = this.resolvePath(appConfig.paths.system_prompt);

    const [providers, pricing, systemPrompts] = await Promise.all([
      this.loadTomlFile<ProvidersConfig>(providersPath),
      this.loadTomlFile<PricingConfig>(pricingPath),
      this.loadTomlFile<SystemPromptConfig>(systemPromptPath),
    ]);

    // 3. 合并
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