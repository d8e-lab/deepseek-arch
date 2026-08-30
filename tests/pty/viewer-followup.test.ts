/**
 * PTY 全双工视图跟随集成测试
 *
 * H1 回归测试：视图关闭后排队消息由主循环发送（无双流并发）。
 * 场景：流式输出中 → 输入普通文字排队 → 打开视图 → 流结束（视图打开期间）
 * → 关闭视图 → 主循环恢复并发送排队消息 → 再输入第二条消息（验证无双流交错）。
 *
 * 依赖: Python 3 (pty 模块), node dist/ 已构建
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PY_SCRIPT = resolve(__dirname, 'capture-viewer-followup.py');
const FRAMES_DIR = resolve(__dirname, 'frames-viewer-followup');
const VERDICT_PATH = resolve(FRAMES_DIR, 'verdict.json');

describe('PTY 全双工视图跟随', () => {
	beforeAll(() => {
		const distExists = existsSync(resolve(__dirname, '../../dist/cli/index.js'));
		if (!distExists) {
			throw new Error('dist/ 未构建，请先执行 npm run build');
		}
	});

	it('流式排队 → 视图 → 关闭后主循环发送，无双流并发', { timeout: 25_000 }, () => {
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

		console.log(`\nPTY 视图跟随: ${verdict.passed_checks}/${verdict.total_checks}`);
		console.log('详细信息:', JSON.stringify(verdict.details, null, 2));
		if (stderr) console.error('stderr:', stderr);

		for (const [checkName, passed] of Object.entries(verdict.details)) {
			expect(passed, `${checkName} 失败`).toBe(true);
		}
	});
});
