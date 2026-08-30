/**
 * PTY 输入稳定性集成测试
 *
 * 回归测试：键入字符（普通文本/命令）时输入区不得上移。
 * 根因：renderInput 上移基准误用区域总高度（lastBottomRows），
 * 而光标实际在输入区行（区域顶部），导致每次键入 UP 过头、
 * CLEAR_TO_END 清掉区域上方内容、画面整体上移。
 *
 * 依赖: Python 3 (pty 模块), node dist/ 已构建
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PY_SCRIPT = resolve(__dirname, 'capture-input-stability.py');
const FRAMES_DIR = resolve(__dirname, 'frames-stability');
const VERDICT_PATH = resolve(FRAMES_DIR, 'verdict.json');

describe('PTY 输入稳定性', () => {
	beforeAll(() => {
		const distExists = existsSync(resolve(__dirname, '../../dist/cli/index.js'));
		if (!distExists) {
			throw new Error('dist/ 未构建，请先执行 npm run build');
		}
	});

	it('逐字符输入时输入区不上移（普通文本 + 命令模式）', { timeout: 20_000 }, () => {
		let stderr = '';
		try {
			execSync(`python3 "${PY_SCRIPT}"`, {
				timeout: 30_000,
				encoding: 'utf-8',
				cwd: resolve(__dirname, '../..'),
			});
		} catch (e: any) {
			stderr = e.stderr ?? '';
		}

		expect(existsSync(VERDICT_PATH)).toBe(true);

		const verdictRaw = readFileSync(VERDICT_PATH, 'utf-8');
		const verdict = JSON.parse(verdictRaw);

		console.log(`\nPTY 输入稳定性: ${verdict.passed_checks}/${verdict.total_checks}`);
		console.log('详细信息:', JSON.stringify(verdict.details, null, 2));
		if (stderr) console.error('stderr:', stderr);

		for (const [checkName, passed] of Object.entries(verdict.details)) {
			expect(passed, `${checkName} 失败`).toBe(true);
		}
	});
});
