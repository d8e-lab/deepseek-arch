/**
 * Tools barrel file — 所有工具在此统一导出
 *
 * 新增工具步骤：
 *   1. 创建 src/tools/xxx.ts，导出具名 Tool 对象
 *   2. 在此文件加一行 export
 *   3. 无需修改其他文件
 *
 * getAllTools() 支持过滤：主代理传 { includeSubagent: true }，
 * 子代理传 {} 或省略（不含 spawn/wait/list_subagents/plan/save_plan）。
 */

import type { Tool } from './types.js';

export { shellTool } from './shell.js';
export { readFileTool } from './read-file.js';
export { searchContentTool } from './search-content.js';
export { writeFileTool } from './write-file.js';
export { editFileTool } from './edit-file.js';
export { planOnTool } from './plan.js';
export { savePlanTool } from './save-plan.js';
export { browserNavigateTool } from './browser-navigate.js';
export { browserSnapshotTool } from './browser-snapshot.js';
export { browserClickTool } from './browser-click.js';
export { browserTypeTool } from './browser-type.js';
export { browserScrollTool } from './browser-scroll.js';
export { browserNavigateBackTool } from './browser-navigate-back.js';
export { browserPressKeyTool } from './browser-press-key.js';
export { subagentSpawnTool, setSubagentRunner } from './subagent-spawn.js';
export type { SubagentRunner } from './subagent-spawn.js';
export { waitTool } from './subagent-wait.js';
export { listSubagentsTool } from './subagent-list.js';
export { tuiCaptureTool, setCaptureFn } from './tui-capture.js';
export type { CaptureFn } from './tui-capture.js';
export { tuiRenderPreviewTool } from './tui-render-preview.js';
export { tuiSessionStartTool } from './tui-session-start.js';
export { tuiSessionSendTool } from './tui-session-send.js';
export { tuiSessionReadTool } from './tui-session-read.js';
export { tuiSessionCaptureTool } from './tui-session-capture.js';
export { tuiSessionStopTool, tuiSessionListTool } from './tui-session-stop.js';

// ─── 具名 import（供 getAllTools 使用）─────────────

import { shellTool } from './shell.js';
import { readFileTool } from './read-file.js';
import { searchContentTool } from './search-content.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { planOnTool } from './plan.js';
import { savePlanTool } from './save-plan.js';
import { browserNavigateTool } from './browser-navigate.js';
import { browserSnapshotTool } from './browser-snapshot.js';
import { browserClickTool } from './browser-click.js';
import { browserTypeTool } from './browser-type.js';
import { browserScrollTool } from './browser-scroll.js';
import { browserNavigateBackTool } from './browser-navigate-back.js';
import { browserPressKeyTool } from './browser-press-key.js';
import { subagentSpawnTool } from './subagent-spawn.js';
import { waitTool } from './subagent-wait.js';
import { listSubagentsTool } from './subagent-list.js';
import { tuiCaptureTool } from './tui-capture.js';
import { tuiRenderPreviewTool } from './tui-render-preview.js';
import { tuiSessionStartTool } from './tui-session-start.js';
import { tuiSessionSendTool } from './tui-session-send.js';
import { tuiSessionReadTool } from './tui-session-read.js';
import { tuiSessionCaptureTool } from './tui-session-capture.js';
import { tuiSessionStopTool, tuiSessionListTool } from './tui-session-stop.js';

/** 所有工具（含 spawn/wait/list/plan），主代理使用 */
const ALL_TOOLS: Tool[] = [
	shellTool,
	readFileTool,
	searchContentTool,
	writeFileTool,
	editFileTool,
	planOnTool,
	savePlanTool,
	browserNavigateTool,
	browserSnapshotTool,
	browserClickTool,
	browserTypeTool,
	browserScrollTool,
	browserNavigateBackTool,
	browserPressKeyTool,
	subagentSpawnTool,
	waitTool,
	listSubagentsTool,
	tuiCaptureTool,
	tuiRenderPreviewTool,
];

/** 自我交互工具集（仅在 --self-interaction 时启用） */
const SELF_INTERACTION_TOOLS: Tool[] = [
	tuiSessionStartTool,
	tuiSessionSendTool,
	tuiSessionReadTool,
	tuiSessionCaptureTool,
	tuiSessionStopTool,
	tuiSessionListTool,
];

/** 子代理工具集（不含 spawn/wait/list/plan/save_plan） */
const SUBAGENT_TOOLS: Tool[] = [
	shellTool,
	readFileTool,
	searchContentTool,
	writeFileTool,
	editFileTool,
	browserNavigateTool,
	browserSnapshotTool,
	browserClickTool,
	browserTypeTool,
	browserScrollTool,
	browserNavigateBackTool,
	browserPressKeyTool,
];

export interface GetToolsOptions {
	includeSubagent?: boolean;
	selfInteraction?: boolean;
}

export function getAllTools(opts?: GetToolsOptions): Tool[] {
	// includeSubagent=true → 全量工具集（主代理使用，含 plan/subagent_spawn 等）
	// includeSubagent=false/undefined → 子代理工具集（不含 spawn/wait/list/plan）
	const tools = opts?.includeSubagent ? [...ALL_TOOLS] : [...SUBAGENT_TOOLS];
	if (opts?.selfInteraction) {
		tools.push(...SELF_INTERACTION_TOOLS);
	}
	return tools;
}
