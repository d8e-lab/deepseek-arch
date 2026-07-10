/**
 * tui_session_capture — 获取子 TUI 会话的结构化屏幕状态
 *
 * 从子会话的 PTY 输出中解析出结构化渲染报告，
 * 类似 tui_capture 但对远程子进程生效。
 */

import type { Tool, ToolResult } from './types.js';
import { sessionManager } from './tui-session-manager.js';

/** 将 ScreenCapture 格式化为文本报告（复用 tui-capture 的格式） */
function formatCapture(cap: import('../cli/tui/types.js').ScreenCapture): string {
	const lines: string[] = [];

	lines.push('=== TUI Session Screen Capture ===');
	lines.push(`Terminal: ${cap.terminal.cols}×${cap.terminal.rows}`);
	lines.push(`State: ${cap.appState}`);
	lines.push('');

	if (cap.header) {
		lines.push('── Header ──');
		lines.push(`  ${cap.header}`);
		lines.push('');
	}

	lines.push(`── Turns (${cap.turnCount}) ──`);
	for (const turn of cap.turns) {
		lines.push(`  Turn #${turn.index + 1}:`);
		const userFirstLine = turn.userText.split('\n')[0] ?? '';
		const userSnippet = userFirstLine.length > 80 ? userFirstLine.slice(0, 80) + '...' : userFirstLine;
		lines.push(`    [User] ${userSnippet}`);

		if (turn.thinkLines > 0) {
			const truncMsg = turn.thinkTruncated ? ' (TRUNCATED)' : '';
			lines.push(`    [Think] ${turn.thinkLines} lines${truncMsg}`);
		}

		for (const tc of turn.toolCalls) {
			const errMsg = tc.error ? ` ✖ ${tc.error}` : '';
			lines.push(`    [T: ${tc.name}] ${tc.args.slice(0, 120)}${errMsg}`);
		}

		if (turn.contentLines > 0) {
			lines.push(`    [Reply] ${turn.contentLines} lines`);
		}

		if (turn.usage) {
			lines.push(`    (${turn.usage})`);
		}
	}
	lines.push('');

	lines.push('── Input Area ──');
	lines.push(`  ${cap.inputArea.shellMode ? 'Shell Mode' : 'Normal'}`);
	lines.push(`  Lines: ${cap.inputArea.lineCount}/${cap.inputArea.maxVisibleLines}`);
	if (cap.inputArea.textPreview) {
		lines.push(`  Preview: ${cap.inputArea.textPreview.slice(0, 100)}`);
	}
	lines.push('');

	if (cap.warnings.length > 0) {
		lines.push('── Warnings ──');
		for (const w of cap.warnings) {
			lines.push(`  ⚠ ${w}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

export const tuiSessionCaptureTool: Tool = {
	name: 'tui_session_capture',
	description:
		'Get a structured rendering report of a child TUI session. ' +
		'Parses the PTY output to extract terminal dimensions, ' +
		'conversation turns (with user/think/tool/reply sections), ' +
		'input area state, and diagnostic warnings. ' +
		'Use this to debug TUI rendering behavior in the child session.',
	parameters: {
		type: 'object',
		properties: {
			session_id: {
				type: 'string',
				description: 'Session ID from tui_session_start',
			},
		},
		required: ['session_id'],
	},
	requiresConfirm: false,
	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const sessionId = params.session_id as string;
		if (!sessionId || !sessionManager.hasSession(sessionId)) {
			return { content: `Error: session "${sessionId}" not found.` };
		}

		// 先等一会让任何进行中的渲染完成
		await new Promise(resolve => setTimeout(resolve, 300));

		// 从 buffer 直接解析，不依赖 captureScreen 的 ANSI dim 分析
		// 因为 usage/dim 等行也有 dim 标记会干扰 think/content 区分
		const raw = sessionManager.readBuffer(sessionId) ?? '';
		if (!raw) {
			return { content: `Error: session "${sessionId}" has no data yet.` };
		}

		const stripped = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r\n?/g, '\n');
		const lines = stripped.split('\n');

		// 结构解析：找 [You]、[Think]、[T:、usage 标记
		const sections: string[] = [];
		let currentSection = '';
		let sectionType = '';

		for (const line of lines) {
			const t = line.trimStart();
			if (t.startsWith('[You]')) {
				if (currentSection) sections.push(currentSection);
				currentSection = '### User\n' + t.replace('[You] ', '');
				sectionType = 'user';
			} else if (t.startsWith('[Think]')) {
				if (currentSection) sections.push(currentSection);
				currentSection = '### Think\n' + t.replace('[Think] ', '');
				sectionType = 'think';
			} else if (t.startsWith('[T:')) {
				if (currentSection && sectionType !== 'tool') {
					sections.push(currentSection);
				}
				currentSection = (sectionType === 'tool' ? currentSection + '\n' : '### Tool\n') + t;
				sectionType = 'tool';
			} else if (line.includes('---') && (line.includes('in') || line.includes('out'))) {
				if (currentSection) sections.push(currentSection);
				currentSection = '### Usage\n' + line.replace(/^-+\s*/, '').replace(/\s*-+$/, '').trim();
				sectionType = 'usage';
			} else if (line.trim() && !line.startsWith('─') && !line.startsWith('deepseek-arch v') && !line.startsWith('Session:')) {
				// 非标签内容：追加到当前 section
				if (sectionType && currentSection) {
					const content = line.trim();
					if (content) currentSection += '\n' + content;
				}
			}
		}
		if (currentSection) sections.push(currentSection);

		const headerLine = lines.find(l => l.startsWith('deepseek-arch v')) ?? '';

		return {
			content: [
				'=== TUI Session Capture ===',
				`Terminal: 300×200  Buffer: ${raw.length} bytes`,
				headerLine ? `Header: ${headerLine}` : '',
				'',
				...sections,
				'',
				'=== End ===',
			].join('\n'),
		};
	},
};
