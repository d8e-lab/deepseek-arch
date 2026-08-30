#!/usr/bin/env python3
"""
PTY 全双工视图跟随测试 — 视图关闭后排队消息由主循环发送（无双流并发）

H1 回归测试：closeViewer 曾 fire-and-forget 启动 sendMessageStream 后立即
恢复 inputCycle，导致键盘 handler 被覆盖、两个模型请求并发写屏幕。

场景：流式输出中 → 输入普通文字排队 → 打开视图 → 流结束（视图打开期间）
→ 关闭视图 → 主循环恢复并发送排队消息 → 只有一轮回复，无交错/重复。

用法:
    python3 tests/pty/capture-viewer-followup.py

输出: tests/pty/frames-viewer-followup/verdict.json
"""

import pty
import os
import sys
import time
import select
import re
import json
import signal
import struct
import fcntl
import termios

FRAMES_DIR = os.path.join(os.path.dirname(__file__), 'frames-viewer-followup')
CMD = ['node', 'dist/cli/index.js', 'chat', '--mock']


def read_all(fd, timeout=0.3):
    chunks = []
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                data = os.read(fd, 65536)
                if data:
                    chunks.append(data)
                else:
                    break
            except (BlockingIOError, OSError):
                break
        else:
            if not chunks:
                break
    return b''.join(chunks)


def main():
    os.makedirs(FRAMES_DIR, exist_ok=True)

    master_fd, slave_fd = pty.openpty()
    s = struct.pack('HHHH', 24, 80, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, s)

    pid = os.fork()
    if pid == 0:
        try:
            os.close(master_fd)
            os.setsid()
            for fd in [0, 1, 2]:
                os.dup2(slave_fd, fd)
            if slave_fd > 2:
                os.close(slave_fd)
            os.environ['TERM'] = 'xterm-256color'
            os.environ['COLUMNS'] = '80'
            os.environ['LINES'] = '24'
            os.execvp(CMD[0], CMD)
        except Exception as e:
            print(f'子进程启动失败: {e}', file=sys.stderr)
            os._exit(1)

    os.close(slave_fd)
    all_buf = bytearray()

    def drain(timeout=0.3):
        buf = read_all(master_fd, timeout)
        all_buf.extend(buf)
        return buf

    try:
        # 启动
        time.sleep(0.6)
        drain(0.5)

        # 发送第一条消息（触发流式输出 #stream → 逐字符）
        for ch in 'hello #stream':
            os.write(master_fd, ch.encode())
            time.sleep(0.01)
        os.write(master_fd, b'\r')
        time.sleep(0.4)  # 流式进行中（reasoning 阶段）
        drain(0.2)       # 清空输入回显，只保留流式增量观察

        # 流式期间：输入普通文字排队（不中断输出）
        for ch in 'followup':
            os.write(master_fd, ch.encode())
            time.sleep(0.01)
        os.write(master_fd, b'\r')
        time.sleep(0.3)
        drain(0.2)

        # 流式期间：打开全屏浏览视图（Ctrl+O）
        os.write(master_fd, b'\x0f')
        time.sleep(0.5)
        buf_view = drain(0.5)

        # 等待流结束（视图打开期间，finally 跳过排空，nextMessage 保留）
        time.sleep(2.5)
        drain(0.5)

        # 关闭视图（q）
        os.write(master_fd, b'q')
        time.sleep(0.6)

        # 主循环恢复：发送排队消息 followup → 第二轮回复
        # 在 followup 流进行中再输入 second：新代码 followup 完成后才进入下一轮输入；
        # 旧代码（fire-and-forget）会双流并发 → 输出交错
        for ch in 'second':
            os.write(master_fd, ch.encode())
            time.sleep(0.01)
        os.write(master_fd, b'\r')
        time.sleep(2.5)
        drain(0.5)
        time.sleep(0.5)
        drain(0.3)

        text = all_buf.decode('utf-8', errors='replace')
        clean = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', text)
        clean = re.sub(r'\r\n?', '\n', clean)

        with open(os.path.join(FRAMES_DIR, 'output.txt'), 'w') as f:
            f.write(clean)
        with open(os.path.join(FRAMES_DIR, 'output.raw.txt'), 'w') as f:
            f.write(text)

        # ─── 检查 ──────────────────────────────
        checks = {}

        # 1. 第一条消息已发送
        checks['first_user_msg'] = 'hello #stream' in clean

        # 2. 排队消息在视图关闭后由主循环发送（[You] followup 出现）
        checks['followup_sent'] = '[You] followup' in clean or 'followup' in clean

        # 3. 无双流并发：followup 的 [You] 行只出现一次（mock 回复正文含 followup 文本属正常）
        checks['followup_once'] = clean.count('[You] followup') == 1

        # 4. 第二轮回复出现（mock: 你好，我是测试提供商。）
        checks['second_reply'] = clean.count('你好，我是测试提供商。') >= 1

        # 5. 无交错迹象：所有 [You] 行按顺序出现
        you_lines = [m.start() for m in re.finditer(r'\[You\]', clean)]
        checks['user_msg_order'] = len(you_lines) >= 3

        # 6. 视图已关闭（回到主界面，header 存在）
        checks['viewer_closed'] = 'deepseek-arch v' in clean

        # 7. 无双流：followup 的回复/token 在 second 的 [You] 之前（无交错）
        idx_followup = clean.find('[You] followup')
        idx_second = clean.find('[You] second')
        idx_ftoken = clean.find('--- token', idx_followup) if idx_followup != -1 else -1
        checks['followup_completed_first'] = (
            idx_followup != -1 and idx_second != -1 and
            idx_ftoken != -1 and idx_ftoken < idx_second
        )
        # 8. second 也有回复（正常完成）
        idx_stoken = clean.find('--- token', idx_second) if idx_second != -1 else -1
        checks['second_completed'] = idx_stoken != -1

        print(f'[检查] first_user_msg={checks["first_user_msg"]}, '
              f'followup_sent={checks["followup_sent"]}, '
              f'followup_once={checks["followup_once"]}, '
              f'second_reply={checks["second_reply"]}, '
              f'user_msg_order={checks["user_msg_order"]}, '
              f'viewer_closed={checks["viewer_closed"]}, '
              f'followup_completed_first={checks["followup_completed_first"]}, '
              f'second_completed={checks["second_completed"]}')

        # 输出关键片段帮助调试
        print('--- 关键输出片段 ---')
        for line in clean.split('\n'):
            if '[You]' in line or '你好' in line or '[Think]' in line or 'token' in line:
                print(f'  {line.strip()[:80]}')

    finally:
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.2)
            for _ in range(20):
                wpid, status = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    break
                time.sleep(0.1)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        except (ProcessLookupError, PermissionError):
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    passed = all(checks.values())
    verdict = {
        'passed': passed,
        'total_checks': len(checks),
        'passed_checks': sum(checks.values()),
        'details': checks,
    }
    with open(os.path.join(FRAMES_DIR, 'verdict.json'), 'w') as f:
        json.dump(verdict, f, indent=2, ensure_ascii=False)

    print(f'\n{"="*50}')
    print(f'测试结果: {"✓ 通过" if passed else "✗ 失败"}')
    print(f'检查项: {verdict["passed_checks"]}/{verdict["total_checks"]}')
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
