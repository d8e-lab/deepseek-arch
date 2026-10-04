/**
 * 图片附件类型（视觉输入）
 *
 * 设计要点：
 *   - 领域层 `Message.content` 恒为字符串，图片以「附件」旁路存在 `Message.images`；
 *   - 持久化只存**引用 + 元数据**（字节在 <sessionDir>/images/ 下），避免 turns.json 膨胀；
 *   - 上线前由 materializeMessages() 展开为 base64 data URL（OpenAI 兼容块数组）。
 *
 * 参考：DeepSeek《图像理解》— Base64 编码图片（内联）与限制。
 */

/** 支持的图片 MIME（与文档一致；格式按文件内容判定，不看扩展名） */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** 细节级别（文档：low 缩放到 512×512；high/original 保留原图；auto 当前等价 original） */
export type ImageDetail = 'low' | 'high' | 'original' | 'auto';

/**
 * 图片附件元数据（持久化于 TurnRecord.messages 的 user 消息）
 *
 * 字节内容不入 JSON：`path` 指向会话资产目录内的副本（内容寻址，天然去重）。
 */
export interface ImageAttachment {
	/** 相对会话目录的资产路径，如 `images/9f2c….png` */
	path: string;
	/** 由文件实际内容判定的 MIME */
	mime: ImageMime;
	/** 原始文件字节数 */
	bytes: number;
	/** 内容 SHA-256（去重键，同时是文件名主干） */
	sha256: string;
	/** 展示用文件名（不含目录） */
	name: string;
	/** 像素宽（解析失败时缺省） */
	width?: number;
	/** 像素高（解析失败时缺省） */
	height?: number;
	/** 细节级别（默认为原图，等价 auto/original） */
	detail?: ImageDetail;
}
