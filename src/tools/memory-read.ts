/**
 * memory_read — 读取记忆条目全文（项目层 + 全局层）
 *
 * 为什么需要专用工具：普通 `read_file` 走 `checkPath`（必须落在 workspace 内），
 * 而**全局层记忆在 `~/.deepseek-arch/memory/`**，文件工具永远读不到（设计稿约束 A）。
 * 本工具在 core 内直接 `node:fs` 读取，是全局层的唯一通道。
 *
 * 路径写法：
 *   - `reply-format.md`              → 自动定位（项目层优先，找不到查全局层）
 *   - `global:style-pref.md`         → 强制全局层
 *   - `project:reply-format.md`      → 强制项目层
 *   - `.deepseek-arch/memory/x.md`   → 按路径解析（含绝对路径）
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { Tool, ToolResult } from './types.js';
import { getMemoryStore } from '../core/memory-service.js';
import { parseEntry } from '../core/memory-store.js';

/** 单次返回的最大字节数（防止超长条目撑爆上下文） */
const MAX_BYTES = 64 * 1024;

interface ResolvedTarget {
	scope: 'project' | 'global';
	filePath: string;
}

/** 解析目标文件：返回存在的那个（不存在返回候选列表用于报错） */
async function resolveTarget(
	store: ReturnType<typeof getMemoryStore>,
	pathArg: string,
): Promise<{ target?: ResolvedTarget; tried: string[] }> {
	const tried: string[] = [];
	const raw = pathArg.trim();

	let layer: 'project' | 'global' | 'auto' = 'auto';
	let name = raw;
	const prefix = /^(global|project):/.exec(raw);
	if (prefix) {
		layer = prefix[1] as 'project' | 'global';
		name = raw.slice(prefix[0].length);
	}

	// 绝对路径 / 含目录的相对路径：直接读
	if (isAbsolute(name) || name.includes('/')) {
		const filePath = isAbsolute(name) ? name : join(process.cwd(), name);
		tried.push(filePath);
		try {
			if ((await stat(filePath)).isFile()) {
				const scope = filePath.includes('/.deepseek-arch/memory') && !filePath.startsWith(store.dirOf('project'))
					? 'global'
					: 'project';
				return { target: { scope, filePath }, tried };
			}
		} catch { /* 继续按层查找 */ }
	}

	const fileName = basename(name).endsWith('.md') ? basename(name) : `${basename(name)}.md`;
	const scopes: ('project' | 'global')[] = layer === 'auto' ? ['project', 'global'] : [layer];
	for (const scope of scopes) {
		const filePath = join(store.dirOf(scope), fileName);
		tried.push(filePath);
		try {
			if ((await stat(filePath)).isFile()) return { target: { scope, filePath }, tried };
		} catch { /* 下一个层 */ }
	}
	return { tried };
}

/**
 * 读取记忆条目（可显式传入 store —— memory agent 用它自己的实例，避免全局单例串用）
 *
 * @param recordUse 读到条目后是否记一次「使用」（LRU 升级/保鲜信号）。
 *   仅 **master 通过 `memory_read` 工具**读全文时记（工具的 execute 默认开启）；
 *   归纳代理自己的读取**不记**（它只是查重，不代表用户在用它）。
 */
export async function readMemoryEntry(
	store: ReturnType<typeof getMemoryStore>,
	pathArgRaw: string,
	recordUse = false,
): Promise<ToolResult> {
	const pathArg = String(pathArgRaw ?? '').trim();
	if (!pathArg) return { content: '', error: 'path is required' };

	const { target, tried } = await resolveTarget(store, pathArg);
	if (!target) {
		return {
			content: `Memory entry not found: ${pathArg}\nLooked in:\n${tried.map((p) => `- ${p}`).join('\n')}`,
			error: 'not_found',
		};
	}

	try {
		const raw = await readFile(target.filePath, 'utf-8');
		const truncated = raw.length > MAX_BYTES ? `${raw.slice(0, MAX_BYTES)}\n…(truncated)` : raw;
		const entry = parseEntry(raw, target.filePath, target.scope);
		const header = entry
			? `[memory:${target.scope}] ${entry.slug} (confidence ${entry.confidence}, updated ${entry.updated}, subject ${entry.subject})`
			: `[memory:${target.scope}] ${basename(target.filePath)} (no frontmatter — legacy note)`;
		if (recordUse && entry) {
			await store.recordUse(target.scope, entry.slug).catch(() => { /* 统计失败不影响读取 */ });
		}
		return { content: `${header}\n\n${entry ? entry.body : truncated}` };
	} catch (err) {
		return { content: `Failed to read ${target.filePath}: ${(err as Error).message}`, error: 'read_failed' };
	}
}

export const memoryReadTool: Tool = {
	name: 'memory_read',
	description:
		'Read a long-term memory entry in full (project layer and global layer both supported). ' +
		'Use it when the memory index (injected as <memory_listing>) mentions an entry you need details for. ' +
		'Path accepts a file name like "reply-format.md" (auto-detects the layer), ' +
		'or "global:<file>.md" / "project:<file>.md" to force a layer. ' +
		'Read-only.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Memory file name (e.g. "reply-format.md") or a layer-prefixed path ("global:style.md").',
			},
		},
		required: ['path'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		// recordUse：master 真读了全文 → 记一次「使用」（LRU 的升级/保鲜信号）
		return readMemoryEntry(getMemoryStore(), String(params.path ?? ''), true);
	},
};
