/**
 * search_content 工具 — 关键词搜索文件内容
 *
 * 支持：
 *   1. 多关键词 OR 搜索（| 分隔）
 *   2. 上下文行显示
 *   3. 文件名过滤（glob 简单匹配）
 *   4. 跳过 node_modules/.git/dist 等目录
 *   5. 二进制文件跳过
 *   6. 大文件（>1MB）跳过
 *   7. 重叠区间合并
 */

import { readFile, stat, readdir } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import type { Tool, ToolResult } from './types.js';
import { checkPath, isBinaryFile, SKIP_DIRS } from './utils.js';

/** 默认最大结果数 */
const DEFAULT_MAX_RESULTS = 30;
const HARD_LIMIT_RESULTS = 100;
/** 跳过的大文件阈值 (1MB) */
const MAX_FILE_BYTES = 1_024 * 1024;
/** 默认上下文行数 */
const DEFAULT_CONTEXT = 1;

/** 匹配结果 */
interface Match {
	lineNum: number;  // 1-indexed
	content: string;
}

/** 将 glob 模式转为正则（仅支持 * 和 **） */
function globToRegex(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '<<DOUBLESTAR>>')
		.replace(/\*/g, '[^/]*')
		.replace(/<<DOUBLESTAR>>/g, '.*');
	return new RegExp(`^${escaped}$`);
}

/** 递归收集需要搜索的文件列表 */
async function collectFiles(
	dir: string,
	sessionCwd: string,
	globRe: RegExp | null,
): Promise<string[]> {
	const results: string[] = [];
	let entries: any[];
	try {
		entries = await readdir(dir, { withFileTypes: true }) as any;
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		const base = basename(fullPath);

		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(base)) continue;
			if (base.startsWith('.')) continue;
			const subResults = await collectFiles(fullPath, sessionCwd, globRe);
			results.push(...subResults);
			continue;
		}

		if (!entry.isFile()) continue;

		const relPath = relative(sessionCwd, fullPath);
		if (globRe && !globRe.test(relPath) && !globRe.test(base)) continue;

		results.push(fullPath);
	}
	return results;
}

export const searchContentTool: Tool = {
	name: 'search_content',
	description:
		'在文件中搜索关键词，返回匹配行及上下文行（默认前后各 1 行），并标注命中文件路径。' +
		'支持 | 分隔多关键词 OR 搜索。跳过 node_modules/.git/dist 等目录和二进制文件。' +
		'已知文件路径后，用 read_file 读取完整内容；不要用 shell grep/rg 代替本工具。',
	parameters: {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: '要搜索的代码关键词（函数名、类名、变量名等），多关键词用 | 分隔，如 "SessionManager|Storage|saveTurn"',
			},
			path: {
				type: 'string',
				description: '搜索路径（文件或目录），默认 "." (整个会话目录)',
			},
			glob: {
				type: 'string',
				description: '文件名 glob 过滤，如 "*.ts" 或 "src/**/*.ts"',
			},
			context_lines: {
				type: 'number',
				description: `匹配行上下各显示几行，默认 ${DEFAULT_CONTEXT}`,
			},
			max_results: {
				type: 'number',
				description: `最大结果数，默认 ${DEFAULT_MAX_RESULTS}，最大 ${HARD_LIMIT_RESULTS}`,
			},
		},
		required: ['pattern'],
	},
	requiresConfirm: false,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const pattern = String(params.pattern ?? '').trim();
		const inputPath = String(params.path ?? '.').trim() || '.';
		const glob = params.glob ? String(params.glob) : null;
		const contextLines = typeof params.context_lines === 'number'
			? Math.max(0, Math.floor(params.context_lines))
			: DEFAULT_CONTEXT;
		const maxResults = Math.min(
			typeof params.max_results === 'number' ? Math.max(1, Math.floor(params.max_results)) : DEFAULT_MAX_RESULTS,
			HARD_LIMIT_RESULTS,
		);
		const sessionCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();

		if (!pattern) {
			return { content: '', error: 'empty pattern' };
		}

		// 解析关键词
		const keywords = pattern.split('|').map((k) => k.trim()).filter(Boolean);
		if (keywords.length === 0) {
			return { content: '', error: 'no valid keywords in pattern' };
		}

		// 路径校验
		const check = checkPath(inputPath, sessionCwd);
		if (!check.valid) {
			return { content: '', error: check.error };
		}

		// 编译 glob
		let globRe: RegExp | null = null;
		if (glob) {
			globRe = globToRegex(glob);
		}

		// 收集文件
		let files: string[];
		try {
			const s = await stat(check.resolved);
			if (s.isFile()) {
				files = [check.resolved];
			} else if (s.isDirectory()) {
				files = await collectFiles(check.resolved, sessionCwd, globRe);
				// 按文件名字典序排序，保证输出稳定
				files.sort();
			} else {
				return { content: '', error: `not a file or directory: ${inputPath}` };
			}
		} catch (err: any) {
			if (err?.code === 'ENOENT') {
				return { content: '', error: `ENOENT: no such file or directory: ${inputPath}` };
			}
			return { content: '', error: `cannot access path: ${err?.message ?? err}` };
		}

		if (files.length === 0) {
			return { content: '(no matching files)' };
		}

		// 搜索所有文件，收集命中的 Match[]
		interface FileMatches {
			relPath: string;
			lines: string[];
			matches: Match[];
		}

		const fileResults: FileMatches[] = [];
		let totalMatches = 0;

		for (const filePath of files) {
			if (totalMatches >= HARD_LIMIT_RESULTS && fileResults.length > 0) break;

			let fileStat: Awaited<ReturnType<typeof stat>>;
			try {
				fileStat = await stat(filePath);
			} catch {
				continue;
			}
			if (!fileStat.isFile()) continue;
			if (fileStat.size > MAX_FILE_BYTES) continue;
			if (fileStat.size === 0) continue;
			if (await isBinaryFile(filePath)) continue;

			let content: string;
			try {
				content = await readFile(filePath, 'utf-8');
			} catch {
				continue;
			}

			const allLines = content.split('\n');
			const matches: Match[] = [];

			for (let i = 0; i < allLines.length; i++) {
				const line = allLines[i];
				for (const kw of keywords) {
					if (line.includes(kw)) {
						matches.push({ lineNum: i + 1, content: line });
						break; // 同一行多个关键词命中只记一次
					}
				}
			}

			if (matches.length > 0) {
				fileResults.push({
					relPath: relative(sessionCwd, filePath),
					lines: allLines,
					matches,
				});
				totalMatches += matches.length;
			}
		}

		if (fileResults.length === 0) {
			return { content: '(no matches)' };
		}

		// ── 构建输出（合并重叠区间）────────────────

		const outputLines: string[] = [];
		let shownCount = 0;
		const truncated = totalMatches > maxResults;

		for (const fr of fileResults) {
			if (shownCount >= maxResults) break;

			const slices = mergeIntervals(fr.matches, fr.lines, contextLines, maxResults - shownCount);
			for (const slice of slices) {
				outputLines.push(`--- ${fr.relPath} ---`);
				for (const sl of slice) {
					if (sl.isMatch) {
						outputLines.push(`${String(sl.lineNum).padStart(6, ' ')}:> ${sl.content}`);
						shownCount++;
					} else {
						outputLines.push(`${String(sl.lineNum).padStart(6, ' ')}:  ${sl.content}`);
					}
				}
			}
		}

		let header = `${shownCount} match${shownCount !== 1 ? 'es' : ''}`;
		if (truncated) {
			header += ` of ${totalMatches} total (truncated)`;
		}
		outputLines.unshift(header, '');

		return { content: outputLines.join('\n') };
	},
};

/** 合并重叠区间后的切片行 */
interface SliceLine {
	lineNum: number;
	content: string;
	isMatch: boolean;
}

/**
 * 合并重叠/相邻的匹配区间，分配配额（最多 maxShown 个命中行），返回切片数组
 */
function mergeIntervals(
	matches: Match[],
	allLines: string[],
	context: number,
	maxShown: number,
): SliceLine[][] {
	if (matches.length === 0) return [];

	// 生成区间
	const intervals = matches.map((m) => ({
		start: Math.max(1, m.lineNum - context),
		end: Math.min(allLines.length, m.lineNum + context),
		matchSet: new Set([m.lineNum]),
	}));

	// 按 start 排序
	intervals.sort((a, b) => a.start - b.start);

	// 合并重叠
	const merged: typeof intervals = [];
	for (const iv of intervals) {
		if (merged.length === 0) {
			merged.push({ ...iv, matchSet: new Set(iv.matchSet) });
			continue;
		}
		const last = merged[merged.length - 1];
		if (iv.start <= last.end + 1) {
			// 重叠或相邻 → 合并
			last.end = Math.max(last.end, iv.end);
			for (const n of iv.matchSet) last.matchSet.add(n);
		} else {
			merged.push({ ...iv, matchSet: new Set(iv.matchSet) });
		}
	}

	// 生成输出切片
	const result: SliceLine[][] = [];
	let remaining = maxShown;

	for (const iv of merged) {
		const slice: SliceLine[] = [];
		for (let ln = iv.start; ln <= iv.end; ln++) {
			slice.push({
				lineNum: ln,
				content: allLines[ln - 1] ?? '',
				isMatch: iv.matchSet.has(ln),
			});
		}
		result.push(slice);

		const matchCount = slice.filter((s) => s.isMatch).length;
		remaining -= matchCount;
		if (remaining <= 0) break;
	}

	return result;
}
