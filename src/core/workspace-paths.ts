/**
 * workspace-paths.ts — 工作区 runtime 目录的单一解析入口
 *
 * 约定：agent 产生的一切 runtime 文件都放在 `{workspace}/.deepseek-arch/` 下，
 * 该目录不参与版本控制（见仓库根 .gitignore）：
 *
 *   {workspace}/.deepseek-arch/
 *   ├── memory/                项目层记忆（全局层在 ~/.deepseek-arch/memory/）
 *   ├── api-requests/          API 镜像落盘（api-monitor 调试用）
 *   └── agent-file-state.json  文件改动标记（file-state）
 *
 * `{workspace}` = `DEEPSEEK_ARCH_SESSION_CWD`（SessionManager 构造时锁定，见 src/core/session.ts）
 * 未设置时回退 process.cwd()；CLI `--workspace` 可在构造前覆盖它。
 *
 * 注意：本模块不得 import 其他 core 模块（避免 tools → core → tools 的循环依赖）。
 */

import { join } from 'node:path';

/** runtime 根目录名（工作区内的相对路径） */
export const RUNTIME_DIR_NAME = '.deepseek-arch';

/** 当前工作区根目录 */
export function getSessionCwd(): string {
	return process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();
}

/** `{workspace}/.deepseek-arch` */
export function getRuntimeDir(sessionCwd: string = getSessionCwd()): string {
	return join(sessionCwd, RUNTIME_DIR_NAME);
}

/** `{workspace}/.deepseek-arch/memory`（项目层记忆；全局层为 `~/.deepseek-arch/memory`） */
export function getMemoryDir(sessionCwd: string = getSessionCwd()): string {
	return join(getRuntimeDir(sessionCwd), 'memory');
}

/** `{workspace}/.deepseek-arch/api-requests`（api-monitor 落盘目录） */
export function getApiRequestsDir(sessionCwd: string = getSessionCwd()): string {
	return join(getRuntimeDir(sessionCwd), 'api-requests');
}

/** `{workspace}/.deepseek-arch/agent-file-state.json`（文件改动标记） */
export function getFileStatePath(sessionCwd: string = getSessionCwd()): string {
	return join(getRuntimeDir(sessionCwd), 'agent-file-state.json');
}
