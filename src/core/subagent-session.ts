/**
 * subagent-session.ts — 子代理会话对象（方案 B 全状态化）
 *
 * 将子代理从"一次性函数调用"升级为"可恢复会话"：
 *  - 独立持有完整消息上下文（messages），支持追加指令续跑（send）
 *  - 实时输出条目（entries）供 TUI 详情/实时视图渲染
 *  - 独立 AbortController（取消不影响主代理）
 *  - toRecord()/fromRecord() 支持持久化与 resume 恢复
 *
 * 驱动逻辑复用 runSubagentLoop（消息队列所有权在会话对象内）。
 */

import type { Message, TokenUsage } from '../types/index.js';
import type { SubagentRecord, SubagentRoundEntry } from '../types/subagent.js';
import type { ModelProvider, ChatOptions } from './model-provider.js';
import type { Tool } from '../tools/types.js';
import { runSubagentLoop, SUBAGENT_CANCELLED } from './subagent.js';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentSessionOptions {
	name: string;
	task: string;
	/** 完整 system prompt（含 Subagent Mode 追加片段），作为消息队列首条 */
	systemPrompt: string;
	provider: ModelProvider;
	tools: Tool[];
	chatDefaults?: ChatOptions;
	/** 每轮 API usage 回调（主会话 token 入账用） */
	onUsage?: (usage: TokenUsage) => void;
}

export class SubagentSession {
	readonly name: string;
	readonly task: string;
	status: SubagentStatus = 'running';
	/** 完整消息上下文（含 system 首条）；驱动时由 runSubagentLoop 返回最新队列替换 */
	messages: Message[];
	/** 实时输出条目（按时间序，TUI 详情/实时视图渲染用） */
	entries: SubagentRoundEntry[] = [];
	result?: string;
	startMs: number;
	endMs?: number;

	private controller: AbortController;
	private provider: ModelProvider;
	private tools: Tool[];
	private chatDefaults?: ChatOptions;
	private onUsage?: (usage: TokenUsage) => void;
	/** 最近一次 drive 的 promise（wait 用；完成后仍保留最后结果） */
	promise: Promise<string> | null = null;

	constructor(opts: SubagentSessionOptions) {
		this.name = opts.name;
		this.task = opts.task;
		this.startMs = Date.now();
		this.provider = opts.provider;
		this.tools = opts.tools;
		this.chatDefaults = opts.chatDefaults;
		this.onUsage = opts.onUsage;
		this.controller = new AbortController();
		this.messages = [
			{ role: 'system', content: opts.systemPrompt },
			{ role: 'user', content: opts.task },
		];
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get isRunning(): boolean {
		return this.status === 'running';
	}

	/** 驱动循环（首启/续跑共用）。同一时刻只允许一次驱动；运行中重复调用返回同一 promise。 */
	drive(): Promise<string> {
		if (this.promise && this.status === 'running') return this.promise;
		this.status = 'running';
		this.promise = this._drive();
		return this.promise;
	}

	private async _drive(): Promise<string> {
		try {
			const { result, messages } = await runSubagentLoop(
				this.messages,
				this.provider,
				this.tools,
				this.controller.signal,
				{
					onEntry: (entry) => this.entries.push(entry),
					onUsage: (usage) => this.onUsage?.(usage),
				},
				this.chatDefaults,
			);
			this.messages = messages;
			if (result === SUBAGENT_CANCELLED) {
				this.status = 'cancelled';
			} else if (result.startsWith('Error:')) {
				this.status = 'failed';
			} else {
				this.status = 'completed';
			}
			this.result = result;
			this.endMs = Date.now();
			return result;
		} catch (err) {
			this.status = 'failed';
			this.result = `Error: ${err instanceof Error ? err.message : String(err)}`;
			this.endMs = Date.now();
			throw err;
		}
	}

	/**
	 * 追加指令并续跑（用户 / master agent 向子代理发送消息）。
	 * 守卫：running 中拒绝（并发保护）；cancelled 拒绝（上下文已中止）。
	 * async 方法：守卫失败以 rejected promise 抛出（await 可捕获）。
	 */
	async send(instruction: string): Promise<string> {
		if (this.status === 'running') {
			throw new Error(`subagent "${this.name}" is still running — wait for it to finish before sending a follow-up.`);
		}
		if (this.status === 'cancelled') {
			throw new Error(`subagent "${this.name}" was cancelled — cannot resume a cancelled subagent.`);
		}
		if (this.messages.length === 0) {
			throw new Error(`subagent "${this.name}" has no message context.`);
		}
		this.messages.push({ role: 'user', content: instruction });
		return this.drive();
	}

	/** 取消（独立 signal，不影响主代理） */
	cancel(): void {
		this.controller.abort();
	}

	/** 转换为持久化记录（含完整消息上下文） */
	toRecord(): SubagentRecord {
		return {
			name: this.name,
			task: this.task,
			status: this.status,
			startMs: this.startMs,
			endMs: this.endMs,
			result: this.result,
			entries: this.entries,
			messages: this.messages,
		};
	}

	/**
	 * 从持久化记录恢复会话（resume 场景）。
	 * 仅恢复 completed/failed 状态（运行中记录不会落盘）；恢复后可通过 send() 继续交互。
	 * 老记录（无 messages 字段）恢复后 send() 会抛"no context"——上下文不可得，无法续跑。
	 */
	static fromRecord(record: SubagentRecord, opts: Omit<SubagentSessionOptions, 'name' | 'task' | 'systemPrompt'>): SubagentSession {
		const session = new SubagentSession({
			name: record.name,
			task: record.task,
			systemPrompt: record.messages?.[0]?.role === 'system'
				? (record.messages[0].content as string)
				: '',
			...opts,
		});
		// 用持久化状态覆盖构造初始值（构造时 status=running、startMs=now）
		session.status = record.status === 'running' ? 'completed' : record.status;
		session.startMs = record.startMs;
		session.endMs = record.endMs;
		session.result = record.result;
		session.entries = [...(record.entries ?? [])];
		if (record.messages && record.messages.length > 0) {
			session.messages = [...record.messages];
		}
		return session;
	}
}
