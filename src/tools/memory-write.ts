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
import { getMemoryStore, emitMemoryAlert } from '../core/memory-service.js';
import { withMemoryLock } from '../core/memory-lock.js';
import { MAX_MEMORY_ENTRY_BYTES, MEMORY_TYPES, type MemoryType } from '../core/memory-store.js';

function asStringArray(v: unknown): string[] | undefined {
	if (v === undefined || v === null) return undefined;
	if (Array.isArray(v)) return v.map((x) => String(x));
	const s = String(v).trim();
	return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
}

/**
 * 置信度容错：模型经常把数字写成字符串（`"1"`），旧实现用 `typeof === 'number'` 判断，
 * 于是字符串被**静默丢弃** —— "软化删除（confidence 1）"看起来成功、实际没生效。
 * 现在统一转数字；不可解析才视为未提供。范围由 store 侧 clamp 到 1–3。
 */
function asConfidence(v: unknown): number | undefined {
	if (v === undefined || v === null || v === '') return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
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
		// workspace 级写锁：与另一个进程（TUI / cron heartbeat）的记忆写入互斥
		const result = await withMemoryLock(store.dirOf(scope), () => store.write(scope, {
			slug: typeof params.slug === 'string' && params.slug.trim() ? params.slug.trim() : undefined,
			subject,
			body,
			name: typeof params.name === 'string' ? params.name : undefined,
			description: typeof params.description === 'string' ? params.description : undefined,
			type,
			tags: asStringArray(params.tags),
			paths: asStringArray(params.paths),
			confidence: asConfidence(params.confidence),
			supersedes: asStringArray(params.supersedes),
			by: typeof params.by === 'string' ? params.by : 'master',
		}));
		// 索引（MEMORY.md / candidates.md）由 store 内部随写随新，调用方不需要 rebuildIndex

		// 超限告警：记忆应当是"一行偏好 + 简短说明"；写入侧就提醒，别等到读取被截断才发现
		const writtenBytes = Buffer.byteLength(body, 'utf-8');
		if (writtenBytes > MAX_MEMORY_ENTRY_BYTES) {
			emitMemoryAlert(
				`[memory] "${result.slug}" 正文 ${Math.round(writtenBytes / 1024)}K 超过上限 ${Math.round(MAX_MEMORY_ENTRY_BYTES / 1024)}K，读取时会被截断（建议拆分或改放普通文件）`,
			);
		}

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
		'1 for uncertain inferences; when you pass a `slug` to update an existing entry, keep its current confidence ' +
		'(a lower value really downgrades it — 1 moves it out of the visible index). ' +
		'Read the memory index injected as <memory_listing> first if you are unsure ' +
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
			supersedes: {
				type: 'string',
				description:
					'Comma-separated slugs this entry replaces (optional). Omit to let the store decide by subject.',
			},
		},
		required: ['subject', 'body'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		return writeMemoryEntry(getMemoryStore(), params);
	},
};
