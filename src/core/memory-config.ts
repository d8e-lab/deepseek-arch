/**
 * memory-config.ts — `[memory]` 配置段 → 会话层配置的**唯一**转换入口
 *
 * 背景（评审发现的"第六处漂移"）：CLI 启动路径读了完整的 21 个键，而 TUI 的
 * `/memory on` 只回填了其中 14 个，于是"关掉再打开"会让另外 7 项（inject、
 * 归纳间隔/写入配额/输入轮数与 token 预算/超时、已读更新提醒）静默回落默认值。
 *
 * 现在两条路径共用本函数，新增配置键只需要在这里加一行（配合约束 C 的五处）。
 * 未配置的键返回 undefined，由 `SessionManager.configureMemory` 的默认值兜底
 * （默认值与 `MEMORY_DEFAULTS` 保持一致）。
 */

import type { ConfigManager } from './config.js';
import type { MemorySessionConfig } from './session.js';

/** 从已加载的配置管理器读取完整的 `[memory]` 会话配置 */
export function readMemorySessionConfig(cfg: ConfigManager): MemorySessionConfig {
	return {
		enabled: cfg.get<boolean>('memory.enabled'),
		inject: cfg.get<boolean>('memory.inject'),
		maxInjectTokens: cfg.get<number>('memory.max_inject_tokens'),
		deltaInjectTokens: cfg.get<number>('memory.delta_inject_tokens'),
		masterMinConfidence: cfg.get<number>('memory.master_min_confidence'),
		recallModel: cfg.get<string>('memory.recall_model'),
		agentModel: cfg.get<string>('memory.agent_model'),
		agentOnTurnEnd: cfg.get<boolean>('memory.agent_on_turn_end'),
		agentMinIntervalSec: cfg.get<number>('memory.agent_min_interval_sec'),
		agentMaxWritesPerRun: cfg.get<number>('memory.agent_max_writes_per_run'),
		agentMaxInputTurns: cfg.get<number>('memory.agent_max_input_turns'),
		agentMaxInputTokens: cfg.get<number>('memory.agent_max_input_tokens'),
		agentTimeoutMs: cfg.get<number>('memory.agent_timeout_ms'),
		notifyReadUpdates: cfg.get<boolean>('memory.notify_read_updates'),
		lruEnabled: cfg.get<boolean>('memory.lru_enabled'),
		lruDecayActiveDays: cfg.get<number>('memory.lru_decay_active_days'),
		lruPromoteUses: cfg.get<number>('memory.lru_promote_uses'),
		lruWindowSize: cfg.get<number>('memory.lru_window_size'),
		lruTotalLimit: cfg.get<number>('memory.lru_total_limit'),
		lruDestroyAfterDays: cfg.get<number>('memory.lru_destroy_after_days'),
		lruDestroyMode: cfg.get<string>('memory.lru_destroy_mode') === 'delete' ? 'delete' : 'archive',
	};
}
