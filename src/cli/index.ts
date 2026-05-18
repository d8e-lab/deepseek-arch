/**
 * CLI 主程序 — Commander.js
 *
 * 提供：
 *   --version / -V   版本信息（含作者、日期）
 *   --help / -h      全局帮助
 *   子命令 chat / resume / help
 */

import { Command } from 'commander';
import { ConfigManager } from '../core/config.js';

const VERSION = '0.4.0';
const AUTHOR = 'helcksun';
const RELEASE_DATE = '2026-05-18';

/** 按显示宽度截断标题（CJK 字符粗略按 2 列计） */
function truncateTitle(title: string, maxWidth: number): string {
	let width = 0;
	for (let i = 0; i < title.length; i++) {
	const code = title.codePointAt(i) ?? 0;
	const cw = (code >= 0x4e00 && code <= 0x9fff) ||
				 (code >= 0x3400 && code <= 0x4dbf) ||
				 (code >= 0xf900 && code <= 0xfaff) ||
				 (code >= 0x2e80 && code <= 0x2eff) ||
				 (code >= 0x3000 && code <= 0x303f) ||
				 (code >= 0xff00 && code <= 0xffef) ||
				 (code >= 0x20000 && code <= 0x2ffff) ? 2 : 1;
	if (width + cw > maxWidth) return title.slice(0, i);
		width += cw;
	}
	return title;
}

export function createProgram(): Command {
	const program = new Command();

	program
	.name('deepseek-arch')
	.description('DeepSeek Terminal Agent — Linux 终端 AI 助手')
	.version(
		`deepseek-arch v${VERSION}\n作者: ${AUTHOR}\n发布日期: ${RELEASE_DATE}`,
		'-V, --version',
		'输出版本信息',
	)
	.helpOption('-h, --help', '显示帮助信息')
	.addHelpCommand('help [command]', '显示子命令帮助信息');

	// ---- chat 子命令 ----
	const chatCmd = new Command('chat')
	.description('开始新对话')
	.option('--title <name>', '设置对话标题')
	.helpOption('-h, --help', '显示 chat 命令帮助')
	.action(async (options) => {
		const { ChatUI } = await import('./chat-ui.js');
		const config = await ConfigManager.getInstance().load();
		const ui = new ChatUI(config);
		await ui.start();
	});

	// ---- resume 子命令 ----
	const resumeCmd = new Command('resume')
	.description('恢复历史对话。不带参数时展示对话列表供选择。')
	.option('--id <id>', '按对话 ID 精确匹配')
	.option('--name <name>', '按对话标题精确匹配')
	.helpOption('-h, --help', '显示 resume 命令帮助')
	.action(async (options) => {
		const config = await ConfigManager.getInstance().load();
		const sessionsDir = config.getSessionsDir();
		const { Storage } = await import('../core/storage.js');
		const storage = new Storage(sessionsDir);

		let sessionId: string;

		if (options.id) {
		const session = await storage.getSession(options.id);
		if (!session) {
			console.error(`未找到会话: ${options.id}`);
			process.exit(1);
		}
		sessionId = options.id;
		} else if (options.name) {
		const session = await storage.getSessionByName(options.name);
		if (!session) {
			console.error(`未找到标题为 '${options.name}' 的会话`);
			process.exit(1);
		}
		sessionId = session.meta.id;
		} else {
		// 无参数：展示会话列表供选择
		const sessions = await storage.listSessions();
		if (sessions.length === 0) {
			console.log('没有历史会话');
			process.exit(0);
		}

		// 渲染表格
		const chalk = (await import('chalk')).default;
		const headerBorder = '┌────┬──────────────────────────────────────┬──────┬──────────────────────┐';
		const midBorder   = '├────┼──────────────────────────────────────┼──────┼──────────────────────┤';
		const footerBorder= '└────┴──────────────────────────────────────┴──────┴──────────────────────┘';

		console.log(headerBorder);
		console.log(`│ ${chalk.bold('#')}  │ ${chalk.bold('标题'.padEnd(36))} │ ${chalk.bold('轮次')} │ ${chalk.bold('更新时间'.padEnd(20))} │`);
		console.log(midBorder);

		for (const s of sessions) {
			const idx  = String(s.index).padEnd(2);
			const title = s.title || '(未命名)';
			// 截断过长标题，CJK 字符粗略按 2 列计
			const displayTitle = truncateTitle(title, 36);
			const turns = String(s.turnCount).padEnd(4);
			const updated = s.updated_at.replace('T', ' ').slice(0, 16);
			console.log(`│ ${idx} │ ${displayTitle.padEnd(36)} │ ${turns} │ ${updated.padEnd(20)} │`);
		}

		console.log(footerBorder);

		// 读取用户输入
		const { createInterface } = await import('node:readline');
		const rl = createInterface({ input: process.stdin, output: process.stdout });

		const index = await new Promise<number>((resolve) => {
			rl.question('输入序号恢复会话: ', (answer) => {
			rl.close();
			const n = parseInt(answer.trim(), 10);
			if (isNaN(n) || n < 1 || n > sessions.length) {
				console.error(`无效序号: ${answer}`);
				process.exit(1);
			}
			resolve(n);
			});
		});

		sessionId = sessions[index - 1].id;
		}

		// 创建 ApiClient + SessionManager
		const provider = config.get<string>('defaults.provider') ?? 'deepseek';
		const model = config.get<string>('defaults.model') ?? 'deepseek-v4-pro';
		const baseUrl = config.get<string>(`providers.${provider}.base_url`) ?? '';
		const apiKey = config.get<string>(`providers.${provider}.api_key`) ?? '';

		if (!apiKey) {
		const chalk = (await import('chalk')).default;
		console.error(chalk.red('错误: 未配置 API Key'));
		console.error(chalk.dim(`  请在 ~/.deepseek-arch/providers.toml 中设置 [${provider}].api_key`));
		process.exit(1);
		}

		const { ApiClient } = await import('../core/api.js');
		const { SessionManager } = await import('../core/session.js');
		const apiClient = new ApiClient(baseUrl, apiKey, model);
		const sessionManager = new SessionManager(storage, apiClient);
		await sessionManager.resumeSession(sessionId);

		// 加载 system prompt
		const sysPromptName = config.get<string>('defaults.system_prompt') ?? 'default';
		const sysPromptContent = config.get<string>(`systemPrompts.${sysPromptName}.content`);
		if (sysPromptContent) {
		sessionManager.setSystemPrompt({ role: 'system', content: sysPromptContent });
		}

		// 启动 ChatUI
		const { ChatUI } = await import('./chat-ui.js');
		const ui = new ChatUI(config, sessionManager);
		await ui.start();
	});

	program.addCommand(chatCmd);
	program.addCommand(resumeCmd);

	return program;
}

export async function run(): Promise<void> {
	const program = createProgram();
	await program.parseAsync(process.argv);
}
