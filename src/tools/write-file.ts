/**
 * write_file 工具 — 创建或覆盖文件
 *
 * 安全约束：
 *   1. 路径限制在会话 cwd 内
 *   2. 原子写入（先写临时文件再 rename）
 *   3. 自动创建父目录
 *   4. 执行前生成 diff 预览
 */

import { writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { relative, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Tool, ToolResult } from './types.js';
import { checkPath } from './utils.js';
import { unifiedDiff } from './diff.js';

/** 判断文件是否存在 */
async function fileExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

export const writeFileTool: Tool = {
	name: 'write_file',
	description:
		'创建新文件或完整重写已有文件，生成 diff 预览后由用户确认再原子写入。自动创建父目录。' +
		'仅用于新建文件或必须整体替换的场景；修改已有文件的部分内容应使用 edit_file。',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: '文件路径，相对于会话目录',
			},
			content: {
				type: 'string',
				description: '文件的完整新内容',
			},
		},
		required: ['path', 'content'],
	},
	requiresConfirm: true,

	async preview(params: Record<string, unknown>): Promise<string | null> {
		const inputPath = String(params.path ?? '');
		const newContent = String(params.content ?? '');
		const sessionCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();

		if (!inputPath.trim()) return null;

		const check = checkPath(inputPath, sessionCwd);
		if (!check.valid) return null;

		const relPath = relative(sessionCwd, check.resolved);
		const exists = await fileExists(check.resolved);
		const oldContent = exists ? await readFile(check.resolved, 'utf-8') : '';

		const diff = await unifiedDiff(
			oldContent,
			newContent,
			exists ? `a/${relPath}` : undefined,
			`b/${relPath}`,
		);

		if (!diff) return 'no changes';
		return diff;
	},

	async execute(params: Record<string, unknown>, _signal?: AbortSignal): Promise<ToolResult> {
		const inputPath = String(params.path ?? '');
		const content = String(params.content ?? '');
		const sessionCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();

		if (!inputPath.trim()) {
			return { content: '', error: 'empty path' };
		}

		const check = checkPath(inputPath, sessionCwd);
		if (!check.valid) {
			return { content: '', error: check.error };
		}

		const relPath = relative(sessionCwd, check.resolved);
		const existed = await fileExists(check.resolved);

		// 确保父目录存在
		await mkdir(dirname(check.resolved), { recursive: true, mode: 0o700 });

		// 原子写入：tmp file → rename
		const tmpPath = check.resolved + '.' + randomBytes(4).toString('hex') + '.tmp';
		try {
			await writeFile(tmpPath, content, { mode: 0o600 });
			// rename 在同文件系统内是原子的
			const { rename } = await import('node:fs/promises');
			await rename(tmpPath, check.resolved);
		} catch (err: any) {
			// 清理 tmp
			try { await import('node:fs/promises').then((m) => m.unlink(tmpPath)); } catch { /* ignore */ }
			return { content: '', error: `write failed: ${err?.message ?? err}` };
		}

		const action = existed ? 'overwrote' : 'created';
		return {
			content: `${action} ${relPath} (${content.length} bytes)`,
		};
	},
};
