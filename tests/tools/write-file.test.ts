import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { writeFileTool } from '../../src/tools/write-file.js';

describe('write_file tool', () => {
	let workDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		const id = randomBytes(8).toString('hex');
		workDir = join(tmpdir(), 'deepseek-test-write-' + id);
		await mkdir(workDir, { recursive: true });
		originalCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? '';
		process.env.DEEPSEEK_ARCH_SESSION_CWD = workDir;
	});

	afterEach(async () => {
		process.env.DEEPSEEK_ARCH_SESSION_CWD = originalCwd;
		await rm(workDir, { recursive: true, force: true });
	});

	describe('execute', () => {
		it('creates a new file', async () => {
			const result = await writeFileTool.execute({
				path: 'new-file.txt',
				content: 'hello world',
			});

			expect(result.error).toBeUndefined();
			expect(result.content).toContain('created');

			const content = await readFile(join(workDir, 'new-file.txt'), 'utf-8');
			expect(content).toBe('hello world');
		});

		it('creates parent directories automatically', async () => {
			const result = await writeFileTool.execute({
				path: 'deep/nested/file.txt',
				content: 'nested content',
			});

			expect(result.error).toBeUndefined();

			const content = await readFile(join(workDir, 'deep/nested/file.txt'), 'utf-8');
			expect(content).toBe('nested content');
		});

		it('overwrites an existing file', async () => {
			const filePath = join(workDir, 'existing.txt');
			await writeFile(filePath, 'old content', 'utf-8');

			const result = await writeFileTool.execute({
				path: 'existing.txt',
				content: 'new content',
			});

			expect(result.error).toBeUndefined();
			expect(result.content).toContain('overwrote');

			const content = await readFile(filePath, 'utf-8');
			expect(content).toBe('new content');
		});

		it('rejects path outside workspace', async () => {
			const result = await writeFileTool.execute({
				path: '../outside.txt',
				content: 'test',
			});

			expect(result.error).toBeDefined();
			expect(result.error).toContain('outside workspace');
		});

		it('rejects empty path', async () => {
			const result = await writeFileTool.execute({
				path: '',
				content: 'test',
			});

			expect(result.error).toBeDefined();
			expect(result.error).toContain('empty path');
		});
	});

	describe('preview', () => {
		it('generates diff showing all additions for new file', async () => {
			const preview = await writeFileTool.preview!({
				path: 'new.ts',
				content: 'const x = 1;\nconst y = 2;\n',
			});

			expect(preview).not.toBeNull();
			expect(preview).toContain('+const x = 1;');
			expect(preview).toContain('+const y = 2;');
		});

		it('generates diff for overwriting existing file', async () => {
			const filePath = join(workDir, 'overwrite.ts');
			await writeFile(filePath, 'const x = 1;\nconst y = 2;\n', 'utf-8');

			const preview = await writeFileTool.preview!({
				path: 'overwrite.ts',
				content: 'const x = 1;\nconst z = 3;\n',
			});

			expect(preview).toContain('-const y = 2;');
			expect(preview).toContain('+const z = 3;');
		});

		it('returns no changes for identical content', async () => {
			const filePath = join(workDir, 'same.ts');
			await writeFile(filePath, 'same content\n', 'utf-8');

			const preview = await writeFileTool.preview!({
				path: 'same.ts',
				content: 'same content\n',
			});

			expect(preview).toBe('no changes');
		});
	});
});
