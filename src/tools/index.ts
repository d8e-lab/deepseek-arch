/**
 * Tools barrel file — 所有工具在此统一导出
 *
 * 新增工具步骤：
 *   1. 创建 src/tools/xxx.ts，导出具名 Tool 对象
 *   2. 在此文件加一行 export
 *   3. 无需修改其他文件
 */

export { shellTool } from './shell.js';
export { readFileTool } from './read-file.js';
export { searchContentTool } from './search-content.js';
export { writeFileTool } from './write-file.js';
export { editFileTool } from './edit-file.js';
