import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { editFileTool } from '../../src/tools/edit-file.js';

describe('edit_file tool', () => {
	let workDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		const id = randomBytes(8).toString('hex');
		workDir = join(tmpdir(), 'deepseek-test-edit-' + id);
		await mkdir(workDir, { recursive: true });
		originalCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? '';
		process.env.DEEPSEEK_ARCH_SESSION_CWD = workDir;
	});

	afterEach(async () => {
		process.env.DEEPSEEK_ARCH_SESSION_CWD = originalCwd;
		await rm(workDir, { recursive: true, force: true });
	});

	describe('execute', () => {
		it('replaces a unique string in a file', async () => {
			const filePath = join(workDir, 'test.ts');
			await writeFile(filePath, 'const x = 1;\nconst y = 2;\n', 'utf-8');

			const result = await editFileTool.execute({
				path: 'test.ts',
				old_string: 'const x = 1;',
				new_string: 'const x = 42;',
			});

			expect(result.error).toBeUndefined();
			expect(result.content).toContain('replaced');

			const content = await readFile(filePath, 'utf-8');
			expect(content).toBe('const x = 42;\nconst y = 2;\n');
		});

		it('fails when old_string not found', async () => {
			const filePath = join(workDir, 'test.ts');
			await writeFile(filePath, 'hello world\n', 'utf-8');

			const result = await editFileTool.execute({
				path: 'test.ts',
				old_string: 'nonexistent',
				new_string: 'replacement',
			});

			expect(result.error).toBeDefined();
			expect(result.error).toContain('not found');
		});

		it('fails when old_string is not unique (replace_all=false)', async () => {
			const filePath = join(workDir, 'test.ts');
			await writeFile(filePath, 'dup\ndup\n', 'utf-8');

			const result = await editFileTool.execute({
				path: 'test.ts',
				old_string: 'dup',
				new_string: 'replaced',
				replace_all: false,
			});

			expect(result.error).toBeDefined();
			expect(result.error).toContain('2 times');
		});

		it('replaces all occurrences with replace_all=true', async () => {
			const filePath = join(workDir, 'test.ts');
			await writeFile(filePath, 'dup\ndup\n', 'utf-8');

			const result = await editFileTool.execute({
				path: 'test.ts',
				old_string: 'dup',
				new_string: 'replaced',
				replace_all: true,
			});

			expect(result.error).toBeUndefined();
			expect(result.content).toContain('2 occurrences');

			const content = await readFile(filePath, 'utf-8');
			expect(content).toBe('replaced\nreplaced\n');
		});

		it('rejects path outside workspace', async () => {
			const result = await editFileTool.execute({
				path: '../outside.txt',
				old_string: 'x',
				new_string: 'y',
			});

			expect(result.error).toBeDefined();
			expect(result.error).toContain('outside workspace');
		});

		it('rejects empty old_string', async () => {
			const result = await editFileTool.execute({
				path: 'test.ts',
				old_string: '',
				new_string: 'y',
			});

			expect(result.error).toBeDefined();
			expect(result.error).toContain('must not be empty');
		});
	});

	describe('preview', () => {
		it('generates unified diff for a replacement', async () => {
			const filePath = join(workDir, 'preview.ts');
			await writeFile(filePath, 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf-8');

			const preview = await editFileTool.preview!({
				path: 'preview.ts',
				old_string: 'const b = 2;',
				new_string: 'const b = 99;',
			});

			expect(preview).not.toBeNull();
			expect(preview).toContain('-const b = 2;');
			expect(preview).toContain('+const b = 99;');
		});

		it('returns error message when old_string not found', async () => {
			const filePath = join(workDir, 'preview.ts');
			await writeFile(filePath, 'hello\n', 'utf-8');

			const preview = await editFileTool.preview!({
				path: 'preview.ts',
				old_string: 'world',
				new_string: 'earth',
			});

			expect(preview).toContain('[ERROR]');
			expect(preview).toContain('not found');
		});

		it('returns error when duplicate and replace_all=false', async () => {
			const filePath = join(workDir, 'preview.ts');
			await writeFile(filePath, 'dup\ndup\n', 'utf-8');

			const preview = await editFileTool.preview!({
				path: 'preview.ts',
				old_string: 'dup',
				new_string: 'x',
				replace_all: false,
			});

			expect(preview).toContain('[ERROR]');
			expect(preview).toContain('2 times');
		});
	});
});
