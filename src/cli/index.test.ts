/**
 * CLI 端到端测试
 *
 * 通过 execSync 运行编译后的 CLI 验证输出。
 * 避免与 Commander 内部实现耦合。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI_PATH = resolve(import.meta.dirname!, '..', '..', 'dist', 'index.js');

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
    it('输出包含版本号、作者、发布日期', () => {
      const { stdout, status } = run(['--version']);
      expect(stdout).toContain('deepseek-arch v0.4.0');
      expect(stdout).toContain('作者: helcksun');
      expect(stdout).toContain('发布日期: 2026-05-18');
    });

    it('-V 等价于 --version', () => {
      const { stdout } = run(['-V']);
      expect(stdout).toContain('deepseek-arch v0.4.0');
    });
  });

  describe('--help', () => {
    it('显示 chat 和 resume 子命令', () => {
      const { stdout } = run(['--help']);
      expect(stdout).toContain('chat');
      expect(stdout).toContain('resume');
    });

    it('-h 等价于 --help', () => {
      const { stdout } = run(['-h']);
      expect(stdout).toContain('Usage:');
    });
  });

  describe('chat 子命令', () => {
    it('chat 无参数时运行 action', () => {
      const { stderr, status } = run(['chat']);
      // 非 TTY 环境应报错退出
      expect(stderr).toContain('错误: 需要交互式终端');
      expect(status).toBe(1);
    });

    it('chat --help 显示子命令帮助', () => {
      const { stdout } = run(['chat', '--help']);
      expect(stdout).toContain('--title');
    });
  });

  describe('resume 子命令', () => {
    it('resume --help 显示子命令帮助', () => {
      const { stdout } = run(['resume', '--help']);
      expect(stdout).toContain('--id');
      expect(stdout).toContain('--name');
    });

    it('resume 无参数时显示会话列表或空提示', () => {
      const { stdout, status } = run(['resume']);
      // 可能已有历史会话（显示表格），也可能为空（显示空提示）
      const hasContent =
        stdout.includes('没有历史会话') ||
        stdout.includes('输入序号恢复会话');
      expect(hasContent).toBe(true);
    });

    it('resume --id 不存在的会话时报错退出', () => {
      const { stderr, status } = run(['resume', '--id', 'nonexistent-id']);
      expect(stderr).toContain('未找到会话');
      expect(status).toBe(1);
    });

    it('resume --name 不存在的会话时报错退出', () => {
      const { stderr, status } = run(['resume', '--name', '不存在的标题']);
      expect(stderr).toContain("未找到标题为");
      expect(status).toBe(1);
    });
  });
});
