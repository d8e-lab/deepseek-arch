/**
 * api-monitor.ts — API 请求监听进程
 *
 * 独立 HTTP 服务器，接收 ApiClient 镜像发送的请求体并原封不动保存到磁盘。
 * 用于排查上下文丢失 / KV-cache 命中问题：完整记录每次实际发给 API 的请求，
 * 与磁盘 turns / 内存 turns 对照即可定位请求序列与预期不一致的环节。
 *
 * 启动：deepseek-arch api-monitor [--port 8899] [--out <dir>]
 * 客户端：deepseek-arch chat --monitor http://127.0.0.1:8899
 *         （或设置环境变量 DEEPSEEK_API_MONITOR_URL）
 *
 * 保存位置：<outDir>/<sessionId|nosession>/<YYYYMMDD-HHMMSS.mmm>[-N].json
 * 文件格式：{ received_at, session_id, endpoint, body } —— body 为原始请求体
 */

import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface ApiMonitorOptions {
	/** 监听端口，默认 8899；传 0 表示随机端口（测试用） */
	port?: number;
	/** 保存目录，默认 ./api-requests */
	outDir?: string;
}

/** 保存的请求记录结构 */
export interface SavedRequest {
	/** 接收时间（ISO 8601） */
	received_at: string;
	/** 会话 ID（来自 X-Session-Id 头，无则为 null） */
	session_id: string | null;
	/** API 端点路径 */
	endpoint: string;
	/** 原始请求体（与发给 API 的完全一致） */
	body: unknown;
}

/** 生成带毫秒时间戳的文件名 */
function timestampFileName(d: Date, seq: number): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, '0');
	const base =
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
		`${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
	return seq === 0 ? `${base}.json` : `${base}-${seq}.json`;
}

/**
 * 保存一条请求记录。
 * 同毫秒写入冲突时追加序号（flag 'wx' 保证不覆盖已有文件）。
 * @returns 实际写入的文件路径
 */
export async function saveApiRequest(
	outDir: string,
	record: SavedRequest,
): Promise<string> {
	const dir = join(resolve(outDir), record.session_id ?? 'nosession');
	await mkdir(dir, { recursive: true, mode: 0o700 });

	const now = new Date();
	let seq = 0;
	while (true) {
		const path = join(dir, timestampFileName(now, seq));
		try {
			await writeFile(path, JSON.stringify(record, null, 2) + '\n', {
				mode: 0o600,
				flag: 'wx',
			});
			return path;
		} catch (err: any) {
			if (err?.code === 'EEXIST') {
				seq++;
				continue;
			}
			throw err;
		}
	}
}

/**
 * 启动 API 请求监听服务器。
 * 仅处理 POST /（body 为镜像请求体），保存后返回 200；其他请求返回 405。
 * 服务器绑定 127.0.0.1，不暴露到外部网络。
 */
export function startApiMonitor(options: ApiMonitorOptions = {}): Server {
	const port = options.port ?? 8899;
	const outDir = options.outDir ?? 'api-requests';

	const server = createServer(async (req, res) => {
		if (req.method !== 'POST' || req.url !== '/') {
			res.writeHead(405, { 'Content-Type': 'text/plain' });
			res.end('Method Not Allowed');
			return;
		}

		// 收集原始请求体
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}
		const raw = Buffer.concat(chunks).toString('utf-8');

		// 解析 JSON（失败时原样保存字符串）
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			body = raw;
		}

		const record: SavedRequest = {
			received_at: new Date().toISOString(),
			session_id: (req.headers['x-session-id'] as string | undefined) ?? null,
			endpoint: '/v1/chat/completions',
			body,
		};

		try {
			const path = await saveApiRequest(outDir, record);
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end(`saved: ${path}`);
		} catch (err: any) {
			res.writeHead(500, { 'Content-Type': 'text/plain' });
			res.end(`save failed: ${err?.message ?? String(err)}`);
		}
	});

	server.listen(port, '127.0.0.1');
	return server;
}
