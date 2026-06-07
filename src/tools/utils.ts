/**
 * Tools 共享工具 — 路径校验、二进制检测
 */

import { resolve, relative, normalize } from 'node:path';
import { stat, open } from 'node:fs/promises';

/** 搜索时默认跳过的目录 */
export const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'coverage',
	'__pycache__',
	'.next',
	'.nuxt',
	'build',
	'.cache',
]);

/** 路径校验结果 */
export type PathCheck =
	| { valid: true; resolved: string }
	| { valid: false; error: string };

/** 校验路径必须在 sessionCwd 或其子目录内 */
export function checkPath(inputPath: string, sessionCwd: string): PathCheck {
	const normalized = normalize(inputPath);
	const resolved = resolve(sessionCwd, normalized);
	const rel = relative(sessionCwd, resolved);
	if (rel.startsWith('..')) {
		return { valid: false, error: `path outside workspace: ${inputPath}` };
	}
	// 路径解析后如果跳出（如 /etc/passwd 通过 ../ 等价）
	if (resolved !== sessionCwd && !resolved.startsWith(sessionCwd + '/') && resolved !== sessionCwd) {
		// resolved 等于 sessionCwd 允许
		if (resolved !== sessionCwd) {
			return { valid: false, error: `path outside workspace: ${inputPath}` };
		}
	}
	return { valid: true, resolved };
}

/** 检测前 4096 字节是否含 null byte（二进制文件） */
export async function isBinaryFile(filePath: string): Promise<boolean> {
	let fd: Awaited<ReturnType<typeof open>> | null = null;
	try {
		fd = await open(filePath, 'r');
		const buf = Buffer.alloc(4096);
		const { bytesRead } = await fd.read(buf, 0, 4096, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (buf[i] === 0) return true;
		}
		return false;
	} catch {
		return false;
	} finally {
		if (fd) await fd.close();
	}
}
