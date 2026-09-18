/**
 * chat --prompt（非交互单轮）与 --workspace 端到端测试
 *
 * 契约：
 *  - stdout = 最终回复；stderr = 进度（工具名）/错误；
 *  - 退出码：0 = 成功，1 = 缺少 --workspace / 会话不存在 / --workspace 目录不可用 / 本轮失败；
 *  - --prompt **必须**搭配 --workspace（v3 决策 D14：非交互场景 cwd 不可控）；
 *  - 单轮执行会正常落盘会话（供 heartbeat/脚本后续 resume）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname!, '..', '..');
const CLI_PATH = resolve(ROOT, 'dist', 'cli', 'index.js');

/** 带环境变量运行 CLI（临时 HOME 隔离配置与会话目录） */
function runWithEnv(
	args: string[],
	env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
	try {
		const stdout = execSync(`node ${CLI_PATH} ${args.join(' ')}`, {
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 30000,
			env: { ...process.env, ...env },
		});
		return { stdout, stderr: '', status: 0 };
	} catch (err: unknown) {
		const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
		return {
			stdout: e.stdout?.toString() ?? '',
			stderr: e.stderr?.toString() ?? '',
			status: e.status ?? null,
		};
	}
}

/**
 * 预置最小 providers.toml。
 * 注意：api_key 必须写进配置——配置值（空串）优先级高于 DEEPSEEK_API_KEY 环境变量，
 * 而空串不是 nullish，`??` 不会回退到环境变量。
 */
function seedHome(home: string): void {
	const dir = join(home, '.deepseek-arch');
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'providers.toml'),
		'[deepseek]\nbase_url = "https://api.deepseek.com"\napi_key = "test-key"\n',
		'utf-8',
	);
}

/** 建临时 HOME + 预置 key，返回清理函数 */
function makeHome(prefix: string): { home: string; cleanup: () => void } {
	const home = mkdtempSync(join(tmpdir(), prefix));
	seedHome(home);
	return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** 建临时 workspace（--prompt 必填），返回清理函数 */
function makeWorkspace(prefix: string): { ws: string; cleanup: () => void } {
	const ws = mkdtempSync(join(tmpdir(), prefix));
	return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

describe('chat --prompt（非交互单轮，e2e）', () => {
	beforeAll(() => {
		execSync('npx tsc', { cwd: ROOT, stdio: 'pipe' });
	});

	it('--help 显示 --prompt 与 --workspace', () => {
		const { stdout } = runWithEnv(['chat', '--help']);
		expect(stdout).toContain('--prompt');
		expect(stdout).toContain('--workspace');
	});

	it('--prompt 缺少 --workspace：报错并退出 1（D14）', () => {
		const { home, cleanup } = makeHome('deepseek-arch-prompt-nows-');
		try {
			const { stderr, status } = runWithEnv(['chat', '--mock', '--prompt', '测试'], { HOME: home });
			expect(status).toBe(1);
			expect(stderr).toContain('--prompt requires --workspace');
		} finally {
			cleanup();
		}
	});

	it('单轮执行：stdout 输出最终回复、退出码 0、会话正常落盘', () => {
		const { home, cleanup } = makeHome('deepseek-arch-prompt-');
		const { ws, cleanup: wsCleanup } = makeWorkspace('deepseek-arch-prompt-ws-');
		try {
			const { stdout, status } = runWithEnv(
				['chat', '--mock', '--prompt', '测试', '--workspace', ws],
				{ HOME: home },
			);

			expect(status).toBe(0);
			expect(stdout).toContain('测试通过！MockProvider 运行正常。');

			const sessionsDir = join(home, '.deepseek-arch', 'sessions');
			const ids = readdirSync(sessionsDir);
			expect(ids).toHaveLength(1);
			const meta = JSON.parse(readFileSync(join(sessionsDir, ids[0], 'meta.json'), 'utf-8'));
			expect(meta.turnCount).toBe(1);
			expect(meta.title).toContain('测试');
		} finally {
			cleanup();
			wsCleanup();
		}
	});

	it('--workspace 指向不存在的目录：报错并退出 1', () => {
		const { home, cleanup } = makeHome('deepseek-arch-prompt-ws-');
		try {
			const { stderr, status } = runWithEnv(
				['chat', '--mock', '--prompt', '测试', '--workspace', '/nonexistent-workspace-xyz'],
				{ HOME: home },
			);
			expect(status).toBe(1);
			expect(stderr).toContain('--workspace is not an accessible directory');
		} finally {
			cleanup();
		}
	});

	it('--workspace 指向存在的目录：正常执行并退出 0', () => {
		const { home, cleanup } = makeHome('deepseek-arch-prompt-ws2-');
		const { ws, cleanup: wsCleanup } = makeWorkspace('deepseek-arch-ws-');
		try {
			const { stdout, status } = runWithEnv(
				['chat', '--mock', '--prompt', '测试', '--workspace', ws],
				{ HOME: home },
			);
			expect(status).toBe(0);
			expect(stdout).toContain('测试通过');
		} finally {
			cleanup();
			wsCleanup();
		}
	});

	it('--prompt 配合 --resume 续跑已存在的会话（轮次累加）', () => {
		const { home, cleanup } = makeHome('deepseek-arch-prompt-resume-');
		const { ws, cleanup: wsCleanup } = makeWorkspace('deepseek-arch-resume-ws-');
		try {
			const env = { HOME: home };
			runWithEnv(['chat', '--mock', '--prompt', '测试', '--workspace', ws], env);

			const sessionsDir = join(home, '.deepseek-arch', 'sessions');
			const id = readdirSync(sessionsDir)[0];

			const { stdout, status } = runWithEnv(
				['chat', '--mock', '--prompt', '你是谁', '--resume', id, '--workspace', ws],
				env,
			);
			expect(status).toBe(0);
			expect(stdout).toContain('我是 MockProvider');

			const meta = JSON.parse(readFileSync(join(sessionsDir, id, 'meta.json'), 'utf-8'));
			expect(meta.turnCount).toBe(2);
		} finally {
			cleanup();
			wsCleanup();
		}
	});

	it('--no-memory：不注入、不跑归纳、不注册记忆工具', () => {
		const { home, cleanup } = makeHome('deepseek-arch-prompt-nomem-');
		const { ws, cleanup: wsCleanup } = makeWorkspace('deepseek-arch-nomem-ws-');
		try {
			const { stdout, status } = runWithEnv(
				['chat', '--mock', '--prompt', '测试', '--workspace', ws, '--no-memory'],
				{ HOME: home },
			);
			expect(status).toBe(0);
			expect(stdout).toContain('测试通过');
			// 记忆 runtime 目录不应被创建（既不注入也不归纳）
			expect(existsSync(join(ws, '.deepseek-arch', 'memory', 'audit.jsonl'))).toBe(false);
		} finally {
			cleanup();
			wsCleanup();
		}
	});

	it('--resume 不存在的会话：退出 1 并提示', () => {
		const { home, cleanup } = makeHome('deepseek-arch-prompt-resume404-');
		const { ws, cleanup: wsCleanup } = makeWorkspace('deepseek-arch-404-ws-');
		try {
			const { stderr, status } = runWithEnv(
				['chat', '--mock', '--prompt', '测试', '--resume', 'nonexistent-id', '--workspace', ws],
				{ HOME: home },
			);
			expect(status).toBe(1);
			expect(stderr).toContain('Session not found');
		} finally {
			cleanup();
			wsCleanup();
		}
	});
});
