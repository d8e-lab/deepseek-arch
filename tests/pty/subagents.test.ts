/**
 * PTY Subagents 总览视图集成测试
 *
 * 通过 Python PTY 启动 TUI → mock 模式 → spawn subagent → Ctrl+T 打开视图
 * → 视图内发送消息 → q 返回 master → 检查各阶段帧验证功能。
 *
 * 依赖: Python 3 (pty 模块), node dist/ 已构建
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PY_SCRIPT = resolve(__dirname, 'capture-subagents.py');
const FRAMES_DIR = resolve(__dirname, 'frames-subagents');
const VERDICT_PATH = resolve(FRAMES_DIR, 'verdict.json');

describe('Subagents 总览视图 PTY 渲染', () => {
	beforeAll(() => {
		const distExists = existsSync(resolve(__dirname, '../../dist/cli/index.js'));
		if (!distExists) {
			throw new Error('dist/ 未构建，请先执行 npm run build');
		}
	});

	it('Ctrl+T 视图：spawn → 状态条 → 视图内发送 → 返回 master', { timeout: 20_000 }, () => {
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

		console.log(`\nSubagents 视图 PTY 测试结果: ${verdict.passed_checks}/${verdict.total_checks}`);
		console.log('详细信息:', JSON.stringify(verdict.details, null, 2));
		if (stderr) console.error('stderr:', stderr);

		for (const [frameName, checks] of Object.entries(verdict.details)) {
			const details = checks as Record<string, boolean>;
			for (const [checkName, passed] of Object.entries(details)) {
				expect(passed, `${frameName} → ${checkName} 失败`).toBe(true);
			}
		}
	});
});
