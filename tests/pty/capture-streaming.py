#!/usr/bin/env python3
"""
PTY 流式帧捕获脚本 — v2

捕获 TUI 在流式输出过程中各阶段的终端输出帧，
检查渲染内容验证 inline 流式修复。

用法:
    python3 tests/pty/capture-streaming.py

输出:
    tests/pty/frames/
        frame-00-initial.{raw,txt}
        frame-01-after-enter.{raw,txt}
        frame-02-streaming.{raw,txt}
        frame-03-streaming-done.{raw,txt}
        verdict.json

返回值:
    0 = 所有检查通过
    1 = 至少一项检查失败
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

# ─── 配置 ─────────────────────────────────────────────

FRAMES_DIR = os.path.join(os.path.dirname(__file__), 'frames')
CMD = ['node', 'dist/index.js', 'chat', '--mock']

# 消息内容（含 #stream 触发逐字符流式输出）
MESSAGE = 'hello #stream'

# ─── ANSI 工具 ────────────────────────────────────────

ANSI_PATTERN = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]')
CR_PATTERN = re.compile(r'\r\n?')

def strip_ansi(text: str) -> str:
    text = ANSI_PATTERN.sub('', text)
    text = CR_PATTERN.sub('\n', text)
    return text

# ─── PTY 读写 ────────────────────────────────────────

def read_all(fd, timeout=0.3):
    """在 timeout 内尽可能读取 PTY 数据"""
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
            # 已有数据，继续等待更多
    return b''.join(chunks)


def save_frame(buffer: bytes, name: str) -> str:
    """保存帧文件（raw + stripped）"""
    raw_path = os.path.join(FRAMES_DIR, f'{name}.raw.txt')
    txt_path = os.path.join(FRAMES_DIR, f'{name}.txt')

    text = buffer.decode('utf-8', errors='replace')
    with open(raw_path, 'w') as f:
        f.write(text)

    clean = strip_ansi(text)
    with open(txt_path, 'w') as f:
        f.write(clean)

    return clean


def wait_child(pid, timeout=3):
    """等待子进程结束"""
    end = time.time() + timeout
    while time.time() < end:
        wpid, status = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            return status
        time.sleep(0.1)
    return None


def last_full_draw_region(text: str) -> str:
    """
    从 stripped 文本中提取最后一次完整 fullDraw 的内容区域。
    fullDraw 以 'DeepSeek Arch' 开头（紧接在 CLEAR_SCREEN 后），
    我们找最后一个 'DeepSeek Arch' 出现位置到结尾的内容。
    """
    idx = text.rfind('DeepSeek Arch')
    if idx == -1:
        return text
    return text[idx:]


# ─── 主流程 ────────────────────────────────────────────

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
    results = {}

    try:
        # ═══ 阶段 0: 等待 TUI 启动 ═══
        time.sleep(0.6)
        buf = read_all(master_fd, timeout=0.5)
        clean = save_frame(buf, 'frame-00-initial')

        checks = {
            'startup_header': 'DeepSeek Arch' in clean,
            'mock_mode': '[MOCK]' in clean,
            'input_prompt': '>' in clean,
        }
        results['frame-00-initial'] = checks
        print(f'[阶段0] 初始: header={checks["startup_header"]}, '
              f'mock={checks["mock_mode"]}, prompt={checks["input_prompt"]}')

        # ═══ 阶段 1: 输入消息并按 Enter ═══
        for ch in MESSAGE:
            os.write(master_fd, ch.encode())
            time.sleep(0.02)

        # 清空输入的回显
        time.sleep(0.1)
        _ = read_all(master_fd, timeout=0.2)

        # 按 Enter
        os.write(master_fd, b'\r')

        # 等待一小段：确保 fullDraw 完成（用户消息 + spinner 可见）
        time.sleep(0.3)
        buf = read_all(master_fd, timeout=0.4)
        clean = save_frame(buf, 'frame-01-after-enter')

        # 检查用户消息是否出现在输出中
        # 注意：stripped 文本中有所有历史渲染，但至少能看到消息
        checks = {
            'user_msg_displayed': MESSAGE in clean,
        }
        results['frame-01-after-enter'] = checks
        print(f'[阶段1] Enter后: user_msg={checks["user_msg_displayed"]}')

        # ═══ 阶段 2: 等待流式过程（reasoning → content → done） ═══
        # MockProvider: reasoning 约 20 chars × 50ms ≈ 1s
        # content with #stream: ~11 chars × 50ms ≈ 0.55s
        # 总共约 1.6s，等待 2s 确保完成
        time.sleep(2.0)
        buf = read_all(master_fd, timeout=0.5)
        clean = save_frame(buf, 'frame-02-streaming')

        # 提取最后一次 fullDraw 的区域（最终完整渲染）
        final_view = last_full_draw_region(clean)

        checks = {
            'user_msg_preserved': MESSAGE in clean,
            'reasoning_appeared': '[模拟思考]' in clean,
            'reply_appeared': '你好，我是测试提供商。' in clean,
            'inline_order': (
                'hello #stream' in final_view and
                '[模拟思考]' in final_view and
                '你好，我是测试提供商。' in final_view
            ),
        }
        results['frame-02-streaming'] = checks
        print(f'[阶段2] 流式完成: user={checks["user_msg_preserved"]}, '
              f'think={checks["reasoning_appeared"]}, '
              f'reply={checks["reply_appeared"]}, '
              f'inline={checks["inline_order"]}')

        # ═══ 阶段 3: 额外等待确认无更多输出 ═══
        time.sleep(0.5)
        buf = read_all(master_fd, timeout=0.3)
        clean = save_frame(buf, 'frame-03-streaming-done')
        checks = {
            'no_extra_output': len(clean.strip()) == 0,
        }
        results['frame-03-streaming-done'] = checks
        print(f'[阶段3] 结束: no_extra={checks["no_extra_output"]}')

    except Exception as e:
        print(f'错误: {e}', file=sys.stderr)
        raise
    finally:
        # 清理子进程
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.2)
            wait_child(pid, 2)
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

    # ─── 判定 ──────────────────────────────────────
    all_checks = []
    for frame_name, checks in results.items():
        for check_name, passed in checks.items():
            all_checks.append(passed)

    passed = all(all_checks)
    verdict = {
        'passed': passed,
        'total_checks': len(all_checks),
        'passed_checks': sum(all_checks),
        'frames': list(results.keys()),
        'details': results,
    }

    with open(os.path.join(FRAMES_DIR, 'verdict.json'), 'w') as f:
        json.dump(verdict, f, indent=2, ensure_ascii=False)

    print(f'\n{"="*50}')
    print(f'测试结果: {"✓ 通过" if passed else "✗ 失败"}')
    print(f'检查项: {verdict["passed_checks"]}/{verdict["total_checks"]}')
    print(f'帧文件保存到: {FRAMES_DIR}/')

    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
