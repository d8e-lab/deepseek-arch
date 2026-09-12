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
	/** 每轮输出条目（按时间序） */
	entries: SubagentRoundEntry[];
	/** 完整消息上下文（含 system/user/assistant/tool；方案 B 会话化后持久化，用于续跑恢复） */
	messages?: import('./chat.js').Message[];
}

/**
 * 子代理落盘元数据（`<sessionDir>/subagents/<name>/meta.json`）。
 * 与 master 的会话 meta.json 同构：状态/时间/轮数 + 该子代理的 system prompt。
 */
export interface SubagentMeta {
	name: string;
	task: string;
	status: 'running' | 'completed' | 'failed' | 'cancelled';
	startMs: number;
	endMs?: number;
	/** 运行轮数（= runs 数组长度） */
	runCount: number;
	/** 完整 system prompt（含 Subagent Mode 片段），恢复时作为消息队列首条 */
	systemPrompt: string;
}

/**
 * 单轮运行落盘记录（`<sessionDir>/subagents/<name>/turn_0.json` 数组元素）。
 * 与 master 每 turn 只存自己那段 messages 同构——每轮存自己的 delta，避免 O(n²) 膨胀。
 */
export interface SubagentRunRecord {
	/** 运行序号（0 起） */
	runIndex: number;
	/** 该轮 user 侧输入（首启 = task；续跑 = 指令） */
	userText: string;
	/** 输入来源 */
	source: 'task' | 'master' | 'user';
	/** 本轮消息（含该轮 user 消息；不含 system） */
	messages: import('./chat.js').Message[];
	/** 本轮输出条目 */
	entries: SubagentRoundEntry[];
	/** 本轮结束状态（进行中为 'running'） */
	status: 'running' | 'completed' | 'failed' | 'cancelled';
	/** 失败原因（status='failed' 时） */
	error?: string;
	/** 本轮开始时间 ms */
	created_at: number;
	/** 本轮结束时间 ms */
	ended_at?: number;
}
