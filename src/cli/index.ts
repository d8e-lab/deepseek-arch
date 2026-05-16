/**
 * CLI 主程序 — Commander.js
 *
 * 提供：
 *   --version / -V   版本信息（含作者、日期）
 *   --help / -h      全局帮助
 *   子命令 chat / resume / help
 */

import { Command } from 'commander';

const VERSION = '0.1.0';
const AUTHOR = 'helcksun';
const RELEASE_DATE = '2026-05-16';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('deepseek-arch')
    .description('DeepSeek Terminal Agent — Linux 终端 AI 助手')
    .version(
      `deepseek-arch v${VERSION}\n作者: ${AUTHOR}\n发布日期: ${RELEASE_DATE}`,
      '-V, --version',
      '输出版本信息',
    )
    .helpOption('-h, --help', '显示帮助信息')
    .addHelpCommand('help [command]', '显示子命令帮助信息');

  // ---- chat 子命令 ----
  const chatCmd = new Command('chat')
    .description('开始新对话')
    .option('--title <name>', '设置对话标题')
    .helpOption('-h, --help', '显示 chat 命令帮助')
    .action(async (options) => {
      // Phase 3-5 实现：启动对话循环
      console.log('chat 子命令 — 待实现');
      console.log('选项:', options);
    });

  // ---- resume 子命令 ----
  const resumeCmd = new Command('resume')
    .description('恢复历史对话。不带参数时展示对话列表供选择。')
    .option('--id <id>', '按对话 ID 精确匹配')
    .option('--name <name>', '按对话标题精确匹配')
    .helpOption('-h, --help', '显示 resume 命令帮助')
    .action(async (options) => {
      // Phase 6 实现：恢复对话
      console.log('resume 子命令 — 待实现');
      console.log('选项:', options);
    });

  program.addCommand(chatCmd);
  program.addCommand(resumeCmd);

  return program;
}

export async function run(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
