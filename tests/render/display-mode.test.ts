/**
 * display-mode 展示模式预设单元测试
 */
import { describe, it, expect } from 'vitest';
import { DISPLAY_PRESETS, isDisplayMode, isFileModTool } from '../../src/render/display-mode.js';

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
