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

describe('shellTool 进程树收尾（回归：管道被后台子进程占住导致永久挂起）', () => {
	/**
	 * 命令本身瞬间结束，但后台子进程继承着 stdout/stderr 管道。
	 * 修复前 `close` 要等该子进程结束才触发 —— 子进程长命时工具调用永久挂起。
	 */
	it.skipIf(process.platform === 'win32')('后台子进程占住管道时仍会在排水宽限内返回', async () => {
		const start = Date.now();
		const result = await shellTool.execute({
			command: 'sleep 60 & echo done; exit 0',
		});
		const elapsed = Date.now() - start;

		// 关键断言：必须在排水宽限（3s）附近收尾，而不是等满 60s 或永久挂起
		expect(elapsed).toBeLessThan(10_000);
		expect(result.content).toContain('exit code: 0');
		expect(result.content).toContain('done');
	}, 20_000);

	it.skipIf(process.platform === 'win32')('命令结束后清理掉残留的后台子进程（不留孤儿）', async () => {
		const result = await shellTool.execute({
			command: 'sleep 60 & echo "PID:$!"',
		});
		const pid = Number(/PID:(\d+)/.exec(result.content)?.[1]);
		expect(Number.isFinite(pid)).toBe(true);

		// cleanup() 会整组 SIGKILL；给内核一点回收时间
		await new Promise((r) => setTimeout(r, 300));
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	}, 20_000);
});
