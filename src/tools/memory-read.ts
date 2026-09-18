/**
 * memory_read — 读取记忆条目全文（项目层 + 全局层）
 *
 * 为什么需要专用工具：普通 `read_file` 走 `checkPath`（必须落在 workspace 内），
 * 而**全局层记忆在 `~/.deepseek-arch/memory/`**，文件工具永远读不到（设计稿约束 A）。
 * 本工具在 core 内直接 `node:fs` 读取，是全局层的唯一通道。
 *
 * 安全边界（v3 决策 D9）：只允许
 *   - 裸文件名：`reply-format.md`（自动定位层，项目层优先）
 *   - 层前缀：`global:style-pref.md` / `project:reply-format.md`
 *   - 落在两个 memory 目录**之内**的路径（绝对或相对）
 * 之外的路径一律拒绝。早期版本允许任意绝对路径（等于绕过 checkPath 读全盘），已移除。
 *
 * 大小上限（v3 决策 D10）：单条超过 MAX_MEMORY_ENTRY_BYTES（含 frontmatter）时截断返回，
 * 并通过告警通道在 UI 提示 —— 既避免超长内容塞进上下文，也提醒该条写歪了。
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Tool, ToolResult } from './types.js';
import { getMemoryStore, emitMemoryAlert } from '../core/memory-service.js';
import { MAX_MEMORY_ENTRY_BYTES, parseEntry, type MemoryScope } from '../core/memory-store.js';

interface ResolvedTarget {
	scope: MemoryScope;
	filePath: string;
}

/** p 是否在 root 之内（不含 root 自身） */
function isInside(root: string, p: string): boolean {
	const rel = relative(root, p);
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** 解析目标文件：只接受裸文件名，或两个 memory 目录之内的路径 */
async function resolveTarget(
	store: ReturnType<typeof getMemoryStore>,
	pathArg: string,
): Promise<{ target?: ResolvedTarget; tried: string[] }> {
	const tried: string[] = [];
	const raw = pathArg.trim();
	if (!raw) return { tried };

	let layer: MemoryScope | 'auto' = 'auto';
	let name = raw;
	const prefix = /^(global|project):/.exec(raw);
	if (prefix) {
		layer = prefix[1] as MemoryScope;
		name = raw.slice(prefix[0].length);
	}

	const scopes: MemoryScope[] = layer === 'auto' ? ['project', 'global'] : [layer];

	// 1) 绝对路径 / 带目录分隔符：解析后必须落在对应 memory 目录内
	if (isAbsolute(name) || /[\\/]/.test(name)) {
		for (const scope of scopes) {
			const root = store.dirOf(scope);
			const filePath = isAbsolute(name) ? resolve(name) : resolve(root, name);
			tried.push(filePath);
			if (!isInside(root, filePath)) continue;
			try {
				if ((await stat(filePath)).isFile()) return { target: { scope, filePath }, tried };
			} catch { /* 继续下一个层 */ }
		}
		return { tried };
	}

	// 2) 裸文件名：在两个层目录里按层查找
	const fileName = basename(name).endsWith('.md') ? basename(name) : `${basename(name)}.md`;
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
 * @param record 读到条目后的信号类型：
 *   - `'use'`（master 通过 `memory_read` 工具读全文）→ 记一次「使用」（LRU 升级/保鲜/复活证据）；
 *   - `'touch'`（**归纳代理**为查重而读）→ 只记「看到」：**推迟销毁倒计时**，不增 uses、不复活；
 *   - `'none'`（默认，纯读取）。
 */
export async function readMemoryEntry(
	store: ReturnType<typeof getMemoryStore>,
	pathArgRaw: string,
	record: 'none' | 'use' | 'touch' = 'none',
): Promise<ToolResult> {
	const pathArg = String(pathArgRaw ?? '').trim();
	if (!pathArg) return { content: '', error: 'path is required' };

	const { target, tried } = await resolveTarget(store, pathArg);
	if (!target) {
		return {
			content:
				`Memory entry not found (or path outside the memory directories): ${pathArg}\n` +
				'Allowed: a bare file name (e.g. "reply-format.md"), a layer prefix ("global:x.md" / "project:x.md"), ' +
				'or a path inside the project/global memory directories.\nLooked in:\n' +
				tried.map((p) => `- ${p}`).join('\n'),
			error: 'not_found',
		};
	}

	try {
		const full = await readFile(target.filePath, 'utf-8');
		const entry = parseEntry(full, target.filePath, target.scope);
		const header = entry
			? `[memory:${target.scope}] ${entry.slug} (confidence ${entry.confidence}, updated ${entry.updated}, subject ${entry.subject})`
			: `[memory:${target.scope}] ${basename(target.filePath)} (no frontmatter — legacy note)`;
		if (entry && record === 'use') {
			await store.recordUse(target.scope, entry.slug).catch(() => { /* 统计失败不影响读取 */ });
		} else if (entry && record === 'touch') {
			await store.recordTouch(target.scope, entry.slug).catch(() => { /* 同上 */ });
		}

		// 统一按字节截断（含 frontmatter 在内的整条内容）——超限在 UI 提示
		const bodyText = entry ? entry.body : full;
		const bytes = Buffer.byteLength(bodyText, 'utf-8');
		const over = bytes > MAX_MEMORY_ENTRY_BYTES;
		const bodyOut = over
			? Buffer.from(bodyText, 'utf-8').subarray(0, MAX_MEMORY_ENTRY_BYTES).toString('utf-8')
			: bodyText;
		if (over) {
			emitMemoryAlert(
				`[memory] "${entry?.slug ?? basename(target.filePath)}" 超过 ${Math.round(MAX_MEMORY_ENTRY_BYTES / 1024)}K，已截断返回（建议拆分，或把长内容改放普通文件）`,
			);
		}

		const suffix = over ? `\n\n⚠ (truncated at ${MAX_MEMORY_ENTRY_BYTES} bytes)` : '';
		return { content: `${header}\n\n${bodyOut}${suffix}` };
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
		'Only paths inside the two memory directories are allowed. Read-only.',
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
		// master 真读了全文 → 记一次「使用」（LRU 的升级/保鲜/复活证据）
		return readMemoryEntry(getMemoryStore(), String(params.path ?? ''), 'use');
	},
};
