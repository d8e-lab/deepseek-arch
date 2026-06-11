#!/usr/bin/env npx tsx
/**
 * KV Cache 命中率验证脚本
 *
 * 原理：
 *   DeepSeek KV cache 按前缀匹配。第 N 轮对话的消息前缀 =
 *   第 N-1 轮的完整 prompt + 第 N-1 轮的 output token。
 *
 * 验证公式：
 *   expected_cache_hit[N]  = prompt_tokens[N-1] + completion_tokens[N-1]
 *   expected_cache_miss[N] = prompt_tokens[N] - expected_cache_hit[N]
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

interface TurnRecord {
	turn: number;
	usage?: TokenUsage;
	interrupted?: boolean;
}

interface TurnResult {
	turn: number;
	hasUsage: boolean;
	expectedHit: number;
	expectedMiss: number;
	actualHit: number;
	actualMiss: number;
	promptTokens: number;
	prevPrompt: number;
	prevCompletion: number;
	hitRate: number;
	ok: boolean;
	reason?: string;
}

const DISCREPANCY_THRESHOLD = 0.05; // 5% 偏差视为异常

function analyze(turns: TurnRecord[]): TurnResult[] {
	const results: TurnResult[] = [];

	for (let i = 0; i < turns.length; i++) {
		const turn = turns[i];

		// 跳过中断的轮次（不参与缓存验证）
		if (turn.interrupted) {
			results.push({
				turn: turn.turn,
				hasUsage: false,
				expectedHit: 0,
				expectedMiss: 0,
				actualHit: 0,
				actualMiss: 0,
				promptTokens: 0,
				prevPrompt: 0,
				prevCompletion: 0,
				hitRate: 0,
				ok: true,
				reason: '⏭ 中断轮次，已跳过',
			});
			continue;
		}

		// 无 usage 数据：旧数据或首轮
		if (!turn.usage || !turn.usage.prompt_tokens) {
			results.push({
				turn: turn.turn,
				hasUsage: false,
				expectedHit: 0,
				expectedMiss: 0,
				actualHit: turn.usage?.prompt_cache_hit_tokens ?? 0,
				actualMiss: turn.usage?.prompt_cache_miss_tokens ?? 0,
				promptTokens: turn.usage?.prompt_tokens ?? 0,
				prevPrompt: 0,
				prevCompletion: 0,
				hitRate: 0,
				ok: true,
				reason: turn.turn === 1
					? '首轮，无前置轮次可对比'
					: '⚠ 无 usage 数据（旧格式或未记录）',
			});
			continue;
		}

		const currUsage = turn.usage;
		const actualHit = currUsage.prompt_cache_hit_tokens ?? 0;
		const actualMiss = currUsage.prompt_cache_miss_tokens ?? 0;

		// 找上一个有效轮次（跳过中断的）
		let prevTurn: TurnRecord | null = null;
		for (let j = i - 1; j >= 0; j--) {
			if (!turns[j].interrupted && turns[j].usage?.prompt_tokens) {
				prevTurn = turns[j];
				break;
			}
		}

		if (!prevTurn) {
			results.push({
				turn: turn.turn,
				hasUsage: true,
				expectedHit: 0,
				expectedMiss: 0,
				actualHit,
				actualMiss,
				promptTokens: currUsage.prompt_tokens,
				prevPrompt: 0,
				prevCompletion: 0,
				hitRate: currUsage.prompt_tokens > 0 ? actualHit / currUsage.prompt_tokens : 0,
				ok: true,
				reason: '无有效前置轮次',
			});
			continue;
		}

		const prevPrompt = prevTurn.usage.prompt_tokens;
		const prevCompletion = prevTurn.usage.completion_tokens;
		const expectedHit = prevPrompt + prevCompletion;
		const expectedMiss = currUsage.prompt_tokens - expectedHit;

		const hitRate = currUsage.prompt_tokens > 0
			? actualHit / currUsage.prompt_tokens
			: 0;

		// 验证：缓存命中 token 与预期偏差是否在阈值内
		const hitDiff = Math.abs(actualHit - expectedHit);
		const hitRatio = expectedHit > 0 ? hitDiff / expectedHit : 0;
		const missDiff = Math.abs(actualMiss - expectedMiss);
		const missRatio = expectedMiss > 0 ? missDiff / expectedMiss : 0;

		const ok = hitRatio <= DISCREPANCY_THRESHOLD && missRatio <= DISCREPANCY_THRESHOLD;

		let reason: string | undefined;
		if (!ok) {
			const parts: string[] = [];
			if (hitRatio > DISCREPANCY_THRESHOLD) {
				parts.push(`cache_hit 偏差 ${(hitRatio * 100).toFixed(1)}% (预期 ${expectedHit}，实际 ${actualHit})`);
			}
			if (missRatio > DISCREPANCY_THRESHOLD) {
				parts.push(`cache_miss 偏差 ${(missRatio * 100).toFixed(1)}% (预期 ${expectedMiss}，实际 ${actualMiss})`);
			}
			reason = parts.join('；');
		}

		results.push({
			turn: turn.turn,
			hasUsage: true,
			expectedHit,
			expectedMiss,
			actualHit,
			actualMiss,
			promptTokens: currUsage.prompt_tokens,
			prevPrompt,
			prevCompletion,
			hitRate,
			ok,
			reason,
		});
	}

	return results;
}

function printReport(results: TurnResult[]): void {
	console.log('');
	console.log('═══════════════════════════════════════════════════════════════');
	console.log('  KV Cache 命中率验证报告');
	console.log('═══════════════════════════════════════════════════════════════');

	let overallOK = 0;
	let overallIssues = 0;
	let totalHitTokens = 0;
	let totalPromptTokens = 0;

	for (const r of results) {
		// 跳过无数据轮次（汇总不计入）
		if (r.reason && r.reason.startsWith('⏭')) continue;

		if (r.hasUsage && r.expectedHit > 0) {
			totalHitTokens += r.actualHit;
			totalPromptTokens += r.promptTokens;

			if (r.ok) {
				overallOK++;
			} else {
				overallIssues++;
			}
		}
	}

	console.log('');
	console.log('  Turn │  Prev(p+c) │  ExpectHit │ ActualHit │  ExpectMiss │ ActualMiss │   Hit% │');
	console.log('  ─────┼────────────┼────────────┼───────────┼─────────────┼────────────┼────────│');

	for (const r of results) {
		if (!r.hasUsage && !r.reason) {
			console.log(`  ${String(r.turn).padStart(4)} │  (无 usage 数据)`);
			continue;
		}
		if (r.reason && r.reason.startsWith('⏭')) {
			console.log(`  ${String(r.turn).padStart(4)} │ ${r.reason}`);
			continue;
		}
		if (r.expectedHit === 0) {
			console.log(`  ${String(r.turn).padStart(4)} │  ${r.reason ?? '无前置'}`);
			console.log(`       │            │            │ ${String(r.actualHit).padStart(9)} │             │ ${String(r.actualMiss).padStart(10)} │ ${(r.hitRate * 100).toFixed(1).padStart(5)}% │`);
			continue;
		}

		const prevStr = `${r.prevPrompt}+${r.prevCompletion}`;
		const status = r.ok ? '✅' : '❌';

		console.log(`  ${String(r.turn).padStart(4)} │ ${prevStr.padStart(10)} │ ${String(r.expectedHit).padStart(10)} │ ${String(r.actualHit).padStart(9)} │ ${String(r.expectedMiss).padStart(11)} │ ${String(r.actualMiss).padStart(10)} │ ${(r.hitRate * 100).toFixed(1).padStart(5)}% │ ${status}`);

		if (!r.ok && r.reason) {
			console.log(`       │            │            │           │             │            │        │   ↳ ${r.reason}`);
		}
	}

	console.log('  ─────┴────────────┴────────────┴───────────┴─────────────┴────────────┴────────┘');
	console.log('');

	if (overallIssues === 0) {
		console.log(`  ✅ 全部 ${overallOK} 轮缓存命中正常`);
	} else {
		console.log(`  ❌ ${overallIssues} 轮异常 / ${overallOK + overallIssues} 轮有效`);
	}

	const overallRate = totalPromptTokens > 0
		? (totalHitTokens / totalPromptTokens * 100).toFixed(1)
		: '0.0';
	console.log(`  📊 整体缓存命中率: ${overallRate}% (${totalHitTokens}/${totalPromptTokens} tokens)`);
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

	const results = analyze(turns);
	printReport(results);

	// 如果存在异常，以非零退出码退出
	const hasIssues = results.some((r) => !r.ok && r.hasUsage && r.expectedHit > 0);
	process.exit(hasIssues ? 1 : 0);
}

main().catch((err) => {
	console.error('错误:', err.message);
	process.exit(2);
});
