/**
 * read_file 工具 — 读取文本文件内容
 *
 * 安全约束：
 *   1. 路径限制在会话 cwd 内
 *   2. 检测二进制文件并拒绝
 *   3. 输出末尾附 mtime
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Tool, ToolResult } from './types.js';
import { checkPath, isBinaryFile } from './utils.js';

/** 默认读取行数 */
const DEFAULT_LIMIT = 200;
/** 最大行数 */
const MAX_LIMIT = 500;

export const readFileTool: Tool = {
	name: 'read_file',
	description:
		'读取文件内容，返回带行号的文本并附文件修改时间。支持分段读取大文件（offset/limit）。' +
		'始终使用本工具读取文件，不要用 shell cat/head/tail 代替。' +
		'先用 search_content 查看匹配行和上下文，再用本工具读取完整文件内容。',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: '文件路径，相对于会话目录',
			},
			offset: {
				type: 'number',
				description: '起始行号（1-indexed），默认 1',
			},
			limit: {
				type: 'number',
				description: `读取行数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}`,
			},
		},
		required: ['path'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>, _signal?: AbortSignal): Promise<ToolResult> {
		const inputPath = String(params.path ?? '');
		const offset = typeof params.offset === 'number' ? Math.max(1, Math.floor(params.offset)) : 1;
		const limit = Math.min(
			typeof params.limit === 'number' ? Math.max(1, Math.floor(params.limit)) : DEFAULT_LIMIT,
			MAX_LIMIT,
		);
		const sessionCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();

		if (!inputPath.trim()) {
			return { content: '', error: 'empty path' };
		}

		// 路径校验
		const check = checkPath(inputPath, sessionCwd);
		if (!check.valid) {
			return { content: '', error: check.error };
		}

		// 文件存在 + 类型检查
		let fileStat: Awaited<ReturnType<typeof stat>>;
		try {
			fileStat = await stat(check.resolved);
		} catch (err: any) {
			if (err?.code === 'ENOENT') {
				return { content: '', error: `ENOENT: no such file: ${inputPath}` };
			}
			return { content: '', error: `cannot stat file: ${err?.message ?? err}` };
		}

		if (!fileStat.isFile()) {
			return { content: '', error: `not a file: ${inputPath}` };
		}

		if (await isBinaryFile(check.resolved)) {
			return { content: '', error: `binary file, cannot read: ${inputPath}` };
		}

		// 读取文件
		let content: string;
		try {
			content = await readFile(check.resolved, 'utf-8');
		} catch (err: any) {
			return { content: '', error: `cannot read file: ${err?.message ?? err}` };
		}

		// 按行分割
		const allLines = content.split('\n');
		const totalLines = allLines.length;
		const startIdx = offset - 1;
		const endIdx = Math.min(startIdx + limit, totalLines);

		if (startIdx >= totalLines) {
			return {
				content: `file has ${totalLines} lines, offset ${offset} is beyond end\n` +
					`  mtime: ${fileStat.mtime.toISOString()}`,
			};
		}

		const selected = allLines.slice(startIdx, endIdx);
		const resultLines: string[] = [];
		// 如果文件行数超出所选范围，在顶部标明行号范围
		for (let i = 0; i < selected.length; i++) {
			const lineNum = startIdx + i + 1;
			resultLines.push(`${String(lineNum).padStart(6, ' ')}: ${selected[i]}`);
		}

		const relPath = relative(sessionCwd, check.resolved);
		let header = `${relPath}  lines ${startIdx + 1}-${endIdx} / ${totalLines}`;
		if (endIdx < totalLines) {
			header += ' (truncated)';
		}

		return {
			content: `${header}\n${resultLines.join('\n')}\n  mtime: ${fileStat.mtime.toISOString()}`,
		};
	},
};
