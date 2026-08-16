/**
 * Skill 核心引擎 — 加载、解析、发现、查找
 *
 * 职责：
 *   1. 解析 skill 文件（YAML frontmatter + Markdown 正文）
 *   2. 从多级目录加载 skill（用户配置目录 → 项目 skill/ 目录），realpath 去重
 *   3. 构建模型可见的 skill listing（预算化：总预算 + 单条截断）
 *   4. 按名称/别名查找 skill
 *   5. 生成调用时的正文（参数替换 $ARGUMENTS / ${SKILL_DIR}）
 *
 * 文件格式约定：skill/<name>.skill.md
 *   frontmatter 字段（均为可选，description 缺失时取正文首行）：
 *     name / description / when_to_use / aliases / argument-hint /
 *     context(inline|fork) / allowed-tools / model / requires-confirm / version
 *
 * 无第三方 YAML 依赖：frontmatter 为简单键值，手写轻量解析
 * （含特殊字符引号 fallback，参考 Claude Code 的 quoteProblematicValues 思路）。
 */

import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG_DIR } from './config.js';

// ─── 类型定义 ──────────────────────────────────────

/** skill 来源：用户配置目录 / 项目 skill/ 目录 */
export type SkillSource = 'user' | 'project';

/** 执行模型：inline = 内容展开进当前对话；fork = 隔离子代理执行（第二期） */
export type SkillContext = 'inline' | 'fork';

/** 解析后的 skill 元信息 */
export interface Skill {
	/** 唯一名称（默认取文件名，去掉 .skill.md） */
	name: string;
	/** 别名（模型可用别名调用） */
	aliases?: string[];
	/** 简介（模型可见；缺失时取正文首行） */
	description: string;
	/** 适用场景（模型可见，listing 中拼在简介后） */
	whenToUse?: string;
	/** 执行模型 */
	context: SkillContext;
	/** 调用后注入的工具白名单（预留） */
	allowedTools?: string[];
	/** 模型覆盖（预留） */
	model?: string;
	/** 调用前是否需要用户确认（预留，第二期） */
	requiresConfirm?: boolean;
	/** 参数提示（UI 用） */
	argumentHint?: string;
	/** 版本号 */
	version?: string;
	/** 文件真实路径 */
	skillPath: string;
	/** 来源 */
	source: SkillSource;
}

/** frontmatter 原始键值 */
type FrontmatterRaw = Record<string, string | string[] | undefined>;

// ─── 常量 ──────────────────────────────────────────

/** skill 文件后缀约定：只认 *.skill.md */
export const SKILL_FILE_RE = /\.skill\.md$/i;

/** listing 总预算（字符）—— 防止 skill 列表撑爆 system prompt */
export const SKILL_LISTING_BUDGET = 1500;
/** 单条 skill 描述截断上限（字符） */
export const MAX_SKILL_DESC_CHARS = 200;

// ─── frontmatter 解析 ──────────────────────────────

/** frontmatter 块正则（文件开头 --- 包裹） */
export const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;

/** 解析为数组的字段（逗号分隔 / [a, b] 形式） */
const ARRAY_FIELDS = new Set(['aliases', 'allowed-tools']);

/** 值含这些字符时视为"不安全"，需要引号保护（glob 等场景） */
const SPECIAL_CHARS = /[{}\[\]*#!|>%@`]|: /;

/**
 * 解析单行 "key: value"。
 * 支持：引号包裹、数组（[a, b] 或逗号分隔）、特殊字符自动加引号重试。
 */
function parseLine(line: string): [string, string | string[]] | null {
	const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
	if (!match) return null;
	const key = match[1]!;
	let value = match[2]!.trim();
	if (!value) return [key, ''];

	// 已是引号包裹 → 去引号
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}

	// 数组字段：支持 [a, b] 与 a, b 两种形式
	if (ARRAY_FIELDS.has(key)) {
		if (value.startsWith('[') && value.endsWith(']')) {
			value = value.slice(1, -1);
		}
		const items = value
			.split(',')
			.map((s) => s.trim().replace(/^["']|["']$/g, ''))
			.filter(Boolean);
		return [key, items];
	}

	return [key, value];
}

/**
 * 解析 frontmatter 块文本 → 键值对。
 * 特殊字符值（如 glob 模式）在初次解析失败后自动加引号重试。
 */
function parseFrontmatterBlock(text: string): FrontmatterRaw {
	const result: FrontmatterRaw = {};
	const problematic: Array<[string, string]> = [];

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const parsed = parseLine(line);
		if (!parsed) continue;
		const [key, value] = parsed;
		if (typeof value === 'string' && SPECIAL_CHARS.test(value)) {
			// 含特殊字符：先记录，尝试引号保护后重解析
			problematic.push([key, value]);
		}
		result[key] = value;
	}

	// 特殊字符重试：对记录的值加双引号再解析（glob 如 **\/*.{ts,tsx}）
	for (const [key, value] of problematic) {
		if (ARRAY_FIELDS.has(key)) continue; // 数组字段不走引号保护
		const quoted = `${key}: "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
		const retried = parseLine(quoted);
		if (retried && typeof retried[1] === 'string') {
			result[key] = retried[1];
		}
	}

	return result;
}

/**
 * 从正文提取简介（第一个非空行，去掉 Markdown 标题标记）。
 */
function extractDescriptionFromBody(body: string): string {
	for (const line of body.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return trimmed.replace(/^#{1,6}\s+/, '').replace(/^>\s*/, '').slice(0, 200);
	}
	return 'Custom skill';
}

/**
 * 解析 skill 文件内容 → { frontmatter 字段, 正文 }。
 * frontmatter 缺失/损坏时降级：字段取默认值，description 取正文首行。
 */
export function parseSkillFrontmatter(
	content: string,
	filePath: string,
): { fields: Omit<Skill, 'skillPath' | 'source'>; body: string } {
	const match = content.match(FRONTMATTER_REGEX);
	if (!match) {
		return {
			fields: {
				name: basename(filePath).replace(SKILL_FILE_RE, ''),
				description: extractDescriptionFromBody(content),
				context: 'inline',
			},
			body: content,
		};
	}

	const raw = parseFrontmatterBlock(match[1] || '');
	const body = content.slice(match[0].length).replace(/^\n+/, '');

	const defaultName = basename(filePath).replace(SKILL_FILE_RE, '');
	const description =
		typeof raw.description === 'string' && raw.description.trim()
			? raw.description.trim()
			: extractDescriptionFromBody(body);
	const contextRaw = typeof raw.context === 'string' ? raw.context.trim() : '';

	return {
		fields: {
			name:
				typeof raw.name === 'string' && raw.name.trim()
					? raw.name.trim()
					: defaultName,
			aliases: Array.isArray(raw.aliases) ? raw.aliases : undefined,
			description,
			whenToUse:
				typeof raw.when_to_use === 'string' && raw.when_to_use.trim()
					? raw.when_to_use.trim()
					: undefined,
			context: contextRaw === 'fork' ? 'fork' : 'inline',
			allowedTools: Array.isArray(raw['allowed-tools'])
				? raw['allowed-tools']
				: undefined,
			model:
				typeof raw.model === 'string' && raw.model.trim()
					? raw.model.trim()
					: undefined,
			requiresConfirm:
				raw['requires-confirm'] === 'true'
					? true
					: raw['requires-confirm'] === 'false'
						? false
						: undefined,
			argumentHint:
				typeof raw['argument-hint'] === 'string' && raw['argument-hint'].trim()
					? raw['argument-hint'].trim()
					: undefined,
			version:
				typeof raw.version === 'string' && raw.version.trim()
					? raw.version.trim()
					: undefined,
		},
		body,
	};
}

// ─── 加载 ──────────────────────────────────────────

/** 项目根（src/core → ../../；dist/core → ../../ 即包根） */
function getProjectRoot(): string {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	return resolve(__dirname, '..', '..');
}

/** 用户级 skill 目录（~/.deepseek-arch/skill/） */
export function getUserSkillDir(): string {
	return resolve(DEFAULT_CONFIG_DIR, 'skill');
}

/** 项目级 skill 目录（<包根>/skill/） */
export function getProjectSkillDir(): string {
	return resolve(getProjectRoot(), 'skill');
}

/** 从单个目录加载 skill（目录不存在/无权限 → 空数组） */
async function loadSkillsFromDir(dir: string, source: SkillSource): Promise<Skill[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}

	const skills: Skill[] = [];
	for (const entry of entries) {
		if (!SKILL_FILE_RE.test(entry)) continue;
		const skillPath = resolve(dir, entry);
		try {
			const content = await readFile(skillPath, 'utf-8');
			const { fields } = parseSkillFrontmatter(content, skillPath);
			skills.push({ ...fields, skillPath, source });
		} catch {
			// 单个文件解析失败不影响其他 skill
			continue;
		}
	}
	return skills;
}

/** 按真实路径去重（realpath 解析 symlink），优先级：先加载者保留（user > project） */
async function dedupeSkills(skills: Skill[]): Promise<Skill[]> {
	const seen = new Map<string, Skill>();
	for (const skill of skills) {
		let real = skill.skillPath;
		try {
			real = await realpath(skill.skillPath);
		} catch {
			// realpath 失败则用原始路径
		}
		if (!seen.has(real)) seen.set(real, skill);
	}
	return [...seen.values()];
}

let skillsCachePromise: Promise<Skill[]> | null = null;

/**
 * 从指定目录加载 skill（可注入目录，供测试与多环境使用）。
 * userDir（优先）→ projectDir，realpath 去重。
 */
export async function loadSkillsFromDirs(
	userDir: string,
	projectDir: string,
): Promise<Skill[]> {
	const [userSkills, projectSkills] = await Promise.all([
		loadSkillsFromDir(userDir, 'user'),
		loadSkillsFromDir(projectDir, 'project'),
	]);
	return dedupeSkills([...userSkills, ...projectSkills]);
}

/**
 * 加载全部 skill：用户配置目录（优先）→ 项目 skill/ 目录。
 * memoize：进程内只加载一次；clearSkillCache() 手动失效。
 */
export function loadSkills(): Promise<Skill[]> {
	if (!skillsCachePromise) {
		skillsCachePromise = loadSkillsFromDirs(getUserSkillDir(), getProjectSkillDir());
	}
	return skillsCachePromise;
}

/** 清空 skill 缓存（测试与热重载用） */
export function clearSkillCache(): void {
	skillsCachePromise = null;
}

// ─── 查找 ──────────────────────────────────────────

/**
 * 按名称查找 skill：支持别名、前导 /（/plan）、大小写不敏感。
 */
export function findSkill(name: string, skills: Skill[]): Skill | undefined {
	const normalized = name.trim().replace(/^\/+/, '');
	if (!normalized) return undefined;
	const lower = normalized.toLowerCase();
	return skills.find(
		(s) =>
			s.name === normalized ||
			s.name.toLowerCase() === lower ||
			s.aliases?.some((a) => a.toLowerCase() === lower),
	);
}

// ─── Listing（模型可见的 skill 目录）───────────────

/** 单条 entry 格式：- name: description - when to use: xxx */
function formatSkillEntry(skill: Skill): string {
	const desc = truncate(skill.description, MAX_SKILL_DESC_CHARS);
	const when = skill.whenToUse
		? ` - when to use: ${truncate(skill.whenToUse, MAX_SKILL_DESC_CHARS)}`
		: '';
	return `- ${skill.name}: ${desc}${when}`;
}

/** 截断字符串（超长加省略号） */
function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

/**
 * 构建 skill listing（模型可发现目录），受预算约束：
 *   总长 ≤ 预算 → 完整展示
 *   超预算 → 逐条截断描述；极端情况只剩名字；再超则按条截断。
 */
export function buildSkillListing(
	skills: Skill[],
	budget: number = SKILL_LISTING_BUDGET,
): string {
	if (skills.length === 0) return '';

	const header =
		'Available skills — invoke with the "skill" tool: {"skill": "<name>", "args": "..."}\n';
	const fullEntries = skills.map(formatSkillEntry);
	const fullText = fullEntries.join('\n');
	if (header.length + fullText.length <= budget) {
		return header + fullText;
	}

	// 超预算：只剩名字
	const nameEntries = skills.map((s) => `- ${s.name}`);
	const nameText = nameEntries.join('\n');
	if (header.length + nameText.length <= budget) {
		// 中间态：描述截断到可用预算。
		// 每条预留 2 字符（": " 前缀）+ 1 字符（截断省略号），保证总长严格不超。
		const descBudget = budget - header.length - nameText.length - 1;
		const perSkill = Math.max(0, Math.floor((descBudget - skills.length * 3) / skills.length));
		const lines = skills.map((s) =>
			perSkill > 0
				? `- ${s.name}: ${truncate(s.description, perSkill)}`
				: `- ${s.name}`,
		);
		return header + lines.join('\n');
	}

	// 极端：名字都放不下，按条截断
	const lines: string[] = [];
	let total = header.length;
	for (const line of nameEntries) {
		if (total + line.length + 1 > budget) break;
		lines.push(line);
		total += line.length + 1;
	}
	return header + lines.join('\n');
}

// ─── 内容生成（调用时）─────────────────────────────

/**
 * 生成 skill 调用时的正文：读文件 → 剥离 frontmatter → 参数替换。
 * 替换规则：
 *   $ARGUMENTS   → args 原样
 *   ${SKILL_DIR} → skill 文件所在目录（正文可引用同目录资源）
 */
export async function getSkillContent(skill: Skill, args: string): Promise<string> {
	const content = await readFile(skill.skillPath, 'utf-8');
	const { body } = parseSkillFrontmatter(content, skill.skillPath);
	let final = body;

	if (args) {
		final = final.replace(/\$ARGUMENTS/g, args);
	}
	final = final.replace(/\$\{SKILL_DIR\}/g, dirname(skill.skillPath));
	return final;
}

/** 供测试与工具使用的便捷入口：加载 + 查找 */
export async function findSkillByName(name: string): Promise<Skill | undefined> {
	const skills = await loadSkills();
	return findSkill(name, skills);
}
