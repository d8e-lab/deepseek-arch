/**
 * workspace-paths.test.ts — 工作区 runtime 目录解析单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
	RUNTIME_DIR_NAME,
	getSessionCwd,
	getRuntimeDir,
	getPlanDir,
	getMemoryDir,
	getApiRequestsDir,
	getFileStatePath,
} from '../../src/core/workspace-paths.js';

describe('workspace-paths', () => {
	const original = process.env.DEEPSEEK_ARCH_SESSION_CWD;

	afterEach(() => {
		if (original === undefined) delete process.env.DEEPSEEK_ARCH_SESSION_CWD;
		else process.env.DEEPSEEK_ARCH_SESSION_CWD = original;
	});

	beforeEach(() => {
		process.env.DEEPSEEK_ARCH_SESSION_CWD = '/tmp/ws-test';
	});

	it('getSessionCwd 优先取 DEEPSEEK_ARCH_SESSION_CWD', () => {
		expect(getSessionCwd()).toBe('/tmp/ws-test');
		delete process.env.DEEPSEEK_ARCH_SESSION_CWD;
		expect(getSessionCwd()).toBe(process.cwd());
	});

	it('runtime 目录布局统一在 {workspace}/.deepseek-arch/ 下', () => {
		expect(RUNTIME_DIR_NAME).toBe('.deepseek-arch');
		expect(getRuntimeDir()).toBe(join('/tmp/ws-test', '.deepseek-arch'));
		expect(getPlanDir()).toBe(join('/tmp/ws-test', '.deepseek-arch', 'plan'));
		expect(getMemoryDir()).toBe(join('/tmp/ws-test', '.deepseek-arch', 'memory'));
		expect(getApiRequestsDir()).toBe(join('/tmp/ws-test', '.deepseek-arch', 'api-requests'));
		expect(getFileStatePath()).toBe(join('/tmp/ws-test', '.deepseek-arch', 'agent-file-state.json'));
	});

	it('可显式传入 workspace（不读环境变量）', () => {
		delete process.env.DEEPSEEK_ARCH_SESSION_CWD;
		expect(getPlanDir('/tmp/explicit')).toBe(join('/tmp/explicit', '.deepseek-arch', 'plan'));
		expect(getMemoryDir('/tmp/explicit')).toBe(join('/tmp/explicit', '.deepseek-arch', 'memory'));
	});
});
