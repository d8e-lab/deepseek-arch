#!/usr/bin/env python3
"""
PTY 输入稳定性测试 — 键入字符时输入区不得上移

回归测试：修复 '键入命令时所有键入行为导致输入框上移'
（根因：renderInput 上移基准用区域总高度 lastBottomRows，而光标在输入区行，
 导致每次键入 UP 过头、CLEAR_TO_END 清掉区域上方内容、画面整体上移）

验证方式：内置简易 ANSI 终端模拟器（24x80），逐字符输入普通文本与命令，
每步应用增量输出后记录『灰底输入区行号』，断言全程不变。

用法:
    python3 tests/pty/capture-input-stability.py

输出:
    tests/pty/frames-stability/verdict.json

返回值: 0 = 通过, 1 = 失败
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

FRAMES_DIR = os.path.join(os.path.dirname(__file__), 'frames-stability')
CMD = ['node', 'dist/cli/index.js', 'chat', '--mock']

GRAY_BG = '\x1b[48;5;238m'
PINK_BG = '\x1b[48;5;210m'


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


# ─── 简易 ANSI 终端模拟器（24x80）──────────────────────

class VTScreen:
    def __init__(self, rows=24, cols=80):
        self.rows = rows
        self.cols = cols
        self.screen = [[' '] * cols for _ in range(rows)]
        self.r = 0
        self.c = 0
        self.gray_rows = set()   # 当前灰底（输入区）行号集合

    def apply(self, raw: str):
        i = 0
        n = len(raw)
        while i < n:
            ch = raw[i]
            if ch == '\x1b':
                m = re.match(r'\x1b\[([0-9;?]*)([A-Za-z])', raw[i:])
                if m:
                    params, cmd = m.group(1), m.group(2)
                    i += m.end()
                    if cmd == 'A':
                        self.r = max(0, self.r - (int(params) if params else 1))
                    elif cmd == 'B':
                        self.r = min(self.rows - 1, self.r + (int(params) if params else 1))
                    elif cmd == 'C':
                        self.c = min(self.cols - 1, self.c + (int(params) if params else 1))
                    elif cmd == 'D':
                        self.c = max(0, self.c - (int(params) if params else 1))
                    elif cmd == 'H':
                        if params and ';' in params:
                            rr, cc = params.split(';')
                            self.r = min(self.rows - 1, (int(rr) if rr else 1) - 1)
                            self.c = min(self.cols - 1, (int(cc) if cc else 1) - 1)
                        else:
                            self.r = self.c = 0
                    elif cmd == 'J':
                        if params == '2' or params == '3':
                            for rr in range(self.rows):
                                for cc in range(self.cols):
                                    self.screen[rr][cc] = ' '
                            self.gray_rows = set()
                            self.r = self.c = 0
                        else:  # 0J: 光标到屏底
                            for rr in range(self.r, self.rows):
                                start = self.c if rr == self.r else 0
                                for cc in range(start, self.cols):
                                    self.screen[rr][cc] = ' '
                            # 被默认背景填充，清除光标行及以下的灰底标记
                            self.gray_rows = {rr for rr in self.gray_rows if rr < self.r}
                    elif cmd == 'K':
                        for cc in range(self.c, self.cols):
                            self.screen[self.r][cc] = ' '
                        # 行清空后不再是灰底行（灰底是行背景，清行不改变背景色；
                        # 这里保守处理：仅当整行变空且无灰底序列重画时由绘制逻辑维护）
                    elif cmd == 'm':
                        # SGR 颜色：灰底/粉底背景标记输入区行
                        if params in ('48;5;238', '48;5;210'):
                            self.gray_rows.add(self.r)
                        continue
                else:
                    i += 1
                    continue
            elif ch == '\r':
                self.c = 0
                i += 1
            elif ch == '\n':
                if self.r == self.rows - 1:
                    self.screen.pop(0)
                    self.screen.append([' '] * self.cols)
                    # 滚动后灰底行整体上移 1
                    self.gray_rows = {rr - 1 for rr in self.gray_rows if rr > 0}
                else:
                    self.r += 1
                i += 1
            elif ch == '\x07':
                i += 1
            else:
                if 0 <= self.r < self.rows and 0 <= self.c < self.cols:
                    self.screen[self.r][self.c] = ch
                self.c += 1
                if self.c >= self.cols:
                    self.c = 0
                    if self.r == self.rows - 1:
                        self.screen.pop(0)
                        self.screen.append([' '] * self.cols)
                        self.gray_rows = {rr - 1 for rr in self.gray_rows if rr > 0}
                    else:
                        self.r += 1
                i += 1


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
    vt = VTScreen()
    checks = {}

    try:
        # 初始画面
        time.sleep(1.5)
        buf = read_all(master_fd, timeout=0.5)
        vt.apply(buf.decode('utf-8', errors='replace'))
        init_rows = sorted(vt.gray_rows)
        checks['initial_input_row'] = len(init_rows) == 1
        print(f'[初始] 输入区行: {init_rows}')

        # 逐字符输入普通文本 abc
        for idx, ch in enumerate('abc', start=1):
            os.write(master_fd, ch.encode())
            time.sleep(0.12)
            buf = read_all(master_fd, timeout=0.3)
            vt.apply(buf.decode('utf-8', errors='replace'))
            rows = sorted(vt.gray_rows)
            key = f'plain-char-{idx}'
            checks[key] = rows == init_rows
            print(f'[普通] 键入 {ch!r}: 输入区行 {rows} {"✓" if rows == init_rows else "✗ 上移!"}')

        # 逐字符输入命令 /context（含建议列表）
        for idx, ch in enumerate('/context', start=1):
            os.write(master_fd, ch.encode())
            time.sleep(0.12)
            buf = read_all(master_fd, timeout=0.3)
            vt.apply(buf.decode('utf-8', errors='replace'))
            rows = sorted(vt.gray_rows)
            key = f'cmd-char-{idx}'
            checks[key] = rows == init_rows
            print(f'[命令] 键入 {ch!r}: 输入区行 {rows} {"✓" if rows == init_rows else "✗ 上移!"}')

    except Exception as e:
        print(f'错误: {e}', file=sys.stderr)
        raise
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
