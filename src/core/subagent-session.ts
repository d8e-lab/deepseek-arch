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
import type { SubagentRecord, SubagentRoundEntry } from '../types/subagent.js';
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
}

export class SubagentSession {
	readonly name: string;
	readonly task: string;
	status: SubagentStatus = 'running';
	/** 最终结果（由 messages 派生；见 lastContent） */
	result?: string;
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
				},
				this.chatDefaults,
			);
			this.msgs = messages;
			run.msgEnd = this.msgs.length;
			// 状态由循环显式返回（不再靠 result 字符串前缀猜测）
			run.status = status === 'cancelled' ? 'cancelled' : 'completed';
			this.status = run.status;
			this.result = this.lastContent()
				?? (status === 'cancelled' ? SUBAGENT_CANCELLED : '(subagent completed with no output)');
			this.endMs = Date.now();
			run.endedAt = this.endMs;
			return this.result;
		} catch (err) {
			run.status = 'failed';
			run.msgEnd = this.msgs.length;
			run.endedAt = Date.now();
			this.status = 'failed';
			this.result = `Error: ${err instanceof Error ? err.message : String(err)}`;
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
			messages: this.msgs,
		};
	}

	/**
	 * 从持久化记录恢复会话（resume 场景）。
	 * 仅恢复非运行中状态（运行中记录不会落盘）；恢复后可通过 send() 继续交互。
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
		if (record.messages && record.messages.length > 0) {
			session.msgs = [...record.messages];
		}
		// 老格式无轮次边界：把整段上下文折叠为单轮（user 输入取 task）
		session.runs.push({
			userText: record.task,
			source: 'task',
			msgStart: Math.min(1, session.msgs.length),
			msgEnd: session.msgs.length,
			entries: [...(record.entries ?? [])],
			status: session.status,
			startedAt: record.startMs,
			endedAt: record.endMs,
		});
		return session;
	}
}

/** 截断单条 content（超限时尾部截断并标注） */
function truncateContent(content: string, maxChars: number = DIALOGUE_MAX_CONTENT_CHARS): string {
	if (content.length <= maxChars) return content;
	return `${content.slice(0, maxChars)}\n...(truncated, ${content.length - maxChars} chars omitted)`;
}
