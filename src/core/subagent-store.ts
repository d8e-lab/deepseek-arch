/**
 * subagent-store.ts — 子代理类型 re-export（兼容旧导入路径）
 *
 * 原 SubagentStore 内存缓冲已由 SubagentSession（subagent-session.ts，方案 B 全状态化）
 * 取代——会话对象自带 entries/status/messages，SessionManager 的 subagents Map 即数据源。
 * 本文件仅保留类型 re-export，避免旧导入路径（from './subagent-store.js'）断裂。
 */

export type { SubagentRecord, SubagentRoundEntry } from '../types/subagent.js';
