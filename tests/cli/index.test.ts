/**
 * CLI 端到端测试
 *
 * 通过 execSync 运行编译后的 CLI 验证输出。
 * 避免与 Commander 内部实现耦合。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI_PATH = resolve(import.meta.dirname!, '..', '..', 'dist', 'cli', 'index.js');

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
      expect(stdout.trim()).toContain('1.1.0');
      expect(status).toBe(0);
    });

    it('-V 等价于 --version', () => {
      const { stdout, status } = run(['-V']);
      expect(stdout.trim()).toContain('1.1.0');
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
  });

  describe('resume 子命令', () => {
    it('resume --help 显示 [id] 位置参数', () => {
      const { stdout } = run(['resume', '--help']);
      expect(stdout).toContain('[id]');
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
});