/**
 * memory_forget — 淘汰一条记忆（仅供 memory agent 使用）
 *
 * 与 `memory_write` 的区别：
 *   - `memory_write` 的 `confidence: 1` 是**软淘汰**：条目移入候选池（用户不再看到，仍可回溯、可恢复）；
 *   - 本工具是**硬淘汰**：写墓碑 + 退出索引（文件保留，避免丢失演化记录）。
 *
 * 权限限制（对齐设计稿 R5）：**不能删除 confidence = 3 的条目**（用户明确陈述的偏好只能由
 * 新条目取代（supersede）或用户本人 `/memory forget` 删除），避免归纳代理误删高置信记忆。
 *
 * 注册范围：**只给 memory agent**（不进 ALL_TOOLS / SUBAGENT_TOOLS）。
 */

import type { Tool, ToolResult } from './types.js';
import type { MemoryStore } from '../core/memory-store.js';
import { getMemoryStore } from '../core/memory-service.js';
import { withMemoryLock } from '../core/memory-lock.js';

/** 硬淘汰实现（可显式注入 store —— memory agent 用它自己的实例） */
export async function forgetMemoryEntry(
	store: MemoryStore,
	params: Record<string, unknown>,
): Promise<ToolResult> {
	const slug = String(params.slug ?? '').trim();
	if (!slug) return { content: '', error: 'slug is required' };
	const reason = typeof params.reason === 'string' ? params.reason : undefined;

	for (const scope of ['project', 'global'] as const) {
		const entry = await store.readEntry(scope, slug);
		if (!entry) continue;
		if (entry.confidence >= 3) {
			return {
				content:
					`Refused: "${slug}" has confidence 3 (an explicit user statement) and cannot be deleted by the memory agent. ` +
					'Write a contradicting memory with the same subject instead — the store will supersede it.',
				error: 'forbidden',
			};
		}
		const ok = await withMemoryLock(store.dirOf(scope), () => store.forget(scope, slug, reason ?? 'memory_agent'));
		return ok
			? { content: `memory_forget ok: "${slug}" retired (${scope}). The file is kept for history.` }
			: { content: `memory_forget failed: "${slug}" not found.`, error: 'not_found' };
	}

	return { content: `memory_forget: "${slug}" not found in either layer.`, error: 'not_found' };
}

export const memoryForgetTool: Tool = {
	name: 'memory_forget',
	description:
		'Retire a memory entry that is clearly obsolete (writes a tombstone and removes it from the index; the file is kept). ' +
		'Prefer `memory_write` with confidence 1 (soft retire: the entry leaves the visible index but stays recoverable). ' +
		'Use this only when the entry is truly wrong and there is no replacement statement. ' +
		'Entries with confidence 3 (explicit user statements) cannot be deleted this way — supersede them instead.',
	parameters: {
		type: 'object',
		properties: {
			slug: { type: 'string', description: 'Entry file name without .md (from the memory index).' },
			reason: { type: 'string', description: 'Why it is obsolete (audited).' },
		},
		required: ['slug'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		return forgetMemoryEntry(getMemoryStore(), params);
	},
};
