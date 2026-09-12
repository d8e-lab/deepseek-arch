/**
 * subagent-session.ts — 子代理会话对象（方案 B 全状态化）
 *
 * 将子代理从"一次性函数调用"升级为"可恢复会话"：
 *  - 独立持有完整消息上下文（扁平 msgs）与逐轮运行记录（runs），支持追加指令续跑（send）
 *  - **run 级中断**：每次 drive 新建 AbortController。取消只中断当前运行——cancelled
 *    不是终态，之后可继续 send 续跑（`runSubagentLoop` 已保证消息序列合法、无悬空 tool_calls）；
 *    同时子代理不接收主代理的 signal（I-1：主代理 Ctrl+C 不连坐）
 *  - 输出条目按 run 分组存放（entries 为扁平投影，供渲染与持久化）
 *  - toRecord()/fromRecord() 支持持久化与 resume 恢复
 *
 * 驱动逻辑复用 runSubagentLoop（消息队列所有权在会话对象内）。
 */

import type { Message, TokenUsage } from '../types/index.js';
import type { SubagentRecord, SubagentRoundEntry, SubagentMeta, SubagentRunRecord } from '../types/subagent.js';
import type { ModelProvider, ChatOptions } from './model-provider.js';
import type { Tool } from '../tools/types.js';
import { runSubagentLoop, SUBAGENT_CANCELLED } from './subagent.js';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** 一轮运行的 user 侧来源：首启任务 / master 指令 / 用户直发 */
export type SubagentRunSource = 'task' | 'master' | 'user';

/** 单轮运行记录（落盘与对话投影的单位） */
export interface SubagentRun {
	/** 该轮 user 侧输入（首启 = task；续跑 = 指令） */
	userText: string;
	/** 输入来源：对话投影据此标注 task / user / master */
	source: SubagentRunSource;
	/** 该轮消息在 msgs 中的起始下标（含该轮 user 消息） */
	msgStart: number;
	/** 该轮消息结束下标（不含）；进行中为 undefined（视作 msgs.length） */
	msgEnd?: number;
	/** 该轮实时输出条目 */
	entries: SubagentRoundEntry[];
	/** 该轮结束状态（进行中为 'running'） */
	status: SubagentStatus;
	/** 该轮失败原因（status='failed' 时；取代旧 result 字段承载错误信息） */
	error?: string;
	startedAt: number;
	endedAt?: number;
}

/** 对话投影中单条 content 的截断上限（防超长输出撑爆 master 上下文） */
export const DIALOGUE_MAX_CONTENT_CHARS = 20_000;

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
	/**
	 * 进度落盘回调（P-1）：每轮关键点触发，由 SessionManager 注入实现。
	 * 使运行中/取消/崩溃都留下轨迹（与 master 每轮增量落盘同构）。
	 */
	onProgress?: () => void;
}

export class SubagentSession {
	readonly name: string;
	readonly task: string;
	status: SubagentStatus = 'running';
	startMs: number;
	endMs?: number;
	/** 逐轮运行记录（首启 + 每次续跑） */
	readonly runs: SubagentRun[] = [];

	/** 完整扁平消息队列（system 首条 + 各轮 user/assistant/tool） */
	private msgs: Message[];
	/** 当前运行的中断控制器（每次 drive 新建；运行结束后清空） */
	private runController: AbortController | null = null;
	private provider: ModelProvider;
	private tools: Tool[];
	private chatDefaults?: ChatOptions;
	private onUsage?: (usage: TokenUsage) => void;
	private onProgress?: () => void;
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
		this.onProgress = opts.onProgress;
		this.msgs = [
			{ role: 'system', content: opts.systemPrompt },
		];
	}

	get messages(): Message[] {
		return this.msgs;
	}

	/** 扁平输出条目（各轮 entries 的拼接，供渲染/持久化） */
	get entries(): SubagentRoundEntry[] {
		return this.runs.flatMap((r) => r.entries);
	}

	/** 当前运行的中断信号（未运行时为空） */
	get signal(): AbortSignal | undefined {
		return this.runController?.signal;
	}

	get isRunning(): boolean {
		return this.status === 'running';
	}

	/** 某一轮实际产生的消息（含该轮 user 消息） */
	runMessages(run: SubagentRun): Message[] {
		return this.msgs.slice(run.msgStart, run.msgEnd ?? this.msgs.length);
	}

	/**
	 * 最后一次运行产出的文本（messages 中最后一条非空 assistant content）。
	 * 取代旧的独立 result 字段来源：最终 content 由循环入队 messages，此处派生即可。
	 */
	lastContent(): string | undefined {
		for (let i = this.msgs.length - 1; i >= 0; i--) {
			const m = this.msgs[i];
			if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0) {
				return m.content;
			}
		}
		return undefined;
	}

	/** 最后一次运行记录 */
	lastRun(): SubagentRun | undefined {
		return this.runs.length > 0 ? this.runs[this.runs.length - 1] : undefined;
	}

	/**
	 * 面向 master 的输出文本（drive/send 返回值、wait 的结果内容）。
	 * completed → 最后一次运行的 content；cancelled / failed → 状态消息。
	 * 取代旧的 result 字段：不再有「最终结果」这一独立概念（需求 4）。
	 */
	outputText(): string {
		if (this.status === 'cancelled') return SUBAGENT_CANCELLED;
		if (this.status === 'failed') {
			const err = this.lastRun()?.error;
			return err ? `Error: ${err}` : '(subagent failed)';
		}
		return this.lastContent() ?? '(subagent completed with no output)';
	}

	/**
	 * 对话投影：按轮输出「user 侧输入 → subagent 文本输出」，
	 * **不含思维链（reasoning）与工具调用/结果**。
	 * 供 master 消费（wait 返回）与「用户直发 subagent」后的通知使用：
	 * 多轮交互时 master 需要看到 user↔subagent 的会话历史，而不是只看最后一条 content。
	 */
	renderDialogue(): string {
		const blocks: string[] = [];
		this.runs.forEach((run, idx) => {
			const label = run.source === 'task' ? 'task' : run.source === 'user' ? 'user' : 'master';
			const lines: string[] = [`[run ${idx + 1}] ${label}: ${run.userText}`];
			const contents = this.runMessages(run)
				.filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0)
				.map((m) => truncateContent(m.content as string));
			if (contents.length === 0) {
				lines.push('  subagent: (no text output)');
			} else {
				for (const c of contents) lines.push(`  subagent: ${c}`);
			}
			blocks.push(lines.join('\n'));
		});
		return blocks.join('\n\n');
	}

	/**
	 * 驱动循环（首启/续跑共用）。同一时刻只允许一次驱动；运行中重复调用返回同一 promise。
	 * @param instruction 续跑指令（省略则重放 task）
	 * @param source 该轮输入来源（默认：有指令 = master，无指令 = task）
	 */
	drive(instruction?: string, source?: SubagentRunSource): Promise<string> {
		if (this.promise && this.status === 'running') return this.promise;
		const userText = instruction ?? this.task;
		const runSource: SubagentRunSource = source ?? (instruction ? 'master' : 'task');
		this.status = 'running';
		this.promise = this._drive(userText, runSource);
		return this.promise;
	}

	private async _drive(userText: string, source: SubagentRunSource): Promise<string> {
		// 该轮 user 消息先入队，run 记录其消息区间（msgs 只追加，下标稳定）
		const msgStart = this.msgs.length;
		this.msgs.push({ role: 'user', content: userText });
		const run: SubagentRun = {
			userText,
			source,
			msgStart,
			entries: [],
			status: 'running',
			startedAt: Date.now(),
		};
		this.runs.push(run);
		// run 级中断：每次驱动独立 controller（取消只中断本次运行，之后可续跑）
		this.runController = new AbortController();

		try {
			const { status, messages } = await runSubagentLoop(
				this.msgs,
				this.provider,
				this.tools,
				this.runController.signal,
				{
					onEntry: (entry) => run.entries.push(entry),
					onUsage: (usage) => this.onUsage?.(usage),
					onProgress: (msgs) => {
						// 采纳循环内部的实时队列（内部副本引用），使进度落盘能看到本轮新增内容
						this.msgs = msgs;
						this.onProgress?.();
					},
				},
				this.chatDefaults,
			);
			this.msgs = messages;
			run.msgEnd = this.msgs.length;
			// 状态由循环显式返回（不再靠 result 字符串前缀猜测）
			run.status = status === 'cancelled' ? 'cancelled' : 'completed';
			this.status = run.status;
			this.endMs = Date.now();
			run.endedAt = this.endMs;
			return this.outputText();
		} catch (err) {
			run.status = 'failed';
			run.msgEnd = this.msgs.length;
			run.endedAt = Date.now();
			run.error = err instanceof Error ? err.message : String(err);
			this.status = 'failed';
			this.endMs = Date.now();
			throw err;
		} finally {
			this.runController = null;
		}
	}

	/**
	 * 追加指令并续跑（用户 / master 向子代理发送消息）。
	 * 守卫：仅 running 中拒绝（并发保护）。cancelled / failed 均可续跑——
	 * cancelled 不是终态（`runSubagentLoop` 保证中断后消息序列合法）。
	 */
	async send(instruction: string, source: SubagentRunSource = 'master'): Promise<string> {
		if (this.status === 'running') {
			throw new Error(`subagent "${this.name}" is still running — wait for it to finish before sending a follow-up.`);
		}
		if (this.msgs.length === 0) {
			throw new Error(`subagent "${this.name}" has no message context.`);
		}
		return this.drive(instruction, source);
	}

	/** 取消当前运行（run 级信号，不影响主代理；运行结束后可再次 drive 续跑） */
	cancel(): void {
		this.runController?.abort();
	}

	/**
	 * 落盘状态（与 master 同构：meta.json + 逐轮 turn_0.json）。
	 * 每轮只存自己的 messages delta（不含 system——system 存 meta.systemPrompt）。
	 */
	toDiskState(): { meta: SubagentMeta; runs: SubagentRunRecord[] } {
		return {
			meta: {
				name: this.name,
				task: this.task,
				status: this.status,
				startMs: this.startMs,
				endMs: this.endMs,
				runCount: this.runs.length,
				systemPrompt: (this.msgs[0]?.role === 'system' ? (this.msgs[0].content as string) : ''),
			},
			runs: this.runs.map((run, idx) => ({
				runIndex: idx,
				userText: run.userText,
				source: run.source,
				messages: this.runMessages(run).filter((m) => m.role !== 'system'),
				entries: [...run.entries],
				status: run.status,
				error: run.error,
				created_at: run.startedAt,
				ended_at: run.endedAt,
			})),
		};
	}

	/** 转换为内存视图记录（TUI/渲染/列表用） */
	toRecord(): SubagentRecord {
		return {
			name: this.name,
			task: this.task,
			status: this.status,
			startMs: this.startMs,
			endMs: this.endMs,
			entries: this.entries,
			messages: this.msgs,
		};
	}

	/**
	 * 从落盘状态恢复会话（resume 场景）。
	 *
	 * 崩溃语义：盘上仍是 running（进程被杀）→ 该轮与整体状态都按 cancelled 恢复，
	 * 因为 cancelled 非终态，恢复后可直接 send 续跑；消息序列由 repairToolPairing
	 * 补齐悬空 tool_calls，保证是合法 API 序列。
	 */
	static fromDiskState(
		state: { meta: SubagentMeta; runs: SubagentRunRecord[] },
		opts: Omit<SubagentSessionOptions, 'name' | 'task' | 'systemPrompt'>,
	): SubagentSession {
		const { meta, runs } = state;
		const session = new SubagentSession({
			name: meta.name,
			task: meta.task,
			systemPrompt: meta.systemPrompt ?? '',
			...opts,
		});
		session.status = meta.status === 'running' ? 'cancelled' : meta.status;
		session.startMs = meta.startMs;
		session.endMs = meta.endMs;
		session.msgs = [{ role: 'system', content: meta.systemPrompt ?? '' }];
		for (const r of runs) {
			// 逐轮修复：tool_calls 与其结果同轮产生，所以悬空补齐必须落在同一轮内
			// （这样每轮的 msgStart/msgEnd 精确，不会因为插入占位消息而串轮）
			const delta = repairToolPairing(r.messages.filter((m) => m.role !== 'system'));
			const msgStart = session.msgs.length;
			session.msgs.push(...delta);
			session.runs.push({
				userText: r.userText,
				source: r.source,
				msgStart,
				msgEnd: session.msgs.length,
				entries: [...(r.entries ?? [])],
				// 运行中被中断的轮次按 cancelled 恢复（可续跑）
				status: r.status === 'running' ? 'cancelled' : r.status,
				error: r.error,
				startedAt: r.created_at,
				endedAt: r.ended_at,
			});
		}
		return session;
	}
}

/** 中断占位结果：崩在「assistant 已入队、工具未回填」时补的配对说明 */
const INTERRUPTED_TOOL_RESULT = 'Not executed: the run was interrupted (process exited before this tool returned).';

/**
 * 修复消息序列：为悬空 assistant.tool_calls 补配对 tool 消息。
 *
 * 运行中落盘可能停在「assistant(含 tool_calls) 已写盘、工具结果还没回来」的瞬间，
 * 直接拿这份消息续跑会被 API 拒绝（tool_calls 必须成对）。补一条中断说明既保持
 * 序列合法，也让模型知道当时发生了什么。
 */
export function repairToolPairing(msgs: Message[]): Message[] {
	const paired = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
	const out: Message[] = [];
	for (const m of msgs) {
		out.push(m);
		if (m.role !== 'assistant' || !m.tool_calls) continue;
		for (const tc of m.tool_calls) {
			if (!paired.has(tc.id)) {
				out.push({ role: 'tool', content: INTERRUPTED_TOOL_RESULT, tool_call_id: tc.id });
			}
		}
	}
	return out;
}

/** 截断单条 content（超限时尾部截断并标注） */
function truncateContent(content: string, maxChars: number = DIALOGUE_MAX_CONTENT_CHARS): string {
	if (content.length <= maxChars) return content;
	return `${content.slice(0, maxChars)}\n...(truncated, ${content.length - maxChars} chars omitted)`;
}
