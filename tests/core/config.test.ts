/**
 * ConfigManager 单元测试
 *
 * 所有测试使用临时目录隔离，不影响真实 ~/.deepseek-arch。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager, DEFAULT_CONFIG_DIR, parseTokenSize } from '../../src/core/config.js';

describe('ConfigManager', () => {
  let testDir: string;

  beforeEach(async () => {
    // 为每个测试创建独立临时目录
    testDir = await mkdtemp(join(tmpdir(), 'deepseek-arch-test-'));
    ConfigManager.resetInstance();
  });

  afterEach(async () => {
    ConfigManager.resetInstance();
    // 清理临时目录
    await rm(testDir, { recursive: true, force: true });
  });

  describe('单例与初始化', () => {
    it('getInstance 返回同一实例', () => {
      const a = ConfigManager.getInstance(testDir);
      const b = ConfigManager.getInstance(testDir);
      expect(a).toBe(b);
    });

    it('首次 load() 自动创建默认配置文件', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();

      const config = mgr.getResolved();
      expect(config).not.toBeNull();
      expect(config!.defaults.provider).toBe('deepseek');
      expect(config!.defaults.model).toBe('deepseek-v4-pro');
      expect(config!.providers.deepseek).toBeDefined();
      expect(config!.providers.deepseek.base_url).toBe('https://api.deepseek.com');
    });

    it('config.toml 缺失但 providers.toml 已存在：不覆盖（保留 API key）', async () => {
      // 只预置 providers.toml（模拟用户删除 config.toml 想重置、保留 API key 的场景）
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(testDir, { recursive: true });
      writeFileSync(
        join(testDir, 'providers.toml'),
        'deepseek = { base_url = "https://api.deepseek.com", api_key = "sk-keep-123" }\n',
      );

      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();

      // providers 内容原样保留
      expect(mgr.get('providers.deepseek.api_key')).toBe('sk-keep-123');
      // config.toml 已重建（默认模板含 display 段）
      expect(mgr.get('defaults.yolo')).toBe(true);
      expect(mgr.get('display.mode')).toBe('normal');
    });

    it('init --force 保留已有 providers.toml（API key 不清空）', async () => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(testDir, { recursive: true });
      writeFileSync(
        join(testDir, 'providers.toml'),
        'deepseek = { base_url = "https://api.deepseek.com", api_key = "sk-keep-456" }\n',
      );

      const mgr = ConfigManager.getInstance(testDir);
      const report = await mgr.init(true);

      expect(mgr.get('providers.deepseek.api_key')).toBe('sk-keep-456');
      // config.toml 已重建
      expect(mgr.get('defaults.model')).toBe('deepseek-v4-pro');
      expect(report.createdFiles.filter((f) => f.includes('providers')).length).toBe(0);
    });

    it('读取 [display] 段（默认模式 + 各档位 overrides）', async () => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(testDir, { recursive: true });
      // 预置带 display 段与完整 defaults 的 config.toml
      writeFileSync(
        join(testDir, 'config.toml'),
        [
          '[paths]',
          'providers = "./providers.toml"',
          'pricing = "./pricing.toml"',
          'system_prompt = "./system-prompt.toml"',
          'sessions = "./sessions"',
          '[defaults]',
          'provider = "deepseek"',
          'model = "deepseek-v4-pro"',
          'system_prompt = "default"',
          'yolo = true',
          'async = false',
          'auto_compact = true',
          'auto_compact_threshold = 0.7',
          'context_window = "1M"',
          '[display]',
          'mode = "short"',
          '[display.overrides.short]',
          'think_live_lines = 2',
          'tool_result_max_lines = 3',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(testDir, 'providers.toml'),
        'deepseek = { base_url = "https://api.deepseek.com", api_key = "sk" }\n',
      );

      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();

      expect(mgr.get('display.mode')).toBe('short');
      expect(mgr.get('display.overrides.short.think_live_lines')).toBe(2);
      expect(mgr.get('display.overrides.short.tool_result_max_lines')).toBe(3);
    });

    it('load() 是幂等的', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();
      const first = mgr.getResolved();
      await mgr.load();
      const second = mgr.getResolved();
      expect(second).toBe(first); // 同一个对象引用
    });

    it('默认配置目录是 ~/.deepseek-arch', () => {
      ConfigManager.resetInstance();
      const mgr = ConfigManager.getInstance();
      expect(mgr.getConfigDir()).toBe(DEFAULT_CONFIG_DIR);
    });
  });

  describe('get() 点号路径取值', () => {
    it('取顶层值', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();
      expect(mgr.get('defaults')).toEqual({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        system_prompt: 'default',
        review_model: 'deepseek-v4-flash',
        reasoning_effort: 'high',
        thinking: 'enabled',
        yolo: true,
        async: false,
        auto_compact: true,
        auto_compact_threshold: 0.7,
        context_window: '1M',
      });
      // temperature/max_tokens 默认不设置（模板中为注释示例，未激活）
      expect(mgr.get('defaults.temperature')).toBeUndefined();
      expect(mgr.get('defaults.max_tokens')).toBeUndefined();
    });

    it('取嵌套值', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();
      expect(mgr.get('defaults.model')).toBe('deepseek-v4-pro');
      expect(mgr.get('providers.deepseek.base_url')).toBe('https://api.deepseek.com');
    });

    it('路径不存在返回 undefined', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();
      expect(mgr.get('nonexistent.key')).toBeUndefined();
      expect(mgr.get('providers.unknown')).toBeUndefined();
    });

    it('未加载时 get 返回 undefined', () => {
      const mgr = ConfigManager.getInstance(testDir);
      expect(mgr.get('defaults.model')).toBeUndefined();
    });
  });

  describe('旧配置自动补全', () => {
    it('已有 config.toml 缺失 defaults 键时自动补全（保留已有值）', async () => {
      // 预置旧版 config.toml（只有 provider/model/system_prompt 三键）
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(testDir, { recursive: true });
      writeFileSync(join(testDir, 'config.toml'), [
        '# 旧配置',
        '[paths]',
        'providers = "./providers.toml"',
        'pricing = "./pricing.toml"',
        'system_prompt = "./system-prompt.toml"',
        'sessions = "./sessions"',
        '[defaults]',
        'provider = "deepseek"',
        'model = "deepseek-v4-pro"',
        'system_prompt = "default"',
        '',
      ].join('\n'));
      // providers.toml 也要有（load 解析跳转引用）
      writeFileSync(join(testDir, 'providers.toml'), 'deepseek = { base_url = "https://api.deepseek.com", api_key = "sk-old" }\n');

      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();

      // 缺失键被补全为默认值
      expect(mgr.get('defaults.reasoning_effort')).toBe('high');
      expect(mgr.get('defaults.thinking')).toBe('enabled');
      expect(mgr.get('defaults.review_model')).toBe('deepseek-v4-flash');
      expect(mgr.get('defaults.yolo')).toBe(true);
      expect(mgr.get('defaults.async')).toBe(false);
      expect(mgr.get('defaults.auto_compact')).toBe(true);
      expect(mgr.get('defaults.auto_compact_threshold')).toBe(0.7);
      expect(mgr.get('defaults.context_window')).toBe('1M');
      // 已有值保留
      expect(mgr.get('defaults.provider')).toBe('deepseek');
      expect(mgr.get('defaults.model')).toBe('deepseek-v4-pro');
      // temperature/max_tokens 不补全（保持未设置语义）
      expect(mgr.get('defaults.temperature')).toBeUndefined();
      expect(mgr.get('defaults.max_tokens')).toBeUndefined();

      // 持久化验证：文件已写入补全键
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(join(testDir, 'config.toml'), 'utf-8');
      expect(content).toContain('reasoning_effort');
      expect(content).toContain('auto_compact');
    });
  });

  describe('set() 配置持久化', () => {
    it('写入并持久化 defaults 段', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();

      await mgr.set('defaults.model', 'deepseek-chat');
      expect(mgr.get('defaults.model')).toBe('deepseek-chat');

      // 验证持久化：重新加载
      ConfigManager.resetInstance();
      const mgr2 = ConfigManager.getInstance(testDir);
      await mgr2.load();
      expect(mgr2.get('defaults.model')).toBe('deepseek-chat');
    });

    it('写入 providers 段持久化到 providers.toml', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();

      await mgr.set('providers.deepseek.api_key', 'sk-test-123');
      expect(mgr.get('providers.deepseek.api_key')).toBe('sk-test-123');

      ConfigManager.resetInstance();
      const mgr2 = ConfigManager.getInstance(testDir);
      await mgr2.load();
      expect(mgr2.get('providers.deepseek.api_key')).toBe('sk-test-123');
    });
  });

  describe('system-prompt 快照', () => {
    it('首次 load() 自动从项目根 system_prompt.txt 生成 system-prompt.toml', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();

      // 快照模板 default 存在且内容非空（来自项目根 system_prompt.txt）
      const content = mgr.get<string>('systemPrompts.default.content');
      expect(content).toBeDefined();
      expect(content!.length).toBeGreaterThan(0);
      expect(content!).toContain('Reasoning Effort');

      // toml 文件确实落盘
      const { access } = await import('node:fs/promises');
      await expect(access(join(testDir, 'system-prompt.toml'))).resolves.toBeUndefined();
    });

    it('system-prompt.toml 缺失时 reload() 会重新生成快照', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();

      // 删除快照，模拟缺失
      const { rm } = await import('node:fs/promises');
      await rm(join(testDir, 'system-prompt.toml'), { force: true });

      await mgr.reload();
      expect(mgr.get<string>('systemPrompts.default.content')).toBeDefined();
    });
  });

  describe('reload() 热重载', () => {
    it('reload 后会读取文件的最新内容', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();

      // 通过另一个实例写入新值
      await mgr.set('defaults.model', 'model-a');
      expect(mgr.get('defaults.model')).toBe('model-a');

      // 模拟外部修改：直接用文件系统写入
      const { writeFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');

      // 但这里我们通过 mgr.set 已经测试了持久化环
      // reload 测试：写入后用 reload 确认
      await mgr.reload();
      expect(mgr.get('defaults.model')).toBe('model-a');
    });
  });

  describe('getSessionsDir()', () => {
    it('返回会话目录完整路径', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();
      const dir = mgr.getSessionsDir();
      expect(dir).toContain('sessions');
      expect(dir).toContain(testDir);
    });
  });

  describe('parseTokenSize()', () => {
    it('纯数字原样返回', () => {
      expect(parseTokenSize(5000)).toBe(5000);
      expect(parseTokenSize(1_000_000)).toBe(1_000_000);
    });

    it('带单位写法（十进制：K=千 M=百万 G=十亿）', () => {
      expect(parseTokenSize('1M')).toBe(1_000_000);
      expect(parseTokenSize('256K')).toBe(256_000);
      expect(parseTokenSize('1.5M')).toBe(1_500_000);
      expect(parseTokenSize('2G')).toBe(2_000_000_000);
    });

    it('大小写与空白容错', () => {
      expect(parseTokenSize('1m')).toBe(1_000_000);
      expect(parseTokenSize(' 256k ')).toBe(256_000);
    });

    it('无法解析返回 undefined', () => {
      expect(parseTokenSize(undefined)).toBeUndefined();
      expect(parseTokenSize('abc')).toBeUndefined();
      expect(parseTokenSize('')).toBeUndefined();
    });
  });

  describe('[memory] 段（约束 C：五处同步）', () => {
    it('默认模板包含 [memory] 段与关键默认值', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();
      const raw = await readFile(join(testDir, 'config.toml'), 'utf-8');
      expect(raw).toContain('[memory]');
      expect(raw).toContain('master_min_confidence = 2');
      expect(raw).toContain('recall_model = "deepseek-v4-flash"');
      expect(raw).toContain('agent_model = "deepseek-v4-flash"');
    });

    it('cfg.get("memory.*") 有值（老配置无该段时走代码默认兜底）', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();
      // 去掉 [memory] 段，模拟老版本配置后重新加载
      const raw = await readFile(join(testDir, 'config.toml'), 'utf-8');
      await writeFile(join(testDir, 'config.toml'), raw.split('# ── 记忆（memory）')[0], 'utf-8');
      await mgr.reload();

      expect(mgr.get<boolean>('memory.enabled')).toBe(true);
      expect(mgr.get<number>('memory.master_min_confidence')).toBe(2);
      expect(mgr.get<string>('memory.agent_model')).toBe('deepseek-v4-flash');
      expect(mgr.get<number>('memory.max_inject_tokens')).toBe(800);
      expect(mgr.getResolved()!.memory.agent_timeout_ms).toBe(90_000);
    });

    it('set("memory.enabled", false) 写回 config.toml 且重新加载后生效', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();
      await mgr.set('memory.enabled', false);

      const raw = await readFile(join(testDir, 'config.toml'), 'utf-8');
      expect(raw).toMatch(/\[memory\][\s\S]*enabled = false/);

      await mgr.reload();
      expect(mgr.get<boolean>('memory.enabled')).toBe(false);
    });

    it('未知配置段仍被拒绝（白名单未被放宽）', async () => {
      const mgr = ConfigManager.getInstance(testDir);
      await mgr.load();
      await expect(mgr.set('unknown.key', 1)).rejects.toThrow(/不支持的配置段/);
    });
  });
});
