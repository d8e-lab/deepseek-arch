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
	/**
	 * 当前分代 id（compact 机制：轮次按 turn_{gen}.json 分代存储）。
	 * 新格式会话存在（初始 0，每次 compact +1）；旧 turns.json 会话无此字段。
	 */
	currentGen?: number;
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
	/** 请求上下文轮次（新格式 = 最新分代 turn_{currentGen}.json；旧格式 = turns.json 全量） */
	turns: TurnRecord[];
	/**
	 * 合并所有分代的轮次（TUI 全量显示用）。
	 * 新格式会话存在（按分代序+轮次序合并）；旧格式会话 undefined（回退 turns）。
	 */
	allTurns?: TurnRecord[];
	systemPrompt?: string;
}

/** 加载会话时使用的会话数据 */
export type SessionData = Session;
