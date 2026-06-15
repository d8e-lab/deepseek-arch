/**
 * FileStateManager — 追踪文件读取状态，防止模型在文件被外部修改后基于过时内容编辑
 *
 * 流程：
 *   1. read_file 完成后 record(path, stat) 记录 mtime+size
 *   2. edit_file/write_file 执行前 check(path) 比对当前状态
 *   3. 如果文件自上次 read 后被修改，返回 [STALE] 错误
 *   4. 工具自身的成功写入也会 update() 刷新状态
 *
 * 状态文件位置: <sessionCwd>/.agent-file-state.json
 * 仅记录相对路径，跨 turn 持久化。
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';

interface FileRecord {
	/** mtime 毫秒时间戳 */
	mtime: number;
	/** 文件字节大小 */
	size: number;
}

type StateStore = Record<string, FileRecord>;

export class FileStateManager {
	private store: StateStore = {};
	private statePath: string;
	private baseDir: string;

	constructor(sessionCwd: string) {
		this.baseDir = sessionCwd;
		this.statePath = `${sessionCwd}/.agent-file-state.json`;
	}

	/** 从磁盘加载状态 */
	async load(): Promise<void> {
		try {
			const raw = await readFile(this.statePath, 'utf-8');
			this.store = JSON.parse(raw);
		} catch {
			this.store = {};
		}
	}

	/** 持久化到磁盘 */
	private async save(): Promise<void> {
		await writeFile(this.statePath, JSON.stringify(this.store, null, 2), { mode: 0o600 });
	}

	/** 将绝对路径转为相对路径作为 key */
	private key(absPath: string): string {
		return relative(this.baseDir, absPath);
	}

	/** 记录一次读取后的文件状态 */
	async record(absPath: string, fileStat: { mtimeMs: number; size: number }): Promise<void> {
		this.store[this.key(absPath)] = {
			mtime: fileStat.mtimeMs,
			size: fileStat.size,
		};
		await this.save();
	}

	/**
	 * 检查文件是否自上次 record 后被修改。
	 * 返回 null 表示 OK，返回字符串表示错误消息。
	 */
	async check(absPath: string): Promise<string | null> {
		const key = this.key(absPath);
		const prev = this.store[key];
		if (!prev) return null; // 从未被 read_file 记录，放行

		let current: { mtimeMs: number; size: number };
		try {
			const s = await stat(absPath);
			current = { mtimeMs: s.mtimeMs, size: s.size };
		} catch {
			// 文件不存在但之前读过 → 可能被外部删除
			return `[STALE] ${key} was deleted since your last read. Re-read to confirm current state.`;
		}

		if (current.mtimeMs !== prev.mtime || current.size !== prev.size) {
			const prevTime = new Date(prev.mtime).toISOString();
			return `[STALE] ${key} was modified since your last read (${prevTime}). Re-read the file before editing.`;
		}

		return null;
	}

	/** 工具写入成功后更新状态，避免自身写入触发误报 */
	async update(absPath: string): Promise<void> {
		try {
			const s = await stat(absPath);
			this.store[this.key(absPath)] = { mtime: s.mtimeMs, size: s.size };
			await this.save();
		} catch {
			// 文件可能被删除，移除记录
			delete this.store[this.key(absPath)];
			await this.save();
		}
	}
}

/** 单例（按 sessionCwd 区分） */
const instances = new Map<string, FileStateManager>();

export async function getFileStateManager(sessionCwd: string): Promise<FileStateManager> {
	let mgr = instances.get(sessionCwd);
	if (!mgr) {
		mgr = new FileStateManager(sessionCwd);
		await mgr.load();
		instances.set(sessionCwd, mgr);
	}
	return mgr;
}
