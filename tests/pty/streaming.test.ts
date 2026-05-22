/**
 * PTY 流式渲染集成测试
 *
 * 通过 Python PTY 启动 TUI → mock 模式 → 输入消息 → 捕获各阶段帧
 * → 检查帧内容验证渲染修复。
 *
 * 依赖: Python 3 (pty 模块), node dist/ 已构建
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PY_SCRIPT = resolve(__dirname, 'capture-streaming.py');
const FRAMES_DIR = resolve(__dirname, 'frames');
const VERDICT_PATH = resolve(FRAMES_DIR, 'verdict.json');

describe('流式 PTY 渲染', () => {
	beforeAll(() => {
		// 确保 dist/ 已构建
		const distExists = existsSync(resolve(__dirname, '../../dist/index.js'));
		if (!distExists) {
			throw new Error('dist/ 未构建，请先执行 npm run build');
		}
	});

	it('捕获流式帧并验证渲染', { timeout: 15_000 }, () => {
		// 运行 Python PTY 脚本
		let stdout: string;
		let stderr: string;
		try {
			const result = execSync(`python3 "${PY_SCRIPT}"`, {
				timeout: 30_000,
				encoding: 'utf-8',
				cwd: resolve(__dirname, '../..'),
			});
			stdout = result;
			stderr = '';
		} catch (e: any) {
			stdout = e.stdout ?? '';
			stderr = e.stderr ?? '';
			// Even if the script exits non-zero, we still want to check verdict
		}

		// 检查 verdict 文件是否生成
		expect(existsSync(VERDICT_PATH)).toBe(true);

		const verdictRaw = readFileSync(VERDICT_PATH, 'utf-8');
		const verdict = JSON.parse(verdictRaw);

		// 输出详细信息帮助调试
		console.log(`\nPTY 测试结果: ${verdict.passed_checks}/${verdict.total_checks}`);
		console.log('详细信息:', JSON.stringify(verdict.details, null, 2));
		if (stderr) console.error('stderr:', stderr);

		// 逐项断言
		for (const [frameName, checks] of Object.entries(verdict.details)) {
			const details = checks as Record<string, boolean>;
			for (const [checkName, passed] of Object.entries(details)) {
				expect(passed, `${frameName} → ${checkName} 失败`).toBe(true);
			}
		}
	});
});
