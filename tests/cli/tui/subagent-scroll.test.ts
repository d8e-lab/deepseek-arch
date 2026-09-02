/**
 * subagent-scroll.test.ts — Ctrl+T Subagents 视图轨迹滚动回归测试
 *
 * 验证：
 *   - 默认贴底显示最新轨迹（最早内容不可见）
 *   - subagentScrollBy 上滚后可看到最早内容（轨迹可回看）
 *   - 滚回底部恢复跟随、提示行出现位置指示
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TuiApp } from '../../../src/presentation/tui-app.js';
import type { SessionManager } from '../../../src/core/session.js';
import type { TuiConfig } from '../../../src/presentation/types.js';
import type { SubagentRecord } from '../../../src/types/index.js';
import { stripAnsi } from '../../../src/render/ansi.js';

/** 构造带 40 行连续输出的 subagent 记录（超出窗口 → 可滚动） */
function makeRecord(name = 's1'): SubagentRecord {
	const entries = [];
	for (let i = 1; i <= 40; i++) {
		entries.push({ type: 'content', content: `轨迹内容行${i}`, timestamp: i });
	}
	return {
		name,
		task: 'demo task',
		status: 'completed',
		startMs: Date.now() - 4000,
		endMs: Date.now() - 1000,
		entries,
	};
}

function makeApp(records: SubagentRecord[]): TuiApp {
	const subs = records.map((r) => ({
		name: r.name,
		status: r.status,
		startMs: r.startMs,
		toRecord: () => r,
	}));
	const mgr = {
		getSubagentAsync: () => false,
		listSubagents: () => subs,
	} as unknown as SessionManager;
	const config: TuiConfig = {
		provider: 'test',
		model: 'test',
		baseUrl: 'http://example.com',
		apiKey: 'k',
		version: '1.3.8',
	};
	return new TuiApp(mgr, config);
}

/** 暴露 TuiApp 私有渲染/滚动方法 */
type ScrollApp = {
	renderSubagentsView: () => void;
	subagentScrollBy: (delta: number) => void;
};

describe('Ctrl+T Subagents 视图轨迹滚动', () => {
	let writes: string[];
	const origWrite = process.stdout.write;

	beforeEach(() => {
		writes = [];
		process.stdout.write = ((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		process.stdout.write = origWrite;
	});

	/** 最近一次 render 的纯文本（从指定写入起点截取） */
	function lastRenderText(fromIdx: number): string {
		return stripAnsi(writes.slice(fromIdx).join(''));
	}

	it('默认贴底显示最新轨迹（最早内容不可见）', () => {
		const app = makeApp([makeRecord()]) as unknown as ScrollApp;
		app.renderSubagentsView();
		const out = stripAnsi(writes.join(''));
		expect(out).toContain('轨迹内容行40');
		expect(out).not.toContain('轨迹内容行1');
		// 轨迹总行数 > 窗口 → 提示行显示滚动位置（/44 = 头部3 + 内容40 + 尾部1）
		expect(out).toContain('/44');
	});

	it('↑↓ 上滚后可回看最早轨迹，滚回底部回到最新', () => {
		const app = makeApp([makeRecord()]) as unknown as ScrollApp;
		app.renderSubagentsView();
		const base = writes.length;

		// 上滚到顶：最早内容出现
		app.subagentScrollBy(-1000);
		let out = lastRenderText(base);
		expect(out).toContain('轨迹内容行1');
		expect(out).not.toContain('轨迹内容行40');

		// 滚回底：重新贴底显示最新
		const mid = writes.length;
		app.subagentScrollBy(1000);
		out = lastRenderText(mid);
		expect(out).toContain('轨迹内容行40');
		expect(out).not.toContain('轨迹内容行1');
	});

	it('切换 subagent（n/p）后从最新输出看起', () => {
		const app = makeApp([makeRecord('s1'), makeRecord('s2')]) as unknown as ScrollApp & {
			handleSubagentsViewInput: (d: string) => void;
		};
		app.renderSubagentsView();
		// 先上滚到顶（停留在历史）
		app.subagentScrollBy(-1000);
		const beforeNav = writes.length;

		// n 切到 s2：应重新贴底（行1 消失、行40 在）
		app.handleSubagentsViewInput('n');
		const afterNav = lastRenderText(beforeNav);
		expect(afterNav).not.toContain('轨迹内容行1');
		expect(afterNav).toContain('轨迹内容行40');
	});
});
