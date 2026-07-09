/**
 * subagent-store.test.ts — SubagentStore 单元测试
 */

import { describe, it, expect } from 'vitest';
import { SubagentStore, SubagentRecord, SubagentRoundEntry } from '../../src/core/subagent-store.js';

describe('SubagentStore', () => {
	it('start 创建 running 状态的记录', () => {
		const store = new SubagentStore();
		const record = store.start('test', 'do something');
		expect(record.name).toBe('test');
		expect(record.task).toBe('do something');
		expect(record.status).toBe('running');
		expect(record.entries).toEqual([]);
		expect(record.startMs).toBeGreaterThan(0);
	});

	it('push 追加条目', () => {
		const store = new SubagentStore();
		store.start('test', 'task');
		store.push('test', { type: 'content', content: 'hello', timestamp: 1 });
		store.push('test', { type: 'thinking', content: 'hmm', timestamp: 2 });

		const record = store.get('test');
		expect(record).toBeDefined();
		expect(record!.entries).toHaveLength(2);
		expect(record!.entries[0].type).toBe('content');
		expect(record!.entries[1].type).toBe('thinking');
	});

	it('push 到不存在的记录不抛错', () => {
		const store = new SubagentStore();
		expect(() => store.push('nonexistent', { type: 'content', content: 'x', timestamp: 0 })).not.toThrow();
	});

	it('finish 标记 completed', () => {
		const store = new SubagentStore();
		store.start('test', 'task');
		store.finish('test', 'all done', false);

		const record = store.get('test');
		expect(record!.status).toBe('completed');
		expect(record!.result).toBe('all done');
		expect(record!.endMs).toBeGreaterThan(0);
	});

	it('finish 标记 failed', () => {
		const store = new SubagentStore();
		store.start('test', 'task');
		store.finish('test', 'Error: something broke', true);

		const record = store.get('test');
		expect(record!.status).toBe('failed');
		expect(record!.result).toBe('Error: something broke');
	});

	it('get 返回 undefined 对于不存在的记录', () => {
		const store = new SubagentStore();
		expect(store.get('nonexistent')).toBeUndefined();
	});

	it('list 列出所有名称', () => {
		const store = new SubagentStore();
		store.start('a', 'ta');
		store.start('b', 'tb');
		expect(store.list()).toEqual(['a', 'b']);
	});

	it('listRecords 列出所有记录', () => {
		const store = new SubagentStore();
		store.start('a', 'ta');
		store.start('b', 'tb');
		const records = store.listRecords();
		expect(records).toHaveLength(2);
		expect(records.map(r => r.name)).toEqual(['a', 'b']);
	});

	it('clear 清空所有记录', () => {
		const store = new SubagentStore();
		store.start('a', 'ta');
		store.clear();
		expect(store.list()).toEqual([]);
		expect(store.get('a')).toBeUndefined();
	});

	it('多个子代理独立记录', () => {
		const store = new SubagentStore();
		store.start('a', 'task a');
		store.start('b', 'task b');
		store.push('a', { type: 'content', content: 'from a', timestamp: 1 });
		store.push('b', { type: 'content', content: 'from b', timestamp: 2 });

		expect(store.get('a')!.entries).toHaveLength(1);
		expect(store.get('b')!.entries).toHaveLength(1);
	});

	it('tool_output 条目支持 outputStream', () => {
		const store = new SubagentStore();
		store.start('test', 'task');
		store.push('test', {
			type: 'tool_output',
			content: 'error line',
			timestamp: 1,
			toolName: 'execute_command',
			outputStream: 'stderr',
		});
		store.push('test', {
			type: 'tool_output',
			content: 'normal line',
			timestamp: 2,
			toolName: 'execute_command',
			outputStream: 'stdout',
		});

		const record = store.get('test')!;
		expect(record.entries).toHaveLength(2);
		expect(record.entries[0].outputStream).toBe('stderr');
		expect(record.entries[1].outputStream).toBe('stdout');
	});

	it('finish 后 record 状态正确且 result 保存', () => {
		const store = new SubagentStore();
		store.start('test', 'complex task');
		store.push('test', { type: 'content', content: 'working...', timestamp: 1 });
		store.push('test', { type: 'tool_call', content: 'read_file', timestamp: 2, toolName: 'read_file', toolArgs: { path: 'x.ts' } });
		store.push('test', { type: 'tool_result', content: 'file contents', timestamp: 3, toolName: 'read_file' });
		store.finish('test', 'task completed successfully', false);

		const record = store.get('test')!;
		expect(record.status).toBe('completed');
		expect(record.result).toBe('task completed successfully');
		expect(record.entries).toHaveLength(3);
		expect(record.endMs).toBeGreaterThanOrEqual(record.startMs);
	});
});
