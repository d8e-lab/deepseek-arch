/**
 * TuiSessionManager — PTY 子会话管理器
 *
 * 使用 node-pty 在伪终端中启动子 deepseek-arch 实例，
 * 支持多 session 管理、输入发送、输出捕获、屏幕状态解析。
 */

import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { stripAnsi } from '../cli/tui/renderer.js';
import type { ScreenCapture, TurnCaptureInfo, ToolCallCaptureInfo, InputAreaCapture } from '../cli/tui/types.js';

// ─── 类型 ───────────────────────────────────────────

export interface SessionInfo {
	sessionId: string;
	pid: number;
	startMs: number;
	/** 最后一次活动的时间戳 */
	lastActiveMs: number;
}

interface ManagedSession {
	info: SessionInfo;
	proc: pty.IPty;
	buffer: string;
	maxBufferSize: number;
}

// ─── 管理器 ─────────────────────────────────────────

class TuiSessionManagerImpl {
	private sessions = new Map<string, ManagedSession>();

	/**
	 * 启动一个新的子 TUI 会话
	 */
	spawn(
		args: string[],
		options?: { cols?: number; rows?: number; env?: Record<string, string> },
	): SessionInfo {
		const sessionId = randomUUID().slice(0, 8);
		const cols = options?.cols ?? 300;
		const rows = options?.rows ?? 200;

		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			TERM: 'xterm-256color',
			BROWSER_HEADED: '0',
			...options?.env,
		};

		// 移除可能干扰 PTY 会话的环境变量
		delete env.BROWSER_CDP;

		const proc = pty.spawn(args[0], args.slice(1), {
			cols,
			rows,
			name: 'xterm-256color',
			env,
		});

		const maxBufferSize = 200 * 1024; // 200KB 环形缓冲

		const session: ManagedSession = {
			info: {
				sessionId,
				pid: proc.pid,
				startMs: Date.now(),
				lastActiveMs: Date.now(),
			},
			proc,
			buffer: '',
			maxBufferSize,
		};

		proc.onData((data: string) => {
			session.info.lastActiveMs = Date.now();
			session.buffer += data;
			// 环形缓冲：超出时从前面切除
			if (session.buffer.length > session.maxBufferSize) {
				const excess = session.buffer.length - session.maxBufferSize;
				session.buffer = session.buffer.slice(excess);
			}
		});

		proc.onExit(() => {
			// 进程退出后，标记 buffer 末尾
			session.buffer += '\n[process exited]\n';
		});

		this.sessions.set(sessionId, session);
		return session.info;
	}

	/**
	 * 向会话写入数据（模拟键盘输入）
	 */
	write(sessionId: string, data: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		try {
			session.proc.write(data);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 读取会话的原始输出
	 */
	readBuffer(sessionId: string): string | null {
		const session = this.sessions.get(sessionId);
		if (!session) return null;
		return session.buffer;
	}

	/**
	 * 获取最近一次全屏刷新的内容
	 * 注意：当前 TUI 使用 inline 渲染（无 alternate screen），
	 * 所以始终返回完整 buffer。lastFullRenderPos 跟踪机制
	 * 仅对使用 \x1b[2J+\x1b[H 全屏刷新的 TUI 有效。
	 */
	readLastScreen(sessionId: string): string | null {
		const session = this.sessions.get(sessionId);
		if (!session) return null;
		return session.buffer;
	}

	/**
	 * 从缓冲内容构建结构化屏幕捕获
	 */
	captureScreen(sessionId: string): ScreenCapture | null {
		const session = this.sessions.get(sessionId);
		if (!session) return null;

		const raw = this.readLastScreen(sessionId) ?? '';
		const text = stripAnsi(raw);
		// 保留所有行（包括空行），使索引与 raw 行数对齐
		const lines = text.split('\n');
		const lineDimFlags = analyzeDimPerLine(raw);

		// 终端尺寸
		const cols = session.proc.cols;
		const rows = session.proc.rows;

		// 解析 Header
		let header = '';
		const headerLine = lines.find(l => l.startsWith('deepseek-arch v'));
		if (headerLine) {
			header = headerLine;
		}

		// 解析对话轮次
		const turns: TurnCaptureInfo[] = [];
		const warnings: string[] = [];
		let currentTurnIndex = -1;
		let currentUserText = '';
		let currentThinkLines = 0;
		let currentThinkTruncated = false;
		let currentContentLines = 0;
		let currentToolCalls: ToolCallCaptureInfo[] = [];
		let currentUsage = '';
		let inThink = false;
		let inContent = false;
		let inToolCall = false;
		/** 当前行是否处于 dim 区域（根据 ANSI 分析） */
		let currentLineDim = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			currentLineDim = i < lineDimFlags.length ? lineDimFlags[i] : false;

			// 检测 [You] 开头 → 新的对话轮次
			if (line.trimStart().startsWith('[You]')) {
				// 保存上一轮
				if (currentUserText) {
					turns.push({
						index: currentTurnIndex,
						userText: currentUserText,
						thinkLines: currentThinkLines,
						thinkTruncated: currentThinkTruncated,
						contentLines: currentContentLines,
						toolCalls: currentToolCalls,
						usage: currentUsage,
					});
				}
				currentTurnIndex++;
				currentUserText = line.replace(/\[You\]\s*/, '').trim();
				currentThinkLines = 0;
				currentThinkTruncated = false;
				currentContentLines = 0;
				currentToolCalls = [];
				currentUsage = '';
				inThink = false;
				inContent = false;
				inToolCall = false;
				continue;
			}

			// 检测 [Think] 标签行
			if (line.trimStart().startsWith('[Think]')) {
				inThink = true;
				inContent = false;
				inToolCall = false;
				currentThinkLines++;
				if (line.trim().endsWith('...') || line.trimEnd().endsWith('...')) {
					currentThinkTruncated = true;
				}
				continue;
			}

			// 检测 [T:
			const toolMatch = line.match(/\[T:\s*(\w+)\]/);
			if (toolMatch) {
				inToolCall = true;
				inThink = false;
				inContent = false;
				const toolName = toolMatch[1];
				const rest = line.slice(line.indexOf(']') + 1).trim();
				currentToolCalls.push({
					name: `execute_${toolName}`,
					args: rest,
					durationMs: 0,
					resultPreview: '',
				});
				continue;
			}

			// 检测 usage 行
			if (line.includes('token:') || (line.includes('---') && (line.includes('in') || line.includes('out') || line.includes('token')))) {
				currentUsage = line.replace(/^---?\s*/, '').replace(/\s*---?$/, '').trim();
				inThink = false;
				inContent = false;
				inToolCall = false;
				continue;
			}

			// 内容行（无标签的纯文本）
			if (line.trim() && !line.startsWith('─') && !line.startsWith('Session:') &&
				!line.startsWith('deepseek-arch v')) {

				if (inThink) {
					// 如果在 think 模式，但当前行不是 dim 样式 → 已切换到 content
					if (!currentLineDim) {
						inThink = false;
						inContent = true;
						currentContentLines++;
					} else {
						currentThinkLines++;
						if (line.trim().endsWith('...')) {
							currentThinkTruncated = true;
						}
					}
				} else if (inContent || (!inToolCall && currentUserText)) {
					currentContentLines++;
				}
			}
		}

		// 保存最后一轮
		if (currentUserText) {
			turns.push({
				index: currentTurnIndex,
				userText: currentUserText,
				thinkLines: currentThinkLines,
				thinkTruncated: currentThinkTruncated,
				contentLines: currentContentLines,
				toolCalls: currentToolCalls,
				usage: currentUsage,
			});
		}

		// 解析输入区域（最后几行）
		const inputCapture: InputAreaCapture = {
			shellMode: lines.some(l => l.includes('!') && lines.indexOf(l) > lines.length - 10),
			lineCount: 0,
			maxVisibleLines: 5,
			cursorRow: 0,
			cursorCol: 0,
			textPreview: '',
		};

		// 找输入区域：从后往前找第一个有灰色背景标记或最后一行
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].trim() && !lines[i].startsWith('─')) {
				inputCapture.textPreview = lines.slice(Math.max(0, i - 4), i + 1)
					.filter(l => l.trim())
					.join('\n')
					.slice(0, 200);
				inputCapture.lineCount = lines.slice(Math.max(0, i - 4), i + 1)
					.filter(l => l.trim()).length;
				break;
			}
		}

		// 诊断警告
		for (const turn of turns) {
			if (turn.thinkTruncated) {
				warnings.push(`Turn #${turn.index + 1}: think content truncated`);
			}
		}

		return {
			terminal: { rows, cols },
			appState: 'IDLE' as any,
			header,
			turnCount: turns.length,
			turns,
			inputArea: inputCapture,
			warnings,
		};
	}

	/**
	 * 终止会话
	 */
	stop(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		try {
			session.proc.kill('SIGTERM');
			// 给子进程 2 秒优雅退出
			setTimeout(() => {
				try {
					session.proc.kill('SIGKILL');
				} catch { /* ignore */ }
			}, 2000);
		} catch {
			try { session.proc.kill('SIGKILL'); } catch { /* ignore */ }
		}
		this.sessions.delete(sessionId);
		return true;
	}

	/**
	 * 列出所有活动的会话
	 */
	list(): SessionInfo[] {
		return Array.from(this.sessions.values()).map(s => s.info);
	}

	/**
	 * 获取会话存在性检查
	 */
	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}
}

// ─── 辅助函数 ─────────────────────────────────────

/**
 * 分析原始 ANSI 文本，返回每行是否包含 dim (\x1b[2m) 样式内容。
 *
 * 用于区分 think 内容（dim）和回复内容（正常显示）。
 * 一行中只要有 \x1b[2m 就标记为 dim 行。
 */
function analyzeDimPerLine(raw: string): boolean[] {
	const rawLines = raw.split(/\r?\n/);
	return rawLines.map(line => {
		// 检查行内是否有任何 \x1b[2m 序列
		return line.includes('\x1b[2m');
	});
}

// ─── 单例导出 ───────────────────────────────────────

/** 全局唯一的 TUI Session 管理器实例 */
export const sessionManager = new TuiSessionManagerImpl();

// 进程退出时清理所有子会话
function cleanupAll() {
	const allSessions = sessionManager.list();
	for (const s of allSessions) {
		try { sessionManager.stop(s.sessionId); } catch { /* ignore */ }
	}
}
process.on('exit', cleanupAll);
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });
process.on('SIGINT', () => { cleanupAll(); process.exit(0); });
