/**
 * Tool 接口与相关类型
 *
 * 工具注册、调用、结果记录等类型定义。
 */

/** 工具执行结果 */
export interface ToolResult {
	content: string;
	error?: string;
}

/** 模型发起 tool call 时的请求 */
export interface ToolCallRequest {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** 持久化的 tool call 记录（含执行结果） */
export interface ToolCallRecord extends ToolCallRequest {
	result?: string;
	error?: string;
	duration_ms: number;
	/** diff 预览内容（文件修改工具执行前生成，resume 时用于重现展示） */
	preview?: string;
}

/** Tool 接口 — 每个工具必须实现 */
export interface Tool {
	/** 工具名（模型可见） */
	name: string;
	/** 工具描述（模型可见） */
	description: string;
	/** JSON Schema 参数定义（模型可见） */
	parameters: Record<string, any>;
	/** 是否需要用户确认后才执行（shell 等危险操作需要） */
	requiresConfirm: boolean;
	/**
	 * 生成执行前的 diff 预览（可选，如文件修改工具）。
	 * 返回 null 表示无预览（session.ts 跳过预览步骤）。
	 */
	preview?(params: Record<string, unknown>): Promise<string | null>;
	/** 执行工具并返回结果 */
	execute(params: Record<string, unknown>): Promise<ToolResult>;
}
