import { describe, it, expect } from 'vitest';
import {
	shellTool,
	buildInvocation,
	PS_ENCODING_PREAMBLE,
} from '../../src/tools/shell.js';

describe('buildInvocation', () => {
	it('win32：powershell.exe + -NoProfile/-NonInteractive + 编码前缀', () => {
		const inv = buildInvocation('git status', 'win32');
		expect(inv.bin).toBe('powershell.exe');
		expect(inv.args).toEqual([
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			PS_ENCODING_PREAMBLE + 'git status',
		]);
	});

	it('编码前缀同时覆盖 PS 输出编码、输入编码与代码页', () => {
		// [Console]::OutputEncoding 决定 PS 写重定向管道的编码
		expect(PS_ENCODING_PREAMBLE).toContain('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8');
		// $OutputEncoding 决定 PS 管道给子进程（输入侧）的编码
		expect(PS_ENCODING_PREAMBLE).toContain('$OutputEncoding=');
		// chcp 65001 修正 cmd 内建 / CRT 工具的输出代码页
		expect(PS_ENCODING_PREAMBLE).toContain('chcp 65001');
	});

	it('非 win32：/bin/bash -c 原样透传命令，不注入前缀', () => {
		const inv = buildInvocation('echo hi', 'linux');
		expect(inv.bin).toBe('/bin/bash');
		expect(inv.args).toEqual(['-c', 'echo hi']);
	});
});

describe('shellTool execute 输出编码', () => {
	it('跨 chunk 的中文输出不被截断成 U+FFFD', async () => {
		// 20000 × 6 字节 ≈ 120KB，远超管道默认 chunk（16KB/64KB），必然跨多个 chunk；
		// 若逐 chunk 直接 toString('utf-8')，跨块的多字节字符会解码成 U+FFFD。
		const result = await shellTool.execute({
			command: `node -e "process.stdout.write('中文编码测试'.repeat(20000))"`,
		});

		expect(result.error).toBeUndefined();
		expect(result.content).toContain('exit code: 0');
		// 输出被截断至最后 8192 字节，尾部应保留且无替换符
		expect(result.content).not.toContain('\uFFFD');
		expect(result.content).toContain('中文编码测试');
	});
});
