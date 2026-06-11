#!/usr/bin/env npx tsx
/**
 * KV Cache 命中率验证脚本
 *
 * 原理：
 *   DeepSeek KV cache 按前缀匹配。第 N 轮对话(或 agent loop 第 R 轮)的消息前缀 =
 *   前一轮(前置 round)的完整 prompt + output token。
 *
 * 验证公式：
 *   expected_hit[N/R] = prompt_tokens[N-1/R-1] + completion_tokens[N-1/R-1]
 *
 * 用法：
 *   npx tsx scripts/check-cache.ts <session-id>
 *   npx tsx scripts/check-cache.ts --dir <sessions-dir> <session-id>
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface TokenUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}

interface RoundUsage {
	round: number;
	prompt_tokens: number;
	completion_tokens: number;
	cache_hit_tokens: number;
	cache_miss_tokens: number;
}

interface TurnRecord {
	turn: number;
	usage?: TokenUsage;
	interrupted?: boolean;
	round_usage?: RoundUsage[];
}

interface RoundResult {
	turn: number;
	round: number;
	promptTokens: number;
	completionTokens: number;
	actualHit: number;
	actualMiss: number;
	expectedHit: number;
	expectedMiss: number;
	hitRate: number;
	ok: boolean;
	anomaly?: string;
}

interface TurnResult {
	turn: number;
	ok: boolean;
	rounds: RoundResult[];
	reason?: string;
}

const DISCREPANCY_THRESHOLD = 0.05; // 5% 偏差视为异常

function verifyRound(
	current: RoundUsage,
	previous: RoundUsage | undefined,
	turnNumber: number,
): RoundResult {
	const hitRate = current.prompt_tokens > 0
		? current.cache_hit_tokens / current.prompt_tokens
		: 0;

	if (!previous) {
		return {
			turn: turnNumber,
			round: current.round,
			promptTokens: current.prompt_tokens,
			completionTokens: current.completion_tokens,
			actualHit: current.cache_hit_tokens,
			actualMiss: current.cache_miss_tokens,
			expectedHit: 0,
			expectedMiss: 0,
			hitRate,
			ok: true,
		};
	}

	const expectedHit = previous.prompt_tokens + previous.completion_tokens;
	const expectedMiss = current.prompt_tokens - expectedHit;

	const hitDiff = Math.abs(current.cache_hit_tokens - expectedHit);
	const hitRatio = expectedHit > 0 ? hitDiff / expectedHit : 0;
	const missDiff = Math.abs(current.cache_miss_tokens - expectedMiss);
	const missRatio = expectedMiss > 0 ? missDiff / expectedMiss : 0;

	const ok = hitRatio <= DISCREPANCY_THRESHOLD && missRatio <= DISCREPANCY_THRESHOLD;

	let anomaly: string | undefined;
	if (!ok) {
		const parts: string[] = [];
		if (hitRatio > DISCREPANCY_THRESHOLD) {
			parts.push(`cache_hit off by ${hitDiff} tokens (${(hitRatio * 100).toFixed(1)}%, exp ${expectedHit} got ${current.cache_hit_tokens})`);
		}
		if (missRatio > DISCREPANCY_THRESHOLD) {
			parts.push(`cache_miss off by ${missDiff} tokens (${(missRatio * 100).toFixed(1)}%, exp ${expectedMiss} got ${current.cache_miss_tokens})`);
		}
		anomaly = parts.join('; ');
	}

	return {
		turn: turnNumber,
		round: current.round,
		promptTokens: current.prompt_tokens,
		completionTokens: current.completion_tokens,
		actualHit: current.cache_hit_tokens,
		actualMiss: current.cache_miss_tokens,
		expectedHit,
		expectedMiss,
		hitRate,
		ok,
		anomaly,
	};
}

function analyze(turns: TurnRecord[]): { turns: TurnResult[]; allRounds: RoundResult[] } {
	const turnResults: TurnResult[] = [];
	const allRounds: RoundResult[] = [];
	let prevRound: RoundUsage | undefined;

	for (const turn of turns) {
		if (turn.interrupted) {
			turnResults.push({ turn: turn.turn, ok: true, rounds: [], reason: '⏭ 中断轮次' });
			continue;
		}

		// 优先使用 round_usage（agent loop 内每轮数据）
		if (turn.round_usage && turn.round_usage.length > 0) {
			const roundResults: RoundResult[] = [];
			for (const ru of turn.round_usage) {
				const rr = verifyRound(ru, prevRound, turn.turn);
				roundResults.push(rr);
				allRounds.push(rr);
				prevRound = ru;
			}
			turnResults.push({
				turn: turn.turn,
				ok: roundResults.every((r) => r.ok),
				rounds: roundResults,
			});
			continue;
		}

		// 回退到 turn 级别 usage
		if (!turn.usage || !turn.usage.prompt_tokens) {
			turnResults.push({
				turn: turn.turn,
				ok: true,
				rounds: [],
				reason: turn.turn === 1
					? '首轮，无前置可对比'
					: '⚠ 无 usage 数据',
			});
			continue;
		}

		const curr = {
			round: 0,
			prompt_tokens: turn.usage.prompt_tokens,
			completion_tokens: turn.usage.completion_tokens,
			cache_hit_tokens: turn.usage.prompt_cache_hit_tokens ?? 0,
			cache_miss_tokens: turn.usage.prompt_cache_miss_tokens ?? 0,
		};
		const rr = verifyRound(curr, prevRound, turn.turn);
		turnResults.push({ turn: turn.turn, ok: rr.ok, rounds: [rr] });
		allRounds.push(rr);
		prevRound = curr;
	}

	return { turns: turnResults, allRounds };
}

function printReport(result: { turns: TurnResult[]; allRounds: RoundResult[] }): void {
	const { turns, allRounds } = result;
	const validRounds = allRounds.filter((r) => r.expectedHit > 0);
	const anomalyRounds = validRounds.filter((r) => !r.ok);
	const totalHit = validRounds.reduce((s, r) => s + r.actualHit, 0);
	const totalPrompt = validRounds.reduce((s, r) => s + r.promptTokens, 0);

	console.log('');
	console.log('══════════════════════════════════════════════════════════════════');
	console.log('  KV Cache 命中率验证报告 (per-round)');
	console.log('══════════════════════════════════════════════════════════════════');
	console.log('');
	console.log('  Turn.Round │  prompt  comp │   exp_hit exp_miss │  actual_hit actual_miss │   Hit% │');
	console.log('  ───────────┼───────────────┼───────────────────┼─────────────────────────┼────────│');

	for (const turn of turns) {
		if (turn.reason) {
			console.log(`  ${String(turn.turn).padStart(4)}       │ ${turn.reason}`);
			continue;
		}
		for (const r of turn.rounds) {
			const label = `${String(r.turn).padStart(4)}.${r.round}`;
			const status = r.expectedHit === 0 ? '-' : (r.ok ? '✅' : '❌');
			const expHit = r.expectedHit > 0 ? String(r.expectedHit) : '-';
			const expMiss = r.expectedHit > 0 ? String(r.expectedMiss) : '-';

			console.log(
				`  ${label.padStart(9)} │ ${String(r.promptTokens).padStart(7)} ${String(r.completionTokens).padStart(5)} │ ${expHit.padStart(7)} ${expMiss.padStart(8)} │ ${String(r.actualHit).padStart(10)} ${String(r.actualMiss).padStart(10)} │ ${(r.hitRate * 100).toFixed(1).padStart(5)}% │ ${status}`,
			);

			if (r.anomaly) {
				console.log(`           │               │                   │                         │        │   ↳ ${r.anomaly}`);
			}
		}
	}

	console.log('  ───────────┴───────────────┴───────────────────┴─────────────────────────┴────────┘');
	console.log('');

	if (anomalyRounds.length === 0) {
		console.log(`  ✅ 全部 ${validRounds.length} 轮 (跨 turn + agent loop) 缓存命中正常`);
	} else {
		console.log(`  ❌ ${anomalyRounds.length} 轮异常 / ${validRounds.length} 轮有效`);
	}

	const overallRate = totalPrompt > 0
		? (totalHit / totalPrompt * 100).toFixed(1)
		: '0.0';
	console.log(`  📊 整体缓存命中率: ${overallRate}% (${totalHit}/${totalPrompt} tokens)`);
	console.log('');
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	let sessionsDir = join(process.env.HOME || '/tmp', '.deepseek-arch', 'sessions');
	let sessionId: string | undefined;

	if (args[0] === '--dir' || args[0] === '-d') {
		sessionsDir = args[1];
		sessionId = args[2];
	} else {
		sessionId = args[0];
	}

	if (!sessionId) {
		console.error('用法: npx tsx scripts/check-cache.ts [--dir <sessions-dir>] <session-id>');
		process.exit(1);
	}

	const turnsPath = join(sessionsDir, sessionId, 'turns.json');

	let turns: TurnRecord[];
	try {
		const raw = await readFile(turnsPath, 'utf-8');
		turns = JSON.parse(raw) as TurnRecord[];
	} catch (err: any) {
		if (err.code === 'ENOENT') {
			console.error(`会话不存在: ${sessionId}`);
			process.exit(1);
		}
		throw err;
	}

	if (turns.length === 0) {
		console.log('会话无对话记录');
		process.exit(0);
	}

	const report = analyze(turns);
	printReport(report);

	const hasIssues = report.turns.some((t) => !t.ok);
	process.exit(hasIssues ? 1 : 0);
}

main().catch((err) => {
	console.error('错误:', err.message);
	process.exit(2);
});
