/**
 * CSI 序列解析（纯计算，无 I/O）
 *
 * 终端按键数据中，方向键/PgUp/PgDn/Home/End 等以 ESC[ 开头、final 字节结尾
 * （如 `\x1b[A` = ↑、`\x1b[5~` = PgUp）。原始数据常为多键同批到达，
 * 逐字符扫描时需要"从某位置解析一个完整 CSI 序列"的纯函数。
 *
 * 此前该解析逻辑在 TuiApp.processChars / handleViewerInput / Selector 中
 * 重复实现 3 份，收口至此。
 */

export interface CsiParseResult {
	/** final 字节（含中间参数），如 'A' / '5~' / '200~'（不含 ESC[ 前缀） */
	seq: string;
	/** final 字节之后的索引（供调用方继续扫描） */
	next: number;
}

/**
 * 从 data 的 escIndex 位置解析 CSI 序列（该位置必须是 '\x1b'）。
 *
 * @param data     原始按键数据
 * @param escIndex 指向 '\x1b' 的索引
 * @returns 解析结果；若 ESC 后不是 '['（独立 ESC，如退出键）返回 null
 */
export function parseCsiSequence(data: string, escIndex: number): CsiParseResult | null {
	if (data[escIndex] !== '\x1b' || data[escIndex + 1] !== '[') return null;
	let i = escIndex + 2;
	let seq = '';
	while (i < data.length) {
		const sc = data.charCodeAt(i);
		if (sc >= 0x40 && sc <= 0x7e) {
			seq += data[i];
			i++;
			break;
		}
		seq += data[i];
		i++;
	}
	return { seq, next: i };
}
