/**
 * views — presentation 视图组件契约
 *
 * 方案 A：把 TuiApp 内嵌的全屏视图与底部子窗格抽为独立组件类，
 * 每个组件自带状态/渲染/输入处理，可单独实例化与测试。
 *
 * 契约分层：
 * - ViewComponent：全屏视图（经 OverlayPane 挂载），render + handleInput + cleanup
 * - 底部子窗格（CommandResultPane/SuggestionPane）：由 BottomArea 容器组合，
 *   提供"高度测量 + 行数组/绘制"能力（见各组件自身类型）
 */

/** 全屏视图输入处理结果 */
export type ViewInputResult = 'handled' | 'close' | 'none';

/** 全屏视图组件契约（Ctrl+O ConversationViewer / Ctrl+T SubagentsViewer） */
export interface ViewComponent {
	/** 渲染当前状态到注入的 ScreenBuffer（调用方保证已进入目标屏幕/区域） */
	render(): void;
	/**
	 * 处理输入数据（原始按键字节流）。
	 * 返回 'close' 表示视图请求关闭（由组合根执行 OverlayPane.close 生命周期）。
	 */
	handleInput(data: string): ViewInputResult;
	/** 视图关闭清理（定时器等），由组合根在 OverlayPane.close 时调用 */
	cleanup(): void;
}
