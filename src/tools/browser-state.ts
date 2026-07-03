/**
 * BrowserState — Playwright 浏览器实例管理单例
 *
 * 职责：
 *   1. 懒加载启动 Chromium（headless 默认，BROWSER_HEADED=1 切换）
 *   2. 管理单例 browser/context/page
 *   3. 下载自动保存到会话工作目录
 *   4. snapshot：ariaSnapshot() → 结构化文本
 *   5. 进程退出时自动清理
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

/** snapshot 输出限制（字符数） */
const MAX_SNAPSHOT_CHARS = 8000;

/** 页面导航默认超时 */
const NAVIGATION_TIMEOUT_MS = 30_000;

class BrowserState {
	private browser: Browser | null = null;
	private context: BrowserContext | null = null;
	private page: Page | null = null;
	private downloadDir: string = '';
	private closed = false;
	private cleanupRegistered = false;
	private _lastUrl: string = '';

	/** 获取或创建 Page 实例 */
	async getPage(): Promise<Page> {
		if (this.closed) {
			throw new Error('Browser has been closed');
		}
		if (this.page && !this.page.isClosed() && this.browser?.isConnected()) {
			return this.page;
		}
		// 页面或浏览器已死 → 重新启动
		await this.launch();
		return this.page!;
	}

	/**
	 * 构建页面 accessibility snapshot 文本
	 * 使用 Playwright 内置的 ariaSnapshot()，输出 YAML 风格结构化文本
	 */
	async buildSnapshot(): Promise<string> {
		const page = await this.getPage();

		// 等待页面稳定
		try {
			await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
		} catch {
			/* ignore */
		}

		const url = page.url();
		const title = await page.title().catch(() => '');

		// 更新追踪的 URL
		if (url && !url.startsWith('about:')) {
			this._lastUrl = url;
		}

		let snapshotText = '';
		try {
			snapshotText = await page.ariaSnapshot();
		} catch {
			snapshotText = '(unable to capture page snapshot)';
		}

		if (!snapshotText || !snapshotText.trim()) {
			snapshotText = '(empty page)';
		}

		// 截断
		if (snapshotText.length > MAX_SNAPSHOT_CHARS) {
			snapshotText = snapshotText.slice(0, MAX_SNAPSHOT_CHARS)
				+ '\n... (truncated, use browser_scroll and browser_snapshot for more content)';
		}

		return `URL: ${url}\nTitle: ${title}\n\n${snapshotText}`;
	}

	/** 关闭浏览器并清理资源 */
	async close(): Promise<void> {
		this.closed = true;
		if (this.page) {
			try { await this.page.close(); } catch { /* ignore */ }
			this.page = null;
		}
		if (this.context) {
			try { await this.context.close(); } catch { /* ignore */ }
			this.context = null;
		}
		if (this.browser) {
			try { await this.browser.close(); } catch { /* ignore */ }
			this.browser = null;
		}
	}

	/** 获取追踪的最后 URL */
	getLastUrl(): string {
		return this._lastUrl;
	}

	/** 手动设置最后 URL（session resume 后恢复使用） */
	setLastUrl(url: string): void {
		this._lastUrl = url;
	}

	/**
	 * 恢复浏览器到指定 URL（resume session 时使用）
	 * 浏览器未启动或 URL 为空时忽略
	 */
	async restoreUrl(url: string): Promise<void> {
		if (!url) return;
		try {
			const page = await this.getPage();
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
			this._lastUrl = url;
		} catch {
			/* 恢复失败不阻塞 */
		}
	}

	/** 获取下载目录 */
	getDownloadDir(): string {
		return this.downloadDir;
	}

	/** 设置下载目录（切换会话时调用） */
	setDownloadDir(dir: string): void {
		this.downloadDir = resolve(dir);
	}

	// ─── 私有方法 ──────────────────────────────

	private async launch(): Promise<void> {
		// 清理已断开的浏览器实例
		if (this.browser && !this.browser.isConnected()) {
			try { await this.browser.close(); } catch { /* ignore */ }
			this.browser = null;
			this.context = null;
			this.page = null;
		}
		// 如果已有健康的浏览器/页面，跳过
		if (this.page && !this.page.isClosed()) {
			return;
		}

		// 确保下载目录存在
		this.downloadDir = process.env.DEEPSEEK_ARCH_SESSION_CWD ?? process.cwd();
		try { await mkdir(this.downloadDir, { recursive: true }); } catch { /* ignore */ }

		// ── 模式 A: CDP 远程连接（如宿主机的 Edge） ─────────
		const cdpUrl = process.env.BROWSER_CDP || '';
		if (cdpUrl) {
			try {
				this.browser = await chromium.connectOverCDP(cdpUrl);
				// 创建独立上下文，不干扰用户现有标签
				this.context = await this.browser.newContext({
					acceptDownloads: true,
					viewport: { width: 1280, height: 720 },
				});
				this.page = await this.context.newPage();
				this._registerCleanup();
				return;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`CDP connection failed (${cdpUrl}): ${msg}`);
			}
		}

		// ── 模式 B: 本地启动 Chromium ───────────────────
		const headed = process.env.BROWSER_HEADED === '1';
		const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || '';

		const launchOptions: Record<string, unknown> = {
			headless: !headed,
			channel: 'chromium',
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
			],
		};

		if (proxy) {
			(launchOptions.args as string[]).push(`--proxy-server=${proxy}`);
		}

		this.browser = await chromium.launch(launchOptions);

		// 注册进程退出清理（仅一次）
		this._registerCleanup();

		const contextOptions: Record<string, unknown> = {
			acceptDownloads: true,
		};

		this.context = await this.browser.newContext(contextOptions);
		this.page = await this.context.newPage();

		// 下载处理：保存到会话工作目录
		this.page.on('download', async (download) => {
			try {
				const suggested = download.suggestedFilename();
				const destPath = join(this.downloadDir, suggested);
				await download.saveAs(destPath);
			} catch {
				/* 下载失败静默 */
			}
		});
	}
	/** 注册进程退出时的清理回调（仅注册一次） */
	private _registerCleanup(): void {
		if (this.cleanupRegistered) return;
		this.cleanupRegistered = true;

		const cleanup = () => {
			if (instance) {
				instance.close().catch(() => {});
			}
		};

		// 正常退出
		process.on('exit', cleanup);

		// 信号退出
		process.on('SIGINT', () => { cleanup(); process.exit(0); });
		process.on('SIGTERM', () => { cleanup(); process.exit(0); });

		// 未捕获异常
		process.on('uncaughtException', (err) => {
			cleanup();
			throw err;
		});
	}
}

/** 单例 */
let instance: BrowserState | null = null;

/** 获取 BrowserState 单例 */
export function getBrowserState(): BrowserState {
	if (!instance) {
		instance = new BrowserState();
	}
	return instance;
}

/** 重置单例（测试用） */
export async function resetBrowserState(): Promise<void> {
	if (instance) {
		await instance.close();
		instance = null;
	}
}

export { NAVIGATION_TIMEOUT_MS };
