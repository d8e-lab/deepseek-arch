/**
 * edit_file 工具 — 精确字符串替换编辑
 *
 * 设计原则：
 *   1. 精确字符串匹配（不用行号）
 *   2. replace_all=false 时要求 old_string 唯一
 *   3. 原子写入
 *   4. 执行前生成 diff 预览
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { relative, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Tool, ToolResult } from './types.js';
import { checkPath } from './utils.js';
import { unifiedDiff } from './diff.js';
import { getFileStateManager } from './file-state.js';

/**
 * 在 content 中查找 old_string 的匹配位置。
 * 返回不重叠的匹配起始偏移量数组。
 */
function findAllMatches(content: string, oldStr: string): number[] {
	const positions: number[] = [];
	let idx = 0;
	while (true) {
		const pos = content.indexOf(oldStr, idx);
		if (pos === -1) break;
		positions.push(pos);
		idx = pos + oldStr.length;
	}
	return positions;
}

export const editFileTool: Tool = {
	name: 'edit_file',
	description:
		'修改已有文件，通过精确字符串匹配替换，生成 diff 预览后由用户确认再写入。' +
		'修改文件时始终使用本工具，不要用 shell sed/awk 代替。old_string 必须唯一匹配（或指定 replace_all）。' +
		'先 read_file 确认要改的内容，再用本工具精确替换。',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: '文件路径，相对于会话目录',
			},
			old_string: {
				type: 'string',
				description: '要替换的原文（精确匹配，仅用制表符）',
			},
			new_string: {
				type: 'string',
				description: '替换后的文本',
			},
			replace_all: {
				type: 'boolean',
				description: '是否替换所有匹配项，默认 false（要求唯一匹配）',
			},
		},
		required: ['path', 'old_string', 'new_string'],
	},
	requiresConfirm: true,

	async preview(params: Record<string, unknown>): Promise<string | null> {
		const inputPath = String(params.path ?? '');
		const oldStr = String(params.old_string ?? '');
		const newStr = String(params.new_string ?? '');
		const replaceAll = params.replace_all === true;
		const sessionCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();

		if (!inputPath.trim()) return null;
		if (!oldStr) return null; // old_string 不可为空

		const check = checkPath(inputPath, sessionCwd);
		if (!check.valid) return null;

		// staleness 检查：文件是否自上次 read 后被修改
		const fsm = await getFileStateManager(sessionCwd);
		const staleErr = await fsm.check(check.resolved);
		if (staleErr) return staleErr;

		let original: string;
		try {
			original = await readFile(check.resolved, 'utf-8');
		} catch (err) {
			return null; // 文件不存在，preview 失败
		}

		const matches = findAllMatches(original, oldStr);

		// 唯一性检查
		if (matches.length === 0) {
			return `[ERROR] old_string not found in file. Possible causes:\n` +
				`  - Tab/space mismatch in indentation (file uses tabs, copy exactly)\n` +
				`  - File was modified since last read — re-read the file first`;
		}
		if (!replaceAll && matches.length > 1) {
			return `[ERROR] old_string appears ${matches.length} times — use replace_all or be more specific`;
		}

		// 内存中替换
		const replaced = original.replaceAll(oldStr, newStr);

		const relPath = relative(sessionCwd, check.resolved);
		const diff = await unifiedDiff(original, replaced, `a/${relPath}`, `b/${relPath}`);
		if (!diff) return 'no changes';
		return diff;
	},

	async execute(params: Record<string, unknown>, _signal?: AbortSignal): Promise<ToolResult> {
		const inputPath = String(params.path ?? '');
		const oldStr = String(params.old_string ?? '');
		const newStr = String(params.new_string ?? '');
		const replaceAll = params.replace_all === true;
		const sessionCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();

		if (!inputPath.trim()) {
			return { content: '', error: 'empty path' };
		}
		if (!oldStr) {
			return { content: '', error: 'old_string must not be empty' };
		}

		const check = checkPath(inputPath, sessionCwd);
		if (!check.valid) {
			return { content: '', error: check.error };
		}

		// staleness 检查：文件是否自上次 read 后被外部修改
		const fsm = await getFileStateManager(sessionCwd);
		const staleErr = await fsm.check(check.resolved);
		if (staleErr) {
			return { content: '', error: staleErr };
		}

		const relPath = relative(sessionCwd, check.resolved);

		// 重新读取文件（preview 和 execute 之间文件可能已被修改）
		let original: string;
		try {
			original = await readFile(check.resolved, 'utf-8');
		} catch (err: any) {
			return { content: '', error: `cannot read file: ${err?.message ?? err}` };
		}

		const matches = findAllMatches(original, oldStr);

		if (matches.length === 0) {
			return {
				content: '',
				error: `old_string not found in ${relPath}. Possible causes:\n` +
					`  - Tab/space mismatch in indentation (file uses tabs, copy exactly)\n` +
					`  - File was modified since last read — re-read the file first`,
			};
		}
		if (!replaceAll && matches.length > 1) {
			return {
				content: '',
				error: `old_string appears ${matches.length} times in ${relPath}. Use replace_all or provide more context (more surrounding lines) to make it unique.`,
			};
		}

		const replaced = original.replaceAll(oldStr, newStr);

		// 原子写入
		await mkdir(dirname(check.resolved), { recursive: true, mode: 0o700 });
		const tmpPath = check.resolved + '.' + randomBytes(4).toString('hex') + '.tmp';
		try {
			await writeFile(tmpPath, replaced, { mode: 0o600 });
			const { rename } = await import('node:fs/promises');
			await rename(tmpPath, check.resolved);
		} catch (err: any) {
			try { await import('node:fs/promises').then((m) => m.unlink(tmpPath)); } catch { /* ignore */ }
			return { content: '', error: `write failed: ${err?.message ?? err}` };
		}

		// 更新文件状态，避免自身写入触发下次 staleness 误报
		await fsm.update(check.resolved);

		const count = matches.length;
		const replacementDesc = count > 1 ? `${count} occurrences` : '1 occurrence';
		return {
			content: `replaced ${replacementDesc} in ${relPath}`,
		};
	},
};
