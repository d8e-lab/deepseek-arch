/**
 * ChatUI — 全屏终端对话界面
 *
 * 基于 node:readline 原始模式 + ANSI 转义序列，零额外 TUI 依赖。
 *
 * 布局：
 *   ┌─ 顶部信息栏 ──────────────────────────────┐
 *   │  DeepSeek Arch v0.2.1                      │
 *   │  Provider: deepseek | Model: deepseek-v4-pro│
 *   ├────────────────────────────────────────────┤
 *   │  [绿色] 用户输入                            │
 *   │  [灰色] 模型思考                            │
 *   │  [白色] 模型回复                            │
 *   │  ...（滚动区域）                            │
 *   ├────────────────────────────────────────────┤
 *   │  [灰底] 多行输入面板（Enter 发送）          │
 *   └────────────────────────────────────────────┘
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import { ConfigManager } from '../core/config.js';
import { ApiClient } from '../core/api.js';
import { Storage } from '../core/storage.js';
import { SessionManager } from '../core/session.js';
import type { Message, ChatCompletionResponse } from '../core/types.js';

// 扩展 readline 的类型定义
interface KeyPress {
  sequence: string;
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

// ─── 常量 ────────────────────────────────────────────

const VERSION = '0.2.1';
const MAX_INPUT_HEIGHT = 10; // 输入面板最大行数

// ANSI 转义序列
const CSI = '\x1b[';
const CURSOR_HOME = `${CSI}H`;
const CLEAR_SCREEN = `${CSI}2J`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ERASE_LINE = `${CSI}2K`;
const ERASE_SCREEN_BELOW = `${CSI}0J`;
const ENTER_ALT_SCREEN = `${CSI}?1049h`;
const EXIT_ALT_SCREEN = `${CSI}?1049l`;

function cursorTo(row: number, col: number = 0): string {
  return `${CSI}${row + 1};${col + 1}H`;
}

// ─── 渲染行类型 ──────────────────────────────────────

type LineColor = 'green' | 'gray' | 'white';

interface RenderedLine {
  text: string;      // 不含 ANSI 的纯文本
  color: LineColor;
}

// ─── ChatUI ──────────────────────────────────────────

export class ChatUI {
  private config: ConfigManager;
  private sessionManager: SessionManager | null = null;

  // 终端尺寸
  private termWidth = 80;
  private termHeight = 24;

  // 对话渲染行（环形缓冲区，用于滚动展示）
  private displayLines: RenderedLine[] = [];

  // 输入
  private inputText = '';
  private cursorPos = 0;

  // 输入历史
  private inputHistory: string[] = [];
  private historyIndex = -1;

  // 运行状态
  private running = false;
  private rawMode = false;

  // 上次输入面板高度（用于增量绘制优化）
  private lastInputHeight = 1;

  // 待退出时恢复的 stdin 设置
  private stdinIsTTY = false;

  constructor(config: ConfigManager) {
    this.config = config;
  }

  // ─── 生命周期 ──────────────────────────────────

  async start(): Promise<void> {
    this.stdinIsTTY = process.stdin.isTTY ?? false;
    if (!this.stdinIsTTY) {
      console.error('错误: 需要交互式终端');
      process.exit(1);
    }

    // 读取终端尺寸
    this.updateTermSize();

    // 初始化 SessionManager（创建 ApiClient + Storage + 新会话）
    await this.initSession();

    // 加载 system prompt 到 SessionManager
    this.loadSystemPrompt();

    // 进入原始模式
    this.enterRawMode();

    // 启用 keypress 事件（原生 UTF-8 支持，含 CJK / IME 输入）
    readline.emitKeypressEvents(process.stdin);
    this.setupKeypressHandler();

    // 注册 resize 事件
    process.stdout.on('resize', () => this.onResize());

    this.running = true;

    // 首次绘制
    this.fullDraw();

    // 等待退出信号（keypress handler 中设置 this.running = false）
    await this.waitForExit();

    // 清理
    this.cleanup();
  }

  // ─── 初始化 ────────────────────────────────────

  private async initSession(): Promise<void> {
    // 创建 Storage（会话存储目录来自 ConfigManager）
    const sessionsDir = this.config.getSessionsDir();
    const storage = new Storage(sessionsDir);

    // 创建 ApiClient（参数从 ConfigManager 读取）
    const provider = this.config.get<string>('defaults.provider') ?? 'deepseek';
    const model = this.config.get<string>('defaults.model') ?? 'deepseek-v4-pro';
    const baseUrl = this.config.get<string>(`providers.${provider}.base_url`) ?? '';
    const apiKey = this.config.get<string>(`providers.${provider}.api_key`) ?? '';

    if (!apiKey) {
      console.error(chalk.red('错误: 未配置 API Key'));
      console.error(chalk.dim(`  请在 ~/.deepseek-arch/providers.toml 中设置 [${provider}].api_key`));
      process.exit(1);
    }

    const client = new ApiClient(baseUrl, apiKey, model);

    // 创建 SessionManager 并启动新会话
    this.sessionManager = new SessionManager(storage, client);
    await this.sessionManager.startNewSession();
  }

  private loadSystemPrompt(): void {
    const promptName = this.config.get<string>('defaults.system_prompt') ?? 'default';
    const content = this.config.get<string>(`systemPrompts.${promptName}.content`);
    if (content) {
      this.sessionManager?.setSystemPrompt({ role: 'system', content });
    }
  }

  private updateTermSize(): void {
    this.termWidth = process.stdout.columns || 80;
    this.termHeight = process.stdout.rows || 24;
  }

  // ─── 原始模式 ──────────────────────────────────

  private enterRawMode(): void {
    // 切换到 alternate screen buffer（隔离终端历史内容）
    process.stdout.write(ENTER_ALT_SCREEN);
    // 清屏
    process.stdout.write(CLEAR_SCREEN);
    process.stdin.setRawMode(true);
    this.rawMode = true;
    process.stdout.write(HIDE_CURSOR);
  }

  private exitRawMode(): void {
    if (this.rawMode) {
      process.stdin.setRawMode(false);
      this.rawMode = false;
    }
    process.stdout.write(SHOW_CURSOR);
  }

  private cleanup(): void {
    this.exitRawMode();
    // 清除颜色属性
    process.stdout.write(`${CSI}0m`);
    // 切换回主屏幕（恢复终端原始内容）
    process.stdout.write(EXIT_ALT_SCREEN);

    // 显示会话信息
    this.printExitSummary();
  }

  /** 退出汇总：session ID + 恢复命令 */
  private printExitSummary(): void {
    const sessionId = this.sessionManager?.getSessionId();
    const session = this.sessionManager?.getSession();
    if (!sessionId || !session) return;

    const turnCount = session.turns.length;
    if (turnCount === 0) return;

    console.log('');
    console.log(chalk.dim('─'.repeat(60)));
    console.log(
      chalk.white('会话已保存  ') +
        chalk.gray(`(${turnCount} 轮对话)`) +
        chalk.dim(`  id: ${sessionId}`),
    );
    console.log(chalk.white('恢复此会话:'));
    console.log(chalk.cyan(`  deepseek-arch resume --id ${sessionId}`));
    console.log(chalk.dim('─'.repeat(60)));
  }

  // ─── Resize ────────────────────────────────────

  private onResize(): void {
    this.updateTermSize();
    this.fullDraw();
  }

  // ─── 键盘事件 ──────────────────────────────────

  /** 等待退出（配合 keypress 事件驱动） */
  private waitForExit(): Promise<void> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  /** 注册 keypress 事件处理器（原生支持 UTF-8 / CJK / IME） */
  private setupKeypressHandler(): void {
    process.stdin.on('keypress', (str: string, key: KeyPress) => {
      if (!this.running) return;

      // Ctrl+C
      if (key.ctrl && key.name === 'c') {
        this.running = false;
        return;
      }

      // Ctrl+D (空行退出)
      if (key.ctrl && key.name === 'd' && this.inputText.length === 0) {
        this.running = false;
        return;
      }

      // Enter
      if (key.name === 'return') {
        if (key.ctrl) {
          // Ctrl+Enter: 插入换行符
          this.insertNewline();
        } else {
          this.handleEnter();
        }
        return;
      }

      // Ctrl+J: 备选换行键
      if (key.ctrl && key.name === 'j') {
        this.insertNewline();
        return;
      }

      // Ctrl+L: 清屏（终端传统快捷键）
      if (key.ctrl && key.name === 'l') {
        this.displayLines = [];
        this.fullDraw();
        return;
      }

      // Backspace — 支持跨 \n 删除
      if (key.name === 'backspace') {
        if (this.cursorPos > 0 && this.inputText[this.cursorPos - 1] === '\n') {
          this.inputText =
            this.inputText.slice(0, this.cursorPos - 1) + this.inputText.slice(this.cursorPos);
          this.cursorPos--;
        } else {
          this.handleBackspace();
        }
        this.drawSmart();
        return;
      }

      // Delete
      if (key.name === 'delete') {
        if (this.cursorPos < this.inputText.length) {
          this.inputText =
            this.inputText.slice(0, this.cursorPos) +
            this.inputText.slice(this.cursorPos + 1);
          this.drawSmart();
        }
        return;
      }

      // 方向键上 — 历史
      if (key.name === 'up') {
        this.historyUp();
        return;
      }

      // 方向键下 — 历史
      if (key.name === 'down') {
        this.historyDown();
        return;
      }

      // 方向键左
      if (key.name === 'left') {
        if (this.cursorPos > 0) this.cursorPos--;
        this.drawSmart();
        return;
      }

      // 方向键右
      if (key.name === 'right') {
        if (this.cursorPos < this.inputText.length) this.cursorPos++;
        this.drawSmart();
        return;
      }

      // Home
      if (key.name === 'home') {
        this.cursorPos = 0;
        this.drawSmart();
        return;
      }

      // End
      if (key.name === 'end') {
        this.cursorPos = this.inputText.length;
        this.drawSmart();
        return;
      }

      // 可打印字符（含中文、emoji 等全部 UTF-8 字符）
      if (str && str.length > 0) {
        this.insertChar(str);
        return;
      }
    });
  }

  // ─── 输入操作 ──────────────────────────────────

  /** 插入换行符（硬换行），触发全屏重绘确保布局正确 */
  private insertNewline(): void {
    this.inputText =
      this.inputText.slice(0, this.cursorPos) + '\n' + this.inputText.slice(this.cursorPos);
    this.cursorPos++;
    this.fullDraw();
  }

  private insertChar(char: string): void {
    this.inputText =
      this.inputText.slice(0, this.cursorPos) + char + this.inputText.slice(this.cursorPos);
    this.cursorPos += char.length;
    this.drawSmart();
  }

  private handleBackspace(): void {
    if (this.cursorPos > 0) {
      this.inputText =
        this.inputText.slice(0, this.cursorPos - 1) + this.inputText.slice(this.cursorPos);
      this.cursorPos--;
      this.drawSmart();
    }
  }

  /** 智能绘制：输入面板高度不变时增量绘制，否则全屏绘制 */
  private drawSmart(): void {
    const newHeight = this.calcInputHeight();
    if (newHeight !== this.lastInputHeight) {
      this.fullDraw();
    } else {
      this.drawInput();
    }
  }

  /** 同步 lastInputHeight（全屏绘制 / 清空输入后调用） */
  private syncInputHeight(): void {
    this.lastInputHeight = this.calcInputHeight();
  }

  private async handleEnter(): Promise<void> {
    const text = this.inputText.trim();
    if (text.length === 0) return;

    // 检查命令
    if (text.startsWith('/')) {
      await this.handleCommand(text);
      this.inputText = '';
      this.cursorPos = 0;
      this.syncInputHeight();
      return;
    }

    // 添加到历史
    this.inputHistory.push(text);
    this.historyIndex = -1;

    // 清空输入
    this.inputText = '';
    this.cursorPos = 0;
    this.syncInputHeight();

    // 显示用户消息
    this.appendLine(text, 'green');

    // 显示加载指示
    const loadingLine: RenderedLine = { text: '⏳ Thinking...', color: 'gray' };
    this.displayLines.push(loadingLine);
    this.fullDraw();

    try {
      const { response } = await this.sessionManager!.sendMessage(text);

      // 移除加载指示
      this.displayLines.pop();

      const choice = response.choices[0];
      const assistantMsg = choice?.message;
      if (!assistantMsg) {
        this.appendLine('[错误] 模型返回空响应', 'gray');
      } else {
        // 显示 reasoning_content（灰色）
        if (assistantMsg.reasoning_content) {
          this.appendLine(assistantMsg.reasoning_content, 'gray');
        }
        // 显示回复（白色）
        this.appendLine(assistantMsg.content, 'white');

        // 可选：显示 token 摘要
        if (response.usage) {
          const u = response.usage;
          const hitRate =
            u.prompt_cache_hit_tokens !== undefined && u.prompt_cache_miss_tokens !== undefined
              ? (
                  (u.prompt_cache_hit_tokens /
                    (u.prompt_cache_hit_tokens + u.prompt_cache_miss_tokens)) *
                  100
                ).toFixed(1)
              : null;
          let summary = `Tokens: ${u.total_tokens} (in: ${u.prompt_tokens}, out: ${u.completion_tokens})`;
          if (hitRate) {
            summary += ` | cache: ${hitRate}%`;
          }
          this.appendLine(summary, 'gray');
        }
      }
    } catch (err: any) {
      // 移除加载指示
      this.displayLines.pop();
      const msg = err?.message ?? String(err);
      this.appendLine(`[错误] ${msg}`, 'gray');
    }

    this.fullDraw();
  }

  private async handleCommand(cmd: string): Promise<void> {
    // 带参数的命令
    if (cmd.startsWith('/title ')) {
      const title = cmd.slice(7).trim();
      if (title) {
        await this.sessionManager?.setTitle(title);
        this.appendLine(`标题已更新: ${title}`, 'gray');
      }
      this.fullDraw();
      return;
    }

    switch (cmd) {
      case '/exit':
      case '/quit':
        this.running = false;
        break;
      case '/clear':
        this.displayLines = [];
        this.fullDraw();
        break;
      default:
        this.appendLine(`未知命令: ${cmd}  (可用: /exit, /clear, /title <name>)`, 'gray');
        this.fullDraw();
    }
  }

  // ─── 历史导航 ──────────────────────────────────

  private historyUp(): void {
    if (this.inputHistory.length === 0) return;
    if (this.historyIndex === -1) {
      this.historyIndex = this.inputHistory.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    }
    this.inputText = this.inputHistory[this.historyIndex];
    this.cursorPos = this.inputText.length;
    this.drawInput();
  }

  private historyDown(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.inputHistory.length - 1) {
      this.historyIndex++;
      this.inputText = this.inputHistory[this.historyIndex];
    } else {
      this.historyIndex = -1;
      this.inputText = '';
    }
    this.cursorPos = this.inputText.length;
    this.drawInput();
  }

  // ─── 渲染 ──────────────────────────────────────

  /** 追加渲染行 */
  private appendLine(text: string, color: LineColor): void {
    const lines = this.wrapText(text, this.termWidth);
    for (const line of lines) {
      this.displayLines.push({ text: line, color });
    }
  }

  /** 文本换行（按显示宽度，支持 CJK 混合文本） */
  private wrapText(text: string, width: number): string[] {
    if (width <= 0) return [text];
    const result: string[] = [];
    for (const paragraph of text.split('\n')) {
      if (paragraph.length === 0) {
        result.push('');
        continue;
      }
      let line = '';
      let lineWidth = 0;
      for (const char of paragraph) {
        const cw = this.charDisplayWidth(char);
        if (lineWidth + cw > width) {
          result.push(line);
          line = char;
          lineWidth = cw;
        } else {
          line += char;
          lineWidth += cw;
        }
      }
      if (line.length > 0 || result.length === 0) {
        result.push(line);
      }
    }
    return result;
  }

  // ─── 绘制 ──────────────────────────────────────

  /** 增量重绘输入区（仅当高度不变时使用） */
  private drawInput(): void {
    const inputHeight = this.calcInputHeight();
    this.lastInputHeight = inputHeight;
    const inputStartRow = this.termHeight - inputHeight;

    // 隐藏光标
    process.stdout.write(HIDE_CURSOR);

    // 绘制分隔线
    process.stdout.write(cursorTo(inputStartRow - 1, 0));
    process.stdout.write(ERASE_LINE);
    process.stdout.write(chalk.dim('─'.repeat(this.termWidth)));

    // 绘制输入面板
    const inputLines = this.renderInputLines(inputHeight);
    for (let i = 0; i < inputHeight; i++) {
      process.stdout.write(cursorTo(inputStartRow + i, 0));
      process.stdout.write(ERASE_LINE);
      if (i < inputLines.length) {
        process.stdout.write(inputLines[i]);
      } else {
        // 填充灰色背景的空行
        process.stdout.write(this.bgGray(' '.repeat(this.termWidth)));
      }
    }

    // 计算光标在输入面板中的位置
    const { cursorRow, cursorCol } = this.calcCursorInInput(inputHeight);
    process.stdout.write(cursorTo(inputStartRow + cursorRow, cursorCol));
    process.stdout.write(SHOW_CURSOR);
  }

  /** 全屏绘制 */
  private fullDraw(): void {
    process.stdout.write(HIDE_CURSOR);
    // 清屏并回到原点，确保无残留内容
    process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);

    this.lastInputHeight = this.calcInputHeight();

    const screen = this.buildScreen();
    // 写入屏幕，每行之间用 \r\n 但最后一行后不换行
    for (let i = 0; i < screen.length; i++) {
      process.stdout.write(screen[i]);
      if (i < screen.length - 1) {
        process.stdout.write('\r\n');
      }
    }

    // 清除屏幕下方残留
    if (screen.length < this.termHeight) {
      process.stdout.write(ERASE_SCREEN_BELOW);
    }

    // 定位光标到输入区
    const inputHeight = this.calcInputHeight();
    const inputStartRow = this.termHeight - inputHeight;
    const { cursorRow, cursorCol } = this.calcCursorInInput(inputHeight);
    process.stdout.write(cursorTo(inputStartRow + cursorRow, cursorCol));
    process.stdout.write(SHOW_CURSOR);
  }

  /** 构建全屏内容 */
  private buildScreen(): string[] {
    const screen: string[] = [];

    // 标题行
    const provider = this.config.get<string>('defaults.provider') ?? 'deepseek';
    const model = this.config.get<string>('defaults.model') ?? 'deepseek-v4-pro';
    screen.push(chalk.bold.cyan(`DeepSeek Arch v${VERSION}`));
    screen.push(
      chalk.dim(`Provider: ${provider}  |  Model: ${model}`) +
        chalk.dim(`  (Ctrl+C 退出 | /exit 退出 | /clear 清屏)`),
    );
    screen.push(chalk.dim('─'.repeat(this.termWidth)));

    // 对话区
    const inputHeight = this.calcInputHeight();
    const headerLines = screen.length;
    const contentArea = this.termHeight - headerLines - inputHeight - 1; // -1 for separator above input

    const visibleLines = this.getVisibleContentLines(contentArea);
    for (const line of visibleLines) {
      screen.push(line);
    }

    // 填充空白到分隔线位置
    while (screen.length < headerLines + contentArea) {
      screen.push('');
    }

    // 分隔线
    screen.push(chalk.dim('─'.repeat(this.termWidth)));

    // 输入面板
    const inputLines = this.renderInputLines(inputHeight);
    for (let i = 0; i < inputHeight; i++) {
      if (i < inputLines.length) {
        screen.push(inputLines[i]);
      } else {
        screen.push(this.bgGray(' '.repeat(this.termWidth)));
      }
    }

    return screen;
  }

  /** 获取可见的对话内容行（带颜色） */
  private getVisibleContentLines(maxLines: number): string[] {
    // 从 displayLines 末尾取 maxLines 行
    const start = Math.max(0, this.displayLines.length - maxLines);
    const lines = this.displayLines.slice(start);

    return lines.map((l) => {
      const colored = this.colorize(l.text, l.color);
      // 确保每行填满宽度（按显示宽度，避免 CJK 残留）
      const displayWidth = this.strDisplayWidth(l.text);
      const padding = Math.max(0, this.termWidth - displayWidth);
      return colored + ' '.repeat(padding);
    });
  }

  /** 渲染输入面板行 */
  private renderInputLines(inputHeight: number): string[] {
    const prompt = '> ';
    const availableWidth = this.termWidth - prompt.length;
    const wrappedInput = this.wrapTextForInput(this.inputText, availableWidth);

    const lines: string[] = [];
    for (let i = 0; i < inputHeight; i++) {
      if (i < wrappedInput.length) {
        const line = prompt + wrappedInput[i];
        const lineDisplayWidth = prompt.length + this.strDisplayWidth(wrappedInput[i]);
        const padded = line + ' '.repeat(Math.max(0, this.termWidth - lineDisplayWidth));
        lines.push(this.bgGray(padded));
      }
    }
    return lines;
  }

  /** 为输入面板换行（按显示宽度，CJK 字符占 2 列） */
  private wrapTextForInput(text: string, width: number): string[] {
    if (width <= 0 || text.length === 0) return [''];
    const result: string[] = [];
    let line = '';
    let lineWidth = 0;

    for (const char of text) {
      if (char === '\n') {
        result.push(line);
        line = '';
        lineWidth = 0;
        continue;
      }
      const charWidth = this.charDisplayWidth(char);
      if (lineWidth + charWidth > width) {
        result.push(line);
        line = char;
        lineWidth = charWidth;
      } else {
        line += char;
        lineWidth += charWidth;
      }
    }
    if (line.length > 0 || result.length === 0) {
      result.push(line);
    }
    return result;
  }

  /** 字符显示宽度（CJK / 全角 = 2，ASCII = 1） */
  private charDisplayWidth(char: string): number {
    const code = char.codePointAt(0) ?? 0;
    // CJK Unified Ideographs, Compatibility, Extension A
    if ((code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x2e80 && code <= 0x2eff) ||  // CJK Radicals
        (code >= 0x3000 && code <= 0x303f) ||  // CJK Symbols
        (code >= 0xff00 && code <= 0xffef) ||  // Halfwidth/Fullwidth
        (code >= 0x20000 && code <= 0x2ffff)) { // Extension B+
      return 2;
    }
    return 1;
  }

  /** 字符串显示宽度 */
  private strDisplayWidth(s: string): number {
    let w = 0;
    for (const char of s) {
      w += this.charDisplayWidth(char);
    }
    return w;
  }

  /** 计算输入面板高度（基于显示宽度） */
  private calcInputHeight(): number {
    const promptLen = 2; // "> "
    const availableWidth = Math.max(1, this.termWidth - promptLen);
    if (this.inputText.length === 0) return 1;
    let lineCount = 1;
    let lineWidth = 0;
    for (const char of this.inputText) {
      if (char === '\n') {
        lineCount++;
        lineWidth = 0;
        continue;
      }
      const cw = this.charDisplayWidth(char);
      if (lineWidth + cw > availableWidth) {
        lineCount++;
        lineWidth = cw;
      } else {
        lineWidth += cw;
      }
    }
    return Math.min(MAX_INPUT_HEIGHT, lineCount);
  }

  /** 计算光标在输入面板中的行列（基于显示宽度） */
  private calcCursorInInput(inputHeight: number): { cursorRow: number; cursorCol: number } {
    const promptLen = 2;
    const availableWidth = Math.max(1, this.termWidth - promptLen);
    let row = 0;
    let col = promptLen;
    let lineWidth = 0;
    for (let i = 0; i < this.cursorPos; i++) {
      const ch = this.inputText[i];
      if (ch === '\n') {
        row++;
        lineWidth = 0;
        continue;
      }
      const cw = this.charDisplayWidth(ch);
      if (lineWidth + cw > availableWidth) {
        row++;
        lineWidth = cw;
      } else {
        lineWidth += cw;
      }
    }
    col = promptLen + lineWidth;
    return { cursorRow: Math.min(row, inputHeight - 1), cursorCol: col };
  }

  /** 颜色渲染 */
  private colorize(text: string, color: LineColor): string {
    switch (color) {
      case 'green':
        return chalk.green(text);
      case 'gray':
        return chalk.gray(text);
      case 'white':
      default:
        return chalk.white(text);
    }
  }

  /** 灰底 */
  private bgGray(text: string): string {
    return `${CSI}48;5;236m${text}${CSI}49m`;
  }
}