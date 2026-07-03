/**
 * 会话相关类型
 */

import type { TurnRecord, Message } from './chat.js';
import type { TokenUsage } from './token.js';

/** 会话元数据（不含消息体） */
export interface SessionMeta {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
	/** 轮次数 */
	turnCount: number;
	/** 累计费用 (CNY) */
	totalCost: number;
	/** 最后一轮对话的 token 用量（用于退出汇总，无需加载全量 turns） */
	lastUsage?: TokenUsage;
	/** 最后一次浏览器访问的 URL（resume 时自动恢复） */
	lastBrowserUrl?: string;
}

/** 会话列表项（用于 resume 列表展示） */
export interface SessionListItem {
	index: number;
	id: string;
	title: string;
	updated_at: string;
	turnCount: number;
}

/** 完整会话（含所有轮次） */
export interface Session {
	meta: SessionMeta;
	turns: TurnRecord[];
	systemPrompt?: string;
}

/** 加载会话时使用的会话数据 */
export type SessionData = Session;
