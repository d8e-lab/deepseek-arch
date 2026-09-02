/**
 * 展示模式预设（short / normal / detail）
 *
 * 纯数据表，供 ConversationView（render SDK）与 TuiApp（presentation）共同消费，
 * 避免各渲染路径散落魔法数字。
 *
 * 三档语义：
 *   detail  现状：think 前 5 行实时显示后折叠、工具实时输出逐行显示、结果最多 12 行
 *   normal  紧凑：think 最多 4 行、保留工具实时输出流、结果最多 6 行（默认档）
 *   short   极简：think 最多 4 行、工具调用只显示「调用 + 成功/失败」，
 *           不展示输出内容——文件修改工具（edit_file/write_file）的 diff/结果除外
 */

export type DisplayMode = 'short' | 'normal' | 'detail';

export interface DisplayPreset {
	/** 实时 think 可见行数（超出后折叠，Ctrl+O 查看完整） */
	thinkLiveLines: number;
	/** 是否逐行展示工具实时输出（tool_output：shell 等执行过程） */
	showLiveToolOutput: boolean;
	/** 工具结果（tool_result）最多展示行数 */
	toolResultMaxLines: number;
	/** short：隐藏非文件修改工具的结果内容，仅显示调用行 + 成功/失败标记 */
	hideNonFileToolResult: boolean;
}

export const DISPLAY_PRESETS: Record<DisplayMode, DisplayPreset> = {
	detail: {
		thinkLiveLines: 5,
		showLiveToolOutput: true,
		toolResultMaxLines: 12,
		hideNonFileToolResult: false,
	},
	normal: {
		thinkLiveLines: 4,
		showLiveToolOutput: true,
		toolResultMaxLines: 6,
		hideNonFileToolResult: false,
	},
	short: {
		thinkLiveLines: 4,
		showLiveToolOutput: false,
		toolResultMaxLines: 6,
		hideNonFileToolResult: true,
	},
};

/** 文件修改类工具：short 模式下仍展示其 diff 预览与结果 */
const FILE_MOD_TOOLS = new Set(['edit_file', 'write_file']);

export function isFileModTool(name?: string): boolean {
	return !!name && FILE_MOD_TOOLS.has(name);
}

/** 校验展示模式名（CLI 解析用） */
export function isDisplayMode(v: unknown): v is DisplayMode {
	return v === 'short' || v === 'normal' || v === 'detail';
}
