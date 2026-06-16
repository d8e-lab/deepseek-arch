/**
 * InputEditor 粘贴功能测试
 *
 * 覆盖 \r 清洗、行数统计、<5 行直接粘贴、#N 标记、buildSubmitContent 还原
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InputEditor } from '../../src/cli/tui/input-editor.js';

describe('InputEditor 粘贴', () => {
	let editor: InputEditor;

	beforeEach(() => {
		editor = new InputEditor();
	});

	// ─── \r 清洗 ──────────────────────────────────

	it('将 \\r\\n 归一化为 \\n', () => {
		editor.handlePaste('line1\r\nline2');
		// 少于 5 行 → 直接展开，getDisplayLines 可见
		const lines = editor.getDisplayLines();
		expect(lines[0]).toBe('line1');
		expect(lines[1]).toBe('line2');
	});

	it('将孤立 \\r 归一化为 \\n', () => {
		editor.handlePaste('foo\rbar');
		const lines = editor.getDisplayLines();
		expect(lines[0]).toBe('foo');
		expect(lines[1]).toBe('bar');
	});

	it('混合 \\r\\n 和 \\n 均归一化', () => {
		editor.handlePaste('a\r\nb\nc\rd');
		const lines = editor.getDisplayLines();
		expect(lines).toEqual(['a', 'b', 'c', 'd']);
	});

	// ─── 行数统计 ──────────────────────────────────

	it('末尾无换行时行数正确', () => {
		// 5 行 → 走标记路径
		editor.handlePaste('1\n2\n3\n4\n5');
		const lines = editor.getDisplayLines();
		expect(lines[0]).toContain('[paste #1 +5 lines]');
	});

	it('末尾有换行不计入行数', () => {
		// 5 行内容 + 末尾 \n → 仍为 5 行
		editor.handlePaste('1\n2\n3\n4\n5\n');
		const lines = editor.getDisplayLines();
		expect(lines[0]).toContain('[paste #1 +5 lines]');
	});

	it('末尾 \\r\\n 不计入行数', () => {
		editor.handlePaste('1\r\n2\r\n');
		const lines = editor.getDisplayLines();
		expect(lines).toEqual(['1', '2']);
	});

	// ─── <5 行直接粘贴 ─────────────────────────────

	it('单行粘贴到空输入框', () => {
		editor.handlePaste('hello');
		const lines = editor.getDisplayLines();
		expect(lines[0]).toBe('hello');
	});

	it('单行粘贴到光标位置', () => {
		editor.insertChar('p');
		editor.insertChar('r');
		editor.insertChar('e');
		// 光标在最右
		editor.moveCursorLeft(); // 光标移到 'e' 前 → "pr|e"
		editor.handlePaste('-fix-');
		const lines = editor.getDisplayLines();
		expect(lines[0]).toBe('pr-fix-e');
	});

	it('多行粘贴到空输入框 (<5 行)', () => {
		editor.handlePaste('line1\nline2\nline3');
		const lines = editor.getDisplayLines();
		expect(lines).toEqual(['line1', 'line2', 'line3']);
	});

	it('多行粘贴到光标位置 (<5 行)', () => {
		editor.insertChar('A');
		// 光标在 'A' 后
		editor.handlePaste('B\nC');
		const lines = editor.getDisplayLines();
		expect(lines).toEqual(['AB', 'C']);
	});

	it('4 行粘贴直接展开（边界值）', () => {
		editor.handlePaste('a\nb\nc\nd');
		const lines = editor.getDisplayLines();
		expect(lines).toEqual(['a', 'b', 'c', 'd']);
	});

	// ─── ≥5 行标记 ─────────────────────────────────

	it('5 行粘贴使用标记（边界值）', () => {
		editor.handlePaste('1\n2\n3\n4\n5');
		const lines = editor.getDisplayLines();
		expect(lines[0]).toBe('[paste #1 +5 lines]');
	});

	it('多次粘贴标记递增 #N', () => {
		editor.handlePaste('1\n2\n3\n4\n5');
		editor.handlePaste('a\nb\nc\nd\ne\nf'); // 6 行
		const content = editor.buildSubmitContent();
		expect(content).toBe('1\n2\n3\n4\n5a\nb\nc\nd\ne\nf');
	});

	// ─── 混合粘贴 ──────────────────────────────────

	it('小粘贴 + 大粘贴混合', () => {
		editor.handlePaste('hello');              // <5 行直接展开
		editor.handlePaste('1\n2\n3\n4\n5');      // ≥5 行标记
		const lines = editor.getDisplayLines();
		expect(lines[0]).toBe('hello[paste #1 +5 lines]');
		const content = editor.buildSubmitContent();
		expect(content).toBe('hello1\n2\n3\n4\n5');
	});

	it('大粘贴 + 小粘贴混合', () => {
		editor.handlePaste('1\n2\n3\n4\n5');      // ≥5 行标记
		editor.handlePaste(' world');             // <5 行直接展开
		const lines = editor.getDisplayLines();
		expect(lines[0]).toBe('[paste #1 +5 lines] world');
		const content = editor.buildSubmitContent();
		expect(content).toBe('1\n2\n3\n4\n5 world');
	});

	// ─── buildSubmitContent 标记还原 ──────────────

	it('单个标记还原为原始文本', () => {
		editor.handlePaste('foo\nbar\nbaz\nqux\nquux');
		const content = editor.buildSubmitContent();
		expect(content).toBe('foo\nbar\nbaz\nqux\nquux');
	});

	it('多个 #N 标记按顺序还原', () => {
		editor.handlePaste('A\nB\nC\nD\nE');     // #1
		editor.handlePaste('1\n2\n3\n4\n5');     // #2
		const content = editor.buildSubmitContent();
		expect(content).toBe('A\nB\nC\nD\nE1\n2\n3\n4\n5');
	});

	// ─── clear 重置 ────────────────────────────────

	it('clear 后 pasteSeq 归零', () => {
		editor.handlePaste('1\n2\n3\n4\n5');  // #1
		editor.clear();
		editor.handlePaste('a\nb\nc\nd\ne');  // 重新从 #1 开始
		const lines = editor.getDisplayLines();
		expect(lines[0]).toContain('[paste #1 +5 lines]');
	});

	it('clear 后 pasteContents 清空', () => {
		editor.handlePaste('1\n2\n3\n4\n5');
		editor.clear();
		// 空输入框提交返回空串
		const content = editor.buildSubmitContent();
		expect(content).toBe('');
	});

	// ─── 边界情况 ──────────────────────────────────

	it('完全空粘贴（只有换行）不崩溃', () => {
		editor.handlePaste('\n');
		const lines = editor.getDisplayLines();
		expect(lines[0]).toBe('');  // clean paste, no marker
	});

	it('全部 \\r\\n 的粘贴不崩溃', () => {
		editor.handlePaste('\r\n\r\n');
		// 归一化为 \n\n，trimmed = \n，lineCount = 1 → 插入空行
		const lines = editor.getDisplayLines();
		expect(lines).toEqual(['', '']);
	});

	// ─── 原子删除 ──────────────────────────────────

	describe('原子删除粘贴标记', () => {
		/** 辅助：添加一段 5 行粘贴并返回其原始文本 */
		function pasteLarge(editor: InputEditor, text: string) {
			editor.handlePaste(text);
		}

		it('Backspace 在标记内部 → 删除整个标记', () => {
			pasteLarge(editor, '1\n2\n3\n4\n5');
			// 标记 "[paste #1 +5 lines]" 共占若干字符，光标在末尾
			// 移动光标到标记中间
			editor.moveCursorLeft();
			editor.moveCursorLeft();
			editor.deleteBeforeCursor();
			const lines = editor.getDisplayLines();
			expect(lines[0]).toBe('');
			expect(editor.buildSubmitContent()).toBe('');
		});

		it('Backspace 紧邻标记右侧 → 删除整个标记', () => {
			editor.insertChar('x');
			pasteLarge(editor, '1\n2\n3\n4\n5');
			// 当前: "x[paste #1 +5 lines]"，光标在标记右侧
			// Backspace 应该删除整个标记
			editor.deleteBeforeCursor();
			const lines = editor.getDisplayLines();
			expect(lines[0]).toBe('x');
		});

		it('Delete 在标记内部 → 删除整个标记', () => {
			pasteLarge(editor, '1\n2\n3\n4\n5');
			editor.moveToLineStart(); // 光标到行首
			editor.moveCursorRight(); // 进入标记
			editor.deleteAfterCursor();
			const lines = editor.getDisplayLines();
			expect(lines[0]).toBe('');
		});

		it('Delete 紧邻标记左侧 → 删除整个标记', () => {
			editor.insertChar('x');
			pasteLarge(editor, '1\n2\n3\n4\n5');
			// "x[paste #1 +5 lines]"
			editor.moveToLineStart();
			editor.moveCursorRight(); // 光标在 x 后、标记前
			editor.deleteAfterCursor();
			expect(editor.getDisplayLines()[0]).toBe('x');
		});

		it('跨行 Backspace：上行末尾是标记 → 删除标记不合并行', () => {
			pasteLarge(editor, '1\n2\n3\n4\n5');
			// 在标记后换行
			editor.moveToLineEnd();
			editor.insertNewline();
			editor.insertChar('y');
			// 当前: 行0="[paste #1 +5 lines]", 行1="y"
			// 光标在行1开头，Backspace
			editor.moveToLineStart();
			editor.deleteBeforeCursor();
			const lines = editor.getDisplayLines();
			expect(lines[0]).toBe('');
			expect(lines[1]).toBe('y');
		});

		it('跨行 Delete：下行开头是标记 → 删除标记不合并行', () => {
			editor.insertChar('x');
			editor.insertNewline();
			pasteLarge(editor, 'a\nb\nc\nd\ne');
			// 行0="x", 行1="[paste #1 +5 lines]"
			// 光标在行0末尾
			editor.moveCursor(-1, 0); // 回到行0
			editor.moveToLineEnd();
			editor.deleteAfterCursor();
			const lines = editor.getDisplayLines();
			expect(lines[0]).toBe('x');
			expect(lines[1]).toBe('');
		});

		it('删除一个标记后 pasteContents 同步移除', () => {
			pasteLarge(editor, '1\n2\n3\n4\n5');        // #1: 5行
			pasteLarge(editor, 'a\nb\nc\nd\ne\nf');     // #2: 6行
			// 删除 #1
			editor.moveToLineStart();
			editor.deleteAfterCursor();
			// 只剩 #2
			const content = editor.buildSubmitContent();
			expect(content).toBe('a\nb\nc\nd\ne\nf');
		});

		it('普通 Backspace/Delete 不受影响', () => {
			editor.insertChar('h');
			editor.insertChar('i');
			// "hi"，光标在最右
			editor.deleteBeforeCursor();
			expect(editor.getDisplayLines()[0]).toBe('h');
			editor.moveToLineStart();
			editor.deleteAfterCursor();
			expect(editor.getDisplayLines()[0]).toBe('');
		});
	});
});
