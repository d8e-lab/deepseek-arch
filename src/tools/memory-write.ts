/**
 * memory_write — 写入/更新一条长期记忆
 *
 * 存储层的判定是确定性的（见 core/memory-store.ts）：
 *   指定 slug → 更新；同 subject 且正文等价 → 合并；同 subject 冲突 → 取代（旧条目留演化记录）；
 *   其余 → 新增（slug 由 subject 派生）。
 *
 * `scope` 决定写到哪一层：`project` = {workspace}/.deepseek-arch/memory/；`global` = ~/.deepseek-arch/memory/。
 * 写完后自动重建该层索引（MEMORY.md / candidates.md），并追加审计。
 *
 * 何时不该写：技术事实、任务细节、临时上下文、能从代码/仓库直接得到的信息（对齐 Claude Code 的
 * "What NOT to save"）。宁少勿滥：只写「跨会话仍有意义」的偏好/约定/边界。
 */

import type { Tool, ToolResult } from './types.js';
import { getMemoryStore } from '../core/memory-service.js';
import { MEMORY_TYPES, type MemoryType } from '../core/memory-store.js';

function asStringArray(v: unknown): string[] | undefined {
	if (v === undefined || v === null) return undefined;
	if (Array.isArray(v)) return v.map((x) => String(x));
	const s = String(v).trim();
	return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
}

/** 写入记忆（可显式传入 store —— memory agent 用它自己的实例，避免全局单例串用） */
export async function writeMemoryEntry(
	store: ReturnType<typeof getMemoryStore>,
	params: Record<string, unknown>,
): Promise<ToolResult> {
	const subject = String(params.subject ?? '').trim();
	const body = String(params.body ?? '').trim();
	if (!subject || !body) {
		return { content: '', error: 'both "subject" and "body" are required' };
	}
	const scope = params.scope === 'global' ? 'global' : 'project';
	const type = (MEMORY_TYPES as readonly string[]).includes(String(params.type))
		? (params.type as MemoryType)
		: 'reference';

	try {
		const result = await store.write(scope, {
			slug: typeof params.slug === 'string' && params.slug.trim() ? params.slug.trim() : undefined,
			subject,
			body,
			name: typeof params.name === 'string' ? params.name : undefined,
			description: typeof params.description === 'string' ? params.description : undefined,
			type,
			tags: asStringArray(params.tags),
			paths: asStringArray(params.paths),
			confidence: typeof params.confidence === 'number' ? params.confidence : undefined,
			remindAt: typeof params.remindAt === 'string' ? params.remindAt : undefined,
			by: typeof params.by === 'string' ? params.by : 'master',
		});
		await store.rebuildIndex(scope);

		const verb =
			result.action === 'add' ? 'added'
			: result.action === 'update' ? 'updated'
			: result.action === 'merge' ? 'merged into existing entry'
			: 'superseded previous entry';
		const superseded = result.superseded?.length ? ` (replaced: ${result.superseded.join(', ')})` : '';
		return { content: `memory_write ok: ${verb} [${scope}] "${result.slug}.md"${superseded}` };
	} catch (err) {
		return { content: `memory_write failed: ${(err as Error).message}`, error: 'write_failed' };
	}
}

export const memoryWriteTool: Tool = {
	name: 'memory_write',
	description:
		'Remember a durable user preference, convention or boundary across sessions. ' +
		'Only write things that stay meaningful in future sessions (preferences, conventions, scope decisions); ' +
		'never write technical facts, task details or temporary context that can be re-derived from the repo. ' +
		'Reuse the same `subject` for the same topic — the store will then update or supersede the existing entry ' +
		'instead of creating a duplicate. Use confidence 3 for explicit user statements, 2 for corrections/confirmations, ' +
		'1 for uncertain inferences. Read the memory index injected as <memory_listing> first if you are unsure ' +
		'whether the topic is already remembered.',
	parameters: {
		type: 'object',
		properties: {
			scope: {
				type: 'string',
				enum: ['project', 'global'],
				description:
					'project = only this workspace; global = personal preference valid across projects. Default: project.',
			},
			subject: {
				type: 'string',
				description: 'Stable topic key used for merging, e.g. "reply.format", "test.policy", "plan.dir".',
			},
			body: {
				type: 'string',
				description:
					'The memory text. For preferences write: rule/fact, then "**Why:**" and "**How to apply:**" lines.',
			},
			name: { type: 'string', description: 'Short human-readable title (shown in the index).' },
			description: { type: 'string', description: 'One-line description used to judge relevance later.' },
			type: { type: 'string', enum: MEMORY_TYPES as unknown as string[], description: 'Memory type.' },
			tags: { type: 'string', description: 'Comma-separated tags (lowercase words).' },
			paths: { type: 'string', description: 'Comma-separated path globs this memory applies to (optional).' },
			confidence: { type: 'number', description: '1 = uncertain, 2 = correction/confirmation, 3 = explicit user statement.' },
			slug: { type: 'string', description: 'Existing entry slug to update (from the index). Omit to add/merge.' },
			remindAt: { type: 'string', description: 'ISO 8601 time to remind about this entry (optional).' },
		},
		required: ['subject', 'body'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		return writeMemoryEntry(getMemoryStore(), params);
	},
};
