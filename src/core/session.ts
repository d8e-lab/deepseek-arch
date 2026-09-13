/**
 * SessionManager — 会话门面（Facade）
 *
 * 协调 ApiClient + Storage，封装对话生命周期：
 *   1. 创建/恢复会话
 *   2. 发送消息 → API 调用 → 自动持久化 turn JSON
 *   3. 构建请求消息队列（含历史轮次的 reasoning_content 以命中 kv-cache）
 *   4. 更新标题
 *   5. Agent loop（tool calling 支持）
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Storage } from './storage.js';
import type { ModelProvider, ChatOptions } from './model-provider.js';
import { yieldEventLoop } from '../utils/event-loop.js';
import { turnUserContent, turnAssistantContent } from '../utils/turn-utils.js';
import { appendCacheLog } from './cache-log.js';
import type {
	Message,
	Session,
	SessionMeta,
	TurnRecord,
	TokenUsage,
	ChatCompletionResponse,
	StreamChunk,
	StreamEvent,
	ToolDefinition,
	RoundUsage,
} from '../types/index.js';

// Re-export for backward compatibility (chat-ui.ts imports from here)
export type { StreamEvent };
import type { Tool, ToolCallRecord } from '../tools/types.js';
import type { ToolCall, ToolCallDelta } from '../types/api.js';
import { getAllTools } from '../tools/index.js';
import { formatSubagentTrace } from '../tools/subagent-trace.js';
import { MemoryStore, type MemoryMaintenanceResult } from './memory-store.js';
import { MemoryRecall } from './memory-recall.js';
import { MemoryInjector, MEMORY_LISTING_TAG } from './memory-inject.js';
import { MemoryAgent } from './memory-agent.js';
import { createMemoryStore } from './memory-service.js';
import { activateSkillsForPaths, extractPathsFromToolCall } from './skill.js';
import {
	MAX_RESTORE_FILES,
	buildCompactMessages,
	buildCompactTurn,
	buildFileRestoreBlock,
	buildPlanBlock,
	buildSkillsBlock,
	estimateTokens,
	extractReadFiles,
	generateSummary,
} from './compact.js';


/** 子代理 System Prompt 追加内容（行为约束） */
const SUBAGENT_APPEND_PROMPT = `
## Subagent Mode

You are running as a subagent delegated by a master agent. Key constraints:

- Execute the assigned sub-task and return a concise result.
- You have access to shell, file, and browser tools.
- Do NOT ask the user questions — there is no interactive user in this context.
- Do NOT spawn sub-subagents, use wait, or list_subagents (these tools are not available to you).
- Do NOT use the skill tool or save_plan (not available to subagents).
- If you cannot complete the task, explain why and return what you have.
- Keep output focused: the master agent needs your result, not a conversation.
- You may receive follow-up instructions after reporting a result. When given a follow-up,
  continue from your previous context — do NOT restart the task from scratch.`;

/** 后台子代理会话（方案 B 全状态化：消息上下文 + 实时输出 + 可续跑） */
export type { SubagentSession } from './subagent-session.js';
import { SubagentSession as SubagentSessionImpl } from './subagent-session.js';
import type { SubagentRecord } from '../types/subagent.js';

/** 会话标题最大字符数（用户第一句话） */
export const SESSION_TITLE_MAX_CHARS = 20;

/**
 * 从用户首条消息派生会话标题：
 * 1. 剥离 TUI 注入的 [shell_start]...[shell_end] 上下文块（仅模型可见）
 * 2. 取第一条非空行并压缩连续空白
 * 3. 截断到 SESSION_TITLE_MAX_CHARS 字符（按 Unicode 码点，不加省略号）
 * 返回空串表示无可用标题。
 */
export function deriveSessionTitle(content: string, maxChars = SESSION_TITLE_MAX_CHARS): string {
	let text = content;
	const shellEnd = text.indexOf('[shell_end]');
	if (shellEnd >= 0) {
		text = text.slice(shellEnd + '[shell_end]'.length);
	}
	const firstLine = text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length > 0) ?? '';
	const normalized = firstLine.replace(/\s+/g, ' ');
	const chars = Array.from(normalized);
	return chars.length <= maxChars ? normalized : chars.slice(0, maxChars).join('');
}

/** 用户直发子代理后的待投递通知（内容在投递时由「对话投影」生成，见 drainNotices） */
interface SubagentNotice {
	/** 子代理名 */
	name: string;
	/** 结束状态 */
	status: string;
	/** 本次运行耗时 ms */
	elapsedMs: number;
	/** 入队时间 ms */
	at: number;
}

/** `[memory]` 配置在会话层的投影（由 CLI 从 config.toml 读取后注入） */
export interface MemorySessionConfig {
	enabled?: boolean;
	inject?: boolean;
	maxInjectTokens?: number;
	deltaInjectTokens?: number;
	masterMinConfidence?: number;
	recallModel?: string;
	agentModel?: string;
	agentOnTurnEnd?: boolean;
	agentMinIntervalSec?: number;
	agentMaxWritesPerRun?: number;
	agentMaxInputTurns?: number;
	agentMaxInputTokens?: number;
	agentTimeoutMs?: number;
	notifyReadUpdates?: boolean;
	/** LRU 维护总开关（默认 true） */
	lruEnabled?: boolean;
	/** 闲置超过该天数 → 降一级（默认 90） */
	lruDecayDays?: number;
	/** 累计使用达到该次数且最近有使用 → 升一级（默认 2） */
	lruPromoteUses?: number;
	/** 候选池中闲置超过该天数 → 归档（默认 180） */
	lruArchiveDays?: number;
	/** 显式注入存储（测试用；省略时按当前工作区构造） */
	store?: MemoryStore;
}

/** 记忆运行时（store + 注入器 + 后台归纳代理） */
export interface MemoryRuntime {
	store: MemoryStore;
	injector: MemoryInjector;
	agent: MemoryAgent;
	config: Required<Omit<MemorySessionConfig, 'store'>>;
}

function stripMemoryListing(content: string): string {
	const re = new RegExp(`\\n*<${MEMORY_LISTING_TAG}>[\\s\\S]*?</${MEMORY_LISTING_TAG}>\\n*`, 'g');
	return content.replace(re, '').trimEnd();
}

export class SessionManager {
	private storage: Storage;
	private provider: ModelProvider;
	private session: Session | null = null;
	private systemPrompt: Message | null = null;
	private tools: Tool[] = [];
	private _subagentAsync: boolean = false;
	/** 实例级：子代理会话集合（方案 B：SubagentSession 全状态化，跨 sendMessageStream 存活） */
	private subagents = new Map<string, SubagentSessionImpl>();
	/**
	 * 实例级：已「消费」的子代理名集合。
	 * 消费 = master 已把该子代理的最新产出纳入自己的上下文（wait 取回 / 同步拿到结果），
	 * 因此不必再在状态块里重复播报（这正是「反复通知」的根因）。
	 * 注意：名称只表达「当前最新产出是否已读」，与「每个结果只能取一次」无关——
	 * wait 始终可重复读取。
	 */
	private consumedSubagents = new Set<string>();
	/**
	 * 待投递的「用户↔子代理」通知队列（需求 2）。
	 * 用户在 TUI 里直接给子代理发消息 → 运行结束后入队，投递一次即出队。
	 */
	private pendingNotices: SubagentNotice[] = [];
	/** 子代理 token 累积（O-1：并入主会话 usage 入账） */
	private subagentUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
	/** 生成参数默认值（temperature/max_tokens/top_p/thinking/reasoning_effort），
	 *  从配置 defaults 读取，发送消息与子代理调用时透传给 provider */
	private chatDefaults: ChatOptions = {};
	/** 子代理落盘串行链（同一子代理的写入按序执行，避免并发写坏文件） */
	private subagentWriteChain = new Map<string, Promise<void>>();
	/** 记忆运行时（未配置时为 null → 完全不介入，测试与旧行为不受影响） */
	private memory: MemoryRuntime | null = null;
	/** 「已更新 N 条记忆」提示回调（TUI 注册；headless 走 stderr） */
	private memoryNoticeCallback: ((count: number, slugs: string[]) => void) | null = null;
	/** 「到期提醒」提示回调（TUI 注册） */
	private memoryDueCallback: ((slugs: string[]) => void) | null = null;
	/** 自动 compact 配置：上下文超阈值时自动压缩（默认开启，70% of 1M tokens） */
	private autoCompact = {
		enabled: true,
		threshold: 0.7,
		contextWindow: 1_000_000,
	};

	constructor(storage: Storage, provider: ModelProvider, tools?: Tool[]) {
		this.storage = storage;
		this.provider = provider;
		if (tools) this.tools = tools;
		// 锁定会话基准目录，供所有工具使用
		if (!process.env.DEEPSEEK_ARCH_SESSION_CWD) {
			process.env.DEEPSEEK_ARCH_SESSION_CWD = process.cwd();
		}
	}

	/** 设置 system prompt（每次请求前插入消息队列首位） */
	setSystemPrompt(prompt: Message | null): void {
		this.systemPrompt = prompt;
	}

	// ─── 会话生命周期 ──────────────────────────────

	/** 创建新会话并持久化 meta.json，同时保存 system prompt 供调试检查 */
	async startNewSession(title = ''): Promise<SessionMeta> {
		const meta = await this.storage.createSession(title);
		this.session = {
			meta,
			turns: [],
			systemPrompt: this.systemPrompt?.content,
		};
		// 关联会话 ID 到 provider（请求镜像监听用）
		this.provider.setSessionId?.(meta.id);

		// 记忆清单注入 system prompt（只在会话创建时做一次：system prompt 在会话内冻结 → 零缓存代价，
		// 代价只是"可能过期"，由会话内的变化提醒补齐）
		// 前置：先做一次 LRU 维护（低频、确定性），保证下面注入的清单就是结算后的结果
		if (this.memory && this.memory.config.inject && this.systemPrompt?.content) {
			try {
				await this.maintainMemory();
				const { block } = await this.memory.injector.buildListingBlock();
				if (block) {
					this.systemPrompt = { role: 'system', content: `${this.systemPrompt.content}\n\n${block}` };
				}
			} catch { /* 清单构建失败不阻塞建会话 */ }
		}

		// 将完整 system prompt 写入会话目录，方便调试 kv-cache 命中率
		if (this.systemPrompt?.content) {
			const dir = this.storage.sessionDir(meta.id);
			await writeFile(join(dir, 'system-prompt.txt'), this.systemPrompt.content, 'utf-8');
		}

		return meta;
	}

	/** 恢复已有会话（从文件加载所有 turn，恢复 system prompt 以命中 kv-cache） */
	async resumeSession(id: string): Promise<Session> {
		const session = await this.storage.getSession(id);
		if (!session) throw new Error(`会话不存在: ${id}`);
		this.session = session;
		// 关联会话 ID 到 provider（请求镜像监听用）
		this.provider.setSessionId?.(session.meta.id);
		// 使用持久化的 system prompt 覆盖当前构建的（保证消息前缀与缓存一致）
		if (session.systemPrompt) {
			this.systemPrompt = { role: 'system', content: session.systemPrompt };
		}
		// 快照里的清单就是模型当前看到的那份 → 播种"已见"集合，之后只提醒差异（避免"全部新增"误报）
		this.memory?.injector.seedFromSystemPrompt(session.systemPrompt);

		// 恢复子代理会话（方案 B：磁盘记录 → SubagentSession，可继续查看/交互）
		await this.restoreSubagents(session.meta.id);

		// 恢复浏览器到上次访问的 URL（如果浏览器工具可用）
		this._restoreBrowserUrl(session);

		return session;
	}

	/**
	 * 尝试恢复浏览器到上次访问的 URL
	 * 浏览器工具不可用时静默跳过
	 */
	private async _restoreBrowserUrl(session: Session): Promise<void> {
		if (!session.meta.lastBrowserUrl) return;
		try {
			const { getBrowserState } = await import('../tools/browser-state.js');
			const state = getBrowserState();
			await state.restoreUrl(session.meta.lastBrowserUrl);
		} catch {
			/* 浏览器工具不可用（未安装 playwright），静默跳过 */
		}
	}

	/** 获取当前会话 */
	getSession(): Session | null {
		return this.session;
	}

	/** 获取当前会话 ID */
	getSessionId(): string | null {
		return this.session?.meta.id ?? null;
	}

	/**
	 * 退出清理：0 轮空会话不落盘。
	 * 会话未产生任何对话轮次（如进入即退出）时删除磁盘目录并清空活跃会话；
	 * 已有轮次或无可删会话时返回 false，不做任何操作。
	 */
	async discardEmptySession(): Promise<boolean> {
		if (!this.session) return false;
		if (this.session.meta.turnCount > 0 || this.session.turns.length > 0) return false;
		const ok = await this.storage.deleteSession(this.session.meta.id);
		if (ok) this.session = null;
		return ok;
	}

	/** 切换默认模型 */
	setModel(model: string): void {
		this.provider.setModel?.(model);
	}

	/** 设置生成参数默认值（temperature/max_tokens/top_p/thinking/reasoning_effort），
	 *  发送消息与子代理调用时透传给 provider。 */
	setChatDefaults(defaults: ChatOptions): void {
		this.chatDefaults = { ...defaults };
	}

	/** 设置自动 compact 配置（上下文超阈值时自动压缩，默认开启 70%/1M） */
	setAutoCompact(config: { enabled?: boolean; threshold?: number; contextWindow?: number }): void {
		if (config.enabled !== undefined) this.autoCompact.enabled = config.enabled;
		if (config.threshold !== undefined && config.threshold > 0 && config.threshold < 1) {
			this.autoCompact.threshold = config.threshold;
		}
		if (config.contextWindow !== undefined && config.contextWindow > 0) {
			this.autoCompact.contextWindow = config.contextWindow;
		}
	}

	/** 设置子代理异步模式 */
	setSubagentAsync(enabled: boolean): void {
		this._subagentAsync = enabled;
	}

	/** 获取子代理异步模式 */
	getSubagentAsync(): boolean {
		return this._subagentAsync;
	}

	/**
	 * 配置记忆机制（由 CLI 从 config.toml 的 `[memory]` 段读取后调用）。
	 * 不调用 = 记忆完全不介入（测试与旧行为不受影响）。
	 */
	configureMemory(cfg: MemorySessionConfig): void {
		const config = {
			enabled: cfg.enabled ?? true,
			inject: cfg.inject ?? true,
			maxInjectTokens: cfg.maxInjectTokens ?? 800,
			deltaInjectTokens: cfg.deltaInjectTokens ?? 200,
			masterMinConfidence: cfg.masterMinConfidence ?? 2,
			recallModel: cfg.recallModel ?? 'deepseek-v4-flash',
			agentModel: cfg.agentModel ?? 'deepseek-v4-flash',
			agentOnTurnEnd: cfg.agentOnTurnEnd ?? true,
			agentMinIntervalSec: cfg.agentMinIntervalSec ?? 30,
			agentMaxWritesPerRun: cfg.agentMaxWritesPerRun ?? 3,
			agentMaxInputTurns: cfg.agentMaxInputTurns ?? 3,
			agentMaxInputTokens: cfg.agentMaxInputTokens ?? 6000,
			agentTimeoutMs: cfg.agentTimeoutMs ?? 90_000,
			notifyReadUpdates: cfg.notifyReadUpdates ?? true,
			lruEnabled: cfg.lruEnabled ?? true,
			lruDecayDays: cfg.lruDecayDays ?? 90,
			lruPromoteUses: cfg.lruPromoteUses ?? 2,
			lruArchiveDays: cfg.lruArchiveDays ?? 180,
		};
		if (!config.enabled) {
			this.memory = null;
			return;
		}
		const store = cfg.store ?? createMemoryStore({ masterMinConfidence: config.masterMinConfidence });
		const recall = new MemoryRecall({ provider: this.provider, model: config.recallModel });
		this.memory = {
			store,
			injector: new MemoryInjector({
				store,
				recall,
				maxInjectTokens: config.maxInjectTokens,
				deltaInjectTokens: config.deltaInjectTokens,
			}),
			agent: new MemoryAgent({
				provider: this.provider,
				store,
				model: config.agentModel,
				maxInputTurns: config.agentMaxInputTurns,
				maxInputTokens: config.agentMaxInputTokens,
				maxWritesPerRun: config.agentMaxWritesPerRun,
				maxToolCalls: 8,
				timeoutMs: config.agentTimeoutMs,
				minIntervalSec: config.agentMinIntervalSec,
				sessionId: this.session?.meta.id,
			}),
			config,
		};
	}

	/** 记忆运行时（未启用返回 null） */
	getMemory(): MemoryRuntime | null {
		return this.memory;
	}

	/**
	 * LRU 维护：按使用情况主动升降级 + 归档（两层都跑）。
	 *
	 * 调用时机：
	 *   - **会话创建时**（`startNewSession`，在构建清单**之前**）→ 保证注入的清单就是结算后的结果；
	 *   - `/memory gc` 手动触发（可 `--dry-run` 预览）。
	 * 幂等、确定性：同一天跑多次结果相同（升降级都要求跨越天数/次数阈值）。
	 */
	async maintainMemory(opts: { dryRun?: boolean } = {}): Promise<MemoryMaintenanceResult[]> {
		const mem = this.memory;
		if (!mem || !mem.config.lruEnabled) return [];
		const lru = {
			enabled: mem.config.lruEnabled,
			decayDays: mem.config.lruDecayDays,
			promoteUses: mem.config.lruPromoteUses,
			archiveDays: mem.config.lruArchiveDays,
		};
		const out: MemoryMaintenanceResult[] = [];
		for (const scope of ['project', 'global'] as const) {
			try {
				out.push(await mem.store.reconcile(scope, lru, opts.dryRun));
			} catch { /* 维护失败不阻塞会话创建；store 内部已尽力审计 */ }
		}
		return out;
	}

	/** 「已更新记忆」提示回调（TUI / headless 注册） */
	setMemoryNoticeCallback(cb: ((count: number, slugs: string[]) => void) | null): void {
		this.memoryNoticeCallback = cb;
	}

	/** 「到期提醒」回调（TUI 注册；提醒块本身已注入给模型） */
	setMemoryDueCallback(cb: ((slugs: string[]) => void) | null): void {
		this.memoryDueCallback = cb;
	}

	/**
	 * 重建 system prompt 里的记忆清单并同步重写会话快照（`/memory refresh` 与 compact 后调用）。
	 * 必须在"前缀本来就要变"的时刻调用（新会话 / compact / 用户显式刷新），否则会作废整段历史前缀。
	 * @returns 是否发生了变化
	 */
	async refreshMemoryPrompt(): Promise<boolean> {
		const mem = this.memory;
		if (!mem || !this.session || !this.systemPrompt) return false;
		const base = stripMemoryListing(this.systemPrompt.content);
		const { block } = await mem.injector.buildListingBlock();
		const content = block ? `${base}\n\n${block}` : base;
		if (content === this.systemPrompt.content) return false;
		this.systemPrompt = { role: 'system', content };
		try {
			await writeFile(
				join(this.storage.sessionDir(this.session.meta.id), 'system-prompt.txt'),
				content,
				'utf-8',
			);
		} catch { /* 快照写失败不影响本轮（resume 时会回退旧文本） */ }
		return true;
	}

	/** 获取子代理会话列表（TUI 详情/实时视图用） */
	listSubagents(): SubagentSessionImpl[] {
		return [...this.subagents.values()];
	}

	/** 获取指定子代理会话 */
	getSubagent(name: string): SubagentSessionImpl | undefined {
		return this.subagents.get(name);
	}

	/** 获取全部子代理记录（含 resume 恢复的） */
	listSubagentRecords(): SubagentRecord[] {
		return [...this.subagents.values()].map((s) => s.toRecord());
	}

	/** 获取指定子代理记录 */
	getSubagentRecord(name: string): SubagentRecord | undefined {
		return this.subagents.get(name)?.toRecord();
	}

	/**
	 * 从磁盘恢复子代理会话（completed/failed/cancelled 可继续 send 交互）。
	 * 崩溃残留的 running 按 cancelled 恢复（非终态，可续跑）。
	 * 恢复的历史子代理直接标为已消费——否则 resume 后状态块会立刻重复播报旧产出。
	 */
	private async restoreSubagents(sessionId: string): Promise<void> {
		try {
			const names = await this.storage.listSubagentRecords(sessionId);
			for (const n of names) {
				const state = await this.storage.loadSubagentState(sessionId, n);
				if (!state) continue;
				const session = SubagentSessionImpl.fromDiskState(state, {
					provider: this.provider,
					tools: getAllTools(),
					chatDefaults: this.chatDefaults,
					onUsage: (u: TokenUsage) => {
						this.subagentUsage.prompt_tokens += u.prompt_tokens;
						this.subagentUsage.completion_tokens += u.completion_tokens;
						this.subagentUsage.total_tokens += u.total_tokens;
					},
					onProgress: () => this.queuePersistSubagent(n),
				});
				this.subagents.set(n, session);
				this.consumedSubagents.add(n);
			}
		} catch {
			/* 恢复失败不阻塞 resume */
		}
	}

	/**
	 * 执行上下文压缩（compact）。
	 *
	 * 流程：等待 subagent 结束 → 生成结构化摘要（独立模型调用）→
	 * 构建文件/plan/skills 重注入块 → 开启新分代写入摘要轮 → 更新内存状态。
	 *
	 * compact 后 master agent 请求上下文 = 摘要 + 重注入块 + 后续轮次；
	 * 磁盘分代文件保留全部历史（用户视角可回查）。
	 */
	async compactContext(): Promise<{
		gen: number;
		compressedTurns: number;
		restoredFiles: number;
		restoredTokens: number;
		summaryPreview: string;
	}> {
		if (!this.session) throw new Error('无活动会话');
		const turns = this.session.turns;
		if (turns.length === 0) throw new Error('会话为空，无需压缩');

		// Phase 1：等待所有 subagent 结束（compact 前必须收敛后台任务）
		const pending = [...this.subagents.values()].filter((s) => s.isRunning);
		if (pending.length > 0) {
			await Promise.all(pending.map((s) => s.promise));
		}

		const cwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();

		// Phase 2：生成结构化摘要（独立非流式调用，失败有 fallback）
		const summary = await generateSummary(this.provider, turns);

		// Phase 3：构建重注入块（文件 / plan / skills）
		const readFiles = extractReadFiles(turns);
		const restore = await buildFileRestoreBlock(readFiles, cwd);
		const plan = await buildPlanBlock(turns, cwd);
		const skills = await buildSkillsBlock(turns);

		// 组装消息序列并开启新分代
		const messages = buildCompactMessages(summary, restore.text, plan.text, skills.text);
		const compactTurn = buildCompactTurn(summary, messages);
		const gen = await this.storage.newGeneration(this.session.meta.id, compactTurn);

		// 更新内存状态（追加摘要轮，后续 buildMessages 自动从它开始）
		this.session.turns.push(compactTurn);
		this.session.meta.turnCount = this.session.turns.length;
		this.session.meta.totalCost = this.session.turns.reduce((s, t) => s + t.cost_rmb, 0);
		this.session.meta.currentGen = gen;

		// R7/R11：compact 是"前缀本来就要变"的时刻 → 顺便重建 system prompt 里的记忆清单并重写快照
		// （否则清单会一直停留在会话创建时的状态）
		await this.refreshMemoryPrompt().catch(() => { /* 失败不阻塞 compact */ });

		return {
			gen,
			compressedTurns: turns.filter((t) => t.type !== 'compact').length,
			restoredFiles: Math.min(readFiles.length, MAX_RESTORE_FILES),
			restoredTokens: restore.tokenCount,
			summaryPreview: summary.length > 120 ? `${summary.slice(0, 120)}…` : summary,
		};
	}

	/**
	 * 运行子代理循环（供 subagent_spawn 工具调用）
	 *
	 * 子代理使用独立消息上下文、受限工具集（无 spawn/wait/list/plan），
	 * 复用当前 provider 和 system prompt（追加子代理行为约束）。
	 *
	 * I-1：子代理内部创建独立 AbortController，不接收/不联动主 agent 的 signal——
	 * 用户中断主 agent 不会连坐杀死后台子代理；取消需显式调用 cancelSubagent()。
	 * M-1：通过 callbacks 将每轮输出写入 SubagentStore，完成后持久化记录。
	 */
	async runSubagent(name: string, task: string): Promise<string> {
		const session = this.createSubagentSession(name, task);
		this.subagents.set(name, session);

		try {
			const result = await session.drive();
			await this.flushPersistSubagent(name);
			return result;
		} catch (err) {
			// drive 内部已标 failed 并 rethrow；持久化失败态并返回错误字符串（兼容旧行为）
			await this.flushPersistSubagent(name).catch(() => {});
			return `Error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/** 创建子代理会话（共享逻辑：runSubagent / resume 恢复用） */
	private createSubagentSession(name: string, task: string): SubagentSessionImpl {
		const subagentTools = getAllTools(); // 不含 subagent 管理工具
		const basePrompt = this.systemPrompt?.content ?? '';
		const subagentPrompt = basePrompt + SUBAGENT_APPEND_PROMPT;
		return new SubagentSessionImpl({
			name,
			task,
			systemPrompt: subagentPrompt,
			provider: this.provider,
			tools: subagentTools,
			chatDefaults: this.chatDefaults,
			// O-1：子代理 token 累积入账
			onUsage: (usage) => {
				this.subagentUsage.prompt_tokens += usage.prompt_tokens;
				this.subagentUsage.completion_tokens += usage.completion_tokens;
				this.subagentUsage.total_tokens += usage.total_tokens;
			},
			// P-1：每轮增量落盘（运行中/取消/崩溃都留下轨迹）
			onProgress: () => this.queuePersistSubagent(name),
		});
	}

	/**
	 * 每轮增量落盘（与 master 每轮 updateLastTurn 同构）。
	 * 运行中也会被 `onProgress` 触发；写入串行化以避免并发写坏同一文件。
	 */
	private queuePersistSubagent(name: string): void {
		const prev = this.subagentWriteChain.get(name) ?? Promise.resolve();
		const next = prev.then(() => this.persistSubagent(name)).catch(() => { /* 落盘失败不阻塞运行 */ });
		this.subagentWriteChain.set(name, next);
	}

	/**
	 * 落盘并等待写入链完成（运行结束/续跑结束后调用）。
	 * 必须走同一条链：否则完成态写入可能与仍在途的进度写入交错，落盘状态回退。
	 */
	private async flushPersistSubagent(name: string): Promise<void> {
		this.queuePersistSubagent(name);
		await this.subagentWriteChain.get(name);
	}

	/** 持久化子代理记录（meta.json + turn_0.json，整份重写；含完整消息上下文） */
	private async persistSubagent(name: string): Promise<void> {
		if (!this.session) return;
		const session = this.subagents.get(name);
		if (!session) return;
		try {
			const { meta, runs } = session.toDiskState();
			await this.storage.saveSubagentState(this.session.meta.id, name, meta, runs);
		} catch { /* 持久化失败不阻塞 */ }
	}

	/**
	 * 向子代理发送消息（追加指令并续跑）。
	 * 用户（TUI，source='user'）与 master agent（subagent_send 工具，source='master'）共用入口。
	 * 守卫：running 中拒绝（并发保护）；cancelled / failed 均可续跑（cancelled 非终态）。
	 *
	 * 消费语义（需求 1/2）：
	 *  - master 直发：结果同步返回 → 立即标已消费（不再重复通知）
	 *  - 用户直发：master 不知情 → 入队一条通知（含 user 指令与 subagent 内容的对话投影），
	 *    投递一次即出队；同时标已消费以免状态块重复播报同一件事
	 */
	async sendToSubagent(
		name: string,
		instruction: string,
		source: 'user' | 'master' = 'master',
	): Promise<string> {
		const session = this.subagents.get(name);
		if (!session) {
			throw new Error(`Subagent "${name}" not found. Use list_subagents to check.`);
		}
		const startMs = Date.now();
		const result = await session.send(instruction, source);
		await this.flushPersistSubagent(name);
		this.consumedSubagents.add(name);
		if (source === 'user') {
			this.enqueueNotice(name, session.status, Date.now() - startMs);
		}
		return result;
	}

	/** 入队一条「用户↔子代理」通知（投递一次后出队） */
	private enqueueNotice(name: string, status: string, elapsedMs: number): void {
		this.pendingNotices.push({ name, status, elapsedMs, at: Date.now() });
	}

	/**
	 * 取出全部待投递通知并格式化为模型可读文本（无待投递时返回 null）。
	 *
	 * 两个投递点共用本方法（先取者得，保证只投递一次、不会每轮重复拼接）：
	 *  - Hook A：agent loop 中挂到本轮下一个 tool result 尾部（master 正在干活时最快送达）
	 *  - Hook B：开轮时兜底注入 agentMessages（本轮没有工具调用也能送达）
	 */
	private drainNotices(): string | null {
		if (this.pendingNotices.length === 0) return null;
		const notices = this.pendingNotices.splice(0, this.pendingNotices.length);
		const blocks = notices.map((n) => {
			const sub = this.subagents.get(n.name);
			const secs = n.elapsedMs / 1000;
			const elapsed = secs < 60
				? `${secs.toFixed(1)}s`
				: `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
			const dialogue = sub ? sub.renderDialogue() : '(subagent context unavailable)';
			return [
				`subagent "${n.name}" (${n.status}, ${elapsed}) — the user sent it instructions directly in the subagent view.`,
				'Conversation between the user and that subagent (no thinking, no tool traces):',
				dialogue,
			].join('\n');
		});
		return [
			'<subagent-notification>',
			'[Subagent Notification — user ↔ subagent]',
			'The following happened outside your own tool calls. Take it into account in your plan;',
			'use wait("<name>") to read (or re-read) a subagent\'s output at any time,',
			'and subagent_trace("<name>") to inspect the tools it ran.',
			'',
			blocks.join('\n\n'),
			'</subagent-notification>',
		].join('\n');
	}

	// ─── 记忆（memory）────────────────────────────────

	/**
	 * 本轮的记忆注入（落盘进 agentMessages）：
	 *  ① 到期提醒（remindAt 已到）② 模型读过的条目被更新 ③ 清单发生变化
	 * 落盘的原因：成为历史的一部分 → 下一轮前缀不断（不落盘会重算上一轮内容）。
	 */
	private async injectMemoryUpdates(agentMessages: Message[]): Promise<void> {
		const mem = this.memory;
		if (!mem || !this.session) return;
		try {
			const blocks: string[] = [];

			// ① 到期提醒（一次性：发出后清空该条目的 remindAt）
			const due = await mem.injector.buildDueBlock();
			if (due) {
				blocks.push(due.block);
				try {
					this.memoryDueCallback?.(due.slugs);
				} catch { /* UI 回调失败不影响注入 */ }
			}

			// ② 读过的条目被更新
			if (mem.config.notifyReadUpdates) {
				const readBlock = await mem.injector.buildReadUpdateBlock(this.collectReadMemorySlugs());
				if (readBlock) blocks.push(readBlock);
			}

			// ③ 清单变化（新增/更新/移除）
			const updateBlock = await mem.injector.buildUpdateBlock();
			if (updateBlock) blocks.push(updateBlock);

			if (blocks.length === 0) return;

			const content = blocks.join('\n\n');
			agentMessages.push({ role: 'user', content });
			await mem.store.audit({
				kind: 'inject',
				at: new Date().toISOString(),
				scope: 'project',
				sid: this.session.meta.id,
				mode: 'delta',
				tokens: estimateTokens(content),
			});
		} catch { /* 注入失败不阻塞本轮 */ }
	}

	/** 上一轮（全部历史）里 memory_read 读过的条目 slug（用于"读过的条目被更新"提醒） */
	private collectReadMemorySlugs(): string[] {
		const slugs = new Set<string>();
		const turns = this.session?.allTurns ?? this.session?.turns ?? [];
		for (const turn of turns) {
			for (const tc of turn.tool_calls ?? []) {
				if (tc.name !== 'memory_read') continue;
				const raw = String((tc.arguments as Record<string, unknown> | undefined)?.path ?? '').trim();
				if (!raw) continue;
				const name = raw.replace(/^(global|project):/, '').split('/').pop() ?? '';
				if (name.endsWith('.md')) slugs.add(name.replace(/\.md$/, ''));
			}
		}
		return [...slugs];
	}

	/**
	 * 后台记忆归纳（与主 agent 本轮并发，不阻塞、异常不打扰）：
	 * 输入 = 游标之后的「用户消息 + 助手最终回复」+ 本轮用户消息；游标成功后推进。
	 */
	private async maybeRunMemoryAgent(currentUser: string): Promise<void> {
		const mem = this.memory;
		if (!mem || !mem.config.agentOnTurnEnd || !this.session) return;
		try {
			const state = await mem.store.getState('project');
			const cursor = Number(state.lastExtractedTurnId ?? '0') || 0;
			const all = this.session.allTurns ?? this.session.turns;
			const window = all.slice(cursor).map((t, i) => ({
				user: turnUserContent(t),
				assistant: turnAssistantContent(t),
				turnId: String(cursor + i + 1),
			}));
			const masterWrote = (all[all.length - 1]?.tool_calls ?? []).some((tc) => tc.name === 'memory_write');
			const result = await mem.agent.run({
				turns: window,
				currentUser,
				masterWrote,
				nextCursor: String(all.length),
			});
			if (result.status === 'done' && result.writes.length > 0) {
				this.memoryNoticeCallback?.(result.writes.length, result.writes.map((w) => w.slug));
			}
		} catch { /* agent 内部已记审计；此处只保证不打扰主流程 */ }
	}

	/**
	 * 取消一个或多个子代理（'all' 取消全部运行中的）。
	 * 主代理通过 subagent_cancel 工具、用户通过 /subagent_cancel 命令调用。
	 * @returns 实际被取消的子代理名列表
	 */
	cancelSubagent(name: string): string[] {
		const targets = name === 'all'
			? [...this.subagents.values()].filter((s) => s.isRunning).map((s) => s.name)
			: (this.subagents.has(name) ? [name] : []);
		for (const n of targets) {
			this.subagents.get(n)?.cancel();
		}
		return targets;
	}

	/** 更新会话标题 */
	async setTitle(title: string): Promise<void> {
		if (!this.session) return;
		await this.storage.updateSessionTitle(this.session.meta.id, title);
		this.session.meta.title = title;
		this.session.meta.updated_at = new Date().toISOString();
	}

	// ─── Tool 辅助 ──────────────────────────────────

	/** 将 Tool[] 转为 API 所需的 ToolDefinition[] */
	private toolsToDefinitions(): ToolDefinition[] {
		return this.tools.map((t) => ({
			type: 'function' as const,
			function: {
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			},
		}));
	}

	/** 将流式 tool_calls delta 累积到 ToolCall[] 中 */
	private accumulateToolCalls(
		acc: ToolCall[],
		deltas: ToolCallDelta[],
	): void {
		for (const delta of deltas) {
			// 找到或创建对应 index 的 ToolCall
			while (acc.length <= delta.index) {
				acc.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
			}
			const tc = acc[delta.index];
			if (delta.id) tc.id = delta.id;
			if (delta.function?.name) tc.function.name += delta.function.name;
			if (delta.function?.arguments) tc.function.arguments += delta.function.arguments;
		}
	}

	/**
	 * 尝试获取浏览器当前 URL（浏览器工具不可用时返回 undefined）
	 */
	private async _browserLastUrl(): Promise<string | undefined> {
		try {
			const { getBrowserState } = await import('../tools/browser-state.js');
			const url = getBrowserState().getLastUrl();
			return url || undefined;
		} catch {
			return undefined;
		}
	}

	// ─── 消息收发 ─────────────────────────────────

	/**
	 * 发送用户消息并返回本轮完整记录
	 *
	 * 自动构建消息队列（system prompt → 历史 turns → 当前消息），
	 * 调用 API 后持久化 turn JSON 到文件系统。
	 */
	async sendMessage(
		userContent: string,
	): Promise<{ turn: TurnRecord; response: ChatCompletionResponse }> {
		if (!this.session) {
			throw new Error('未创建会话——请先调用 startNewSession() 或 resumeSession()');
		}

		// 构建完整消息队列
		const messages = this.buildMessages(userContent);

		// 调用 API（带上 tools）
		const options = this.tools.length > 0 ? { tools: this.toolsToDefinitions() } : undefined;
		const response = await this.provider.chat(messages, options);

		const choice = response.choices[0];
		const assistantMsg = choice?.message;
		if (!assistantMsg) {
			throw new Error('模型返回空响应');
		}

		// 提取 usage（API 不保证一定有）
		const usage: TokenUsage = response.usage ?? {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		};

		// 费用暂为 0（Phase 7 TokenCalculator 实现后补全）
		const costRmb = 0;

		// 持久化 turn JSON
		const browserUrl = await this._browserLastUrl();
		const turn = await this.storage.saveTurn(
			this.session.meta.id,
			{ role: 'user', content: userContent },
			{
				id: response.id,
				role: 'assistant',
				content: assistantMsg.content,
				reasoning_content: assistantMsg.reasoning_content,
			},
			usage,
			costRmb,
			undefined,
			undefined,
			undefined,
			undefined,
			browserUrl,
		);

		// 更新内存中的会话
		this.session.turns.push(turn);
		this.session.meta.turnCount = this.session.turns.length;
		this.session.meta.updated_at = turn.created_at;

		return { turn, response };
	}

	/**
	 * 流式发送用户消息（支持 agent loop + tool calling）
	 *
	 * 当 tools 不为空时，模型可能返回 tool_calls。执行工具后将结果发回模型，
	 * 循环直到模型返回纯文本或无更多工具调用。
	 *
	 * 通过 onEvent 回调推送增量内容，支持外部 AbortSignal 中断。
	 * 流式完成后自动持久化 turn；中断时保存不完整轮次（interrupted=true）。
	 *
	 * @returns 完整的 TurnRecord（正常完成），或 null（中断/错误）
	 */
	async sendMessageStream(
		userContent: string,
		onEvent: (event: StreamEvent) => void,
		signal?: AbortSignal,
		onConfirm?: (toolName: string, params: Record<string, unknown>) => Promise<boolean>,
	): Promise<TurnRecord | null> {
		if (!this.session) {
			throw new Error('未创建会话——请先调用 startNewSession() 或 resumeSession()');
		}

		// 新会话（无标题且无轮次）：以第一条用户消息作为会话标题（≤20 字）
		if (!this.session.meta.title && this.session.meta.turnCount === 0) {
			const derivedTitle = deriveSessionTitle(userContent);
			if (derivedTitle) {
				await this.setTitle(derivedTitle);
			}
		}

		const baseMessages = this.buildMessages(userContent);
		const toolDefs = this.tools.length > 0 ? this.toolsToDefinitions() : undefined;

		let responseId = '';
		let modelName = '';
		let finalContent = '';
		let finalReasoning = '';
		let usage: TokenUsage | undefined;
		const toolRecords: ToolCallRecord[] = [];
		/** Agent loop 中累积的 tool_call/results 消息 */
		const agentMessages: Message[] = [];
		/** 每轮 API 调用的 token 用量（用于监控缓存命中率） */
		const roundUsages: RoundUsage[] = [];
		/** 是否已创建进行中的 turn（用于增量落盘） */
		let turnSaved = false;
		const userMsg: Message = { role: 'user', content: userContent };

		// ── 子代理状态追踪（实例级，跨轮次/跨中断存活）──
		/** 是否异步模式（默认非异步） */
		const asyncMode = this._subagentAsync ?? false;

		/** 异步模式状态块（拼到 roundMessages 末尾，不写 agentMessages——kv-cache 前缀稳定） */
		const buildStatusBlock = (): Message | null => {
			if (!asyncMode || this.subagents.size === 0) return null;

			const now = Date.now();
			const lines: string[] = ['[Subagent Status — async mode]'];
			let hasContent = false;

			for (const [name, sub] of this.subagents) {
				const elapsed = Math.round((now - sub.startMs) / 1000);
				const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

				if (sub.status === 'running') {
					lines.push(`- "${name}"  (running, ${elapsedStr})`);
					hasContent = true;
				} else if (sub.status === 'completed' && !this.consumedSubagents.has(name)) {
					lines.push(`- "${name}"  (completed, ${elapsedStr}) — use wait("${name}")`);
					hasContent = true;
				} else if (sub.status === 'failed' && !this.consumedSubagents.has(name)) {
					const errMsg = `: ${sub.outputText().slice(0, 60)}`;
					lines.push(`- "${name}"  (failed, ${elapsedStr})${errMsg} — use wait("${name}")`);
					hasContent = true;
				} else if (sub.status === 'cancelled' && !this.consumedSubagents.has(name)) {
					// cancelled 非终态：可 wait 读取，也可 subagent_send 续跑
					lines.push(`- "${name}"  (cancelled, ${elapsedStr}) — wait("${name}") to read, subagent_send to resume`);
					hasContent = true;
				}
				// 已消费（已读）的终态子代理不再出现在状态块，避免每轮重复播报
			}

			return hasContent ? { role: 'user', content: lines.join('\n') } : null;
		};

		/** 拦截子代理工具调用（spawn/wait/list_subagents/subagent_cancel），返回 true 表示已处理 */
		const interceptSubagentTool = async (
			tc: ToolCall,
			args: Record<string, unknown>,
			async: boolean,
			msgs: Message[],
			records: ToolCallRecord[],
			emit: (event: StreamEvent) => void,
			launch: (name: string, task: string) => Promise<string>,
			deferredSpawns?: { name: string; tc: ToolCall; args: Record<string, unknown>; sub: SubagentSessionImpl }[],
		): Promise<boolean> => {
			const pushResult = (result: string, error?: string, durationMs = 0) => {
				msgs.push({ role: 'tool', content: result, tool_call_id: tc.id });
				records.push({
					id: tc.id, name: tc.function.name, arguments: args,
					result, error, duration_ms: durationMs,
				});
				emit({
					type: 'tool_result', toolCallId: tc.id,
					toolName: tc.function.name, toolResult: result, error,
				});
			};

			switch (tc.function.name) {
				case 'subagent_spawn': {
					const name = (args.subagent_name as string) || '';
					const task = (args.task as string) || '';
					if (!name || !task) {
						pushResult('Error: both "subagent_name" and "task" are required.', 'invalid_params');
						return true;
					}
					if (this.subagents.has(name)) {
						pushResult(`Error: subagent "${name}" already exists. Use a unique name.`, 'duplicate');
						return true;
					}

					// launch → runSubagent：创建 SubagentSession（同步放入 this.subagents）并 drive
					// 事件监听挂在 session.promise（drive promise，resolve 即完成；不含持久化延迟）
					launch(name, task);
					const sub = this.subagents.get(name);
					if (!sub) {
						pushResult(`Error: failed to create subagent "${name}".`, 'create_failed');
						return true;
					}
					const startMs = sub.startMs;

					if (async) {
						// M-5：异步模式发紧凑事件（替代 12 行 tool_result）
						const summary = `[SPAWNED] Subagent "${name}" started. Task: ${task.slice(0, 150)}${task.length > 150 ? '...' : ''}\nUse list_subagents to check status, wait("${name}") to retrieve result.`;
						msgs.push({ role: 'tool', content: summary, tool_call_id: tc.id });
						records.push({
							id: tc.id, name: tc.function.name, arguments: args,
							result: summary, duration_ms: 0,
						});
						emit({
							type: 'subagent_spawned',
							subagentName: name,
							subagentTask: task,
						});

						// 后台监听完成时发 subagent_finished 事件（cancelled 映射为 failed，UI 显示 ✗）
						sub.promise?.then(() => {
							const s = this.subagents.get(name);
							if (s) {
								emit({
									type: 'subagent_finished',
									subagentName: name,
									subagentStatus: s.status === 'completed' ? 'completed' : 'failed',
									subagentElapsedMs: Date.now() - startMs,
									error: s.status !== 'completed' ? s.outputText() : undefined,
								});
							}
						});
					} else if (deferredSpawns) {
						// M-3：非异步模式延迟到循环结束，与其它子代理并行 Promise.all
						deferredSpawns.push({ name, tc, args, sub });
					}
					return true;
				}

				case 'subagent_send': {
					const name = (args.subagent_name as string) || '';
					const instruction = (args.instruction as string) || '';
					if (!name || !instruction) {
						pushResult('Error: both "subagent_name" and "instruction" are required.', 'invalid_params');
						return true;
					}
					const sub = this.subagents.get(name);
					if (!sub) {
						pushResult(`Subagent "${name}" not found. Use list_subagents to check.`, 'not_found');
						return true;
					}
					if (sub.status === 'running') {
						pushResult(
							`Subagent "${name}" is still running. Wait for it to complete (or use subagent_cancel) before sending a follow-up.`,
							'still_running',
						);
						return true;
					}
					// cancelled / failed 均可续跑：cancelled 不是终态（需求 3）

					// 追加指令并同步等待续跑（追问性质，master 需要新结果才能继续）
					const startMs2 = Date.now();
					try {
						const result = await this.sendToSubagent(name, instruction, 'master');
						pushResult(
							`Follow-up result for "${name}":\n\n${result}`,
							undefined,
							Date.now() - startMs2,
						);
					} catch (err) {
						pushResult(
							`Error sending follow-up to "${name}": ${err instanceof Error ? err.message : String(err)}`,
							'send_failed',
						);
					}
					return true;
				}

				case 'subagent_cancel': {
					const name = (args.subagent_name as string) || '';
					if (!name) {
						pushResult('Error: "subagent_name" is required ("all" cancels every running subagent).', 'invalid_params');
						return true;
					}
					const targets = this.cancelSubagent(name);
					if (targets.length === 0) {
						pushResult(
							`No running subagent named "${name}" found. Use list_subagents to check.`,
							'not_found',
						);
						return true;
					}
					pushResult(`Cancelled subagent${targets.length > 1 ? 's' : ''}: ${targets.join(', ')}`);
					return true;
				}

				case 'wait': {
					const raw = args.subagent_name;
					let names: string[];
					if (raw === undefined || raw === null || raw === '') {
						// 无参数：等待所有「运行中或尚未消费」的子代理（已读的不再打扰）
						names = [...this.subagents.keys()].filter((n) => {
							const s = this.subagents.get(n);
							return s?.isRunning || !this.consumedSubagents.has(n);
						});
						if (names.length === 0) {
							pushResult('No pending subagents to wait for. Use list_subagents to check.');
							return true;
						}
					} else if (typeof raw === 'string') {
						names = [raw];
					} else if (Array.isArray(raw)) {
						names = raw.map((n) => String(n)).filter(Boolean);
						if (names.length === 0) {
							pushResult('Error: "subagent_name" array is empty.', 'invalid_params');
							return true;
						}
					} else {
						pushResult(
							'Error: "subagent_name" must be a string, an array of strings, or omitted.',
							'invalid_params',
						);
						return true;
					}

					const missing = names.filter((n) => !this.subagents.has(n));
					if (missing.length > 0) {
						pushResult(
							`Subagent(s) not found: ${missing.join(', ')}. Use list_subagents to check.`,
							'not_found',
						);
						return true;
					}
					// 可重复读取：不再有「每个结果只能取一次」限制——消费只影响通知，不影响读取
					// 等待所有指定 subagent 完成（并行等待，全部结束后才继续）
					const startMs = Date.now();
					await Promise.all(names.map((n) => this.subagents.get(n)!.promise!));
					const elapsed = Date.now() - startMs;
					for (const n of names) this.consumedSubagents.add(n);

					const anyFailed = names.some((n) => {
						const s = this.subagents.get(n);
						return s?.status === 'failed' || s?.status === 'cancelled';
					});
					const body = names
						.map((n) => {
							const s = this.subagents.get(n)!;
							// 单轮：直接给最终 content（最常见，省 token）
							// 多轮：给 user↔subagent 对话投影（master 需要看到完整会话历史）
							const text = s.runs.length > 1 ? s.renderDialogue() : s.outputText();
							return `=== ${n} ===\n${text}`;
						})
						.join('\n\n');
					pushResult(
						`Subagent result(s):\n\n${body}`,
						anyFailed ? 'subagent_failed' : undefined,
						elapsed,
					);
					return true;
				}

				case 'subagent_trace': {
					const name = (args.subagent_name as string) || '';
					if (!name) {
						pushResult('Error: "subagent_name" is required.', 'invalid_params');
						return true;
					}
					const sub = this.subagents.get(name);
					if (!sub) {
						pushResult(`Subagent "${name}" not found. Use list_subagents to check.`, 'not_found');
						return true;
					}
					const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 0;
					pushResult(formatSubagentTrace(name, sub, limit));
					return true;
				}

				case 'list_subagents': {
					if (this.subagents.size === 0) {
						pushResult('No subagents in this session.');
						return true;
					}
					const now = Date.now();
					const lines: string[] = [];
					for (const [n, sub] of this.subagents) {
						const elapsed = Math.round((now - sub.startMs) / 1000);
						const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
						// [new] = master 尚未看过其最新产出；[read] = 已消费（wait 仍可重复读取）
						const mark = this.consumedSubagents.has(n) ? ' [read]' : ' [new]';

						if (sub.status === 'running') {
							lines.push(`- "${n}"  running (${elapsedStr})`);
						} else if (sub.status === 'completed') {
							lines.push(`- "${n}"  completed (${elapsedStr})${mark} — wait("${n}")`);
						} else if (sub.status === 'cancelled') {
							lines.push(`- "${n}"  cancelled (${elapsedStr})${mark} — subagent_send to resume, subagent_trace to inspect`);
						} else {
							lines.push(`- "${n}"  failed (${elapsedStr})${mark} — wait("${n}")`);
						}
					}
					pushResult(lines.join('\n'));
					return true;
				}

				default:
					return false;
			}
		};

		try {
			// ── Agent Loop ──────────────────────────
			let userDenied = false;

			// Hook B：开轮时兜底投递「用户↔子代理」通知（本轮若不再有工具调用，Hook A 不会触发）。
			// 注入为 user 消息并随 turn.messages 落盘 → 只出现一次，不会每轮重复拼接。
			const noticeAtTurnStart = this.drainNotices();
			if (noticeAtTurnStart) {
				agentMessages.push({ role: 'user', content: noticeAtTurnStart });
			}

			// 记忆变化提醒（同样落盘：落盘后历史字节稳定 → 前缀缓存不断）
			await this.injectMemoryUpdates(agentMessages);

			// 后台记忆归纳：与主 agent 本轮**并发**（不阻塞、不影响本轮上下文）
			void this.maybeRunMemoryAgent(userContent);

			for (let round = 0; !userDenied; round++) {
				// M-2：异步模式状态块拼到 roundMessages 末尾（不写 agentMessages——kv-cache 前缀稳定）
				const statusBlock = buildStatusBlock();
				const roundMessages = statusBlock
					? [...baseMessages, ...agentMessages, statusBlock]
					: [...baseMessages, ...agentMessages];

				let roundContent = '';
				let roundReasoning = '';
				const pendingToolCalls: ToolCall[] = [];

				for await (const chunk of this.provider.chatStream(roundMessages, {
					tools: toolDefs,
					signal,
					...this.chatDefaults,
				})) {
					if (!responseId) responseId = chunk.id;
					if (!modelName) modelName = chunk.model;

					const delta = chunk.choices[0]?.delta;
					if (!delta) continue;

					// reasoning delta
					if (delta.reasoning_content) {
						roundReasoning += delta.reasoning_content;
						finalReasoning += delta.reasoning_content;
						onEvent({ type: 'reasoning_delta', text: delta.reasoning_content });
					}

					// content delta
					if (delta.content) {
						roundContent += delta.content;
						finalContent += delta.content;
						onEvent({ type: 'content_delta', text: delta.content });
					}

					// tool_calls delta
					if (delta.tool_calls && delta.tool_calls.length > 0) {
						this.accumulateToolCalls(pendingToolCalls, delta.tool_calls);
						// 发送 tool_call_delta 事件（TUI 可选择性展示）
						for (const tcd of delta.tool_calls) {
							if (tcd.function?.arguments) {
								onEvent({ type: 'tool_call_delta', text: tcd.function.arguments });
							}
						}
					}

					if (chunk.usage) usage = chunk.usage;
					await yieldEventLoop();
				}

				// 记录本轮 API 调用的 token 用量
				if (usage) {
					roundUsages.push({
						round,
						prompt_tokens: usage.prompt_tokens,
						completion_tokens: usage.completion_tokens,
						cache_hit_tokens: usage.prompt_cache_hit_tokens ?? 0,
						cache_miss_tokens: usage.prompt_cache_miss_tokens ?? 0,
					});
				}

				// ── 自动 compact：本轮请求输入超阈值 → 压缩历史（保留 agentMessages 继续执行）──
				// 以 usage.prompt_tokens（本轮实际请求的输入 token 数，含全部历史）为判据。
				// compactContext 会等待子代理结束 → 生成摘要 → 开启新分代 → 更新 this.session.turns；
				// 之后重建 baseMessages（摘要轮成为新前缀），当前轮的工具交互（agentMessages）保留。
				if (usage && this.autoCompact.enabled) {
					const promptTokens = usage.prompt_tokens + (usage.completion_tokens ?? 0);
					const limit = Math.floor(this.autoCompact.contextWindow * this.autoCompact.threshold);
					if (promptTokens > limit && this.session!.turns.length > 0) {
						try {
							const result = await this.compactContext();
							// compact 后重建 baseMessages：buildMessages 从最后一个摘要轮开始，
							// agentMessages（当前轮工具交互）保留，消息序列 = 摘要 + userMsg + agentMessages
							baseMessages.length = 0;
							baseMessages.push(...this.buildMessages(userContent));
							onEvent({
								type: 'auto_compact',
								text: `上下文 ${promptTokens} tokens 超过阈值 ${limit}，已自动压缩`,
								compactGen: result.gen,
								compressedTurns: result.compressedTurns,
								restoredFiles: result.restoredFiles,
							});
						} catch (err) {
							// 自动 compact 失败不阻塞主流程
							onEvent({ type: 'auto_compact', text: `自动压缩失败: ${err instanceof Error ? err.message : String(err)}` });
						}
					}
				}

				// 本轮无 tool_calls → 检查子代理状态
				if (pendingToolCalls.length === 0) {
					agentMessages.push({
						role: 'assistant',
						content: roundContent,
						reasoning_content: roundReasoning || undefined,
					});

					// M-2：异步模式下子代理状态已由 roundMessages 末尾的状态块提供给模型，
					// 模型看到状态后自主调度 wait/list_subagents；不再注入静态提醒或强制 continue。

					break;
				}

				// ── 执行 tool calls ──────────────────
				// 添加 assistant 消息（含 tool_calls, reasoning_content）
				agentMessages.push({
					role: 'assistant',
					content: roundContent || '',
					tool_calls: pendingToolCalls,
					reasoning_content: roundReasoning || undefined,
				});

				// 首次遇到 tool call：创建进行中的 turn 落盘
				if (!turnSaved) {
					turnSaved = true;
					try {
						const inProgress = await this.storage.saveTurn(
							this.session.meta.id,
							userMsg,
							// 方案 C：agentLoopMessages 非空，顶层只存 id（content 由 messages 推导）
							{ id: responseId || '', role: 'assistant' },
							{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
							0,
							true, // interrupted — 进行中
							undefined, // toolCalls 稍后由 updateLastTurn 设置
							[userMsg, ...agentMessages],
							roundUsages.length > 0 ? roundUsages : undefined,
							await this._browserLastUrl(),
						);
						// 修复 C-1：进行中的 turn 立即进入内存，保持内存与磁盘一致
						// （此前只在磁盘落盘、内存缺位，导致结束分支用 length-1 覆盖上一轮）
						this.session.turns.push(inProgress);
					} catch { /* 持久化失败不阻塞 */ }
				}

				// M-3：收集本轮所有子代理 spawn（非异步模式用于循环结束后并行 Promise.all）
				const allDeferredSpawns: { name: string; tc: ToolCall; args: Record<string, unknown>; sub: SubagentSessionImpl }[] = [];

				for (let i = 0; i < pendingToolCalls.length; i++) {
					const tc = pendingToolCalls[i];
					const tool = this.tools.find((t) => t.name === tc.function.name);
					let args: Record<string, unknown> = {};
					try {
						args = JSON.parse(tc.function.arguments);
					} catch {
						// JSON 解析失败，args 留空
					}

					// 通知 TUI：工具开始执行
					onEvent({
						type: 'tool_call_start',
						toolCallId: tc.id,
						toolName: tc.function.name,
						toolArgs: args,
					});

					// ── 子代理工具拦截 ──────────────────
					const intercepted = await interceptSubagentTool(
						tc, args,
						asyncMode, agentMessages, toolRecords, onEvent,
						(name, task) => this.runSubagent(name, task),
						allDeferredSpawns,
					);
					if (intercepted) continue;
					// ───────────────────────────────────

					// 生成 diff 预览（文件修改工具）
					let previewText: string | undefined;
					if (tool?.preview) {
						const preview = await tool.preview(args);
						if (preview !== null && preview !== undefined) {
							previewText = preview;
							onEvent({
								type: 'tool_preview',
								toolCallId: tc.id,
								toolName: tc.function.name,
								toolPreview: preview,
							});
						}
					}

					// 需要用户确认的工具：静态 requiresConfirm 或动态 confirmRequiredFor 任一命中
					// 通过 onConfirm 回调确认（diff 已渲染在屏幕上）
					let denied = false;
					const isStalePreview = previewText?.startsWith('[STALE]');
					const dynamicConfirm = tool?.confirmRequiredFor
						? await tool.confirmRequiredFor(args)
						: false;
					if ((tool?.requiresConfirm || dynamicConfirm) && onConfirm && !isStalePreview) {
						const approved = await onConfirm(tc.function.name, args);
						if (!approved) {
							denied = true;
							userDenied = true;
						}
					}
					const startMs = Date.now();
					let toolResult: string;
					let toolError: string | undefined;
					/** 条件 skill 激活通知：追加到本工具结果末尾（不插入 user 消息） */
					let skillReminderText: string | null = null;

					if (denied) {
						toolResult = 'The user rejected this operation. Do not retry the same approach. Explain the reason for the change and suggest an alternative, or ask the user for guidance.';
						toolError = 'denied';
					} else if (tool) {
						try {
							const r = await tool.execute(
								args,
								signal,
								(line, stream) => {
									onEvent({
										type: 'tool_output',
										toolCallId: tc.id,
										toolName: tc.function.name,
										outputLine: line,
										outputStream: stream,
									});
								},
							);
							toolResult = r.content;
							toolError = r.error;

							// 条件 skill 激活：文件工具触碰匹配路径后，激活并将通知追加到本工具结果末尾
							if (!toolError) {
								const touched = extractPathsFromToolCall(tc.function.name, args);
								if (touched.length > 0) {
									const cwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();
									const activated = activateSkillsForPaths(touched, cwd);
									if (activated.length > 0) {
										const lines = activated.map(
											(s) =>
												`- ${s.name}: ${s.description}${s.whenToUse ? ` - when to use: ${s.whenToUse}` : ''}`,
										);
										skillReminderText =
											`\n\n<system-reminder>\nNew skill(s) now available — invoke with the "skill" tool:\n` +
											lines.join('\n') +
											'\n</system-reminder>';
									}
								}
							}
						} catch (err: unknown) {
							if (err instanceof Error && err.name === 'AbortError') {
								// 用户 Ctrl+C 中断工具执行，与拒绝对齐：设 userDenied，走同样的 skip+break 路径
								toolResult = 'The user cancelled this operation during execution. Do not retry the same approach. Explain the reason and suggest an alternative, or ask the user for guidance.';
								toolError = 'cancelled';
								userDenied = true;
							} else {
								throw err;
							}
						}
					} else {
						toolResult = `Unknown tool: ${tc.function.name}`;
						toolError = 'unknown_tool';
					}

				// 拼入 error 信息：确保模型能感知工具执行失败
				// 条件 skill 激活通知追加到工具结果末尾（不插入 user 消息，保持 assistant/tool 序列连续）
				let toolMessage = toolError ? `${toolResult}\nError: ${toolError}` : toolResult;
				if (skillReminderText) {
					toolMessage += skillReminderText;
				}
				// Hook A：把待投递的「用户↔子代理」通知挂到本轮下一个 tool result 尾部。
				// 与 skillReminderText 同一手法：不额外插入 user 消息，保持 assistant/tool 交替；
				// 内容随该 tool 消息进 agentMessages → 只出现一次。
				const noticeText = this.drainNotices();
				if (noticeText) {
					toolMessage += `\n\n${noticeText}`;
				}

					const durationMs = Date.now() - startMs;

					toolRecords.push({
						id: tc.id,
						name: tc.function.name,
						arguments: args,
						result: toolResult,
						error: toolError,
						duration_ms: durationMs,
						preview: previewText,
					});

					// 通知 TUI：工具执行完成
					onEvent({
						type: 'tool_result',
						toolCallId: tc.id,
						toolName: tc.function.name,
						toolResult,
						error: toolError,
						toolDenied: denied || toolError === 'cancelled',
					});

					// 拒绝/取消时：写入结果，剩余 tool 补 skip 结果，退出 agent loop
					if (denied || toolError === 'cancelled') {
						agentMessages.push({
							role: 'tool',
							content: toolMessage,
							tool_call_id: tc.id,
						});
						for (let j = i + 1; j < pendingToolCalls.length; j++) {
							agentMessages.push({
								role: 'tool',
								content: 'Skipped: a previous tool call was rejected or cancelled by the user.',
								tool_call_id: pendingToolCalls[j].id,
							});
						}
						break;
					}

					// 将 tool 结果加入 messages
					agentMessages.push({
						role: 'tool',
						content: toolMessage,
						tool_call_id: tc.id,
					});
				}

				// ── M-3：非异步模式的 deferred spawns：收集完毕，并行等待 ──
				if (allDeferredSpawns.length > 0) {
					await Promise.all(allDeferredSpawns.map((d) => d.sub.promise!));
					for (const d of allDeferredSpawns) {
						const sub = d.sub;
						// 非 async 模式：结果已同步回填给 master → 标记已消费（不再重复通知）
						this.consumedSubagents.add(d.name);
						// 非 async 模式：子代理结果同步回填给 master（内容由 messages 派生，
						// fail/cancelled 时是状态消息——见 SubagentSession.outputText）
						const output = sub.outputText();
						agentMessages.push({
							role: 'tool',
							content: `Subagent "${d.name}" completed.\n\n${output}`,
							tool_call_id: d.tc.id,
						});
						toolRecords.push({
							id: d.tc.id, name: 'subagent_spawn', arguments: d.args,
							result: output,
							error: sub.status === 'failed' || sub.status === 'cancelled' ? 'subagent_failed' : undefined,
							duration_ms: Date.now() - sub.startMs,
						});
						onEvent({
							type: 'tool_result',
							toolCallId: d.tc.id,
							toolName: 'subagent_spawn',
							toolResult: output,
							error: sub.status === 'failed' || sub.status === 'cancelled' ? 'subagent_failed' : undefined,
						});
					}
				}

				// 每轮工具执行后增量落盘（在 agent loop 内）
				if (turnSaved) {
					try {
						await this.storage.updateLastTurn(this.session.meta.id, {
							toolCalls: toolRecords,
							messages: [userMsg, ...agentMessages],
							usage: usage ?? undefined,
							roundUsages: roundUsages.length > 0 ? roundUsages : undefined,
							lastBrowserUrl: await this._browserLastUrl(),
						});
					} catch { /* 持久化失败不阻塞 */ }
				}
			}

			// ── 持久化 ──────────────────────────────
			const finalUsage = usage ?? {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
			};
			// O-1：子代理 token 入账（累积增量并入本轮 usage，入账后清零）
			if (this.subagentUsage.total_tokens > 0) {
				finalUsage.prompt_tokens += this.subagentUsage.prompt_tokens;
				finalUsage.completion_tokens += this.subagentUsage.completion_tokens;
				finalUsage.total_tokens += this.subagentUsage.total_tokens;
				this.subagentUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
			}

			const browserUrl = await this._browserLastUrl();
			let turn: TurnRecord;

			if (turnSaved) {
				// 已有进行中的 turn：更新为完成状态（messages 已由增量落盘维护）
				// C-5：updateLastTurn 返回 null（磁盘 turns 为空/损坏）时回退 saveTurn 兜底
				const updated = await this.storage.updateLastTurn(this.session.meta.id, {
					toolCalls: toolRecords.length > 0 ? toolRecords : undefined,
					messages: agentMessages.length > 0 ? [userMsg, ...agentMessages] : undefined,
					usage: finalUsage,
					roundUsages: roundUsages.length > 0 ? roundUsages : undefined,
					interrupted: false,
					lastBrowserUrl: browserUrl,
				});
				if (updated) {
					turn = updated;
				} else {
					// 磁盘无进行中 turn（首次 saveTurn 失败被吞）：重新保存完整 turn
					turn = await this.storage.saveTurn(
						this.session.meta.id,
						userMsg,
						{ id: responseId || '', role: 'assistant', content: finalContent, reasoning_content: finalReasoning || undefined },
						finalUsage,
						0,
						false,
						toolRecords.length > 0 ? toolRecords : undefined,
						[userMsg, ...agentMessages],
						roundUsages.length > 0 ? roundUsages : undefined,
						browserUrl,
					);
					this.session.turns.push(turn);
				}
			} else {
				// 无工具调用：直接追加新 turn
				const costRmb = 0;
				turn = await this.storage.saveTurn(
					this.session.meta.id,
					userMsg,
					{
						id: responseId || '',
						role: 'assistant',
						content: finalContent || '(no response)',
						reasoning_content: finalReasoning || undefined,
					},
					finalUsage,
					costRmb,
					false,
					undefined,
					// 有注入块（子代理通知 / 记忆变化提醒）时写入完整消息序列：
					// 注入内容必须随 turn.messages 落盘，否则下一轮前缀在该位置断开、重算上一轮内容。
					// 注意：无工具轮的 assistant 消息也已 push 进 agentMessages，此处不再重复追加。
					agentMessages.length > 0 ? [userMsg, ...agentMessages] : undefined,
					roundUsages.length > 0 ? roundUsages : undefined,
					browserUrl,
				);
				this.session.turns.push(turn);
			}

			// 写入缓存命中率监控日志（v2 无 turn 字段，轮次号 = 内存 turns 长度——此时已含当前轮）
			if (roundUsages.length > 0) {
				const dir = this.storage.sessionDir(this.session.meta.id);
				appendCacheLog(dir, this.session.meta.id, this.session.turns.length, roundUsages);
			}

			// 更新内存中的 session 元数据。
			// turnSaved 时当前轮已在 turns 数组（首次 saveTurn 时 push，修复 C-1），
			// lastIdx 指向的就是当前轮，直接替换为最终版本。
			if (turnSaved) {
				const lastIdx = this.session.turns.length - 1;
				if (lastIdx >= 0) {
					this.session.turns[lastIdx] = turn;
				} else {
					// 防御：saveTurn 失败未 push 时兜底
					this.session.turns.push(turn);
				}
			}
			this.session.meta.turnCount = this.session.turns.length;
			this.session.meta.updated_at = turn.created_at;

			onEvent({ type: 'done', usage: finalUsage });
			return turn;
		} catch (err: unknown) {
			const isAbort = err instanceof Error && err.name === 'AbortError';
			const msg = err instanceof Error ? err.message : String(err);

			// 有工具调用记录才保留中断轮次
			if (toolRecords.length > 0) {
				const partialUsage = usage ?? {
					prompt_tokens: 0,
					completion_tokens: 0,
					total_tokens: 0,
				};
				// O-1：子代理 token 入账（中断路径同样并入）
				if (this.subagentUsage.total_tokens > 0) {
					partialUsage.prompt_tokens += this.subagentUsage.prompt_tokens;
					partialUsage.completion_tokens += this.subagentUsage.completion_tokens;
					partialUsage.total_tokens += this.subagentUsage.total_tokens;
					this.subagentUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
				}

				try {
					const browserUrl = await this._browserLastUrl();
					let turn: TurnRecord;

					if (turnSaved) {
						// 已有进行中的 turn：更新为中断状态。
						// "已中断"状态由 interrupted 标志驱动显示（conversation.ts）。
						// C-5：updateLastTurn 返回 null（磁盘无进行中 turn）时回退 saveTurn 追加
						const updated = await this.storage.updateLastTurn(this.session.meta.id, {
							toolCalls: toolRecords,
							messages: [userMsg, ...agentMessages],
							usage: partialUsage,
							roundUsages: roundUsages.length > 0 ? roundUsages : undefined,
							interrupted: true,
							lastBrowserUrl: browserUrl,
						});
						if (updated) {
							turn = updated;
							const lastIdx = this.session.turns.length - 1;
							if (lastIdx >= 0) this.session.turns[lastIdx] = turn;
						} else {
							// 磁盘无进行中 turn：直接保存完整中断 turn
							turn = await this.storage.saveTurn(
								this.session.meta.id,
								userMsg,
								{ id: responseId || '', role: 'assistant' },
								partialUsage,
								0,
								true,
								toolRecords,
								[userMsg, ...agentMessages],
								roundUsages.length > 0 ? roundUsages : undefined,
								browserUrl,
							);
							this.session.turns.push(turn);
						}
					} else {
						// 工具刚返回 tool_calls 但尚未首次 saveTurn → 直接追加。
						// agentLoopMessages 非空，顶层只存 id（content 由 messages 推导）。
						turn = await this.storage.saveTurn(
							this.session.meta.id,
							userMsg,
							{ id: responseId || '', role: 'assistant' },
							partialUsage,
							0,
							true,
							toolRecords,
							[userMsg, ...agentMessages],
							roundUsages.length > 0 ? roundUsages : undefined,
							browserUrl,
						);
						this.session.turns.push(turn);
					}

					this.session.meta.turnCount = this.session.turns.length;
					this.session.meta.updated_at = turn.created_at;

					onEvent({ type: 'error', error: isAbort ? '已中断' : msg });
					return turn;
				} catch {
					// 持久化失败，不阻塞
				}
			}

			onEvent({ type: 'error', error: msg });
			return null;
		}
	}

	/** 构建请求消息队列（中断轮次保留用户消息 + 已完成工具结果，以维持上下文连续性） */
	private buildMessages(currentContent: string): Message[] {
		const messages: Message[] = [];

		// 1. System prompt
		if (this.systemPrompt) {
			messages.push(this.systemPrompt);
		}

		// 2. 历史轮次
		const turns = this.session!.turns;
		// compact 边界：从最后一个摘要轮（type='compact'）开始平铺。
		// 其之前的轮次已被压缩进摘要，不再进入请求上下文（磁盘全量保留供 TUI 回查）。
		let startIdx = 0;
		for (let i = turns.length - 1; i >= 0; i--) {
			if (turns[i].type === 'compact') {
				startIdx = i;
				break;
			}
		}
		for (let i = startIdx; i < turns.length; i++) {
			const turn = turns[i];
			if (turn.interrupted) {
				// 中断轮次：保留用户消息 + 已完成的工具交互，但不包含截断的 assistant 最终回复
				if (turn.messages && turn.messages.length > 0) {
					messages.push(...turn.messages);
				} else {
					// 兼容旧数据：至少保留用户消息
					if (turn.user) messages.push(turn.user);
				}
				continue;
			}

			// 优先使用存储的完整消息序列（精确回放 API 收发的消息前缀）
			if (turn.messages && turn.messages.length > 0) {
				messages.push(...turn.messages);
				continue;
			}

			// 兼容旧数据（v1）：从 user/assistant/tool_calls 反向重建
			if (turn.user) messages.push(turn.user);

			const tcRecords = turn.tool_calls;
			if (tcRecords && tcRecords.length > 0) {
				const toolCalls: ToolCall[] = tcRecords.map((tcr) => ({
					id: tcr.id,
					type: 'function' as const,
					function: {
						name: tcr.name,
						arguments: JSON.stringify(tcr.arguments),
					},
				}));
				messages.push({
					role: 'assistant',
					content: '',
					tool_calls: toolCalls,
				});
				for (const tcr of tcRecords) {
					const msgContent = tcr.result || tcr.error
						? `${tcr.result || ''}${tcr.error ? '\nError: ' + tcr.error : ''}`
						: '';
					messages.push({
						role: 'tool',
						content: msgContent,
						tool_call_id: tcr.id,
					});
				}
			}

			messages.push({
				role: 'assistant',
				content: turn.assistant?.content ?? '',
				reasoning_content: turn.assistant?.reasoning_content,
			});
		}

		// 3. 当前用户消息
		messages.push({ role: 'user', content: currentContent });

		return messages;
	}
}
