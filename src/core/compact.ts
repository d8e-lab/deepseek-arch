/**
 * compact.ts — 上下文压缩核心逻辑
 *
 * 职责：
 *   1. 生成结构化摘要（独立非流式模型调用，按 compact.skill Phase 2 类别）
 *   2. 提取会话中 Read 工具读过的文件，重注入最新内容（大小分流 + 预算控制）
 *   3. 提取当前 plan 文件内容与本次会话调用过的 skills
 *   4. 组装 compact 后的消息序列（摘要 + 重注入块），供新分代文件写入
 *
 * 关键设计：compact 后 master agent 请求上下文 = 摘要 + 重注入块 + 后续轮次；
 * 磁盘分代文件保留全部历史（用户视角可回查）。
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelProvider } from './model-provider.js';
import type { TurnRecord, Message } from '../types/index.js';
import type { ToolCallRecord } from '../tools/types.js';
import { turnUserContent, turnAssistantContent } from '../utils/turn-utils.js';

// ─── 常量（后续可配置化）───────────────────────────

/** 文件重注入数量上限（硬限制） */
export const MAX_RESTORE_FILES = 5;
/** 每文件 token 上限：超过则只给 <compact_file_reference> 引用 */
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;
/** 文件内容总 token 预算：累加超过丢弃较旧文件 */
export const POST_COMPACT_TOKEN_BUDGET = 50_000;
/** 文件大小上限（字节）：超过则只给引用 */
export const MAX_FILE_BYTES = 256 * 1024;
/** 每个 skill 截断上限（tokens） */
export const SKILL_MAX_TOKENS = 5_000;
/** skills 总预算（tokens） */
export const SKILLS_TOKEN_BUDGET = 25_000;
/** plan 文件截断上限（tokens） */
export const PLAN_MAX_TOKENS = 5_000;

/** 排除路径前缀：plan 文件 / memory 预留（后续 memory 机制接入） */
const EXCLUDED_PREFIXES = ['.plans/', 'memory/', '.memory/'];

/** 工具名 → skill 文件映射（旧版兼容：plan_on 工具） */
const SKILL_MAP: Record<string, string> = {
	plan_on: 'plan.skill.md',
};

/**
 * 从工具调用记录解析 skill 文件名。
 * 新机制：skill 工具调用，skill 名在 arguments.skill（可能带别名/前导斜杠）。
 * 旧机制：硬编码工具名映射（SKILL_MAP 兼容）。
 */
function skillFileNameFromCall(tcr: ToolCallRecord): string | undefined {
	if (tcr.name === 'skill') {
		const arg = (tcr.arguments as Record<string, unknown> | undefined)?.skill;
		if (typeof arg === 'string' && arg.trim()) {
			const base = arg.trim().replace(/^\/+/, '');
			return base.endsWith('.skill.md') ? base : `${base}.skill.md`;
		}
	}
	return SKILL_MAP[tcr.name];
}

// ─── 工具函数 ──────────────────────────────────────

/** 粗略 token 估算：UTF-8 字节数 / 3 */
export function estimateTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, 'utf-8') / 3);
}

/** 按 token 上限截断文本（近似字节截断，末尾加标记） */
export function truncateTokens(text: string, maxTokens: number): string {
	const buf = Buffer.from(text, 'utf-8');
	const maxBytes = maxTokens * 3;
	if (buf.length <= maxBytes) return text;
	return buf.subarray(0, maxBytes).toString('utf-8') + '\n...(truncated)';
}

/** 路径规范化：统一正斜杠、去掉开头的 ./ 与尾部斜杠 */
function normalizePath(p: string): string {
	let s = p.replace(/\\/g, '/').trim();
	while (s.startsWith('./')) s = s.slice(2);
	s = s.replace(/\/+$/, '');
	return s;
}

// ─── Read 文件提取与重注入 ─────────────────────────

/** 会话中 Read 工具读过的文件记录 */
export interface ReadFileRecord {
	/** 相对会话目录路径（规范化） */
	path: string;
	/** 最后访问时间戳（轮次时间 + 调用序号近似） */
	lastAccessMs: number;
	/** 全局调用序号（同轮次内保持调用顺序，次级排序键） */
	seq: number;
}

/**
 * 从历史轮次提取 Read 工具读过的文件。
 * 去重：同路径只保留最后访问的记录；排除 plan / memory 路径。
 * 排序：按最后访问时间降序（同时间按调用序号降序）。
 */
export function extractReadFiles(turns: TurnRecord[]): ReadFileRecord[] {
	const byPath = new Map<string, ReadFileRecord>();
	let seq = 0;
	for (const turn of turns) {
		const t = new Date(turn.created_at).getTime() || 0;
		for (const tcr of turn.tool_calls ?? []) {
			if (tcr.name !== 'read_file') continue;
			const raw = String(tcr.arguments?.path ?? '');
			if (!raw) continue;
			const norm = normalizePath(raw);
			if (EXCLUDED_PREFIXES.some((p) => norm.startsWith(p))) continue;
			const rec: ReadFileRecord = { path: norm, lastAccessMs: t, seq };
			const prev = byPath.get(norm);
			// 保留最后访问（时间更大；相等时序号更大 = 后调用）
			if (!prev || rec.lastAccessMs > prev.lastAccessMs
				|| (rec.lastAccessMs === prev.lastAccessMs && rec.seq > prev.seq)) {
				byPath.set(norm, rec);
			}
			seq++;
		}
	}
	return [...byPath.values()].sort(
		(a, b) => b.lastAccessMs - a.lastAccessMs || b.seq - a.seq,
	);
}

/**
 * 为选中的文件构建重注入块。
 * 大小分流：≤5K tokens 且 ≤256KB → 完整读入最新盘上内容；
 * 超限 → 只给 <compact_file_reference> 引用（模型按需自行 Read）。
 * 预算：累加超过 POST_COMPACT_TOKEN_BUDGET 丢弃较旧文件。
 */
export async function buildFileRestoreBlock(
	files: ReadFileRecord[],
	sessionCwd: string,
): Promise<{ text: string; tokenCount: number }> {
	const parts: string[] = [];
	let totalTokens = 0;

	for (const file of files.slice(0, MAX_RESTORE_FILES)) {
		const resolved = resolve(sessionCwd, file.path);

		// 读取最新内容 + 大小检查
		let content: string;
		try {
			const st = await stat(resolved);
			if (st.size > MAX_FILE_BYTES) throw new Error('too large');
			content = await readFile(resolved, 'utf-8');
		} catch {
			// 缺失 / 不可读 / 超过字节上限 → 引用
			const ref = `<compact_file_reference path="${file.path}">File not restorable (missing, unreadable, or > ${MAX_FILE_BYTES} bytes). Use read_file to load it.</compact_file_reference>`;
			parts.push(ref);
			totalTokens += estimateTokens(ref);
			continue;
		}

		const tokens = estimateTokens(content);
		if (tokens > POST_COMPACT_MAX_TOKENS_PER_FILE) {
			// 超过 token 上限 → 引用（一行内容都不给）
			const ref = `<compact_file_reference path="${file.path}">File too large to restore (${tokens} tokens > ${POST_COMPACT_MAX_TOKENS_PER_FILE} limit). Use read_file to load it.</compact_file_reference>`;
			parts.push(ref);
			totalTokens += estimateTokens(ref);
			continue;
		}

		// 预算检查：超了丢弃（后面更旧的文件也一并丢弃）
		if (totalTokens + tokens > POST_COMPACT_TOKEN_BUDGET) break;

		parts.push(`[Compact File Restore] path: ${file.path} (${tokens} tokens)\n${content}`);
		totalTokens += tokens;
	}

	return { text: parts.join('\n\n'), tokenCount: totalTokens };
}

// ─── Skills 提取 ───────────────────────────────────

/** 会话中调用过的 skill 记录 */
export interface SkillRecord {
	/** skill 文件名（如 plan.skill.md） */
	name: string;
	/** 最近调用时间戳 */
	lastCallMs: number;
	/** 全局调用序号（次级排序键） */
	seq: number;
}

/** 从历史轮次提取本次会话调用过的 skills（按最近调用排序，去重） */
export function extractSkills(turns: TurnRecord[]): SkillRecord[] {
	const byName = new Map<string, SkillRecord>();
	let seq = 0;
	for (const turn of turns) {
		const t = new Date(turn.created_at).getTime() || 0;
		for (const tcr of turn.tool_calls ?? []) {
			const name = skillFileNameFromCall(tcr);
			if (!name) continue;
			const rec: SkillRecord = { name, lastCallMs: t, seq };
			const prev = byName.get(name);
			if (!prev || rec.lastCallMs > prev.lastCallMs
				|| (rec.lastCallMs === prev.lastCallMs && rec.seq > prev.seq)) {
				byName.set(name, rec);
			}
			seq++;
		}
	}
	return [...byName.values()].sort(
		(a, b) => b.lastCallMs - a.lastCallMs || b.seq - a.seq,
	);
}

/** 读取 skill 文件内容（配置目录 → 项目 skill/ 目录 fallback） */
async function readSkillContent(name: string): Promise<string | null> {
	const candidates = [
		resolve(homedir(), '.deepseek-arch', 'skill', name),
		resolve(process.cwd(), 'skill', name),
	];
	for (const p of candidates) {
		try {
			return await readFile(p, 'utf-8');
		} catch {
			/* 尝试下一个 */
		}
	}
	return null;
}

/** 构建 skills 重注入块（每 skill 截断 5K，总预算 25K） */
export async function buildSkillsBlock(
	turns: TurnRecord[],
): Promise<{ text: string; tokenCount: number }> {
	const skills = extractSkills(turns);
	const parts: string[] = [];
	let total = 0;
	for (const s of skills) {
		const content = await readSkillContent(s.name);
		if (!content) continue;
		const truncated = truncateTokens(content, SKILL_MAX_TOKENS);
		const tokens = estimateTokens(truncated);
		if (total + tokens > SKILLS_TOKEN_BUDGET) break;
		parts.push(`[Skill: ${s.name}]\n${truncated}`);
		total += tokens;
	}
	return { text: parts.join('\n\n'), tokenCount: total };
}

// ─── Plan 文件提取 ─────────────────────────────────

/** 从历史轮次提取 save_plan 调用保存的 plan 文件名（按最近调用排序，去重） */
export function extractPlanNames(turns: TurnRecord[]): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	// 从最新轮次到最旧，轮内从后到前（后调用 = 更新）
	for (let i = turns.length - 1; i >= 0; i--) {
		const tcs = turns[i].tool_calls ?? [];
		for (let j = tcs.length - 1; j >= 0; j--) {
			const tcr = tcs[j];
			if (tcr.name !== 'save_plan') continue;
			const name = String(tcr.arguments?.plan_name ?? '');
			if (!name || seen.has(name)) continue;
			seen.add(name);
			names.push(name);
		}
	}
	return names;
}

/** 构建 plan 重注入块（读 .plans/<name>.md 最新内容，截断 PLAN_MAX_TOKENS） */
export async function buildPlanBlock(
	turns: TurnRecord[],
	sessionCwd: string,
): Promise<{ text: string; tokenCount: number }> {
	const names = extractPlanNames(turns);
	const parts: string[] = [];
	let total = 0;
	for (const name of names) {
		const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
		const filePath = join(sessionCwd, '.plans', `${safe}.md`);
		try {
			const content = await readFile(filePath, 'utf-8');
			const truncated = truncateTokens(content, PLAN_MAX_TOKENS);
			const tokens = estimateTokens(truncated);
			if (total + tokens > PLAN_MAX_TOKENS) break;
			parts.push(`[Current Plan: ${name}]\n${truncated}`);
			total += tokens;
		} catch {
			/* plan 文件不存在 → 跳过 */
		}
	}
	return { text: parts.join('\n\n'), tokenCount: total };
}

// ─── 摘要生成 ──────────────────────────────────────

/** 摘要生成 system prompt（按 compact.skill Phase 2 类别） */
const SUMMARY_PROMPT = `你是一个对话压缩引擎。你的任务是把一段长对话历史压缩为结构化摘要，使"只有这份摘要 + 后续新内容"的模型仍能无缝继续任务。

摘要必须包含以下类别（逐轮扫描，不遗漏关键信息）：
1. **用户目标**：用户最初要解决什么问题、各轮提出的需求（原话要点）、特定设计的原因和场景
2. **决策**：已确定的技术方案、被否决的方案及原因
3. **变更**：修改/创建了哪些文件（路径 + 一句话变更）、git 提交/分支
4. **工具调用与结果**：调用了哪些工具（哪些成功/失败/被用户拒绝）、shell 命令的具体命令、调研结论、浏览器访问的 URL、完整保留给 subagent 的指令和汇报
5. **Plan 与未完成事项**：引用的 plan 文件、明确标记 ⏳ 的待办、已完成工作、被中断的工作、下一步计划
6. **约束**：用户设定的安全/风格/范围限制

要求：
- 用中文输出（除非原文是英文）
- 保留文件路径、命令、URL、commit hash 等精确信息，不要概括丢失
- 压缩冗余的中间过程（冗长 shell 输出省略为结论），但保留结论与关键数字
- 写好后设想"下一轮只有这份摘要，能否继续任务"——能，才合格
- 直接输出摘要正文，不要输出其他解释`;

/** 将轮次序列化为文本（供摘要模型阅读） */
function serializeTurns(turns: TurnRecord[]): string {
	const parts: string[] = [];
	for (let i = 0; i < turns.length; i++) {
		const turn = turns[i];
		const user = turnUserContent(turn);
		const assistant = turnAssistantContent(turn);
		const tc = turn.tool_calls ?? [];
		const tools = tc.length > 0
			? `\n工具调用:\n${tc.map((t) => `  - ${t.name} ${JSON.stringify(t.arguments ?? {})} → ${(t.result ?? '').slice(0, 200)}${t.error ? ` [error: ${t.error}]` : ''}`).join('\n')}`
			: '';
		parts.push(
			`[轮次 ${i + 1}${turn.type === 'compact' ? '（历史摘要）' : ''}]` +
			`\n用户: ${user.slice(0, 1000)}` +
			`${tools}` +
			(assistant ? `\n助手: ${assistant.slice(0, 2000)}` : ''),
		);
	}
	return parts.join('\n\n---\n\n');
}

/**
 * 生成结构化摘要（独立非流式模型调用）。
 * 失败时回退为"简单轮次罗列"（不阻断 compact 流程）。
 */
export async function generateSummary(provider: ModelProvider, turns: TurnRecord[]): Promise<string> {
	const messages: Message[] = [
		{ role: 'system', content: SUMMARY_PROMPT },
		{ role: 'user', content: `以下是需要压缩的对话历史：\n\n${serializeTurns(turns)}` },
	];
	try {
		const resp = await provider.chat(messages, { temperature: 0.3 });
		const content = resp.choices[0]?.message?.content ?? '';
		return content.trim() || `(compact fallback) 历史共 ${turns.length} 轮已压缩，详见磁盘分代文件。`;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return `(compact fallback: 摘要生成失败 ${msg}) 历史共 ${turns.length} 轮已压缩，详见磁盘分代文件。`;
	}
}

// ─── 组装 ──────────────────────────────────────────

/**
 * 组装 compact 后的消息序列：
 * [摘要 user] + [文件重注入 user] + [plan user] + [skills user]
 */
export function buildCompactMessages(
	summary: string,
	restoreText: string,
	planText: string,
	skillsText: string,
): Message[] {
	const messages: Message[] = [
		{ role: 'user', content: `[Compacted Context Summary]\n${summary}` },
	];
	if (restoreText) {
		messages.push({ role: 'user', content: `[Compact File Restore Block]\n${restoreText}` });
	}
	if (planText) {
		messages.push({ role: 'user', content: `[Compact Plan]\n${planText}` });
	}
	if (skillsText) {
		messages.push({ role: 'user', content: `[Compact Skills]\n${skillsText}` });
	}
	return messages;
}

/** 构造摘要轮 TurnRecord（写入新分代文件的第一条） */
export function buildCompactTurn(summary: string, messages: Message[]): TurnRecord {
	return {
		type: 'compact',
		version: 2,
		summary,
		messages,
		cost_rmb: 0,
		created_at: new Date().toISOString(),
	};
}
