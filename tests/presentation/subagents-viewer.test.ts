/**
 * subagents-viewer.test.ts — Ctrl+T Subagents 视图轨迹滚动回归测试（组件级）
 *
 * 方案 A 迁移：原测试通过 TuiApp 私有方法 renderSubagentsView/subagentScrollBy
 * 驱动，现直接实例化 SubagentsViewer（注入 fake out/数据源），断言等价保留。
 *
 * 验证：
 *   - 默认贴底显示最新轨迹（最早内容不可见）
 *   - ↑↓ 上滚后可看到最早内容（轨迹可回看），滚回底部恢复跟随
 *   - 切换 subagent（n/p）后从最新输出看起
 *   - subagent 结束后：耗时固定到 endMs，500ms 刷新定时器停止
 */
import { describe, it, expect } from 'vitest';
import { SubagentsViewer } from '../../src/presentation/views/subagents-viewer.js';
import type { SubagentViewSession } from '../../src/presentation/views/subagents-viewer.js';
import { ScreenBuffer } from '../../src/presentation/screen-buffer.js';
import type { SubagentRecord } from '../../src/types/index.js';
import { stripAnsi } from '../../src/render/ansi.js';

/** 构造带 40 行输出的 subagent 记录（超出窗口 → 可滚动；内容为按行格式的完整句子行） */
function makeRecord(name = 's1'): SubagentRecord {
	const entries = [];
	for (let i = 1; i <= 40; i++) {
		entries.push({
			type: 'content',
			content: `轨迹内容行${i}：按行格式的完整正文句子，模拟真实记录行粒度。`,
			timestamp: i,
		});
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

/** 把 record 包装为会话对象（与原 TuiApp 测试 makeApp 的包装等价） */
function toSession(r: SubagentRecord): { name: string; status: string; startMs: number; endMs?: number; toRecord: () => SubagentRecord } {
	return {
		name: r.name,
		status: r.status,
		startMs: r.startMs,
		endMs: r.endMs,
		toRecord: () => r,
	};
}

/** 用外部可变的 subagent 会话对象列表构造 Viewer（测试可模拟 running → completed 转变） */
function makeViewer(
	subs: Array<{ name: string; status: string; startMs: number; endMs?: number; toRecord: () => SubagentRecord }>,
): { viewer: SubagentsViewer; writes: string[] } {
	const writes: string[] = [];
	const out = new ScreenBuffer({ write: (s: string) => writes.push(s) });
	const viewer = new SubagentsViewer({
		out,
		listSubagents: () => subs as unknown as SubagentViewSession[],
		sendToSubagent: async () => undefined,
		isStreamActive: () => false, // 主流程空闲（不因 maySpawnMore 保持刷新）
		getSize: () => ({ rows: 24, cols: 80 }),
	});
	return { viewer, writes };
}

/** 暴露 Viewer 私有渲染/滚动/输入方法（组件级白盒） */
type ScrollViewer = {
	render: () => void;
	scrollBy: (delta: number) => void;
	handleInput: (d: string) => unknown;
	cleanup: () => void;
	timer: ReturnType<typeof setInterval> | null;
};

describe('SubagentsViewer 轨迹滚动', () => {
	it('默认贴底显示最新轨迹（最早内容不可见）', () => {
		const { viewer, writes } = makeViewer([toSession(makeRecord())]);
		viewer.render();
		const out = stripAnsi(writes.join(''));
		expect(out).toContain('轨迹内容行40');
		expect(out).not.toContain('轨迹内容行1');
		// 轨迹总行数 > 窗口 → 提示行显示滚动位置（/44 = 头部3 + 内容40 + 尾部1）
		expect(out).toContain('/44');
	});

	it('↑↓ 上滚后可回看最早轨迹，滚回底部回到最新', () => {
		const { viewer, writes } = makeViewer([toSession(makeRecord())]);
		const anyViewer = viewer as unknown as ScrollViewer;
		anyViewer.render();
		const base = writes.length;

		// 上滚到顶：最早内容出现
		anyViewer.scrollBy(-1000);
		let out = stripAnsi(writes.slice(base).join(''));
		expect(out).toContain('轨迹内容行1');
		expect(out).not.toContain('轨迹内容行40');

		// 滚回底：重新贴底显示最新
		const mid = writes.length;
		anyViewer.scrollBy(1000);
		out = stripAnsi(writes.slice(mid).join(''));
		expect(out).toContain('轨迹内容行40');
		expect(out).not.toContain('轨迹内容行1');
	});

	it('切换 subagent（n/p）后从最新输出看起', () => {
		const { viewer, writes } = makeViewer([toSession(makeRecord("s1")), toSession(makeRecord("s2"))]);
		const anyViewer = viewer as unknown as ScrollViewer;
		anyViewer.render();
		// 先上滚到顶（停留在历史）
		anyViewer.scrollBy(-1000);
		const beforeNav = writes.length;

		// n 切到 s2：应重新贴底（行1 消失、行40 在）
		anyViewer.handleInput('n');
		const afterNav = stripAnsi(writes.slice(beforeNav).join(''));
		expect(afterNav).not.toContain('轨迹内容行1');
		expect(afterNav).toContain('轨迹内容行40');
	});

	it('subagent 结束后：耗时固定到 endMs，500ms 刷新定时器停止', () => {
		const subs = [
			{ name: 's1', status: 'running', startMs: Date.now() - 5000, toRecord: () => makeRecord('s1') },
		];
		const { viewer, writes } = makeViewer(subs);
		const anyViewer = viewer as unknown as ScrollViewer;
		try {
			anyViewer.render();
			// running 中：视图刷新定时器在跑
			expect(anyViewer.timer).not.toBeNull();

			// 模拟结束：completed + endMs（startMs 后 1s）
			subs[0].status = 'completed';
			subs[0].endMs = Date.now() - 4000;
			const before = writes.length;
			anyViewer.render();
			const out = stripAnsi(writes.slice(before).join(''));

			// 全部结束且主流程空闲 → 定时器停止
			expect(anyViewer.timer).toBeNull();
			// 耗时固定为 endMs-startMs=1s（而非 now-startMs≈5s 继续跳动）
			expect(out).toContain('(completed, 1.0s)');
		} finally {
			anyViewer.cleanup();
		}
	});
});
