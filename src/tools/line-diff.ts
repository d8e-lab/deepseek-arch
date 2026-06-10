/**
 * 行级 unified diff 生成器
 *
 * 使用 LCS（最长公共子序列）算法生成与 git diff 兼容的 unified diff 输出。
 * 纯内存操作，不依赖外部命令。
 */

/** 一条 diff 输出行 */
export interface DiffLine {
	prefix: '+' | '-' | ' ';
	text: string;
}

/** 一个 diff hunk */
export interface DiffHunk {
	/** 旧文件起始行号（1-indexed） */
	oldStart: number;
	/** 旧文件行数（上下文 + 删除行） */
	oldCount: number;
	/** 新文件起始行号（1-indexed） */
	newStart: number;
	/** 新文件行数（上下文 + 新增行） */
	newCount: number;
	/** hunk 内的行 */
	lines: DiffLine[];
}

/**
 * 生成两个文本的 unified diff 文本。
 * 只输出带变更的 hunk，上下文行数默认 3。
 *
 * @param oldText 旧文本
 * @param newText 新文本
 * @param oldLabel 旧文件标签（如 "a/src/foo.ts"），可选
 * @param newLabel 新文件标签（如 "b/src/foo.ts"），可选
 * @param contextLines 上下文行数，默认 3
 */
export function unifiedDiff(
	oldText: string,
	newText: string,
	oldLabel?: string,
	newLabel?: string,
	contextLines = 3,
): string {
	const oldLines = oldText.split('\n');
	const newLines = newText.split('\n');

	const hunks = generateDiffHunks(oldLines, newLines, contextLines);

	if (hunks.length === 0) return '';

	const output: string[] = [];

	if (oldLabel) output.push(`--- ${oldLabel}`);
	if (newLabel) output.push(`+++ ${newLabel}`);

	for (const hunk of hunks) {
		const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
		output.push(header);
		for (const line of hunk.lines) {
			output.push(`${line.prefix}${line.text}`);
		}
	}

	return output.join('\n');
}

/**
 * 生成 LCS 表
 */
function lcsTable(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (a[i - 1] === b[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	return dp;
}

/**
 * 从 LCS 表回溯生成编辑脚本
 * 返回的数组每项表示：'keep' | 'add' | 'remove'
 */
function backtrack(
	dp: number[][],
	a: string[],
	b: string[],
): Array<{ op: 'keep' | 'add' | 'remove'; line?: string }> {
	const result: Array<{ op: 'keep' | 'add' | 'remove'; line?: string }> = [];
	let i = a.length;
	let j = b.length;

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
			result.unshift({ op: 'keep', line: a[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			result.unshift({ op: 'add', line: b[j - 1] });
			j--;
		} else {
			result.unshift({ op: 'remove', line: a[i - 1] });
			i--;
		}
	}

	return result;
}

/**
 * 生成 diff hunks
 */
export function generateDiffHunks(
	a: string[],
	b: string[],
	context = 3,
): DiffHunk[] {
	const dp = lcsTable(a, b);
	const edits = backtrack(dp, a, b);

	// 找出所有变更区间
	const changeIndices = new Set<number>();
	for (let idx = 0; idx < edits.length; idx++) {
		if (edits[idx].op !== 'keep') {
			// 将变更行及上下文行加入集合
			for (let ctx = -context; ctx <= context; ctx++) {
				const ctxIdx = idx + ctx;
				if (ctxIdx >= 0 && ctxIdx < edits.length) {
					changeIndices.add(ctxIdx);
				}
			}
		}
	}

	if (changeIndices.size === 0) return [];

	// 将连续的变更区间合并为 hunk
	const hunks: DiffHunk[] = [];
	const sortedIndices = [...changeIndices].sort((x, y) => x - y);

	let rangeStart = sortedIndices[0];
	let rangeEnd = sortedIndices[0];

	for (let i = 1; i < sortedIndices.length; i++) {
		if (sortedIndices[i] <= rangeEnd + 1) {
			rangeEnd = sortedIndices[i];
		} else {
			hunks.push(buildHunk(edits, rangeStart, rangeEnd));
			rangeStart = sortedIndices[i];
			rangeEnd = sortedIndices[i];
		}
	}
	hunks.push(buildHunk(edits, rangeStart, rangeEnd));

	return hunks;
}

/** 从编辑脚本的区间构建一个 DiffHunk */
function buildHunk(
	edits: Array<{ op: 'keep' | 'add' | 'remove'; line?: string }>,
	start: number,
	end: number,
): DiffHunk {
	const lines: DiffLine[] = [];
	/** 移除的总行数（含删除 + 上下文 keep） */
	let removedCount = 0;
	/** 新增的总行数（含新增 + 上下文 keep） */
	let addedCount = 0;
	/** 旧文件起始行号（找到第一条非 add 行的 1-indexed line num） */
	let oldStart = 0;
	/** 新文件起始行号 */
	let newStart = 0;

	// 计算起始行号
	let oldLine = 1;
	let newLine = 1;
	for (let i = 0; i < start; i++) {
		if (edits[i].op === 'remove' || edits[i].op === 'keep') oldLine++;
		if (edits[i].op === 'add' || edits[i].op === 'keep') newLine++;
	}
	oldStart = oldLine;
	newStart = newLine;

	for (let i = start; i <= end; i++) {
		const edit = edits[i];
		switch (edit.op) {
			case 'keep':
				lines.push({ prefix: ' ', text: edit.line! });
				removedCount++;
				addedCount++;
				break;
			case 'remove':
				lines.push({ prefix: '-', text: edit.line! });
				removedCount++;
				break;
			case 'add':
				lines.push({ prefix: '+', text: edit.line! });
				addedCount++;
				break;
		}
	}

	return {
		oldStart,
		oldCount: removedCount,
		newStart,
		newCount: addedCount,
		lines,
	};
}
