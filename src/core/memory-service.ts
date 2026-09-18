/**
 * memory-service.ts — 记忆服务的路径与实例装配（单一入口）
 *
 * 项目层 = `{workspace}/.deepseek-arch/memory/`（workspace-paths.getMemoryDir）
 * 全局层 = `~/.deepseek-arch/memory/`（跨项目偏好）
 *
 * `setMemoryStore()` 供运行时替换（CLI/session 用配置里的阈值构造；测试注入临时目录）。
 * 工具与 agent 一律通过 `getMemoryStore()` 取实例，避免各处重复解析路径与阈值。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './memory-store.js';
import { getMemoryDir } from './workspace-paths.js';

export interface MemoryServiceOptions {
	/** 项目层目录（默认 {workspace}/.deepseek-arch/memory） */
	projectDir?: string;
	/** 全局层目录（默认 ~/.deepseek-arch/memory） */
	globalDir?: string;
	/** master 可见的最低置信度（默认 2） */
	masterMinConfidence?: number;
	/** LRU 局部判定总开关（默认 true） */
	lruEnabled?: boolean;
	/** 会话内即时升级阈值（默认 2） */
	promoteUses?: number;
}

/** 全局层目录 */
export function getGlobalMemoryDir(): string {
	return join(homedir(), '.deepseek-arch', 'memory');
}

/** 按当前工作区/配置构造 MemoryStore */
export function createMemoryStore(opts: MemoryServiceOptions = {}): MemoryStore {
	return new MemoryStore({
		projectDir: opts.projectDir ?? getMemoryDir(),
		globalDir: opts.globalDir ?? getGlobalMemoryDir(),
		masterMinConfidence: opts.masterMinConfidence ?? 2,
		lruEnabled: opts.lruEnabled ?? true,
		promoteUses: opts.promoteUses ?? 2,
	});
}

let override: MemoryStore | null = null;

/** 运行时替换记忆存储（CLI/session 按配置构造；测试注入临时目录） */
export function setMemoryStore(store: MemoryStore | null): void {
	override = store;
}

/** 取当前记忆存储（未显式设置时按工作区默认值懒构造） */
export function getMemoryStore(): MemoryStore {
	return override ?? createMemoryStore();
}

// ─── 记忆告警通道（TUI / headless 各自注册一个 sink）──────────
//
// 用途：需要"让用户看到"的边界情况（如条目超过 64K 被截断）。
// 工具（memory_read / memory_write）拿不到 SessionManager，因此 sink 放在本模块，
// 由 UI 层注册；未注册时静默（不影响工具结果本身）。

export type MemoryAlertSink = (message: string) => void;

let alertSink: MemoryAlertSink | null = null;

/** 注册告警 sink（传 null 取消） */
export function setMemoryAlertSink(sink: MemoryAlertSink | null): void {
	alertSink = sink;
}

/** 发出一次记忆告警（sink 抛错不影响调用方） */
export function emitMemoryAlert(message: string): void {
	try {
		alertSink?.(message);
	} catch {
		/* UI 提示失败不影响记忆操作 */
	}
}
