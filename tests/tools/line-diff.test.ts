import { describe, it, expect } from 'vitest';
import { unifiedDiff, generateDiffHunks } from '../../src/tools/line-diff.js';

describe('line-diff', () => {
	describe('unifiedDiff', () => {
		it('identical texts produce empty output', () => {
			const text = 'line1\nline2\nline3';
			const result = unifiedDiff(text, text);
			expect(result).toBe('');
		});

		it('single line added', () => {
			const oldText = 'line1\nline2';
			const newText = 'line1\nnew line\nline2';
			const result = unifiedDiff(oldText, newText);
			expect(result).toContain('+new line');
		});

		it('single line removed', () => {
			const oldText = 'line1\nremoved\nline2';
			const newText = 'line1\nline2';
			const result = unifiedDiff(oldText, newText);
			expect(result).toContain('-removed');
		});

		it('single line replaced', () => {
			const oldText = 'line1\nold\nline3';
			const newText = 'line1\nnew\nline3';
			const result = unifiedDiff(oldText, newText);
			expect(result).toContain('-old');
			expect(result).toContain('+new');
		});

		it('includes file headers when labels provided', () => {
			const result = unifiedDiff('a', 'b', 'a/src/foo.ts', 'b/src/foo.ts');
			expect(result).toContain('--- a/src/foo.ts');
			expect(result).toContain('+++ b/src/foo.ts');
		});

		it('no headers when labels not provided', () => {
			const result = unifiedDiff('a', 'b');
			expect(result).not.toContain('---');
			expect(result).not.toContain('+++');
		});

		it('hunk header format', () => {
			const oldText = 'a\nb\nc\nd\ne\nf\ng\nh';
			const newText = 'a\nb\nNEW\nc\nd\ne\nf\ng\nh';
			const result = unifiedDiff(oldText, newText);
			// Should have @@ header
			expect(result).toMatch(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/m);
		});

		it('multiple hunks for distant changes', () => {
			const lines = [];
			for (let i = 1; i <= 50; i++) lines.push(`line ${i}`);
			const oldText = lines.join('\n');
			const newLines = [...lines];
			newLines[5] = 'CHANGED EARLY';
			newLines[45] = 'CHANGED LATE';
			const result = unifiedDiff(oldText, newLines.join('\n'));
			// 3 context lines default, changes at line 6 and 46 have 40 lines gap > 2*3
			// So should be 2 hunks
			const hunkCount = (result.match(/^@@ /gm) || []).length;
			expect(hunkCount).toBe(2);
		});
	});

	describe('generateDiffHunks', () => {
		it('empty result when no changes', () => {
			const hunks = generateDiffHunks(['a', 'b'], ['a', 'b']);
			expect(hunks).toHaveLength(0);
		});

		it('single add line', () => {
			const hunks = generateDiffHunks(['a', 'c'], ['a', 'b', 'c']);
			expect(hunks).toHaveLength(1);
			const hunk = hunks[0];
			expect(hunk.lines.some((l) => l.prefix === '+' && l.text === 'b')).toBe(true);
		});

		it('single remove line', () => {
			const hunks = generateDiffHunks(['a', 'b', 'c'], ['a', 'c']);
			expect(hunks).toHaveLength(1);
			const hunk = hunks[0];
			expect(hunk.lines.some((l) => l.prefix === '-' && l.text === 'b')).toBe(true);
		});

		it('context lines are included around changes', () => {
			const a = ['1', '2', '3', '4', '5', '6', '7'];
			const b = ['1', '2', '3', 'CHANGED', '5', '6', '7'];
			const hunks = generateDiffHunks(a, b, 2);
			const hunk = hunks[0];
			// Should include 2 context lines before and after the change
			expect(hunk.lines.some((l) => l.prefix === ' ' && l.text === '2')).toBe(true);
			expect(hunk.lines.some((l) => l.prefix === ' ' && l.text === '5')).toBe(true);
		});
	});
});
