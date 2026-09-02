/**
 * display-mode 展示模式预设单元测试
 */
import { describe, it, expect } from 'vitest';
import {
	DISPLAY_PRESETS,
	isDisplayMode,
	isFileModTool,
	mergeDisplayPreset,
	parseDisplayOverride,
	buildDisplayPreset,
} from '../../src/render/display-mode.js';

describe('DISPLAY_PRESETS', () => {
	it('三档预设齐全且 short/normal 比 detail 紧凑', () => {
		expect(DISPLAY_PRESETS.detail.thinkLiveLines).toBe(5);
		expect(DISPLAY_PRESETS.normal.thinkLiveLines).toBe(4);
		expect(DISPLAY_PRESETS.short.thinkLiveLines).toBe(4);

		// detail 现状：结果 12 行；normal：6 行
		expect(DISPLAY_PRESETS.detail.toolResultMaxLines).toBe(12);
		expect(DISPLAY_PRESETS.normal.toolResultMaxLines).toBe(6);

		// 实时输出流：detail/normal 保留，short 隐藏
		expect(DISPLAY_PRESETS.detail.showLiveToolOutput).toBe(true);
		expect(DISPLAY_PRESETS.normal.showLiveToolOutput).toBe(true);
		expect(DISPLAY_PRESETS.short.showLiveToolOutput).toBe(false);

		// short：隐藏非文件修改工具结果
		expect(DISPLAY_PRESETS.short.hideNonFileToolResult).toBe(true);
		expect(DISPLAY_PRESETS.normal.hideNonFileToolResult).toBe(false);
		expect(DISPLAY_PRESETS.detail.hideNonFileToolResult).toBe(false);
	});
});

describe('isFileModTool', () => {
	it('识别 edit_file/write_file', () => {
		expect(isFileModTool('edit_file')).toBe(true);
		expect(isFileModTool('write_file')).toBe(true);
		expect(isFileModTool('shell')).toBe(false);
		expect(isFileModTool('read_file')).toBe(false);
		expect(isFileModTool(undefined)).toBe(false);
	});
});

describe('isDisplayMode', () => {
	it('只接受 short/normal/detail', () => {
		expect(isDisplayMode('short')).toBe(true);
		expect(isDisplayMode('normal')).toBe(true);
		expect(isDisplayMode('detail')).toBe(true);
		expect(isDisplayMode('verbose')).toBe(false);
		expect(isDisplayMode(undefined)).toBe(false);
	});
});

describe('parseDisplayOverride', () => {
	it('映射 config 的 snake_case 键为预设字段', () => {
		const out = parseDisplayOverride({
			think_live_lines: 2,
			tool_result_max_lines: 8,
			show_live_tool_output: false,
			hide_non_file_tool_result: true,
		});
		expect(out).toEqual({
			thinkLiveLines: 2,
			toolResultMaxLines: 8,
			showLiveToolOutput: false,
			hideNonFileToolResult: true,
		});
	});

	it('非法/缺失值忽略（返回空覆盖）', () => {
		expect(parseDisplayOverride(undefined)).toEqual({});
		expect(parseDisplayOverride({ think_live_lines: 'x', show_live_tool_output: 'yes' })).toEqual({});
		expect(parseDisplayOverride({ think_live_lines: -1, tool_result_max_lines: -3 })).toEqual({
			thinkLiveLines: 1, // 下限 1
			toolResultMaxLines: 0, // 下限 0
		});
	});
});

describe('mergeDisplayPreset / buildDisplayPreset', () => {
	it('无覆盖时返回内置预设', () => {
		expect(buildDisplayPreset('normal', undefined)).toEqual(DISPLAY_PRESETS.normal);
		expect(buildDisplayPreset('detail', {})).toEqual(DISPLAY_PRESETS.detail);
	});

	it('buildDisplayPreset 应用当前档位的覆盖，其余沿用内置', () => {
		const p = buildDisplayPreset('short', {
			overrides: { short: { think_live_lines: 2 } },
		});
		expect(p.thinkLiveLines).toBe(2);
		expect(p.showLiveToolOutput).toBe(false); // 沿用 short 内置
		expect(p.hideNonFileToolResult).toBe(true);
	});

	it('其他档位的覆盖不影响当前档', () => {
		const p = buildDisplayPreset('normal', {
			overrides: { short: { think_live_lines: 2 } },
		});
		expect(p.thinkLiveLines).toBe(DISPLAY_PRESETS.normal.thinkLiveLines);
	});

	it('mergeDisplayPreset 保留 base 未覆盖字段', () => {
		const base = DISPLAY_PRESETS.detail;
		const merged = mergeDisplayPreset(base, { toolResultMaxLines: 20 });
		expect(merged.toolResultMaxLines).toBe(20);
		expect(merged.thinkLiveLines).toBe(base.thinkLiveLines);
		expect(merged.showLiveToolOutput).toBe(base.showLiveToolOutput);
	});
});
