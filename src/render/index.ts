/**
 * 渲染 SDK（Render SDK）— 公开导出
 *
 * 无 I/O 的渲染组件库：输出 ANSI 字符串行数组，终端接入由表示层负责。
 * 用法：`import { ConversationView, wrapText } from 'deepseek-arch/render';`
 */
export { ConversationView, wrapText, truncateThink, renderToolCallLine, renderToolResultLines, renderToolError } from './conversation.js';
export { MarkdownTableRenderer } from './markdown.js';
export { InputEditor } from './input-editor.js';
export { Selector } from './selector.js';
export type { SelectOption, SelectorIO } from './selector.js';
export { SubagentRecordView } from './subagent-record-view.js';
export * from './ansi.js';
export * from './types.js';
