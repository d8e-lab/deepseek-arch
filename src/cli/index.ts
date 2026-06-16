#!/usr/bin/env node
/**
 * deepseek-arch CLI 入口
 *
 * 子命令：
 *   chat                  启动新对话（或 --resume 恢复）
 *   resume [id]           列出或恢复已有会话
 *   clear                 清除旧会话（保留最近 10 条）
 */

import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { ConfigManager, DEFAULT_CONFIG_DIR } from '../core/config.js';
import { ApiClient } from '../core/api.js';
import { SessionManager } from '../core/session.js';
import { Storage } from '../core/storage.js';
import { TuiApp } from './tui/app.js';
import type { TuiConfig } from './tui/types.js';
import * as toolModules from '../tools/index.js';
import { buildSystemPromptContext } from '../core/system-info.js';

/** 从 barrel file 获取所有已注册的工具 */
function loadTools() {
	const tools = Object.values(toolModules);
	return tools;
}

const PACKAGE_VERSION = '1.2.0';

async function createTuiConfig(): Promise<TuiConfig> {
	const cfg = await ConfigManager.getInstance().load();
	const providerName = cfg.get<string>('defaults.provider') ?? 'deepseek';
	const model = cfg.get<string>('defaults.model') ?? 'deepseek-v4-pro';
	const baseUrl = cfg.get<string>(`providers.${providerName}.base_url`) ?? 'https://api.deepseek.com';
	const apiKey = cfg.get<string>(`providers.${providerName}.api_key`) ?? '';

	return {
		provider: providerName,
		model,
		baseUrl,
		apiKey,
		version: PACKAGE_VERSION,
	};
}

async function createSessionManager(config: TuiConfig): Promise<SessionManager> {
	const apiClient = new ApiClient(config.baseUrl, config.apiKey, config.model);
	const cfg = ConfigManager.getInstance();
	const sessionsDir = cfg.getSessionsDir();
	const storage = new Storage(sessionsDir);

	const sessionMgr = new SessionManager(storage, apiClient, loadTools());

	// 设置 system prompt
	const defaultPrompt = cfg.get<string>('defaults.system_prompt') ?? 'default';
	const sysContent = cfg.get<string>(`systemPrompts.${defaultPrompt}.content`);
	if (sysContent) {
		// 收集系统与环境信息，注入到 system prompt
		const envContext = await buildSystemPromptContext();
		sessionMgr.setSystemPrompt({ role: 'system', content: sysContent + '\n' + envContext });
	}

	return sessionMgr;
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
	.action(async (options: { resume?: string; yolo?: boolean }) => {
		try {
			const tuiConfig = await createTuiConfig();

			if (!tuiConfig.apiKey) {
				console.error('Error: api_key not configured.');
				console.error(`Set it in ${DEFAULT_CONFIG_DIR}/providers.toml or set DEEPSEEK_API_KEY env var.`);
				process.exit(1);
			}

			const sessionMgr = await createSessionManager(tuiConfig);

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
				const app = new TuiApp(sessionMgr, tuiConfig, loadTools(), ConfigManager.getInstance(), options.yolo);
				await app.start(session);
				return;
			}

			// 新会话
			const app = new TuiApp(sessionMgr, tuiConfig, loadTools(), ConfigManager.getInstance(), options.yolo);
			await app.start();
		} catch (err: any) {
			console.error('Failed to start:', err?.message ?? err);
			process.exit(1);
		}
	});

program
	.command('clear')
	.description('Delete all sessions except the 10 most recent')
	.action(async () => {
		try {
			await ConfigManager.getInstance().load();
			const sessionsDir = ConfigManager.getInstance().getSessionsDir();
			const storage = new Storage(sessionsDir);
			const sessions = await storage.listSessions();

			if (sessions.length === 0) {
				console.log('No sessions to clear.');
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
	.action(async (id?: string) => {
		try {
			await ConfigManager.getInstance().load();
			const sessionsDir = ConfigManager.getInstance().getSessionsDir();
			const storage = new Storage(sessionsDir);

			if (id) {
				// 按 ID 或名称恢复
				let session = await storage.getSession(id);
				if (!session) {
					session = await storage.getSessionByName(id);
				}
				if (!session) {
					console.error(`Session not found: ${id}`);
					process.exit(1);
				}

				const tuiConfig = await createTuiConfig();
				const sessionMgr = await createSessionManager(tuiConfig);
				await sessionMgr.resumeSession(session.meta.id);

				const app = new TuiApp(sessionMgr, tuiConfig, loadTools(), ConfigManager.getInstance());
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
			console.log('  #    ID                 Title              Updated             Turns');
			console.log('  ---  -----------------  -----------------  ------------------  -----');

			for (const s of sessions) {
				const shortId = s.id.slice(0, 17);
				const title = (s.title || '(untitled)').slice(0, 18);
				const updated = s.updated_at.slice(0, 16).replace('T', ' ');
				console.log(
					`  ${String(s.index).padStart(3)}  ${shortId.padEnd(18)} ${title.padEnd(19)} ${updated.padEnd(19)} ${String(s.turnCount).padStart(4)}`,
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
			const sessionMgr = await createSessionManager(tuiConfig);
			await sessionMgr.resumeSession(session.meta.id);

			const app = new TuiApp(sessionMgr, tuiConfig, loadTools(), ConfigManager.getInstance());
			await app.start(session);
		} catch (err: any) {
			console.error('Failed:', err?.message ?? err);
			process.exit(1);
		}
	});

program.parse(process.argv);
