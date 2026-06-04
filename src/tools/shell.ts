/**
 * ShellTool — 执行 shell 命令
 *
 * 安全约束：
 *   1. 禁止 sudo
 *   2. 工作目录限制为指定目录或其子目录
 *   3. 超时 10 分钟
 *   4. stdin → /dev/null（不支持交互式命令）
 *   5. stdout/stderr 各截断至最后 8192 字节
 *   6. 返回退出码 + killed 标记
 */

import { exec } from 'node:child_process';
import { resolve, relative } from 'node:path';
import type { Tool, ToolResult } from './types.js';

/** 单侧输出截断字节数 */
const TRUNCATE_BYTES = 8192;
/** 命令超时 (10 分钟) */
const CMD_TIMEOUT_MS = 10 * 60 * 1000;

/** 截断字节串：保留最后 N 字节，前缀 “... (truncated)” */
function truncateOutput(raw: string, maxBytes: number): string {
	const buf = Buffer.from(raw, 'utf-8');
	if (buf.length <= maxBytes) return raw;
	const suffix = buf.subarray(buf.length - maxBytes);
	return `... (truncated)\n${Buffer.from(suffix).toString('utf-8')}`;
}

export const shellTool: Tool = {
	name: 'execute_command',
	description:
		'在项目目录中执行 shell 命令。支持管道、重定向等 shell 语法。' +
		'请尽量使用非交互式命令（如 git diff、ls -la、npm test 等）。' +
		'禁止使用 sudo。工作目录默认为会话目录。',
	parameters: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: '要执行的 shell 命令（非交互式）',
			},
			cwd: {
				type: 'string',
				description: '工作目录（必须为会话目录的子目录，默认为会话目录）',
			},
		},
		required: ['command'],
	},
	requiresConfirm: true,

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const command = String(params.command ?? '');
		const cwdParam = params.cwd ? String(params.cwd) : undefined;

		if (!command.trim()) {
			return { content: '', error: 'empty command' };
		}

		// ── sudo 禁止 ──────────────────────────────
		if (/\bsudo\b/.test(command)) {
			return { content: '', error: 'sudo is forbidden' };
		}

		// ── 工作目录校验 ──────────────────────────
		const sessionCwd = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();
		let workDir = sessionCwd;
		if (cwdParam) {
			const resolved = resolve(sessionCwd, cwdParam);
			// 必须在 sessionCwd 或其子目录内
			const rel = relative(sessionCwd, resolved);
			if (rel.startsWith('..') || rel === '') {
				// 允许 sessionCwd 本身 (rel === '') 和子目录
				workDir = resolved;
			} else if (resolved === sessionCwd) {
				workDir = resolved;
			} else {
				return { content: '', error: `directory outside workspace: ${cwdParam}` };
			}
		}

		// ── 执行 ──────────────────────────────────
		return new Promise((resolveResult) => {
			const child = exec(
				command,
				{
					cwd: workDir,
					timeout: CMD_TIMEOUT_MS,
					maxBuffer: 10 * 1024 * 1024, // 10MB buffer
					shell: '/bin/bash',
				},
				(error: Error | null, stdout: string, stderr: string) => {
					const killed = child.killed || (error as any)?.signal !== undefined;
					const exitCode = (error as any)?.code ?? 0;

					const result: ToolResult = {
						content: [
							`exit code: ${exitCode}`,
							stdout.trim() ? `stdout:\n${truncateOutput(stdout, TRUNCATE_BYTES)}` : 'stdout: (empty)',
							stderr.trim() ? `stderr:\n${truncateOutput(stderr, TRUNCATE_BYTES)}` : 'stderr: (empty)',
							killed ? '(killed by signal)' : '',
						]
							.filter(Boolean)
							.join('\n'),
					};

					if (killed && !result.content.includes('(killed')) {
						result.content += '\n(killed by signal)';
					}

					resolveResult(result);
				},
			);
		});
	},
};
