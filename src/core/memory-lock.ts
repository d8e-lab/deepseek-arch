/**
 * memory-lock.ts — 记忆写入的 workspace 级互斥锁（跨进程）
 *
 * 为什么需要：即使产品上"暂不支持同一 workspace 多会话"，实际上仍会有第二个进程 ——
 * TUI 与 cron/heartbeat 唤起的 `chat --prompt`，或两次 `chat --prompt` 时间上重叠。
 * 记忆条目与索引是「读-改-写 + 整文件重写」，并发会互相覆盖（丢条目/丢使用统计）。
 *
 * 语义：
 *  - **粗粒度**：每层记忆目录一把锁（`.memory.lock`），一次只允许一个写者；
 *  - **有界等待**：默认 15s 拿不到就抛错（调用方按"本次记忆操作失败"处理，不影响主流程）；
 *  - **崩溃自愈**：锁文件 mtime 超过 staleMs 视为陈旧（持有者已死），可被抢占；
 *  - **不误删**：释放前核对 token，只有自己仍持有才删除（避免删掉抢占者的锁）。
 *
 * 只保护"写入/整理"，读路径不取锁（读多写少，且读不破坏数据）。
 */

import { open, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** 锁文件名（放在对应记忆层目录内） */
const LOCK_FILE = '.memory.lock';

/** 默认等待上限（毫秒） */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 陈旧锁判定（毫秒）：明显长于任何一次记忆写入，避免误抢正常运行中的锁 */
const DEFAULT_STALE_MS = 5 * 60_000;

export interface MemoryLockOptions {
	/** 获取锁的最长等待时间（默认 15s） */
	timeoutMs?: number;
	/** 锁文件多久未更新视为陈旧、可抢占（默认 5 分钟） */
	staleMs?: number;
}

/** 锁文件路径（测试与排查用） */
export function memoryLockPath(dir: string): string {
	return join(dir, LOCK_FILE);
}

/**
 * 在记忆层目录上取得独占锁后执行 `fn`。
 * 拿不到锁时抛错（调用方决定降级策略），不会无限阻塞。
 */
export async function withMemoryLock<T>(
	dir: string,
	fn: () => Promise<T>,
	opts: MemoryLockOptions = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const lockPath = memoryLockPath(dir);
	const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const deadline = Date.now() + timeoutMs;

	let handle: Awaited<ReturnType<typeof open>> | null = null;
	while (handle === null) {
		try {
			handle = await open(lockPath, 'wx', 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			// 陈旧锁：持有者崩溃留下的文件 → 清理后重试
			try {
				const st = await stat(lockPath);
				if (Date.now() - st.mtimeMs > staleMs) {
					await unlink(lockPath);
					continue;
				}
			} catch { /* 锁刚被释放 → 直接重试 */ }
			if (Date.now() > deadline) {
				throw new Error(`memory lock timeout (${timeoutMs}ms): ${lockPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 40));
		}
	}

	try {
		await handle.writeFile(`${token}\n`, 'utf-8');
		return await fn();
	} finally {
		try {
			await handle.close();
		} catch { /* 关闭失败忽略 */ }
		// 只删自己的锁：若期间被判定为陈旧并遭抢占，文件里会是别人的 token
		try {
			const current = (await readFile(lockPath, 'utf-8')).trim();
			if (current === token) await unlink(lockPath);
		} catch { /* 已被清理或不可读 → 忽略 */ }
	}
}
