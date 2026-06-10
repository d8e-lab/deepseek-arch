/**
 * system-info — 收集系统、环境、工作区信息
 *
 * 在会话启动时注入 system prompt，让 agent 了解运行环境。
 * 收集内容：
 *   1. OS 信息（WSL/Windows/Linux 发行版/macOS）
 *   2. 用户名
 *   3. 工作区路径
 *   4. 网络 IP
 *   5. Git 分支与远程仓库信息
 *   6. 工作区目录结构
 *   7. README / AGENTS.md 内容
 */

import { readFile, readdir } from 'node:fs/promises';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo, networkInterfaces } from 'node:os';
import { execSync } from 'node:child_process';

/** 目录树最大深度 */
const MAX_TREE_DEPTH = 2;
/** 单层最大条目数 */
const MAX_DIR_ENTRIES = 80;
/** README/AGENTS 最大读取字节数 */
const MAX_DOC_BYTES = 8192;

// ─── OS 检测 ──────────────────────────────────────

/** 检测是否运行在 WSL 中 */
function isWSL(): boolean {
	return safeReadFile('/proc/version').toLowerCase().includes('microsoft');
}

/** 安全同步读取文件，失败返回空串 */
function safeReadFile(path: string): string {
	try {
		return readFileSync(path, 'utf-8');
	} catch {
		return '';
	}
}

/** 获取 Linux 发行版名称 */
function getLinuxDistro(): string {
	const content = safeReadFile('/etc/os-release');
	if (!content) return 'Linux';

	const nameMatch = content.match(/^PRETTY_NAME="?(.+?)"?$/m);
	if (nameMatch) return nameMatch[1];

	const idMatch = content.match(/^ID="?(.+?)"?$/m);
	if (idMatch) return idMatch[1];

	return 'Linux';
}

/** 获取 OS 描述字符串 */
function getOSInfo(): string {
	if (process.platform === 'win32') return 'Windows';
	if (process.platform === 'darwin') return 'macOS';
	if (isWSL()) {
		const distro = getLinuxDistro();
		return `${distro} (WSL2)`;
	}
	return getLinuxDistro();
}

/** 获取内核版本 */
function getKernelVersion(): string {
	return safeReadFile('/proc/version').split(' ')[2] || '';
}

// ─── 用户名 ────────────────────────────────────────

function getUsername(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER || process.env.USERNAME || 'unknown';
	}
}

// ─── 网络 IP ──────────────────────────────────────

function getNetworkIPs(): string[] {
	const interfaces = networkInterfaces();
	const ips: string[] = [];
	for (const [name, addrs] of Object.entries(interfaces)) {
		if (!addrs) continue;
		for (const addr of addrs) {
			// 跳过内部回环地址
			if (addr.internal) continue;
			if (addr.family === 'IPv4') {
				ips.push(`${name}: ${addr.address}`);
			}
		}
	}
	return ips;
}

// ─── Git 信息 ─────────────────────────────────────

function getGitInfo(cwd: string): { branches: string[]; remotes: string[] } | null {
	try {
		const branchOutput = execSync('git branch --all', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		if (!branchOutput) return null;

		const branches = branchOutput
			.split('\n')
			.map((l) => l.replace(/^\*?\s*/, '').trim())
			.filter(Boolean);

		const remoteOutput = execSync('git remote -v', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		const remotes = remoteOutput
			.split('\n')
			.filter(Boolean)
			.map((l) => l.trim());

		return { branches, remotes };
	} catch {
		return null;
	}
}

// ─── 目录树 ──────────────────────────────────────

async function buildDirTree(dir: string, maxDepth: number, currentDepth: number): Promise<string[]> {
	if (currentDepth > maxDepth) return [];

	const lines: string[] = [];
	let entries: string[];

	try {
		entries = await readdir(dir);
	} catch {
		return lines;
	}

	// 过滤隐藏文件和目录
	entries = entries
		.filter((e) => !e.startsWith('.') && e !== 'node_modules')
		.sort();

	if (entries.length > MAX_DIR_ENTRIES) {
		entries = entries.slice(0, MAX_DIR_ENTRIES);
	}

	const prefix = '  '.repeat(currentDepth);

	for (const entry of entries) {
		const fullPath = join(dir, entry);
		let isDir = false;
		try {
			isDir = statSync(fullPath).isDirectory();
		} catch {
			// skip unreadable
		}

		if (isDir) {
			lines.push(`${prefix}${entry}/`);
			if (currentDepth < maxDepth) {
				const children = await buildDirTree(fullPath, maxDepth, currentDepth + 1);
				lines.push(...children);
			}
		} else {
			lines.push(`${prefix}${entry}`);
		}
	}

	return lines;
}

// ─── README / AGENTS ──────────────────────────────

async function findAndReadDocs(dir: string): Promise<{ name: string; content: string }[]> {
	const docs: { name: string; content: string }[] = [];

	try {
		const entries = await readdir(dir);
		// 匹配 README, README.md, Readme.md, readme.md 等
		const readmeFile = entries.find((e) => /^readme(\.\w+)?$/i.test(e));
		if (readmeFile) {
			const content = await readFileHead(join(dir, readmeFile), MAX_DOC_BYTES);
			if (content) docs.push({ name: readmeFile, content });
		}

		// 匹配 AGENTS.md, agents.md, Agents.md 等
		const agentsFile = entries.find((e) => /^agents\.\w+$/i.test(e));
		if (agentsFile) {
			const content = await readFileHead(join(dir, agentsFile), MAX_DOC_BYTES);
			if (content) docs.push({ name: agentsFile, content });
		}
	} catch {
		// ignore
	}

	return docs;
}

async function readFileHead(filePath: string, maxBytes: number): Promise<string | null> {
	try {
		const buf = await readFile(filePath);
		const text = buf.toString('utf-8');
		if (buf.length <= maxBytes) return text;
		return text.slice(0, maxBytes) + '\n\n[... truncated ...]';
	} catch {
		return null;
	}
}

// ─── 组装 ──────────────────────────────────────────

export interface SystemInfo {
	os: string;
	kernel: string;
	username: string;
	workspace: string;
	home: string;
	networkIPs: string[];
	git: { branches: string[]; remotes: string[] } | null;
	dirTree: string[];
	docs: { name: string; content: string }[];
}

/**
 * 收集系统与环境信息。
 * 所有命令均使用同步/阻塞方式（仅在会话启动时调用一次，不影响交互体验）。
 */
async function collect(cwd: string): Promise<SystemInfo> {
	const [dirTree, docs] = await Promise.all([
		buildDirTree(cwd, MAX_TREE_DEPTH, 0),
		findAndReadDocs(cwd),
	]);

	return {
		os: getOSInfo(),
		kernel: getKernelVersion(),
		username: getUsername(),
		workspace: cwd,
		home: homedir(),
		networkIPs: getNetworkIPs(),
		git: getGitInfo(cwd),
		dirTree,
		docs,
	};
}

/**
 * 将系统信息格式化为 system prompt 注入文本。
 */
export async function buildSystemPromptContext(cwd?: string): Promise<string> {
	const workspace = cwd ?? process.cwd();
	const info = await collect(workspace);

	const lines: string[] = [];

	lines.push('');
	lines.push('<environment_info>');

	// OS & 用户 & 路径
	lines.push(`OS: ${info.os}${info.kernel ? ` (kernel ${info.kernel})` : ''}`);
	lines.push(`User: ${info.username}`);
	lines.push(`Workspace: ${info.workspace}`);

	// 网络
	if (info.networkIPs.length > 0) {
		lines.push(`Network: ${info.networkIPs.join(', ')}`);
	}

	// Git
	if (info.git) {
		lines.push(`Git branches:\n  ${info.git.branches.join('\n  ')}`);
		if (info.git.remotes.length > 0) {
			lines.push(`Git remotes: ${info.git.remotes.join('; ')}`);
		}
	}

	// 目录结构
	lines.push('');
	lines.push('Directory structure:');
	lines.push(...info.dirTree);

	// README / AGENTS
	for (const doc of info.docs) {
		lines.push('');
		lines.push(`--- ${doc.name} ---`);
		lines.push(doc.content);
	}

	lines.push('</environment_info>');

	return lines.join('\n');
}
