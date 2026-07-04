/**
 * scripts/debug-prompt.ts — 输出完整 system prompt 与 tools 信息供调试检查
 *
 * 用法：
 *   npx tsx scripts/debug-prompt.ts              # 在当前工作区运行
 *   npx tsx scripts/debug-prompt.ts /my/project  # 指定工作区
 *   npx tsx scripts/debug-prompt.ts --tools-only # 只展示 tools 信息
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPromptContext } from '../src/core/system-info.js';
import * as toolModules from '../src/tools/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const toolsOnly = args.includes('--tools-only');
const cwd = args.find((a) => !a.startsWith('--')) ?? process.cwd();

// ─── Tools ─────────────────────────────────────

if (!toolsOnly) {
	const [spContent, envContext] = await Promise.all([
		readFile(resolve(projectRoot, 'system_prompt.txt'), 'utf-8'),
		buildSystemPromptContext(cwd),
	]);

	const full = spContent + '\n' + envContext;

	// 将 README / AGENTS 的正文替换为占位符，方便快速检查 prompt 结构
	const forDisplay = full
		.replace(/^--- README[^\n]*\n[\s\S]*?(?=\n--- \w+|\n<\/environment_info>)/gm, '[README context]')
		.replace(/^--- AGENTS[^\n]*\n[\s\S]*?(?=\n--- \w+|\n<\/environment_info>)/gm, '[AGENTS context]');

	console.log(forDisplay);
	console.log('');
	console.log('──────────────────────────────────────────');
	console.log(`System Prompt — ${full.length} chars / ~${Math.round(full.length / 3.5)} tokens`);
}

// ─── Tools ─────────────────────────────────────

const tools = Object.values(toolModules);

console.log('');
console.log('══════════════════════════════════════════════');
console.log(`Tools (${tools.length})`);
console.log('══════════════════════════════════════════════');

for (const tool of tools) {
	const confirm = tool.requiresConfirm ? ' [需确认]' : '';
	console.log(`\n[${tool.name}]${confirm}`);
	console.log(`  ${tool.description}`);

	// 参数列表
	const props = tool.parameters?.properties;
	const required: string[] = tool.parameters?.required ?? [];
	if (props) {
		console.log('  Parameters:');
		for (const [name, schema] of Object.entries(props)) {
			const s = schema as Record<string, unknown>;
			const req = required.includes(name) ? ' (required)' : '';
			const type = s.type ?? 'any';
			const desc = s.description ?? '';
			console.log(`    ${name}: ${type}${req}  ${desc}`);
		}
	}
}
