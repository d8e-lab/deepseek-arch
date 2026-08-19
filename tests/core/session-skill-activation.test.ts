/**
 * F-10 回归测试：skill 条件激活通知的插入位置
 *
 * 修复前 bug：文件工具触碰 docs/** 激活条件 skill 后，system-reminder 被
 * 直接 push 进 agentMessages，落在 assistant(tool_calls) 与 tool 结果消息之间，
 * 打断 assistant tool_calls 序列，导致 API 报"消息发送失败"。
 *
 * 修复后：通知延迟到所有 tool 消息之后插入，序列为
 *   assistant(tool_calls) → tool(结果) → user(system-reminder)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../../src/core/storage.js';
import type { ModelProvider } from '../../src/core/model-provider.js';
import { SessionManager } from '../../src/core/session.js';
import { clearSkillCache, loadSkillsFromDirs } from '../../src/core/skill.js';
import type { Message, StreamChunk } from '../../src/types/index.js';
import type { Tool, ToolResult } from '../../src/tools/types.js';

describe('SessionManager · skill 条件激活通知插入位置', () => {
	let testDir: string;
	let skillDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), 'session-skill-test-'));
		skillDir = await mkdtemp(join(tmpdir(), 'skill-dir-'));

		// 条件激活 skill：触碰 docs/** 路径时激活
		await writeFile(
			join(skillDir, 'docs.skill.md'),
			`---
name: docs
description: 文档维护规范
when_to_use: 修改 docs/ 目录下的文档时
paths: docs/**
context: inline
version: 1.0.0
---
# Docs Skill
`,
		);

		clearSkillCache();
		await loadSkillsFromDirs('/nonexistent', skillDir);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		await rm(skillDir, { recursive: true, force: true });
		clearSkillCache();
	});

	it('system-reminder 在所有 tool 消息之后插入，不打断 assistant tool_calls 序列', async () => {
		// mock read_file 工具：name 命中 TOOL_PATH_PARAMS，execute 不真读文件
		const readFileTool: Tool = {
			name: 'read_file',
			description: 'read file',
			parameters: { type: 'object', properties: {}, required: [] },
			requiresConfirm: false,
			async execute(_args): Promise<ToolResult> {
				return { content: 'file content' };
			},
		};

		const received: Message[][] = [];
		let call = 0;
		async function* stream(messages: Message[]): AsyncGenerator<StreamChunk> {
			received.push(JSON.parse(JSON.stringify(messages)));
			call++;
			if (call === 1) {
				// 第一轮：返回 read_file tool_call（触碰 docs/guide.md）
				yield {
					id: 'call-1',
					object: 'chat.completion.chunk',
					created: 123,
					model: 'test',
					choices: [{
						index: 0,
						delta: {
							tool_calls: [{
								index: 0,
								id: 'call_read',
								type: 'function',
								function: { name: 'read_file', arguments: '{"path":"docs/guide.md"}' },
							}],
						},
						finish_reason: null,
					}],
				};
				yield {
					id: 'call-1',
					object: 'chat.completion.chunk',
					created: 123,
					model: 'test',
					choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				};
			} else {
				// 第二轮：纯文本结束
				yield {
					id: 'call-2',
					object: 'chat.completion.chunk',
					created: 123,
					model: 'test',
					choices: [{
						index: 0,
						delta: { content: 'done' },
						finish_reason: 'stop',
					}],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				};
			}
		}

		const provider: ModelProvider = {
			chatStream: (msgs) => stream(msgs),
		} as unknown as ModelProvider;

		const storage = new Storage(testDir);
		const mgr = new SessionManager(storage, provider, [readFileTool]);
		mgr.setSystemPrompt({ role: 'system', content: 'test' });

		await mgr.startNewSession();
		await mgr.sendMessageStream('请读文档', () => {});

		// 第二轮 provider 收到的消息 = 上一轮 agent loop 构建的完整序列
		const secondRound = received[1] ?? received[0];

		// 断言 1：存在 read_file 的 tool 结果消息
		const toolIdx = secondRound.findIndex((m) => m.role === 'tool' && (m as any).tool_call_id === 'call_read');
		expect(toolIdx).toBeGreaterThanOrEqual(0);

		// 断言 2：存在 skill 激活的 system-reminder
		const reminderIdx = secondRound.findIndex(
			(m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('system-reminder'),
		);
		expect(reminderIdx).toBeGreaterThanOrEqual(0);
		expect(secondRound[reminderIdx]!.content).toContain('docs');

		// 断言 3：system-reminder 在 tool 消息之后（修复的核心）
		expect(reminderIdx).toBeGreaterThan(toolIdx);

		// 断言 4：assistant(tool_calls) 之后紧跟 tool 消息（中间无 user 消息插入）
		const assistantIdx = secondRound.findIndex((m) => m.role === 'assistant' && (m as any).tool_calls);
		expect(assistantIdx).toBeGreaterThanOrEqual(0);
		expect(secondRound[assistantIdx + 1]?.role).toBe('tool');
	});
});
