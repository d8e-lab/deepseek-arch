/**
 * CLI 端到端测试
 *
 * 通过 execSync 运行编译后的 CLI 验证输出。
 * 避免与 Commander 内部实现耦合。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const CLI_PATH = resolve(import.meta.dirname!, '..', '..', 'dist', 'cli', 'index.js');
/** 从 package.json 读取当前版本（与 PACKAGE_VERSION 单一来源对齐） */
const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(resolve(import.meta.dirname!, '..', '..', 'package.json'), 'utf-8'),
).version;

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args.join(' ')}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? null,
    };
  }
}

describe('CLI (e2e)', () => {
  beforeAll(() => {
    // 确保已编译
    execSync('npx tsc', { cwd: resolve(import.meta.dirname!, '..', '..'), stdio: 'pipe' });
  });

  describe('--version', () => {
    it('输出包含版本号', () => {
      const { stdout, status } = run(['--version']);
      expect(stdout.trim()).toContain(PACKAGE_VERSION);
      expect(status).toBe(0);
    });

    it('-V 等价于 --version', () => {
      const { stdout, status } = run(['-V']);
      expect(stdout.trim()).toContain(PACKAGE_VERSION);
      expect(status).toBe(0);
    });
  });

  describe('--help', () => {
    it('显示 chat、resume 和 clear 子命令', () => {
      const { stdout } = run(['--help']);
      expect(stdout).toContain('chat');
      expect(stdout).toContain('resume');
      expect(stdout).toContain('clear');
    });

    it('-h 等价于 --help', () => {
      const { stdout } = run(['-h']);
      expect(stdout).toContain('Usage:');
    });
  });

  describe('chat 子命令', () => {
    it('chat --help 显示 --resume 和 --yolo 选项', () => {
      const { stdout } = run(['chat', '--help']);
      expect(stdout).toContain('--resume');
      expect(stdout).toContain('--yolo');
    });

    it('chat --help 显示 --no-yolo 与展示模式选项', () => {
      const { stdout } = run(['chat', '--help']);
      expect(stdout).toContain('--no-yolo');
      expect(stdout).toContain('--short');
      expect(stdout).toContain('--normal');
      expect(stdout).toContain('--detail');
    });

    it('chat --help 显示全部选项（含 debug/self-interaction/monitor）', () => {
      const { stdout } = run(['chat', '--help']);
      expect(stdout).toContain('--debug');
      expect(stdout).toContain('--self-interaction');
      expect(stdout).toContain('--mock');
      expect(stdout).toContain('--monitor');
      expect(stdout).toContain('--cdp');
      expect(stdout).toContain('--async');
    });
  });

  describe('resume 子命令', () => {
    it('resume --help 显示 [id] 位置参数', () => {
      const { stdout } = run(['resume', '--help']);
      expect(stdout).toContain('[id]');
    });

    it('resume --help 显示 --yolo 选项（与 chat 对齐）', () => {
      const { stdout } = run(['resume', '--help']);
      expect(stdout).toContain('--yolo');
      expect(stdout).toContain('--no-yolo');
      expect(stdout).toContain('--detail');
    });

    it('resume 无参数时显示会话列表或空提示', () => {
      const { stdout } = run(['resume']);
      const hasContent =
        stdout.includes('No saved sessions') ||
        stdout.includes('Saved sessions');
      expect(hasContent).toBe(true);
    });

    it('resume 不存在的会话时报错退出', () => {
      const { stderr, status } = run(['resume', 'nonexistent-id']);
      expect(stderr).toContain('Session not found');
      expect(status).toBe(1);
    });
  });

  describe('init 子命令', () => {
    it('init --help 显示 --force 选项', () => {
      const { stdout } = run(['init', '--help']);
      expect(stdout).toContain('--force');
      expect(stdout).toContain('Initialize or migrate');
    });

    it('init 在临时 HOME 下生成配置并报告', () => {
      const { mkdtempSync } = require('node:fs');
      const { tmpdir } = require('node:os');
      const { join } = require('node:path');
      const home = mkdtempSync(join(tmpdir(), 'deepseek-arch-cli-init-'));
      const { stdout, status } = runWithEnv(['init'], { HOME: home });
      expect(status).toBe(0);
      expect(stdout).toContain('Config directory');
      expect(stdout).toContain('config.toml: created');
      // 生成的文件存在
      const { existsSync } = require('node:fs');
      expect(existsSync(join(home, '.deepseek-arch', 'config.toml'))).toBe(true);
      expect(existsSync(join(home, '.deepseek-arch', 'providers.toml'))).toBe(true);
      // 再次运行：已存在
      const again = runWithEnv(['init'], { HOME: home });
      expect(again.stdout).toContain('config.toml: exists');
    });
  });
});

/** 带环境变量运行的辅助（init 测试用临时 HOME 隔离） */
function runWithEnv(args: string[], env: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args.join(' ')}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? null,
    };
  }
}