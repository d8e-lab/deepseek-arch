/**
 * cache-log — KV cache 命中率监控日志
 *
 * 在 agent loop 每轮 API 调用后记录 token 使用情况，
 * 根据公式验证缓存是否正确命中，偏差超过阈值标记为异常。
 *
 * 公式：expected_hit[round N] = prompt_tokens[round N-1] + completion_tokens[round N-1]
 *
 * 日志位置：<sessionsDir>/<sessionId>/cache.log
 * 格式：空格分隔的键值对，单行，可 grep
 */
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RoundUsage } from '../types/chat.js';

/** 偏差阈值（5%） */
const ANOMALY_THRESHOLD = 0.05;

export interface CacheCheckResult {
	ok: boolean;
	anomaly?: string;
	expectedHit: number;
	expectedMiss: number;
}

/** 验证本轮缓存命中是否与预期一致 */
export function verifyCacheHit(
	current: RoundUsage,
	previous: RoundUsage | undefined,
): CacheCheckResult {
	if (!previous) {
		// 首轮无法验证（无前置数据），只能报告实际命中率
		const hitRate = current.prompt_tokens > 0
			? current.cache_hit_tokens / current.prompt_tokens
			: 0;
		return {
			ok: true,
			expectedHit: 0,
			expectedMiss: 0,
		};
	}

	const expectedHit = previous.prompt_tokens + previous.completion_tokens;
	const expectedMiss = current.prompt_tokens - expectedHit;

	const hitDiff = Math.abs(current.cache_hit_tokens - expectedHit);
	const hitRatio = expectedHit > 0 ? hitDiff / expectedHit : 0;
	const missDiff = Math.abs(current.cache_miss_tokens - expectedMiss);
	const missRatio = expectedMiss > 0 ? missDiff / expectedMiss : 0;

	const hitOk = hitRatio <= ANOMALY_THRESHOLD;
	const missOk = missRatio <= ANOMALY_THRESHOLD;

	const parts: string[] = [];
	if (!hitOk) {
		parts.push(`cache_hit off by ${hitDiff} tokens (${(hitRatio * 100).toFixed(1)}%, expected ${expectedHit} got ${current.cache_hit_tokens})`);
	}
	if (!missOk) {
		parts.push(`cache_miss off by ${missDiff} tokens (${(missRatio * 100).toFixed(1)}%, expected ${expectedMiss} got ${current.cache_miss_tokens})`);
	}

	return {
		ok: hitOk && missOk,
		anomaly: parts.length > 0 ? parts.join('; ') : undefined,
		expectedHit,
		expectedMiss,
	};
}

/** 格式化单轮日志行 */
function formatLogLine(
	sessionId: string,
	turnNumber: number,
	round: number,
	usage: RoundUsage,
	result: CacheCheckResult,
): string {
	const ts = new Date().toISOString();
	const hitRate = usage.prompt_tokens > 0
		? ((usage.cache_hit_tokens / usage.prompt_tokens) * 100).toFixed(1)
		: '0.0';

	const parts = [
		ts,
		`sid=${sessionId.slice(0, 8)}`,
		`turn=${turnNumber}`,
		`round=${round}`,
		`prompt=${usage.prompt_tokens}`,
		`comp=${usage.completion_tokens}`,
		`hit=${usage.cache_hit_tokens}(${hitRate}%)`,
		`miss=${usage.cache_miss_tokens}`,
	];

	if (result.expectedHit > 0) {
		parts.push(`exp_hit=${result.expectedHit}`);
		parts.push(`exp_miss=${result.expectedMiss}`);
	}

	if (result.anomaly) {
		parts.push(`ANOMALY ${result.anomaly}`);
	} else {
		parts.push('OK');
	}

	return parts.join(' | ');
}

/** 写入一条缓存监控日志 */
export async function appendCacheLog(
	sessionsDir: string,
	sessionId: string,
	turnNumber: number,
	roundUsages: RoundUsage[],
): Promise<void> {
	const logPath = join(sessionsDir, sessionId, 'cache.log');

	for (let i = 0; i < roundUsages.length; i++) {
		const prev = i > 0 ? roundUsages[i - 1] : undefined;
		const result = verifyCacheHit(roundUsages[i], prev);
		const line = formatLogLine(sessionId, turnNumber, roundUsages[i].round, roundUsages[i], result);

		try {
			await appendFile(logPath, line + '\n', 'utf-8');
		} catch {
			// 日志写入失败不阻塞主流程
		}
	}
}
