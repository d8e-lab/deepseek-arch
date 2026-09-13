/**
 * memory-session.test.ts — 记忆机制与会话层的集成测试（批次 3 子任务 6）
 *
 * 覆盖：清单注入 system prompt（会话创建）、变化提醒落盘（turn.messages）、
 * 后台归纳触发（游标推进 + agent 写入）、/memory refresh 重建 system prompt 与快照。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../../src/core/storage.js';
import { SessionManager } from '../../src/core/session.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import type { ModelProvider } from '../../src/core/model-provider.js';
import type { Message, StreamChunk } from '../../src/types/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 主代理 / 记忆归纳代理分流 provider（按 system prompt 判定） */
function makeProvider(): ModelProvider {
	let agentTurn = 0;
	async function* gen(messages: Message[]): AsyncGenerator<StreamChunk> {
		const sys = String(messages[0]?.content ?? '');
		const chunk = (delta: Record<string, unknown>): StreamChunk => ({
			id: 'c', object: 'chat.completion.chunk', created: 0, model: 'flash',
			choices: [{ index: 0, delta, finish_reason: null }],
		} as StreamChunk);

		if (sys.includes('记忆归纳代理')) {
			agentTurn++;
			if (agentTurn === 1) {
				yield chunk({
					tool_calls: [{
						index: 0, id: 'w1', type: 'function',
						function: {
							name: 'memory_write',
							arguments: JSON.stringify({
								subject: 'agent.written', name: '代理写入', description: '来自归纳代理',
								confidence: 3, body: '归纳代理写入的偏好。',
							}),
						},
					}],
				});
				return;
			}
			yield chunk({ content: '归纳完成。' });
			return;
		}
		yield chunk({ content: '主代理回复' });
	}
	return {
		chatStream: gen,
		async chat() {
			return {
				id: 'c', object: 'chat.completion', created: 0, model: 'flash',
				choices: [{ index: 0, message: { role: 'assistant', content: '{"selected":[]}' }, finish_reason: 'stop' }],
			};
		},
	} as unknown as ModelProvider;
}

describe('记忆与会话集成', () => {
	let root: string;
	let storage: Storage;
	let store: MemoryStore;
	let mgr: SessionManager;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'deepseek-memory-session-'));
		storage = new Storage(join(root, 'sessions'));
		store = new MemoryStore({ projectDir: join(root, 'memory'), globalDir: join(root, 'gmemory') });
		mgr = new SessionManager(storage, makeProvider());
		mgr.setSystemPrompt({ role: 'system', content: '你是助手。' });
		mgr.configureMemory({ store, agentOnTurnEnd: true, agentMinIntervalSec: 0 });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('会话创建：记忆清单注入 system prompt 并写入会话快照', async () => {
		await store.write('project', { subject: 'a.b', name: 'A', description: '已有记忆', confidence: 3, body: 'x' });
		const meta = await mgr.startNewSession('记忆注入测试');

		const snapshot = await readFile(join(storage.sessionDir(meta.id), 'system-prompt.txt'), 'utf-8');
		expect(snapshot).toContain('<memory_listing>');
		expect(snapshot).toContain('- [A](a-b.md) — 已有记忆');
		expect(snapshot).toContain('memory_read');
	});

	it('无记忆时不注入（保持"无记忆 = 现状字节"）', async () => {
		const meta = await mgr.startNewSession('空记忆');
		const snapshot = await readFile(join(storage.sessionDir(meta.id), 'system-prompt.txt'), 'utf-8');
		expect(snapshot).toBe('你是助手。');
	});

	it('会话内清单变化 → 变化提醒作为一条 user 消息落盘（历史字节稳定）', async () => {
		await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });
		const meta = await mgr.startNewSession('变化提醒测试');
		await sleep(10);
		await store.write('project', { subject: 'c.d', name: '新条目', description: 'd2', confidence: 3, body: 'y' });

		await mgr.sendMessageStream('你好', () => {});

		const turns = await storage.getTurns(meta.id);
		const allText = turns.flatMap((t) => t.messages ?? []).map((m) => String(m.content ?? '')).join('\n');
		expect(allText).toContain('<memory-update>');
		expect(allText).toContain('added');
		expect(allText).toContain('新条目');
	});

	it('后台归纳随用户发言触发：写入记忆并推进游标（第二轮窗口 = 第一轮对话）', async () => {
		const meta = await mgr.startNewSession('归纳触发测试');

		await mgr.sendMessageStream('我希望回复先给结论', () => {});
		await mgr.sendMessageStream('第二轮消息', () => {});
		await sleep(120); // agent 为 fire-and-forget

		// agent 写入了记忆
		const entries = await store.listEntries('project');
		expect(entries.map((e) => e.slug)).toContain('agent-written');

		// 游标推进到第一轮（第二轮开始时窗口里只有第一轮）
		const state = await store.getState('project');
		expect(state.lastExtractedTurnId).toBe('1');

		// 主会话本身不受影响
		expect((await storage.getTurns(meta.id)).length).toBe(2);
	});

	it('refreshMemoryPrompt：重建 system prompt 清单并重写快照；无变化返回 false', async () => {
		await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });
		const meta = await mgr.startNewSession('刷新测试');

		expect(await mgr.refreshMemoryPrompt()).toBe(false); // 清单没变

		await sleep(10);
		await store.write('project', { subject: 'e.f', name: '后加条目', description: 'd2', confidence: 3, body: 'z' });
		expect(await mgr.refreshMemoryPrompt()).toBe(true);

		const snapshot = await readFile(join(storage.sessionDir(meta.id), 'system-prompt.txt'), 'utf-8');
		expect(snapshot).toContain('后加条目');
		expect(snapshot).toContain('你是助手。');
		// 只有一个 <memory_listing> 块（重建而非追加）
		expect(snapshot.match(/<memory_listing>/g)).toHaveLength(1);
	});

	it('到期提醒：条目的提醒块随本轮落盘，且触发 once 回调', async () => {
		await store.write('project', {
			subject: 'defer.a', name: '到期项', description: 'd', confidence: 3, body: 'b',
			remindAt: '2020-01-01T00:00:00Z',
		});
		const meta = await mgr.startNewSession('到期提醒测试');
		const dueSlugs: string[][] = [];
		mgr.setMemoryDueCallback((slugs) => dueSlugs.push(slugs));

		await mgr.sendMessageStream('你好', () => {});

		const turns = await storage.getTurns(meta.id);
		const allText = turns.flatMap((t) => t.messages ?? []).map((m) => String(m.content ?? '')).join('\n');
		expect(allText).toContain('<memory-due>');
		expect(allText).toContain('到期项');
		expect(dueSlugs).toEqual([['defer-a']]);
		// 一次性：条目仍在但 remindAt 已清空
		expect((await store.readEntry('project', 'defer-a'))!.remindAt).toBeUndefined();
	});

	it('compact 后重建 system prompt：清单刷新 + 快照同步（R7/R11）', async () => {
		await store.write('project', { subject: 'a.b', name: 'A', description: 'd', confidence: 3, body: 'x' });
		const meta = await mgr.startNewSession('compact 刷新测试');
		await mgr.sendMessageStream('第一轮', () => {});

		// 会话内新增记忆（快照里还没有）
		const before = await readFile(join(storage.sessionDir(meta.id), 'system-prompt.txt'), 'utf-8');
		expect(before).not.toContain('compact 后新增');

		await store.write('project', { subject: 'n.m', name: 'compact 后新增', description: 'd2', confidence: 3, body: 'y' });
		await mgr.compactContext();

		const after = await readFile(join(storage.sessionDir(meta.id), 'system-prompt.txt'), 'utf-8');
		expect(after).toContain('compact 后新增');
		expect(after.match(/<memory_listing>/g)).toHaveLength(1);
	});

	it('未配置记忆时完全不介入（旧行为不变）', async () => {
		const plain = new SessionManager(storage, makeProvider());
		plain.setSystemPrompt({ role: 'system', content: '你是助手。' });
		expect(plain.getMemory()).toBeNull();

		const meta = await plain.startNewSession('无记忆');
		const snapshot = await readFile(join(storage.sessionDir(meta.id), 'system-prompt.txt'), 'utf-8');
		expect(snapshot).toBe('你是助手。');
		await plain.sendMessageStream('你好', () => {});
		expect(await store.getState('project')).toEqual({}); // 没跑 agent、没写游标
	});
});
