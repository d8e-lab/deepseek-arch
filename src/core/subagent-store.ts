/**
 * SubagentStore — 子代理输出内存缓冲
 *
 * 在 Agent Loop 中实时捕获子代理每轮输出（thinking/content/tool_calls/tool_results），
 * 供 TUI 详情视图渲染和存储持久化。
 *
 * 线程安全：单线程（Node.js event loop）下无竞态。
 */

/** 子代理单轮输出条目 */
export interface SubagentRoundEntry {
	/** 条目类型 */
	type: 'thinking' | 'content' | 'tool_call' | 'tool_result';
	/** 文本内容 */
	content: string;
	/** 毫秒时间戳 */
	timestamp: number;
	/** tool name（type=tool_call/tool_result 时） */
	toolName?: string;
	/** tool arguments（type=tool_call 时） */
	toolArgs?: Record<string, unknown>;
	/** tool result error（type=tool_result 时） */
	toolError?: string;
}

/** 单个子代理的完整执行记录 */
export interface SubagentRecord {
	/** 子代理名 */
	name: string;
	/** 委派任务 */
	task: string;
	/** 状态 */
	status: 'running' | 'completed' | 'failed';
	/** 启动时间 ms */
	startMs: number;
	/** 结束时间 ms（完成后填入） */
	endMs?: number;
	/** 最终结果文本 */
	result?: string;
	/** 每轮输出条目（按时间序） */
	entries: SubagentRoundEntry[];
}

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
	finish(name: string, result: string, failed: boolean): void {
		const record = this.records.get(name);
		if (record) {
			record.status = failed ? 'failed' : 'completed';
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
