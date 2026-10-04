/**
 * image-refs.ts — 从用户输入文本中识别本地图片路径
 *
 * 支持的写法（终端里常见来源）：
 *   1. `@/tmp/a.png`、`@./shot.png`、`@"带 空格.png"`  —— 显式引用，任意相对/绝对路径；
 *   2. 绝对路径裸文本 `/tmp/a.png`（终端拖拽文件的默认产物）；
 *   3. `~/Pictures/a.png`、`file:///tmp/a.png`；
 *   4. 被单/双引号包裹，或空格被反斜杠转义（`/tmp/my\ shot.png`）。
 *
 * 设计约束：
 *   - **相对裸路径不自动识别**（如正文里讨论 `assets/logo.png`），否则普通对话会被误判成附件；
 *     需要相对路径时用 `@` 前缀显式声明；
 *   - 候选先按扩展名预筛（.png/.jpg/.jpeg/.gif/.webp），真正的格式判定仍以文件内容为准
 *     （由 ImageStore 嗅探魔数），避免逐个尝试打开正文里出现的任意文件。
 *
 * 本模块只做「文本 → 候选路径」的解析；不存在的路径静默忽略，输入原样可用。
 */

import { isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/** 预筛扩展名（真正的格式判定仍以文件内容为准） */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/** 需要在 token 末尾剥离的 ASCII 标点（英文行文常紧贴路径） */
const TRAILING_PUNCTUATION = ',.;:!?)]}\'"';

/** 一次扫描命中的图片引用 */
export interface ImageRefHit {
	/** 原文中的完整片段（用于诊断） */
	raw: string;
	/** 解析后的绝对路径 */
	path: string;
	/** 是否来自 `@` 显式引用 */
	explicit: boolean;
}

/**
 * 扫描文本中的图片引用。
 *
 * @param text 用户输入原文
 * @param cwd  相对路径基准目录（默认进程 cwd）
 * @returns 去重后的候选路径（保持出现顺序）
 */
export function extractImageRefs(text: string, cwd: string = process.cwd()): ImageRefHit[] {
	if (!text) return [];

	const hits: ImageRefHit[] = [];
	const seen = new Set<string>();

	for (const token of tokenize(text)) {
		if (!looksLikeImagePath(token.value)) continue;

		const path = resolveToken(token.value, cwd);
		if (!path || seen.has(path)) continue;
		seen.add(path);
		hits.push({ raw: token.raw, path, explicit: token.explicit });
	}

	return hits;
}

interface Token {
	/** 已去引号/去转义的路径原文 */
	value: string;
	/** 原文片段 */
	raw: string;
	/** 是否来自 `@` 显式引用 */
	explicit: boolean;
}

/**
 * 把文本切分为候选路径 token。
 *
 * 实现为「按位置扫描 + 边界判定」，而非全局正则：需要正确处理
 * 中文标点、引号包裹与反斜杠转义空格。
 */
function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < text.length) {
		const ch = text[i];

		// `@` 显式引用：@path 或 @"path" / @'path'
		if (ch === '@') {
			const quoted = readQuoted(text, i + 1);
			if (quoted) {
				tokens.push({ value: quoted.value, raw: text.slice(i, quoted.end), explicit: true });
				i = quoted.end;
				continue;
			}
			const bare = readBare(text, i + 1);
			if (bare) {
				tokens.push({ value: bare.value, raw: text.slice(i, bare.end), explicit: true });
				i = bare.end;
				continue;
			}
			i++;
			continue;
		}

		// 引号包裹的路径（拖拽终端有时会加引号）
		if (ch === '"' || ch === '\'') {
			const quoted = readQuoted(text, i);
			if (quoted) {
				tokens.push({ value: quoted.value, raw: text.slice(i, quoted.end), explicit: false });
				i = quoted.end;
				continue;
			}
			i++;
			continue;
		}

		// 裸路径：必须以 / 、~/ 或 file:// 开头（相对裸路径不识别）
		if (isPathStart(text, i)) {
			const bare = readBare(text, i);
			if (bare) {
				tokens.push({ value: bare.value, raw: text.slice(i, bare.end), explicit: false });
				i = bare.end;
				continue;
			}
		}

		i++;
	}

	return tokens;
}

/** 当前位置是否像路径起点（避免把英文单词里的字符当成路径） */
function isPathStart(text: string, index: number): boolean {
	const ch = text[index];
	const prev = index > 0 ? text[index - 1] : '';

	if (text.startsWith('file://', index)) return true;

	if (ch === '/') {
		// 排除 `//`（转义斜杠/URL 协议）、URL 路径段（prev 为 : 或 /）与标识符后的斜杠（a/b）
		if (text[index + 1] === '/') return false;
		return !/[\w@~./:)\]]/.test(prev);
	}

	if (ch === '~' && text[index + 1] === '/') {
		return !/[\w@~./:)\]]/.test(prev);
	}

	return false;
}

/** 读取引号包裹的内容（支持 \ 转义），index 必须指向引号 */
function readQuoted(text: string, index: number): { value: string; end: number } | null {
	const quote = text[index];
	if (quote !== '"' && quote !== '\'') return null;

	let value = '';
	let i = index + 1;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\\' && i + 1 < text.length) {
			value += text[i + 1];
			i += 2;
			continue;
		}
		if (ch === quote) return { value, end: i + 1 };
		value += ch;
		i++;
	}
	return null; // 未闭合引号：不作为路径
}

/** 读取裸 token（到空白/中文标点/引号为止），支持 `\ ` 转义空格，并剥离尾部标点 */
function readBare(text: string, index: number): { value: string; end: number } | null {
	let value = '';
	let i = index;

	while (i < text.length) {
		const ch = text[i];
		if (ch === '\\' && text[i + 1] === ' ') {
			value += ' ';
			i += 2;
			continue;
		}
		if (isTokenBoundary(ch)) break;
		value += ch;
		i++;
	}

	// 剥离英文标点（"@/tmp/a.png," → "/tmp/a.png"）
	let end = i;
	while (value.length > 0 && TRAILING_PUNCTUATION.includes(value[value.length - 1])) {
		value = value.slice(0, -1);
		end--;
	}

	return value.length > 0 ? { value, end } : null;
}

/** token 边界：空白、引号、尖括号、常见中文标点 */
function isTokenBoundary(ch: string): boolean {
	if (/\s/.test(ch)) return true;
	if (ch === '"' || ch === '\'' || ch === '`' || ch === '<' || ch === '>') return true;
	// 中文标点常紧贴路径出现（如「看这张@/tmp/a.png。」）
	return '，。；：！？、（）【】《》“”‘’'.includes(ch);
}

/** 路径形态预筛：扩展名匹配 */
function looksLikeImagePath(value: string): boolean {
	const lower = value.toLowerCase().split(/[?#]/)[0];
	return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 把 token 归一化为绝对路径；不认识的写法返回 null */
function resolveToken(value: string, cwd: string): string | null {
	if (value.startsWith('file://')) {
		try {
			return decodeURIComponent(new URL(value).pathname);
		} catch {
			return null;
		}
	}
	return resolveUserPath(value, cwd);
}

/**
 * 用户路径归一化：`file://` → 本地路径、`~/` → home、相对 → 基准目录。
 *
 * 供 `/image <路径>` 命令与内联扫描共用（与工具的相对路径基准保持一致）。
 */
export function resolveUserPath(value: string, cwd: string = process.cwd()): string {
	let raw = value.trim();

	if (raw.startsWith('file://')) {
		try {
			return decodeURIComponent(new URL(raw).pathname);
		} catch {
			return raw;
		}
	}

	// 去掉路径两端可能的包裹引号（拖拽产物常见）
	if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\'') && raw.endsWith('\'')))) {
		raw = raw.slice(1, -1);
	}

	if (raw === '~') return homedir();
	if (raw.startsWith('~/')) {
		raw = homedir() + sep + raw.slice(2);
	}

	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}
