/**
 * 消息与对话相关类型
 */

import type { TokenUsage } from './token.js';
import type { ToolCallRecord } from '../tools/types.js';

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 单条对话消息 */
export interface Message {
	/** 角色：system / user / assistant / tool */
	role: MessageRole;
	/** 消息正文（assistant 触发 tool_calls 时可为空） */
	content: string;
	/**
	 * 模型思维链内容（reasoning_content）
	 * 持久化以命中供应商的 prompt kv-cache
	 */
	reasoning_content?: string;
	/**
	 * 工具调用 ID（tool 角色消息关联到哪个 tool_call）
	 */
	tool_call_id?: string;
	/** 工具名称 */
	name?: string;
	/** 工具调用列表（assistant 角色触发 tool_calls 时填充） */
	tool_calls?: import('./api.js').ToolCall[];
}

/** 一轮对话（user + assistant + usage + cost） */
export interface TurnRecord {
	/** 轮次序号（从 1 开始） */
	turn: number;
	/** 用户消息 */
	user: Message;
	/** 助手回复 */
	assistant: {
		/** API 返回的 response id */
		id: string;
		role: 'assistant';
		content: string;
		reasoning_content?: string;
	};
	/** Token 用量 */
	usage?: TokenUsage;
	/** 本轮费用 (CNY) */
	cost_rmb: number;
	/** 创建时间 */
	created_at: string;
	/** 是否为中断的不完整轮次（不会被发送回 API 作为上下文） */
	interrupted?: boolean;
	/** 本轮工具调用记录（含执行结果，agent 模式下填充） */
	tool_calls?: ToolCallRecord[];
	/**
	 * 本轮完整消息序列（含 user、中间 assistant tool_calls、tool results、最终 assistant）
	 * 用于精确回放 API 收发的消息前缀，命中 KV cache。
	 * 不存在时回退到从 tool_calls 重建（兼容旧数据）。
	 */
	messages?: Message[];
	/** Agent loop 每轮 API 调用的 token 用量（用于监控缓存命中率） */
	round_usage?: RoundUsage[];
}

/** 审查模型判决类型 */
export type ReviewVerdict = 'completed' | 'stalled' | 'deflecting' | 'asking_user';

/** Agent loop 单轮 token 用量（用于记录每轮 API 调用的缓存行为） */
export interface RoundUsage {
	/** agent loop 中的轮次（从 0 开始） */
	round: number;
	/** 本轮 prompt tokens */
	prompt_tokens: number;
	/** 本轮 completion tokens */
	completion_tokens: number;
	/** 本轮命中缓存 tokens */
	cache_hit_tokens: number;
	/** 本轮未命中缓存 tokens */
	cache_miss_tokens: number;
}

/** 流式事件（SessionManager → ChatUI 回调） */
export interface StreamEvent {
	type: 'reasoning_delta' | 'content_delta' | 'done' | 'error'
		| 'tool_call_delta' | 'tool_call_start' | 'tool_preview' | 'tool_result'
		| 'tool_output'
		| 'review_verdict'
		| 'subagent_spawned' | 'subagent_finished' | 'subagent_update';
	/** 增量文本（reasoning_delta / content_delta / tool_call_delta） */
	text?: string;
	/** token 用量（done 事件） */
	usage?: TokenUsage;
	/** 错误信息（error 事件 / tool_result 事件的工具执行错误 / subagent_finished） */
	error?: string;
	/** tool call ID（tool_call_delta / tool_call_start / tool_preview / tool_result / tool_output） */
	toolCallId?: string;
	/** tool 名称（tool_call_start / tool_preview） */
	toolName?: string;
	/** tool 参数（tool_call_start） */
	toolArgs?: Record<string, unknown>;
	/** diff 预览内容（tool_preview） */
	toolPreview?: string;
	/** tool 执行结果（tool_result） */
	toolResult?: string;
	/** tool 是否被拒绝执行（tool_result） */
	toolDenied?: boolean;
	/** tool 实时输出行（tool_output），stream 标识 stdout/stderr */
	outputLine?: string;
	outputStream?: 'stdout' | 'stderr';
	/** 审查判决（review_verdict 事件） */
	verdict?: ReviewVerdict;
	/** 审查理由（review_verdict 事件） */
	reviewReason?: string;
	/** 是否自动继续（review_verdict 事件：true=注入 continuation, false=等待用户） */
	autoContinue?: boolean;
	/** 子代理名（subagent_spawned / subagent_finished / subagent_update） */
	subagentName?: string;
	/** 子代理任务（subagent_spawned） */
	subagentTask?: string;
	/** 子代理状态（subagent_finished） */
	subagentStatus?: 'completed' | 'failed';
	/** 子代理耗时 ms（subagent_finished） */
	subagentElapsedMs?: number;
}
