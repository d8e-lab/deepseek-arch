/**
 * memory-lock.test.ts — 记忆写锁单元测试（v3 决策 D13）
 *
 * 覆盖：互斥（并发调用必须串行）、fn 抛错也释放锁、陈旧锁可被抢占、
 * 拿不到锁时有界超时（不无限阻塞）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withMemoryLock, memoryLockPath } from '../../src/core/memory-lock.js';

describe('withMemoryLock', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'deepseek-mem-lock-'));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('互斥：并发调用串行执行，且结束后锁文件被清理', async () => {
		const order: string[] = [];
		const a = withMemoryLock(dir, async () => {
			order.push('a-start');
			await new Promise((resolve) => setTimeout(resolve, 60));
			order.push('a-end');
		});
		const b = withMemoryLock(dir, async () => {
			order.push('b-start');
			order.push('b-end');
		});
		await Promise.all([a, b]);

		expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
		expect(existsSync(memoryLockPath(dir))).toBe(false);
	});

	it('fn 抛错也会释放锁（后续调用不被卡死）', async () => {
		await expect(withMemoryLock(dir, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
		expect(existsSync(memoryLockPath(dir))).toBe(false);
		await expect(withMemoryLock(dir, async () => 'ok')).resolves.toBe('ok');
	});

	it('陈旧锁可被抢占（持有者崩溃留下的锁文件）', async () => {
		await writeFile(memoryLockPath(dir), 'dead-process-1\n', 'utf-8');
		// mtime 设到很久以前 → 视为陈旧
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(memoryLockPath(dir), old, old);

		await expect(withMemoryLock(dir, async () => 'ok', { staleMs: 1000 })).resolves.toBe('ok');
	});

	it('拿不到锁时有界超时（不无限阻塞）', async () => {
		await writeFile(memoryLockPath(dir), 'other-process\n', 'utf-8'); // 新鲜锁

		await expect(
			withMemoryLock(dir, async () => 'never', { timeoutMs: 120, staleMs: 60_000 }),
		).rejects.toThrow(/timeout/);
	});
});
