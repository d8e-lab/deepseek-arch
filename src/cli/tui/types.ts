/**
 * TUI 内部类型
 */

/** TUI 应用状态 */
export enum AppState {
	IDLE = 'IDLE',
	SENDING = 'SENDING',
	STREAMING = 'STREAMING',
	/** 等待用户确认 tool call 执行 */
	CONFIRMING = 'CONFIRMING',
	ERROR = 'ERROR',
}

/** 从 ResolvedConfig 提取的 TUI 所需配置 */
export interface TuiConfig {
	provider: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	version: string;
}
