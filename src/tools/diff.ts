/**
 * 行级 unified diff 生成器 — 基于系统 diff 命令
 *
 * 使用 Linux diff -u 生成与 git diff 兼容的 unified diff 输出。
 * 通过临时文件传递内容，异步执行。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 生成两个文本的 unified diff。
 * 无差异时返回空字符串。
 *
 * @param oldText 旧文本
 * @param newText 新文本
 * @param oldLabel 旧文件标签（如 "a/src/foo.ts"），可选
 * @param newLabel 新文件标签（如 "b/src/foo.ts"），可选
 */
export async function unifiedDiff(
	oldText: string,
	newText: string,
	oldLabel?: string,
	newLabel?: string,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'deepseek-diff-'));
	const oldPath = join(dir, 'a');
	const newPath = join(dir, 'b');

	await Promise.all([
		writeFile(oldPath, oldText, 'utf-8'),
		writeFile(newPath, newText, 'utf-8'),
	]);

	try {
		return await new Promise<string>((resolve, reject) => {
			const args: string[] = ['-u'];
			if (oldLabel) args.push('--label', oldLabel);
			args.push(oldPath);
			if (newLabel) args.push('--label', newLabel);
			args.push(newPath);

			execFile('diff', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
				const code = (err as any)?.code ?? 0;
				if (code >= 2) {
					reject(new Error(`diff failed (exit ${code}): ${err?.message}`));
				} else {
					// code 0 = identical (no output), code 1 = differences found
					resolve(code === 1 ? stdout : '');
				}
			});
		});
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
