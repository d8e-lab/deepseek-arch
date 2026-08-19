/**
 * 子代理（Subagent）领域类型
 *
 * 从 src/core/subagent-store.ts 下沉到领域类型层，
 * 使 render SDK / presentation / core 均可引用，避免渲染层反向依赖 core。
 */

/** 子代理单轮输出条目 */
export interface SubagentRoundEntry {
	/** 条目类型 */
	type: 'thinking' | 'content' | 'tool_call' | 'tool_result' | 'tool_output';
	/** 文本内容 */
	content: string;
	/** 毫秒时间戳 */
	timestamp: number;
	/** tool name（type=tool_call/tool_result/tool_output 时） */
	toolName?: string;
	/** tool arguments（type=tool_call 时） */
	toolArgs?: Record<string, unknown>;
	/** tool result error（type=tool_result 时） */
	toolError?: string;
	/** 输出流（type=tool_output 时，stdout 或 stderr） */
	outputStream?: 'stdout' | 'stderr';
}

/** 单个子代理的完整执行记录 */
export interface SubagentRecord {
	/** 子代理名 */
	name: string;
	/** 委派任务 */
	task: string;
	/** 状态 */
	status: 'running' | 'completed' | 'failed' | 'cancelled';
	/** 启动时间 ms */
	startMs: number;
	/** 结束时间 ms（完成后填入） */
	endMs?: number;
	/** 最终结果文本 */
	result?: string;
	/** 每轮输出条目（按时间序） */
	entries: SubagentRoundEntry[];
}
