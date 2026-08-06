/**
 * turn-utils.ts — TurnRecord 派生字段辅助函数
 *
 * 方案 C：有完整消息序列（messages）的轮次，顶层 assistant 不持久化
 * content/reasoning_content（避免双份存储），由本模块在读取时推导。
 * 无 messages 的轮次（无工具调用 / 中断无交互 / 旧数据）回退顶层字段。
 */

import type { TurnRecord } from '../types/chat.js';

/** 从 turn 推导助手最终回复 content（有 messages 时拼接，否则回退顶层） */
export function turnAssistantContent(turn: TurnRecord): string {
	if (turn.messages && turn.messages.length > 0) {
		return turn.messages
			.filter((m) => m.role === 'assistant')
			.map((m) => m.content ?? '')
			.join('');
	}
	return turn.assistant.content ?? '';
}

/** 从 turn 推导助手 reasoning_content（有 messages 时拼接，否则回退顶层） */
export function turnAssistantReasoning(turn: TurnRecord): string {
	if (turn.messages && turn.messages.length > 0) {
		return turn.messages
			.filter((m) => m.role === 'assistant')
			.map((m) => m.reasoning_content ?? '')
			.join('');
	}
	return turn.assistant.reasoning_content ?? '';
}
