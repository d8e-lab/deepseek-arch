/**
 * SubagentStore — 子代理输出内存缓冲
 *
 * 在 Agent Loop 中实时捕获子代理每轮输出（thinking/content/tool_calls/tool_results），
 * 供 TUI 详情视图渲染和存储持久化。
 *
 * 线程安全：单线程（Node.js event loop）下无竞态。
 */

import type { SubagentRecord, SubagentRoundEntry } from '../types/subagent.js';

// re-export 领域类型（兼容旧导入路径：from './subagent-store.js'）
export type { SubagentRecord, SubagentRoundEntry } from '../types/subagent.js';

export class SubagentStore {
	private records = new Map<string, SubagentRecord>();

	/** 创建一个新的子代理记录（spawn 时调用） */
	start(name: string, task: string): SubagentRecord {
		const record: SubagentRecord = {
			name,
			task,
			status: 'running',
			startMs: Date.now(),
			entries: [],
		};
		this.records.set(name, record);
		return record;
	}

	/** 推送一条输出条目 */
	push(name: string, entry: SubagentRoundEntry): void {
		const record = this.records.get(name);
		if (record) {
			record.entries.push(entry);
		}
	}

	/** 标记子代理完成 */
	finish(name: string, result: string, status: 'completed' | 'failed' | 'cancelled'): void {
		const record = this.records.get(name);
		if (record) {
			record.status = status;
			record.endMs = Date.now();
			record.result = result;
		}
	}

	/** 获取指定子代理记录 */
	get(name: string): SubagentRecord | undefined {
		return this.records.get(name);
	}

	/** 列出所有子代理名 */
	list(): string[] {
		return [...this.records.keys()];
	}

	/** 列出所有记录（用于持久化） */
	listRecords(): SubagentRecord[] {
		return [...this.records.values()];
	}

	/** 清空 */
	clear(): void {
		this.records.clear();
	}
}
