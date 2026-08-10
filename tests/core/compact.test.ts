/**
 * compact.test.ts — compact 核心逻辑单元测试
 *
 * 覆盖：
 *   - extractReadFiles：提取/去重/排除 plan·memory/按最后访问时间排序
 *   - buildFileRestoreBlock：大小分流（小文件全文 / 大文件引用）、前 5 上限、预算截断
 *   - extractSkills / extractPlanNames：从 tool_calls 提取
 *   - buildCompactMessages：组装消息序列
 *   - generateSummary：mock provider 摘要生成 + fallback
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TurnRecord } from '../../src/types/index.js';
import {
  extractReadFiles,
  buildFileRestoreBlock,
  extractSkills,
  extractPlanNames,
  buildCompactMessages,
  generateSummary,
  estimateTokens,
  truncateTokens,
  MAX_RESTORE_FILES,
  POST_COMPACT_TOKEN_BUDGET,
  POST_COMPACT_MAX_TOKENS_PER_FILE,
} from '../../src/core/compact.js';
import type { ModelProvider } from '../../src/core/model-provider.js';

/** 构造一条带工具调用的 turn */
function makeTurn(
  user: string,
  assistant: string,
  toolCalls: { name: string; args: Record<string, unknown> }[],
  created: string,
): TurnRecord {
  const messages: import('../../src/types/index.js').Message[] = [
    { role: 'user', content: user },
  ];
  if (toolCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: toolCalls.map((tc, i) => ({
        id: `call-${i}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    });
    for (let i = 0; i < toolCalls.length; i++) {
      messages.push({ role: 'tool', content: 'ok', tool_call_id: `call-${i}` });
    }
  }
  messages.push({ role: 'assistant', content: assistant });
  return {
    version: 2,
    messages,
    cost_rmb: 0.001,
    created_at: created,
    tool_calls: toolCalls.map((tc, i) => ({
      id: `call-${i}`,
      name: tc.name,
      arguments: tc.args,
      duration_ms: 10,
    })),
  };
}

describe('extractReadFiles', () => {
  it('提取 read_file 调用并去重（同路径保留最后访问）', () => {
    const turns = [
      makeTurn('q1', 'a1', [
        { name: 'read_file', args: { path: 'src/foo.ts' } },
        { name: 'read_file', args: { path: 'src/bar.ts' } },
      ], '2026-01-01T00:00:00Z'),
      makeTurn('q2', 'a2', [
        { name: 'read_file', args: { path: 'src/foo.ts' } }, // 重复
      ], '2026-01-02T00:00:00Z'),
    ];
    const files = extractReadFiles(turns);
    expect(files).toHaveLength(2);
    const foo = files.find((f) => f.path === 'src/foo.ts')!;
    expect(foo).toBeDefined();
    // foo 最后访问时间 = 第二轮
    expect(foo.lastAccessMs).toBe(new Date('2026-01-02T00:00:00Z').getTime());
  });

  it('按最后访问时间降序排序', () => {
    const turns = [
      makeTurn('q1', 'a1', [{ name: 'read_file', args: { path: 'old.ts' } }], '2026-01-01T00:00:00Z'),
      makeTurn('q2', 'a2', [{ name: 'read_file', args: { path: 'new.ts' } }], '2026-01-03T00:00:00Z'),
      makeTurn('q3', 'a3', [{ name: 'read_file', args: { path: 'mid.ts' } }], '2026-01-02T00:00:00Z'),
    ];
    const files = extractReadFiles(turns);
    expect(files.map((f) => f.path)).toEqual(['new.ts', 'mid.ts', 'old.ts']);
  });

  it('排除 plan（.plans/）与 memory 路径', () => {
    const turns = [
      makeTurn('q1', 'a1', [
        { name: 'read_file', args: { path: '.plans/compact.md' } },
        { name: 'read_file', args: { path: 'memory/notes.md' } },
        { name: 'read_file', args: { path: 'src/main.ts' } },
      ], '2026-01-01T00:00:00Z'),
    ];
    const files = extractReadFiles(turns);
    expect(files.map((f) => f.path)).toEqual(['src/main.ts']);
  });

  it('非 read_file 工具调用不进入结果', () => {
    const turns = [
      makeTurn('q1', 'a1', [
        { name: 'execute_command', args: { command: 'ls' } },
        { name: 'read_file', args: { path: 'src/x.ts' } },
      ], '2026-01-01T00:00:00Z'),
    ];
    expect(extractReadFiles(turns)).toHaveLength(1);
  });
});

describe('buildFileRestoreBlock', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'compact-restore-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('小文件完整读入最新内容', async () => {
    await writeFile(join(cwd, 'small.ts'), 'const x = 1;\n', 'utf-8');
    const block = await buildFileRestoreBlock(
      [{ path: 'small.ts', lastAccessMs: 1, seq: 0 }],
      cwd,
    );
    expect(block.text).toContain('[Compact File Restore] path: small.ts');
    expect(block.text).toContain('const x = 1;');
    expect(block.tokenCount).toBeGreaterThan(0);
  });

  it('超大文件（>256KB）只给引用，不给内容', async () => {
    await writeFile(join(cwd, 'big.ts'), 'x'.repeat(300 * 1024), 'utf-8');
    const block = await buildFileRestoreBlock(
      [{ path: 'big.ts', lastAccessMs: 1, seq: 0 }],
      cwd,
    );
    expect(block.text).toContain('<compact_file_reference');
    expect(block.text).not.toContain('xxx'); // 不给内容
  });

  it('token 超限文件（>5K tokens）只给引用', async () => {
    // 5K tokens ≈ 15K 字节
    await writeFile(join(cwd, 'tok.ts'), 'y'.repeat(POST_COMPACT_MAX_TOKENS_PER_FILE * 3 + 100), 'utf-8');
    const block = await buildFileRestoreBlock(
      [{ path: 'tok.ts', lastAccessMs: 1, seq: 0 }],
      cwd,
    );
    expect(block.text).toContain('<compact_file_reference');
    expect(block.text).toContain('too large to restore');
  });

  it('文件不存在只给引用', async () => {
    const block = await buildFileRestoreBlock(
      [{ path: 'missing.ts', lastAccessMs: 1, seq: 0 }],
      cwd,
    );
    expect(block.text).toContain('<compact_file_reference');
    expect(block.text).toContain('not restorable');
  });

  it('最多注入 5 个文件（硬限制）', async () => {
    const files = [];
    for (let i = 0; i < 8; i++) {
      await writeFile(join(cwd, `f${i}.ts`), `// file ${i}\n`, 'utf-8');
      files.push({ path: `f${i}.ts`, lastAccessMs: 100 - i, seq: i });
    }
    const block = await buildFileRestoreBlock(files, cwd);
    expect(block.text.split('[Compact File Restore]').length - 1).toBeLessThanOrEqual(MAX_RESTORE_FILES);
  });

  it('总预算超限丢弃较旧文件', async () => {
    // 构造每个 ~12K tokens 的文件（36K 字节），3 个就超 50K 预算
    const chunk = 'z'.repeat(12_000 * 3);
    const files = [];
    for (let i = 0; i < 5; i++) {
      await writeFile(join(cwd, `big${i}.ts`), chunk, 'utf-8');
      files.push({ path: `big${i}.ts`, lastAccessMs: 100 - i, seq: i });
    }
    const block = await buildFileRestoreBlock(files, cwd);
    // 预算 50K：最多容纳 4 个 12K（4*12=48K），第 5 个丢弃
    const fullCount = (block.text.match(/\[Compact File Restore\] path:/g) ?? []).length;
    expect(fullCount).toBeLessThanOrEqual(4);
    // token 数不超预算
    expect(block.tokenCount).toBeLessThanOrEqual(POST_COMPACT_TOKEN_BUDGET);
  });
});

describe('extractSkills / extractPlanNames', () => {
  it('extractSkills 提取 plan_on 调用并去重', () => {
    const turns = [
      makeTurn('q1', 'a1', [{ name: 'plan_on', args: {} }], '2026-01-01T00:00:00Z'),
      makeTurn('q2', 'a2', [{ name: 'execute_command', args: {} }], '2026-01-02T00:00:00Z'),
    ];
    const skills = extractSkills(turns);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('plan.skill.md');
  });

  it('extractPlanNames 提取 save_plan 文件名（从新到旧去重）', () => {
    const turns = [
      makeTurn('q1', 'a1', [{ name: 'save_plan', args: { plan_name: 'alpha' } }], '2026-01-01T00:00:00Z'),
      makeTurn('q2', 'a2', [
        { name: 'save_plan', args: { plan_name: 'alpha' } },
        { name: 'save_plan', args: { plan_name: 'beta' } },
      ], '2026-01-02T00:00:00Z'),
    ];
    const names = extractPlanNames(turns);
    expect(names).toEqual(['beta', 'alpha']);
  });
});

describe('buildCompactMessages', () => {
  it('组装 [摘要 + 文件重注入 + plan + skills] 消息序列', () => {
    const messages = buildCompactMessages('摘要内容', '文件块', '计划块', '技能块');
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({
      role: 'user',
      content: '[Compacted Context Summary]\n摘要内容',
    });
    expect(messages[1].content).toContain('[Compact File Restore Block]');
    expect(messages[2].content).toContain('[Compact Plan]');
    expect(messages[3].content).toContain('[Compact Skills]');
  });

  it('空重注入块不生成对应消息', () => {
    const messages = buildCompactMessages('摘要', '', '', '');
    expect(messages).toHaveLength(1);
  });
});

describe('generateSummary', () => {
  it('mock provider 返回摘要内容', async () => {
    const provider = {
      chat: async () => ({
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: '生成的摘要' }, finish_reason: 'stop' }],
      }),
    } as unknown as ModelProvider;

    const summary = await generateSummary(provider, [makeTurn('q', 'a', [], '2026-01-01T00:00:00Z')]);
    expect(summary).toBe('生成的摘要');
  });

  it('provider 失败时回退为 fallback 文本（不阻断）', async () => {
    const provider = {
      chat: async () => { throw new Error('api down'); },
    } as unknown as ModelProvider;

    const summary = await generateSummary(provider, [makeTurn('q', 'a', [], '2026-01-01T00:00:00Z')]);
    expect(summary).toContain('(compact fallback');
  });
});

describe('estimateTokens / truncateTokens', () => {
  it('estimateTokens 按 UTF-8 字节/3 估算', () => {
    expect(estimateTokens('abc')).toBe(1); // 3 字节 / 3
    expect(estimateTokens('你好')).toBe(2); // 6 字节 / 3
    expect(estimateTokens('')).toBe(0);
  });

  it('truncateTokens 超限截断并加标记', () => {
    const text = 'a'.repeat(3000);
    const truncated = truncateTokens(text, 500); // 500 tokens ≈ 1500 字节
    expect(truncated.length).toBeLessThan(text.length);
    expect(truncated.endsWith('...(truncated)')).toBe(true);
  });
});
