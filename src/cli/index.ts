#!/usr/bin/env node
/**
 * deepseek-arch CLI 入口
 *
 * 子命令：
 *   chat                  启动新对话（或 --resume 恢复）
 *   resume [id]           列出或恢复已有会话
 *   clear [--below N]     清除会话（默认保留最近 10 条；--below N 删除轮次<N 的会话）
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { ConfigManager, DEFAULT_CONFIG_DIR, parseTokenSize } from '../core/config.js';
import { buildDisplayPreset, isDisplayMode } from '../render/display-mode.js';
import type { DisplayMode } from '../render/display-mode.js';
import { ApiClient } from '../core/api.js';
import { MockProvider } from '../core/mock-provider.js';
import { SessionManager, deriveSessionTitle } from '../core/session.js';
import { Storage } from '../core/storage.js';
import { TuiApp } from '../presentation/tui-app.js';
import type { TuiConfig } from '../presentation/types.js';
import { getAllTools, setSubagentRunner, setCaptureFn, setSkillForkRunner } from '../tools/index.js';
import type { SubagentRunner } from '../tools/index.js';
import type { Tool } from '../tools/types.js';
import { buildSystemPromptContext } from '../core/system-info.js';
import { loadSkills, buildSkillListing } from '../core/skill.js';
import { configureBrowser } from '../tools/browser-state.js';
import { startApiMonitor } from '../core/api-monitor.js';
import { getApiRequestsDir } from '../core/workspace-paths.js';
import { setMemoryStore } from '../core/memory-service.js';
import { existsSync, statSync } from 'node:fs';
import { turnAssistantContent } from '../utils/turn-utils.js';

/** 获取主代理工具集（含 subagent_spawn/wait/list_subagents） */
function loadMasterTools(debug = false, selfInteraction = false) {
	const tools = getAllTools({ includeSubagent: true, selfInteraction });
	if (!debug) {
		// 非 debug 模式不暴露 TUI 调试工具
		return tools.filter(t => t.name !== 'tui_capture' && t.name !== 'tui_render_preview');
	}
	return tools;
}

const PACKAGE_VERSION = "1.5.3";

async function createTuiConfig(): Promise<TuiConfig> {
	const cfg = await ConfigManager.getInstance().load();
	const providerName = cfg.get<string>('defaults.provider') ?? 'deepseek';
	const model = cfg.get<string>('defaults.model') ?? 'deepseek-v4-pro';
	const baseUrl = cfg.get<string>(`providers.${providerName}.base_url`) ?? 'https://api.deepseek.com';
	// api_key：配置优先，回退到 DEEPSEEK_API_KEY 环境变量
	const apiKey = cfg.get<string>(`providers.${providerName}.api_key`)
		?? process.env.DEEPSEEK_API_KEY
		?? '';
	// 审查模型：可从配置读取，默认用 flash（更便宜）
	const reviewModel = cfg.get<string>('defaults.review_model') ?? 'deepseek-v4-flash';

	return {
		provider: providerName,
		model,
		baseUrl,
		apiKey,
		version: PACKAGE_VERSION,
		systemPrompt: cfg.get<string>('defaults.system_prompt') ?? 'default',
		reviewModel,
	};
}

async function createSessionManager(config: TuiConfig, tools: Tool[], asyncMode = false, monitorUrl?: string, mock = false): Promise<SessionManager> {
	const cfg = ConfigManager.getInstance();
	// 供应商级超时/重试配置（可选，默认 120s / 2 次）
	const timeoutMs = cfg.get<number>(`providers.${config.provider}.timeout_ms`) ?? 120_000;
	const maxRetries = cfg.get<number>(`providers.${config.provider}.max_retries`) ?? 2;
	const provider = mock
		? new MockProvider('mock-chat', 50)
		: new ApiClient(config.baseUrl, config.apiKey, config.model, monitorUrl, timeoutMs, maxRetries);
	const sessionsDir = cfg.getSessionsDir();
	const storage = new Storage(sessionsDir);

	const sessionMgr = new SessionManager(storage, provider, tools);

	// 注入生成参数默认值（temperature/max_tokens/top_p/thinking/reasoning_effort）
	const chatDefaults = {
		...(cfg.get<number>('defaults.temperature') !== undefined ? { temperature: cfg.get<number>('defaults.temperature') } : {}),
		...(cfg.get<number>('defaults.max_tokens') !== undefined ? { max_tokens: cfg.get<number>('defaults.max_tokens') } : {}),
		...(cfg.get<string>('defaults.reasoning_effort') ? { reasoning_effort: cfg.get<string>('defaults.reasoning_effort') } : {}),
		...(cfg.get<string>('defaults.thinking') ? { thinking: { type: cfg.get<string>('defaults.thinking') } as { type: 'enabled' | 'disabled' } } : {}),
	};
	sessionMgr.setChatDefaults(chatDefaults);

	// 自动 compact 配置（默认开启 70%/1M；context_window 支持 "1M"/"256K" 等单位写法）
	sessionMgr.setAutoCompact({
		enabled: cfg.get<boolean>('defaults.auto_compact') ?? true,
		threshold: cfg.get<number>('defaults.auto_compact_threshold') ?? 0.7,
		contextWindow: parseTokenSize(cfg.get<number | string>('defaults.context_window')) ?? 1_000_000,
	});

	// 注入子代理执行器（懒绑定，解决循环依赖）
	setSubagentRunner((name, task) => sessionMgr.runSubagent(name, task));

	// 注入 skill fork 执行器（frontmatter context: fork 的 skill 走子代理）
	setSkillForkRunner((name, task) => sessionMgr.runSubagent(name, task));

	// 设置子代理异步模式
	sessionMgr.setSubagentAsync(asyncMode);

	// 记忆机制：按 [memory] 段装配（默认开启；CLI --no-memory 会在创建后覆盖为关闭）
	sessionMgr.configureMemory({
		enabled: cfg.get<boolean>('memory.enabled') ?? true,
		inject: cfg.get<boolean>('memory.inject') ?? true,
		maxInjectTokens: cfg.get<number>('memory.max_inject_tokens') ?? 800,
		deltaInjectTokens: cfg.get<number>('memory.delta_inject_tokens') ?? 200,
		masterMinConfidence: cfg.get<number>('memory.master_min_confidence') ?? 2,
		recallModel: cfg.get<string>('memory.recall_model') ?? 'deepseek-v4-flash',
		agentModel: cfg.get<string>('memory.agent_model') ?? 'deepseek-v4-flash',
		agentOnTurnEnd: cfg.get<boolean>('memory.agent_on_turn_end') ?? true,
		agentMinIntervalSec: cfg.get<number>('memory.agent_min_interval_sec') ?? 30,
		agentMaxWritesPerRun: cfg.get<number>('memory.agent_max_writes_per_run') ?? 3,
		agentMaxInputTurns: cfg.get<number>('memory.agent_max_input_turns') ?? 3,
		agentMaxInputTokens: cfg.get<number>('memory.agent_max_input_tokens') ?? 6000,
		agentTimeoutMs: cfg.get<number>('memory.agent_timeout_ms') ?? 90_000,
		notifyReadUpdates: cfg.get<boolean>('memory.notify_read_updates') ?? true,
	});
	// 记忆工具（memory_read/write）与「已更新记忆」提示：与工作区/阈值保持一致
	setMemoryStore(sessionMgr.getMemory()?.store ?? null);
	sessionMgr.setMemoryNoticeCallback((count) => {
		process.stderr.write(`[memory] updated ${count}\n`);
	});

	// 设置 system prompt
	// 来源：system-prompt.toml 模板（ConfigManager.load() 启动时已保证存在——
	// 缺失时从项目根 system_prompt.txt 生成快照，见 ensureSystemPromptSnapshot）
	const defaultPrompt = cfg.get<string>('defaults.system_prompt') ?? 'default';
	const sysContent = cfg.get<string>(`systemPrompts.${defaultPrompt}.content`);
	if (sysContent) {
		// 收集系统与环境信息，注入到 system prompt
		const envContext = await buildSystemPromptContext();
		// 注入 skill listing：让模型知道有哪些可用 skill（预算化，见 core/skill.ts）
		const skills = await loadSkills();
		const skillListing = buildSkillListing(skills);
		const listingSection = skillListing
			? `\n\n<skill_listing>\n${skillListing}\n</skill_listing>`
			: '';
		sessionMgr.setSystemPrompt({
			role: 'system',
			content: sysContent + '\n' + envContext + listingSection,
		});
	} else {
		// 模板缺失（defaults.system_prompt 指向了未定义的模板名）→ 提示但不注入
		process.stderr.write(`[warn] system prompt 模板 "${defaultPrompt}" 未定义于 system-prompt.toml，本次未注入 system prompt\r\n`);
	}

	return sessionMgr;
}

/**
 * 应用 `--workspace`：覆盖工作区根目录。
 *
 * 影响面：工具的工作目录、`{workspace}/.deepseek-arch/` runtime 目录（plan/memory/api-requests）、
 * 以及所有走 `DEEPSEEK_ARCH_SESSION_CWD` 的路径解析。
 * **必须在创建 SessionManager 之前调用**（其构造函数会把该值锁定为会话 cwd，见 core/session.ts）。
 * @returns 目录不可用时返回 false（已打印错误）
 */
function applyWorkspace(workspace?: string): boolean {
	if (!workspace) return true;
	const resolved = resolve(workspace);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		console.error(`Error: --workspace is not an accessible directory: ${resolved}`);
		return false;
	}
	process.env.DEEPSEEK_ARCH_SESSION_CWD = resolved;
	return true;
}

/**
 * 非交互单轮执行（`chat --prompt <content>`）：不进 TUI，跑完一轮就退出。
 *
 * 契约（供脚本/心跳复用）：
 *  - stdout = 最终回复（一行结尾）；stderr = 进度（工具名）与错误；
 *  - 退出码：0 = 成功；1 = 会话不存在 / 本轮失败；
 *  - 工具确认：不注册 onConfirm → 需要确认的工具直接执行（即 yolo，见需求 D6）；
 *  - 失败且未产生轮次时丢弃刚创建的空会话（避免自动化反复留空壳）。
 */
async function runPromptOnce(
	sessionMgr: SessionManager,
	prompt: string,
	resumeId: string | null,
): Promise<number> {
	if (resumeId) {
		const storage = new Storage(ConfigManager.getInstance().getSessionsDir());
		let session = await storage.getSession(resumeId);
		if (!session) session = await storage.getSessionByName(resumeId);
		if (!session) {
			console.error(`Session not found: ${resumeId}`);
			return 1;
		}
		await sessionMgr.resumeSession(session.meta.id);
	} else {
		await sessionMgr.startNewSession(deriveSessionTitle(prompt));
	}

	const turn = await sessionMgr.sendMessageStream(prompt, (event) => {
		if (event.type === 'tool_call_start' && event.toolName) {
			process.stderr.write(`[tool] ${event.toolName}\n`);
		} else if (event.type === 'error' && event.error) {
			process.stderr.write(`[error] ${event.error}\n`);
		}
	});

	if (!turn) {
		if (!resumeId) await sessionMgr.discardEmptySession();
		return 1;
	}
	const text = turnAssistantContent(turn);
	process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
	return 0;
}

/** 解析展示模式：--short/--normal/--detail 互斥；缺省时回退 configMode（合法）→ 'normal' */
function resolveDisplayMode(opts: { short?: boolean; normal?: boolean; detail?: boolean }, configMode?: string): DisplayMode {
	const flags = (['short', 'normal', 'detail'] as const).filter((k) => opts[k]);
	if (flags.length > 1) {
		throw new Error('--short / --normal / --detail 互斥，请只选择一个');
	}
	if (opts.short) return 'short';
	if (opts.detail) return 'detail';
	return isDisplayMode(configMode) ? configMode : 'normal';
}

// ─── CLI 定义 ─────────────────────────────────────

const program = new Command();

program
	.name('deepseek-arch')
	.version(PACKAGE_VERSION)
	.description('Linux terminal AI assistant');

program
	.command('chat')
	.description('Start a new conversation or resume an existing one')
	.option('-r, --resume <id>', 'resume a session by ID or name')
	.option('--yolo', 'skip all tool confirmations (auto-approve edit/shell)')
	.option('--no-yolo', 'disable YOLO mode (ask for tool confirmations; YOLO is default)')
	.option('--short', 'compact display: think ≤4 lines, tool output hidden except file edits')
	.option('--normal', 'balanced display: think ≤4 lines, tool results ≤6 lines (default)')
	.option('--detail', 'full display (current behavior): live tool output, results ≤12 lines')
	.option('--browser', 'show browser window (instead of headless)')
	.option('--cdp <url>', 'connect to host browser via CDP (e.g. http://127.0.0.1:9222)')
	.option('--async', 'async subagent mode (subagent_spawn returns immediately)')
	.option('--debug', 'enable TUI capture & render preview tools for model debugging')
	.option('--self-interaction', 'enable TUI session (PTY) tools for self-interaction testing')
	.option('--mock', 'use MockProvider instead of real API (for testing)')
	.option('--monitor <url>', 'mirror API requests to a monitor server (start one with: deepseek-arch api-monitor)')
	.option('--workspace <dir>', 'workspace root for tools & runtime files (default: current directory)')
	.option('--no-memory', 'disable long-term memory entirely (no injection, no extraction, no memory tools)')
	.option('-p, --prompt <content>', 'run a single non-interactive turn and print the reply to stdout (yolo; combines with --resume)')
	.action(async (options: { resume?: string; prompt?: string; workspace?: string; noMemory?: boolean; yolo?: boolean; short?: boolean; normal?: boolean; detail?: boolean; browser?: boolean; cdp?: string; async?: boolean; debug?: boolean; selfInteraction?: boolean; mock?: boolean; monitor?: string }) => {
		try {
			// 加载配置（幂等）——必须先于 cfg.get，否则 defaults/display 读不到
			const cfg = ConfigManager.getInstance();
			await cfg.load();

			// 工作区覆盖必须在创建 SessionManager 之前（构造时锁定会话 cwd）
			if (!applyWorkspace(options.workspace)) {
				process.exit(1);
			}

			// YOLO：CLI 参数优先（--yolo true / --no-yolo false），回退到配置文件 defaults（重启保持）；默认开启
			const yolo = options.yolo ?? cfg.get<boolean>('defaults.yolo') ?? true;
			// 展示模式：CLI flag 优先 → config [display].mode → 默认 normal
			const displayMode = resolveDisplayMode(options, cfg.get<string>('display.mode'));
			const displayPreset = buildDisplayPreset(displayMode, cfg.get('display'));
			const asyncMode = options.async ?? cfg.get<boolean>('defaults.async') ?? false;
			const debug = options.debug ?? false;
			// 请求镜像监听地址：CLI 参数优先，回退到环境变量
			const monitorUrl = options.monitor ?? process.env.DEEPSEEK_API_MONITOR_URL;
			const tuiConfig = await createTuiConfig();

			// 浏览器配置：CLI 参数优先，无则回退到环境变量
			configureBrowser({
				headed: options.browser ?? undefined,
				cdpUrl: options.cdp ?? undefined,
			});

			if (!tuiConfig.apiKey) {
				console.error('Error: api_key not configured.');
				console.error(`Set it in ${DEFAULT_CONFIG_DIR}/providers.toml or set DEEPSEEK_API_KEY env var.`);
				process.exit(1);
			}

			// 主代理工具集（debug 模式才含 tui_capture / tui_render_preview）
			const tools = loadMasterTools(debug, options.selfInteraction)
				.filter((t) => !(options.noMemory && (t.name === 'memory_read' || t.name === 'memory_write')));

			const sessionMgr = await createSessionManager(tuiConfig, tools, asyncMode, monitorUrl, options.mock);

			// --no-memory：完全关闭（不注入、不归纳、工具已在上方剔除）
			if (options.noMemory) {
				sessionMgr.configureMemory({ enabled: false });
				setMemoryStore(null);
			}
			// resume 命令的 --no-memory
			if (options?.noMemory) {
				sessionMgr.configureMemory({ enabled: false });
				setMemoryStore(null);
			}

			// 非交互单轮（headless）：不进 TUI，跑完一轮直接退出
			if (options.prompt !== undefined) {
				process.exit(await runPromptOnce(sessionMgr, options.prompt, options.resume ?? null));
			}

			if (options.resume) {
				// 按 ID 或名称查找会话
				const storage = new Storage(ConfigManager.getInstance().getSessionsDir());
				let session = await storage.getSession(options.resume);
				if (!session) {
					session = await storage.getSessionByName(options.resume);
				}
				if (!session) {
					console.error(`Session not found: ${options.resume}`);
					process.exit(1);
				}
				await sessionMgr.resumeSession(session.meta.id);
				const app = new TuiApp(sessionMgr, tuiConfig, tools, ConfigManager.getInstance(), yolo, options.mock, displayMode, displayPreset);
				if (options.selfInteraction) {
					app.setSelfInteraction(true);
				}
				if (debug) {
					setCaptureFn(() => app.captureScreen());
				}
				await app.start(session);
				return;
			}

			// 新会话
			const app = new TuiApp(sessionMgr, tuiConfig, tools, ConfigManager.getInstance(), yolo, options.mock, displayMode, displayPreset);
			if (options.selfInteraction) {
				app.setSelfInteraction(true);
			}
			if (debug) {
				setCaptureFn(() => app.captureScreen());
			}
			await app.start();
		} catch (err: any) {
			console.error('Failed to start:', err?.message ?? err);
			process.exit(1);
		}
	});

program
	.command('clear')
	.description('Delete old sessions (default: keep the 10 most recent; --below <N>: delete all sessions with fewer than N turns)')
	.option('--below <n>', 'delete all sessions with fewer than N turns (overrides keep-10 default)')
	.action(async (options: { below?: string }) => {
		try {
			await ConfigManager.getInstance().load();
			const sessionsDir = ConfigManager.getInstance().getSessionsDir();
			const storage = new Storage(sessionsDir);

			// --below <N>：按轮次阈值删除（忽略"保留最近 10 条"保护，用于清理空会话/废会话）
			// 参数先行校验（与有无会话无关）
			const below = options.below !== undefined ? Number(options.below) : undefined;
			if (below !== undefined && (!Number.isInteger(below) || below <= 0)) {
				console.error('--below 需要一个正整数（例如: clear --below 3 删除少于 3 轮的会话）');
				process.exit(1);
			}

			const sessions = await storage.listSessions();

			if (sessions.length === 0) {
				console.log('No sessions to clear.');
				process.exit(0);
			}

			if (below !== undefined) {
				const toDelete = sessions.filter((s) => s.turnCount < below);
				if (toDelete.length === 0) {
					console.log(`No sessions with fewer than ${below} turn(s).`);
					process.exit(0);
				}

				let deleted = 0;
				for (const s of toDelete) {
					const ok = await storage.deleteSession(s.id);
					if (ok) deleted++;
				}

				console.log(`Cleared ${deleted} session(s) with fewer than ${below} turn(s), kept ${sessions.length - deleted} session(s).`);
				process.exit(0);
			}

			const keep = 10;
			const toDelete = sessions.slice(keep);
			if (toDelete.length === 0) {
				console.log(`Only ${sessions.length} session(s), nothing to clear (keep ${keep} most recent).`);
				process.exit(0);
			}

			let deleted = 0;
			for (const s of toDelete) {
				const ok = await storage.deleteSession(s.id);
				if (ok) deleted++;
			}

			console.log(`Cleared ${deleted} old session(s), kept ${Math.min(sessions.length, keep)} most recent.`);
			process.exit(0);
		} catch (err: any) {
			console.error('Failed:', err?.message ?? err);
			process.exit(1);
		}
	});

program
	.command('resume [id]')
	.description('List all sessions or resume a specific one')
	.option('--browser', 'show browser window (instead of headless)')
	.option('--cdp <url>', 'connect to host browser via CDP')
	.option('--yolo', 'skip all tool confirmations (auto-approve edit/shell)')
	.option('--no-yolo', 'disable YOLO mode (ask for tool confirmations; YOLO is default)')
	.option('--short', 'compact display: think ≤4 lines, tool output hidden except file edits')
	.option('--normal', 'balanced display: think ≤4 lines, tool results ≤6 lines (default)')
	.option('--detail', 'full display (current behavior): live tool output, results ≤12 lines')
	.option('--async', 'async subagent mode (subagent_spawn returns immediately)')
	.option('--debug', 'enable TUI capture & render preview tools for model debugging')
	.option('--self-interaction', 'enable TUI session (PTY) tools for self-interaction testing')
	.option('--mock', 'use MockProvider instead of real API (for testing)')
	.option('--monitor <url>', 'mirror API requests to a monitor server (start one with: deepseek-arch api-monitor)')
	.option('--workspace <dir>', 'workspace root for tools & runtime files (default: current directory)')
	.option('--no-memory', 'disable long-term memory entirely (no injection, no extraction, no memory tools)')
	.action(async (id?: string, options?: { browser?: boolean; cdp?: string; workspace?: string; noMemory?: boolean; yolo?: boolean; short?: boolean; normal?: boolean; detail?: boolean; async?: boolean; debug?: boolean; selfInteraction?: boolean; mock?: boolean; monitor?: string }) => {
		try {
			await ConfigManager.getInstance().load();
			// 工作区覆盖必须在创建 SessionManager 之前（构造时锁定会话 cwd）
			if (options?.workspace && !applyWorkspace(options.workspace)) {
				process.exit(1);
			}
			// --no-memory：工具剔除在 createSessionManager 之后统一处理（见下方 sessionMgr 创建处）
			const sessionsDir = ConfigManager.getInstance().getSessionsDir();
			const storage = new Storage(sessionsDir);
			const monitorUrl = options?.monitor ?? process.env.DEEPSEEK_API_MONITOR_URL;

			if (id) {
				// 浏览器配置
				configureBrowser({
					headed: options?.browser ?? undefined,
					cdpUrl: options?.cdp ?? undefined,
				});
				let session = await storage.getSession(id);
				if (!session) {
					session = await storage.getSessionByName(id);
				}
				if (!session) {
					console.error(`Session not found: ${id}`);
					process.exit(1);
				}

				const tuiConfig = await createTuiConfig();
				const cfg = ConfigManager.getInstance();
				const yolo = options?.yolo ?? cfg.get<boolean>('defaults.yolo') ?? true;
				const displayMode = resolveDisplayMode(options ?? {}, cfg.get<string>('display.mode'));
				const displayPreset = buildDisplayPreset(displayMode, cfg.get('display'));
				const asyncMode = options?.async ?? cfg.get<boolean>('defaults.async') ?? false;
				const debug = options?.debug ?? false;
				const tools = loadMasterTools(debug, options?.selfInteraction);
				const sessionMgr = await createSessionManager(tuiConfig, tools, asyncMode, monitorUrl, options?.mock);
				await sessionMgr.resumeSession(session.meta.id);

				const app = new TuiApp(sessionMgr, tuiConfig, tools, ConfigManager.getInstance(), yolo, options?.mock, displayMode, displayPreset);
				if (options?.selfInteraction) {
					app.setSelfInteraction(true);
				}
				if (debug) {
					setCaptureFn(() => app.captureScreen());
				}
				await app.start(session);
				return;
			}

			// 列出会话
			const sessions = await storage.listSessions();
			if (sessions.length === 0) {
				console.log('No saved sessions found.');
				console.log('Start a new conversation with: deepseek-arch chat');
				return;
			}

			console.log('Saved sessions:');
			console.log('');
			// 列宽与行渲染保持一致（Title 最长 20 字）
			console.log(`  ${'#'.padStart(3)}  ${'ID'.padEnd(18)} ${'Title'.padEnd(21)} ${'Updated'.padEnd(19)} ${'Turns'.padStart(4)}`);
			console.log(`  ${'---'.padStart(3)}  ${'-'.repeat(18)} ${'-'.repeat(21)} ${'-'.repeat(19)} ${'-'.repeat(4)}`);

			for (const s of sessions) {
				const shortId = s.id.slice(0, 17);
				const title = (s.title || '(untitled)').slice(0, 20);
				const updated = s.updated_at.slice(0, 16).replace('T', ' ');
				console.log(
					`  ${String(s.index).padStart(3)}  ${shortId.padEnd(18)} ${title.padEnd(21)} ${updated.padEnd(19)} ${String(s.turnCount).padStart(4)}`,
				);
			}

			console.log('');
			console.log('Resume a session: deepseek-arch resume <id>');
			console.log('');

			// 交互式选择
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			const answer = await new Promise<string>((resolve) => {
				rl.question(`Select a session (1-${sessions.length}) or press Enter to cancel: `, resolve);
			});
			rl.close();

			const idx = parseInt(answer.trim(), 10);
			if (isNaN(idx) || idx < 1 || idx > sessions.length) {
				console.log('Cancelled.');
				return;
			}

			const selected = sessions[idx - 1];
			const session = await storage.getSession(selected.id);
			if (!session) {
				console.error('Session not found.');
				process.exit(1);
			}

			const tuiConfig = await createTuiConfig();
			const cfg = ConfigManager.getInstance();
			const yolo = options?.yolo ?? cfg.get<boolean>('defaults.yolo') ?? true;
			const displayMode = resolveDisplayMode(options ?? {}, cfg.get<string>('display.mode'));
			const displayPreset = buildDisplayPreset(displayMode, cfg.get('display'));
			const asyncMode = options?.async ?? cfg.get<boolean>('defaults.async') ?? false;
			const debug = options?.debug ?? false;
			const tools = loadMasterTools(debug, options?.selfInteraction);
			const sessionMgr = await createSessionManager(tuiConfig, tools, asyncMode, monitorUrl, options?.mock);
			await sessionMgr.resumeSession(session.meta.id);

			const app = new TuiApp(sessionMgr, tuiConfig, tools, ConfigManager.getInstance(), yolo, options?.mock, displayMode, displayPreset);
			if (options?.selfInteraction) {
				app.setSelfInteraction(true);
			}
			if (debug) {
				setCaptureFn(() => app.captureScreen());
			}
			await app.start(session);
		} catch (err: any) {
			console.error('Failed:', err?.message ?? err);
			process.exit(1);
		}
	});

// ─── init 子命令 ─────────────────────────────────
// 显式初始化/迁移配置：生成缺失的 config.toml/providers.toml/pricing.toml，
// 自动补全 defaults 缺失键；--force 备份并重新生成 config.toml。

program
	.command('init')
	.description('Initialize or migrate configuration files (config.toml/providers.toml/pricing.toml)')
	.option('-f, --force', 'backup and regenerate config.toml from default template')
	.action(async (options: { force?: boolean }) => {
		try {
			const cfg = ConfigManager.getInstance();
			const report = await cfg.init(!!options.force);
			console.log(`Config directory: ${report.configDir}`);
			if (report.forceBackup) console.log(`Backup created: ${report.forceBackup}`);
			if (report.created) {
				console.log('config.toml: created from default template');
			} else {
				console.log('config.toml: exists (defaults checked)');
			}
			if (report.addedDefaults.length > 0) {
				console.log(`Added default keys: ${report.addedDefaults.join(', ')}`);
			}
			for (const f of report.createdFiles) {
				console.log(`Created missing file: ${f}`);
			}
			console.log('Next: set your API key in providers.toml, then run: deepseek-arch chat');
		} catch (err: any) {
			console.error('Failed:', err?.message ?? err);
			process.exit(1);
		}
	});

// ─── api-monitor 子命令 ─────────────────────────────
// 启动 API 请求监听进程：接收 ApiClient 镜像发送的请求体，原样保存到磁盘。

program
	.command('api-monitor')
	.description('Start an API request monitor server (saves mirrored API requests for debugging)')
	.option('-p, --port <port>', 'listen port (default 8899)', '8899')
	.option('-o, --out <dir>', 'output directory (default {workspace}/.deepseek-arch/api-requests)')
	.action((options: { port?: string; out?: string }) => {
		const port = parseInt(options.port ?? '8899', 10);
		const outDir = options.out;
		const server = startApiMonitor({ port, outDir });

		const addr = server.address();
		const actualPort = typeof addr === 'object' && addr ? addr.port : port;

		console.log(`API monitor listening on http://127.0.0.1:${actualPort}`);
		console.log(`Saving mirrored requests to: ${resolve(outDir ?? getApiRequestsDir())}`);
		console.log('');
		console.log('In another terminal, mirror requests to this monitor:');
		console.log(`  deepseek-arch chat --monitor http://127.0.0.1:${actualPort}`);
		console.log(`  # or: export DEEPSEEK_API_MONITOR_URL=http://127.0.0.1:${actualPort}`);
		console.log('');
		console.log('Press Ctrl+C to stop.');

		const shutdown = (): void => {
			server.close();
			process.exit(0);
		};
		process.on('SIGINT', shutdown);
		process.on('SIGTERM', shutdown);
	});

// ─── completion 子命令 ─────────────────────────────
// 生成 bash/zsh shell 补全脚本

function generateBashCompletion(): void {
	const D = String.fromCharCode(36);
	const lines = [
		'',
		'# deepseek-arch bash completion',
		'_deepseek_arch_completions() {',
		"\tlocal cur prev words cword",
		"\t_init_completion || return",
		'',
		"\t# 第一级子命令",
		"\tif [[ " + D + "cword -eq 1 ]]; then",
		"\t\tCOMPREPLY=($(compgen -W \"chat resume clear init completion\" -- \"" + D + "cur\"))",
		"\t\treturn",
		"\tfi",
		'',
		"\t# 子命令选项",
		"\tcase \"" + D + "{words[1]}\" in",
		"\t\tchat)",
		"\t\t\tif [[ \"" + D + "cur\" == -* ]]; then",
		"\t\t\t\tCOMPREPLY=($(compgen -W \"--resume --yolo --browser --cdp --async --debug --self-interaction --mock --monitor\" -- \"" + D + "cur\"))",
		"\t\t\tfi",
		"\t\t\t;;",
		"\t\tresume)",
		"\t\t\tif [[ \"" + D + "cur\" == -* ]]; then",
		"\t\t\t\tCOMPREPLY=($(compgen -W \"--browser --cdp --yolo --async --debug --self-interaction --mock --monitor\" -- \"" + D + "cur\"))",
		"\t\t\tfi",
		"\t\t\t;;",
		"\t\tclear)",
		"\t\t\tif [[ \"" + D + "cur\" == -* ]]; then",
		"\t\t\t\tCOMPREPLY=($(compgen -W \"--below\" -- \"" + D + "cur\"))",
		"\t\t\tfi",
		"\t\t\t;;",
		"\t\tcompletion)",
		"\t\t\tCOMPREPLY=($(compgen -W \"bash zsh\" -- \"" + D + "cur\"))",
		"\t\t\t;;",
		"\tesac",
		"} &&",
		"complete -F _deepseek_arch_completions deepseek-arch",
	];
	console.log(lines.join('\n'));
}

function generateZshCompletion(): void {
	const D = String.fromCharCode(36);
	const lines = [
		'',
		'#compdef deepseek-arch',
		'',
		"_deepseek_arch() {",
		"\tlocal -a subcommands",
		"\tsubcommands=(",
		"\t\t'chat:Start a new conversation or resume an existing one'",
		"\t\t'resume:List all sessions or resume a specific one'",
		"\t\t'clear:Delete old sessions (default: keep the 10 most recent; --below N: delete sessions with fewer than N turns)'",
		"\t\t'completion:Generate shell completion script'",
		"\t)",
		'',
		"\t_arguments \\",
		"\t\t'--version[Show version]' \\",
		"\t\t'--help[Show help]' \\",
		"\t\t'1: :->command' \\",
		"\t\t'*:: :->args'",
		'',
		"\tcase " + D + "state in",
		"\t\tcommand)",
		"\t\t\t_describe -t commands 'deepseek-arch commands' subcommands",
		"\t\t\t;;",
		"\t\targs)",
		"\t\t\tcase " + D + "words[1] in",
		"\t\t\t\tchat)",
		"\t\t\t\t\t_arguments \\",
		"\t\t\t\t\t\t'--resume=[Session ID or name to resume]:id' \\",
		"\t\t\t\t\t\t'--yolo[Skip all tool confirmations]' \\",
		"\t\t\t\t\t\t'--browser[Show browser window]' \\",
		"\t\t\t\t\t\t'--cdp=[Connect to browser via CDP]:url' \\",
		"\t\t\t\t\t\t'--async[Async subagent mode]' \\",
		"\t\t\t\t\t\t'--debug[Enable TUI debug tools]' \\",
		"\t\t\t\t\t\t'--self-interaction[Enable TUI session PTY tools]' \\",
		"\t\t\t\t\t\t'--mock[Use MockProvider]' \\",
		"\t\t\t\t\t\t'--monitor=[Mirror API requests]:url'",
		"\t\t\t\t\t;;",
		"\t\t\t\tresume)",
		"\t\t\t\t\t_arguments \\",
		"\t\t\t\t\t\t'--browser[Show browser window]' \\",
		"\t\t\t\t\t\t'--cdp=[Connect to browser via CDP]:url' \\",
		"\t\t\t\t\t\t'--yolo[Skip all tool confirmations]' \\",
		"\t\t\t\t\t\t'--async[Async subagent mode]' \\",
		"\t\t\t\t\t\t'--debug[Enable TUI debug tools]' \\",
		"\t\t\t\t\t\t'--self-interaction[Enable TUI session PTY tools]' \\",
		"\t\t\t\t\t\t'--mock[Use MockProvider]' \\",
		"\t\t\t\t\t\t'--monitor=[Mirror API requests]:url'",
		"\t\t\t\t\t;;",
		"\t\t\t\tclear)",
		"\t\t\t\t\t_arguments '--below=[Delete sessions with fewer than N turns]:N:'",
		"\t\t\t\t\t;;",
		"\t\t\t\tcompletion)",
		"\t\t\t\t\t_arguments '1:shell type:(bash zsh)'",
		"\t\t\t\t\t;;",
		"\t\t\tesac",
		"\t\t\t;;",
		"\tesac",
		'}',
		'',
		"_deepseek_arch \"" + D + "@\"",
	];
	console.log(lines.join('\n'));
}

program
	.command('completion')
	.description('Generate shell completion script for bash or zsh')
	.argument('[shell]', 'Shell type: bash or zsh')
	.action((shell?: string) => {
		const sh = shell || (process.env.SHELL?.includes('zsh') ? 'zsh' : 'bash');
		if (sh === 'zsh') {
			generateZshCompletion();
		} else {
			generateBashCompletion();
		}
	});

program.parse(process.argv);
