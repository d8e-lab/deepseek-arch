/**
 * turn-utils.ts — TurnRecord 派生字段辅助函数
 *
 * v2：messages 恒存（唯一事实源），顶层不再持久化 turn/user/assistant。
 * 所有读取方统一走本模块：
 *   - turnUserContent：用户消息（messages[0]，旧数据回退 turn.user）
 *   - turnAssistantContent / turnAssistantReasoning：助手回复（messages 拼接，旧数据回退顶层）
 * v1 旧数据（无 messages）仍可从 user/assistant/tool_calls 重建。
 */

import type { TurnRecord } from '../types/chat.js';

/** 从 turn 推导用户消息 content（v2: messages[0]；旧数据回退 turn.user） */
export function turnUserContent(turn: TurnRecord): string {
	if (turn.messages && turn.messages.length > 0) {
		const first = turn.messages[0];
		if (first.role === 'user') return first.content;
	}
	return turn.user?.content ?? '';
}

/** 从 turn 推导助手最终回复 content（有 messages 时拼接，否则回退顶层） */
export function turnAssistantContent(turn: TurnRecord): string {
	if (turn.messages && turn.messages.length > 0) {
		return turn.messages
			.filter((m) => m.role === 'assistant')
			.map((m) => m.content ?? '')
			.join('');
	}
	return turn.assistant?.content ?? '';
}

/** 从 turn 推导助手 reasoning_content（有 messages 时拼接，否则回退顶层） */
export function turnAssistantReasoning(turn: TurnRecord): string {
	if (turn.messages && turn.messages.length > 0) {
		return turn.messages
			.filter((m) => m.role === 'assistant')
			.map((m) => m.reasoning_content ?? '')
			.join('');
	}
	return turn.assistant?.reasoning_content ?? '';
}
