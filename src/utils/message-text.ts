/**
 * message-text.ts — 从上线消息中提取纯文本
 *
 * `ApiMessage.content` 可能是纯字符串，也可能是内容块数组（含图片块）。
 * 所有只关心文本的消费方（MockProvider、日志、标题推导）统一走本模块，
 * 避免各处重复处理块结构。
 */

import type { ApiContentBlock } from '../types/api.js';

/** content 联合类型的最小结构约束 */
export interface ContentCarrier {
	content: string | ApiContentBlock[];
}

/** 拼接消息中的所有文本块（图片块被忽略） */
export function messageText(message: ContentCarrier): string {
	const { content } = message;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((block): block is Extract<ApiContentBlock, { type: 'text' }> => block?.type === 'text')
		.map((block) => block.text ?? '')
		.join('');
}

/** 消息是否携带图片块 */
export function hasImageBlocks(message: ContentCarrier): boolean {
	const { content } = message;
	if (!Array.isArray(content)) return false;
	return content.some((block) => block?.type === 'image_url');
}

/** 统计消息中的图片块数量 */
export function countImageBlocks(message: ContentCarrier): number {
	const { content } = message;
	if (!Array.isArray(content)) return 0;
	return content.filter((block) => block?.type === 'image_url').length;
}
