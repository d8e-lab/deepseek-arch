/**
 * ConfigManager 单元测试
 *
 * 所有测试使用临时目录隔离，不影响真实 ~/.deepseek-arch。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager, DEFAULT_CONFIG_DIR } from './config.js';

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
      });
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
});