/**
 * ConversationViewer 单元测试
 *
 * 描述：直接实例化组件（注入 fake out + turns），验证 render 行构建、
 * 搜索高亮/跳转、ESC/方向键输入、q/ESC 关闭请求。
 */
import { describe, it, expect } from 'vitest';
import { ConversationViewer } from '../../src/presentation/views/conversation-viewer.js';
import { ScreenBuffer } from '../../src/presentation/screen-buffer.js';
import { ConversationView } from '../../src/render/conversation.js';
import { stripAnsi } from '../../src/render/ansi.js';
import type { TurnRecord } from '../../src/types/index.js';

function makeTurn(text: string, think: string): TurnRecord {
	return {
		version: 2,
		messages: [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: text, reasoning_content: think },
		],
		cost_rmb: 0,
		created_at: new Date().toISOString(),
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function makeViewer(turns: TurnRecord[]): {
	viewer: ConversationViewer;
	writes: string[];
} {
	const writes: string[] = [];
	const out = new ScreenBuffer({ write: (s: string) => writes.push(s) });
	const viewer = new ConversationViewer({
		out,
		getTurns: () => turns,
		conversation: new ConversationView(),
		getSize: () => ({ rows: 24, cols: 80 }),
	});
	return { viewer, writes };
}

describe('ConversationViewer', () => {
	it('render：构建轮次行并全屏绘制（含轮标题与 think）', () => {
		const { viewer, writes } = makeViewer([makeTurn('回复内容', '思考内容')]);
		viewer.render();
		const out = writes.join('');
		expect(out).toContain('\x1b[2J\x1b[H'); // 清屏+复位
		expect(out).toContain('对话浏览'); // 顶部提示
		expect(stripAnsi(out)).toContain('第 1 轮');
		expect(stripAnsi(out)).toContain('思考内容');
		expect(stripAnsi(out)).toContain('回复内容');
	});

	it('render：空 turns 显示占位', () => {
		const { viewer, writes } = makeViewer([]);
		viewer.render();
		expect(stripAnsi(writes.join(''))).toContain('(暂无对话)');
	});

	it('handleInput q/Q/单独 ESC 返回 close', () => {
		const { viewer } = makeViewer([makeTurn('r', 't')]);
		expect(viewer.handleInput('q')).toBe('close');
		expect(viewer.handleInput('Q')).toBe('close');
		expect(viewer.handleInput('\x1b')).toBe('close');
	});

	it('handleInput 普通字符返回 handled 且不关闭', () => {
		const { viewer } = makeViewer([makeTurn('r', 't')]);
		expect(viewer.handleInput('abc')).toBe('handled');
	});

	it('方向键滚动：内容超出视口时移动视口起点', () => {
		// 生成多行内容（>22 可见行）使滚动有意义
		const turns = [makeTurn(Array.from({ length: 40 }, (_, i) => `行${i}`).join('\n'), '')];
		const { viewer, writes } = makeViewer(turns);
		viewer.render();
		const first = stripAnsi(writes.join(''));
		expect(first).toContain('行0');
		// ↓ 下滚一行
		writes.length = 0;
		viewer.handleInput('\x1b[B');
		const scrolled = stripAnsi(writes.join(''));
		expect(scrolled).toContain('行1');
	});

	it('搜索：/ 进入搜索模式，Enter 后高亮匹配行并跳转', () => {
		const turns = [makeTurn(Array.from({ length: 20 }, (_, i) => `目标${i}行`).join('\n'), '')];
		const { viewer, writes } = makeViewer(turns);
		viewer.render();
		// 搜索 "目标15"
		writes.length = 0;
		viewer.handleInput('/目标15\r');
		const out = writes.join('');
		// 匹配行以反转色渲染
		expect(out).toContain('\x1b[7m');
		// 状态行显示匹配信息
		expect(stripAnsi(out)).toContain('目标15');
	});
});
