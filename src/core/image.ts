/**
 * image.ts — 视觉图片输入核心模块
 *
 * 职责：
 *   1. 按**文件内容**嗅探图片格式（JPEG/PNG/GIF/WebP）并解析像素尺寸；
 *   2. 落地文档「限制」：单图 32 MiB、请求体 48 MiB、单请求 ≤600 张、
 *      图片总量 64 MiB、单边 8192 px（≥15 张时 4096 px）；
 *   3. ImageStore：把图片复制到 <sessionDir>/images/<sha256>.<ext>（内容寻址去重）；
 *   4. materializeMessages：发送前把 Message.images 引用展开为 base64 内容块。
 *
 * 参考：DeepSeek《图像理解》— Base64 编码图片（内联）/ 限制。
 */

import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import type { ApiContentBlock, ApiMessage, ImageAttachment, ImageMime, Message } from '../types/index.js';
import { messageText } from '../utils/message-text.js';

// ─── 限制常量（与官方文档一致）─────────────────────

/** 支持的 MIME（格式由内容判定，不看扩展名） */
export const SUPPORTED_IMAGE_MIMES: readonly ImageMime[] = [
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
];

/** 单张图片最大字节数（base64 / 外部 URL 路径）：32 MiB */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** 请求体大小上限：48 MiB */
export const MAX_REQUEST_BODY_BYTES = 48 * 1024 * 1024;
/** 单请求图片张数上限：600 */
export const MAX_IMAGES_PER_REQUEST = 600;
/** 单请求图片总大小上限（不含 file_id 图片）：64 MiB */
export const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
/** 单边最大像素：8192；单请求 ≥15 张时降为 4096 */
export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_DIMENSION_MANY = 4096;
/** 「多图」阈值：达到该张数后像素上限收紧 */
export const MANY_IMAGES_THRESHOLD = 15;

/** 默认视觉模型（可用 defaults.vision_models 覆盖） */
export const DEFAULT_VISION_MODELS: readonly string[] = [
	'deepseek-flash',
	'deepseek-v4-flash-vision-exp',
];

/** 会话资产子目录名 */
export const IMAGE_DIR = 'images';

const MIME_EXTENSION: Record<ImageMime, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
};

/** 估算 JSON 报文中的固定开销（键名、role、引号、逗号等），用于体积预算 */
const MESSAGE_OVERHEAD_BYTES = 256;

// ─── 错误类型 ───────────────────────────────────────

export type ImageErrorCode =
	| 'unsupported_format'
	| 'too_large'
	| 'too_many'
	| 'request_too_large'
	| 'dimension_exceeded'
	| 'missing_asset'
	| 'no_session';

/** 图片输入错误（用户可读消息，TUI 直接呈现） */
export class ImageError extends Error {
	readonly code: ImageErrorCode;

	constructor(code: ImageErrorCode, message: string) {
		super(message);
		this.name = 'ImageError';
		this.code = code;
	}
}

// ─── 格式嗅探 ───────────────────────────────────────

/**
 * 按魔数判定图片 MIME；不支持的格式返回 null。
 * 文档明确「格式由文件实际内容判断，而非文件名或声明的 MIME 类型」。
 */
export function sniffImageMime(data: Uint8Array): ImageMime | null {
	if (data.length < 12) return null;

	// JPEG: FF D8 FF
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';

	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
		&& data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
	) return 'image/png';

	// GIF: "GIF87a" / "GIF89a"
	if (
		data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38
		&& (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61
	) return 'image/gif';

	// WebP: "RIFF" .... "WEBP"
	if (
		data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
		&& data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
	) return 'image/webp';

	return null;
}

// ─── 尺寸解析 ───────────────────────────────────────

/** 解析图片像素尺寸；结构异常时返回 null（尺寸仅用于限额校验，不影响可用性） */
export function readImageSize(data: Uint8Array, mime: ImageMime): { width: number; height: number } | null {
	switch (mime) {
		case 'image/png': return readPngSize(data);
		case 'image/gif': return readGifSize(data);
		case 'image/jpeg': return readJpegSize(data);
		case 'image/webp': return readWebpSize(data);
		default: return null;
	}
}

function readUint32BE(data: Uint8Array, offset: number): number {
	return (
		(data[offset] << 24 >>> 0)
		+ (data[offset + 1] << 16)
		+ (data[offset + 2] << 8)
		+ data[offset + 3]
	);
}

function readUint16LE(data: Uint8Array, offset: number): number {
	return data[offset] + (data[offset + 1] << 8);
}

function readUint24LE(data: Uint8Array, offset: number): number {
	return data[offset] + (data[offset + 1] << 8) + (data[offset + 2] << 16);
}

/** PNG：签名 8 字节 + 长度 4 + "IHDR" 4 → 宽 4 / 高 4（大端） */
function readPngSize(data: Uint8Array): { width: number; height: number } | null {
	if (data.length < 24) return null;
	if (String.fromCharCode(...data.subarray(12, 16)) !== 'IHDR') return null;
	const width = readUint32BE(data, 16);
	const height = readUint32BE(data, 20);
	return width > 0 && height > 0 ? { width, height } : null;
}

/** GIF：逻辑屏幕描述符位于偏移 6（宽）/ 8（高），小端 */
function readGifSize(data: Uint8Array): { width: number; height: number } | null {
	if (data.length < 10) return null;
	const width = readUint16LE(data, 6);
	const height = readUint16LE(data, 8);
	return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG：扫描段直到 SOFn（C0-C3/C5-C7/C9-CB/CD-CF），高/宽跟在精度字节之后 */
function readJpegSize(data: Uint8Array): { width: number; height: number } | null {
	let offset = 2; // 跳过 SOI
	while (offset + 9 < data.length) {
		if (data[offset] !== 0xff) { offset++; continue; }
		const marker = data[offset + 1];
		// 填充字节 / 无长度段（RSTn、SOI、EOI、TEM）
		if (marker === 0xff) { offset++; continue; }
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }

		const segmentLength = (data[offset + 2] << 8) + data[offset + 3];
		if (segmentLength < 2) return null;
		const isSof = (marker >= 0xc0 && marker <= 0xc3)
			|| (marker >= 0xc5 && marker <= 0xc7)
			|| (marker >= 0xc9 && marker <= 0xcb)
			|| (marker >= 0xcd && marker <= 0xcf);
		if (isSof) {
			// 段内布局：长度(2) 精度(1) 高(2) 宽(2)
			const height = (data[offset + 5] << 8) + data[offset + 6];
			const width = (data[offset + 7] << 8) + data[offset + 8];
			return width > 0 && height > 0 ? { width, height } : null;
		}
		offset += 2 + segmentLength;
	}
	return null;
}

/** WebP：按 chunk 类型解析 VP8（有损）/ VP8L（无损）/ VP8X（扩展/动图） */
function readWebpSize(data: Uint8Array): { width: number; height: number } | null {
	if (data.length < 30) return null;
	const fourCC = String.fromCharCode(...data.subarray(12, 16));

	if (fourCC === 'VP8 ') {
		// 帧标签 3 字节 + 起始码 9D 01 2A，随后宽/高各 2 字节（14 位有效）
		if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
		const width = readUint16LE(data, 26) & 0x3fff;
		const height = readUint16LE(data, 28) & 0x3fff;
		return width > 0 && height > 0 ? { width, height } : null;
	}

	if (fourCC === 'VP8L') {
		if (data[20] !== 0x2f) return null;
		const bits = data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24);
		const width = (bits & 0x3fff) + 1;
		const height = ((bits >> 14) & 0x3fff) + 1;
		return { width, height };
	}

	if (fourCC === 'VP8X') {
		// flags(1) + reserved(3) + canvas width-1（3 字节小端）+ height-1（3 字节小端）
		const width = readUint24LE(data, 24) + 1;
		const height = readUint24LE(data, 27) + 1;
		return { width, height };
	}

	return null;
}

// ─── 展示辅助 ───────────────────────────────────────

/** 人类可读体积（1.2 MB / 340 KB / 12 B） */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 附件的一行摘要（TUI 展示与错误提示共用） */
export function describeAttachment(att: ImageAttachment): string {
	const dims = att.width && att.height ? `, ${att.width}×${att.height}` : '';
	return `${att.name} (${formatBytes(att.bytes)}${dims})`;
}

// ─── 视觉模型判定 ───────────────────────────────────

/**
 * 当前模型是否支持图片输入。
 *
 * 文档中视觉能力由 deepseek-flash 提供；名单可用 defaults.vision_models 覆盖。
 * 判定失败不阻断发送，仅用于提示（供应商侧仍会返回 400）。
 */
export function isVisionModel(model: string | undefined | null, extra: readonly string[] = []): boolean {
	if (!model) return false;
	const normalized = model.trim().toLowerCase();
	const known = new Set([...DEFAULT_VISION_MODELS, ...extra].map((m) => m.trim().toLowerCase()));
	if (known.has(normalized)) return true;
	// 兜底：显式带 vision 标识的模型名（如 deepseek-v4-flash-vision-exp 的变体）
	return normalized.includes('vision');
}

// ─── 图片资产存储 ───────────────────────────────────

/**
 * ImageStore — 会话图片资产目录的读写
 *
 * 目录布局：<sessionDir>/images/<sha256>.<ext>
 * 内容寻址：同一张图重复附加只占一份；原文件删除/移动不影响历史轮次。
 */
export class ImageStore {
	/** <sessionDir>/images */
	readonly dir: string;

	constructor(private readonly sessionDir: string) {
		this.dir = join(sessionDir, IMAGE_DIR);
	}

	/** 资产绝对路径 */
	absolutePath(att: Pick<ImageAttachment, 'path'>): string {
		return join(this.sessionDir, att.path);
	}

	/**
	 * 附加一张图片：读入 → 嗅探 → 限额校验 → 内容寻址落盘。
	 *
	 * @param source 文件路径或原始字节（粘贴/测试用）
	 * @param name   展示用文件名（缺省取源文件名）
	 * @throws ImageError 格式不支持 / 单图超限 / 尺寸超限
	 */
	async attach(source: string | Uint8Array, name?: string): Promise<ImageAttachment> {
		const data = typeof source === 'string' ? await readFile(source) : Buffer.from(source);
		const label = name ?? (typeof source === 'string' ? basename(source) : 'image');

		const mime = sniffImageMime(data);
		if (!mime) {
			throw new ImageError(
				'unsupported_format',
				`Unsupported image format: ${label} (only JPEG/PNG/GIF/WebP are supported; detected by content, not extension)`,
			);
		}
		if (data.byteLength > MAX_IMAGE_BYTES) {
			throw new ImageError(
				'too_large',
				`Image too large: ${label} is ${formatBytes(data.byteLength)} (max ${formatBytes(MAX_IMAGE_BYTES)} per image)`,
			);
		}

		const size = readImageSize(data, mime);
		if (size && (size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION)) {
			throw new ImageError(
				'dimension_exceeded',
				`Image dimensions too large: ${label} is ${size.width}×${size.height} (max ${MAX_IMAGE_DIMENSION} px per side)`,
			);
		}

		const sha256 = createHash('sha256').update(data).digest('hex');
		const relPath = `${IMAGE_DIR}/${sha256}.${MIME_EXTENSION[mime]}`;
		const absolute = join(this.sessionDir, relPath);

		if (!(await exists(absolute))) {
			await mkdir(this.dir, { recursive: true, mode: 0o700 });
			await writeFile(absolute, data, { mode: 0o600 });
		}

		return {
			path: relPath,
			mime,
			bytes: data.byteLength,
			sha256,
			name: sanitizeName(label),
			...(size ? { width: size.width, height: size.height } : {}),
		};
	}

	/** 读取附件字节；资产缺失时返回 null（调用方决定降级策略） */
	async load(att: ImageAttachment): Promise<Buffer | null> {
		try {
			return await readFile(this.absolutePath(att));
		} catch {
			return null;
		}
	}

	/** 读取附件并编码为 base64 data URL */
	async toDataUrl(att: ImageAttachment): Promise<string | null> {
		const data = await this.load(att);
		if (!data) return null;
		return toDataUrl(att.mime, data);
	}

	/** 删除附件资产（历史轮次仍保留引用，删除后降级为 unavailable 文本） */
	async remove(att: ImageAttachment): Promise<void> {
		try {
			await unlink(this.absolutePath(att));
		} catch {
			/* 已不存在 */
		}
	}
}

/** 组装 data URL（文档方式 1：base64 内联） */
export function toDataUrl(mime: ImageMime, data: Uint8Array): string {
	return `data:${mime};base64,${Buffer.from(data).toString('base64')}`;
}

/** 文件名净化：去掉目录与不可见字符，限制长度 */
function sanitizeName(name: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = basename(name).replace(/[\u0000-\u001f\u007f]/g, '').trim();
	return cleaned.slice(0, 120) || 'image';
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

// ─── 消息物化（领域层 → 上线层）────────────────────

interface ImageBudget {
	/** 报文体积估算（含 base64 膨胀与文本） */
	estimatedBodyBytes: number;
}

/**
 * 估算报文体积：base64 膨胀 4/3 + 文本字节 + 每条消息固定开销。
 * 不构造完整 JSON，避免为了限额检查先分配几十 MB 字符串。
 *
 * 注：此处只统计「已经是块数组」的消息（历史物化结果）；
 * 尚未物化的 `Message.images` 引用由调用方按元数据另行累加。
 */
function measureBudget(messages: ApiMessage[]): ImageBudget {
	let estimatedBodyBytes = 0;

	for (const message of messages) {
		estimatedBodyBytes += MESSAGE_OVERHEAD_BYTES + Buffer.byteLength(messageText(message), 'utf-8');
		const blocks = Array.isArray(message.content) ? message.content : [];
		for (const block of blocks) {
			if (block?.type !== 'image_url') continue;
			estimatedBodyBytes += base64Length(imageBlockBytes(block.image_url.url));
		}
	}

	return { estimatedBodyBytes };
}

/** data URL 的原始字节数（非 data URL 视为外部 URL，不计入内联体积） */
function imageBlockBytes(url: string): number {
	if (!url.startsWith('data:')) return 0;
	const comma = url.indexOf(',');
	if (comma < 0) return 0;
	const payload = url.slice(comma + 1);
	return Math.floor((payload.length * 3) / 4);
}

/** base64 编码后的字符数 */
function base64Length(rawBytes: number): number {
	return Math.ceil(rawBytes / 3) * 4;
}

/**
 * 把领域层消息展开为上线消息：user 消息的 images 引用 → base64 内容块。
 *
 * - 无图片时零 I/O（直接返回原数组），避免每轮发送的额外开销；
 * - 整包限额（张数 / 总量 / 请求体）在读取字节之前先行校验；
 * - ≥15 张时像素上限收紧为 4096；
 * - 资产缺失时降级为 `[image unavailable: name]` 文本块，不阻断整轮。
 *
 * @throws ImageError 超出文档限制
 */
export async function materializeMessages(
	messages: Message[],
	sessionDir: string,
): Promise<ApiMessage[]> {
	if (!messages.some((m) => m.images && m.images.length > 0)) {
		return messages;
	}

	const store = new ImageStore(sessionDir);
	const allImages = messages.flatMap((m) => m.images ?? []);

	// 1. 先按元数据做整包校验（避免先读几十 MB 字节再报错）
	const totalRawBytes = allImages.reduce((sum, att) => sum + att.bytes, 0);
	if (allImages.length > MAX_IMAGES_PER_REQUEST) {
		throw new ImageError(
			'too_many',
			`Too many images in one request: ${allImages.length} (max ${MAX_IMAGES_PER_REQUEST})`,
		);
	}
	if (totalRawBytes > MAX_TOTAL_IMAGE_BYTES) {
		throw new ImageError(
			'request_too_large',
			`Total image size too large: ${formatBytes(totalRawBytes)} (max ${formatBytes(MAX_TOTAL_IMAGE_BYTES)} per request)`,
		);
	}

	const dimensionLimit = allImages.length >= MANY_IMAGES_THRESHOLD
		? MAX_IMAGE_DIMENSION_MANY
		: MAX_IMAGE_DIMENSION;
	const oversized = allImages.find(
		(att) => (att.width ?? 0) > dimensionLimit || (att.height ?? 0) > dimensionLimit,
	);
	if (oversized) {
		const hint = allImages.length >= MANY_IMAGES_THRESHOLD
			? ` (limit drops to ${MAX_IMAGE_DIMENSION_MANY} px when a request has ${MANY_IMAGES_THRESHOLD}+ images)`
			: '';
		throw new ImageError(
			'dimension_exceeded',
			`Image dimensions too large: ${oversized.name} is ${oversized.width}×${oversized.height} (max ${dimensionLimit} px per side)${hint}`,
		);
	}

	// 2. 报文体积预算：base64 膨胀后仍须 ≤ 48 MiB
	const textBudget = measureBudget(messages);
	const estimatedBody = textBudget.estimatedBodyBytes
		+ allImages.reduce((sum, att) => sum + base64Length(att.bytes), 0);
	if (estimatedBody > MAX_REQUEST_BODY_BYTES) {
		throw new ImageError(
			'request_too_large',
			`Request body would be about ${formatBytes(estimatedBody)}, over the ${formatBytes(MAX_REQUEST_BODY_BYTES)} limit`
			+ ' — attach fewer/smaller images, or use the Files API',
		);
	}

	// 3. 读盘并构造内容块
	const result: ApiMessage[] = [];
	for (const message of messages) {
		if (!message.images || message.images.length === 0) {
			result.push(message);
			continue;
		}

		const blocks: ApiContentBlock[] = [];
		const text = messageText(message);
		if (text.length > 0) blocks.push({ type: 'text', text });

		const missing: string[] = [];
		for (const att of message.images) {
			const url = await store.toDataUrl(att);
			if (!url) {
				missing.push(att.name);
				continue;
			}
			blocks.push({
				type: 'image_url',
				image_url: att.detail ? { url, detail: att.detail } : { url },
			});
		}
		if (missing.length > 0) {
			blocks.push({ type: 'text', text: `[image unavailable: ${missing.join(', ')}]` });
		}

		result.push({
			role: message.role,
			content: blocks,
			...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
			...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
			...(message.name !== undefined ? { name: message.name } : {}),
			...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
		});
	}

	return result;
}
