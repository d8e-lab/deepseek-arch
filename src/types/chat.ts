/**
 * 消息与对话相关类型
 */

import type { TokenUsage } from './token.js';

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 单条对话消息 */
export interface Message {
	/** 角色：system / user / assistant */
	role: MessageRole;
	/** 消息正文 */
	content: string;
	/**
	 * 模型思维链内容（reasoning_content）
	 * 持久化以命中供应商的 prompt kv-cache
	 */
	reasoning_content?: string;
	/**
	 * 工具调用 ID（为 agent tool call 预留）
	 */
	tool_call_id?: string;
	/** 工具名称（为 agent tool call 预留） */
	name?: string;
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
}

/** 流式事件（SessionManager → ChatUI 回调） */
export interface StreamEvent {
	type: 'reasoning_delta' | 'content_delta' | 'done' | 'error';
	/** 增量文本（reasoning_delta / content_delta） */
	text?: string;
	/** token 用量（done 事件） */
	usage?: TokenUsage;
	/** 错误信息（error 事件） */
	error?: string;
}
