/**
 * 表示层类型（从 src/cli/tui/types.ts 拆分）
 *
 * - 本文件：表示层（TuiApp）配置
 * - 渲染相关类型见 src/render/types.ts
 */

/** 从 ResolvedConfig 提取的 TUI 所需配置 */
export interface TuiConfig {
	provider: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	version: string;
	/** YOLO 模式下审查模型名（默认同主模型） */
	reviewModel?: string;
}
