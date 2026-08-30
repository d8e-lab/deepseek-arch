#!/usr/bin/env python3
"""
PTY Subagents 总览视图捕获脚本

流程：
  1. 启动 TUI（mock + yolo）
  2. 发送 #spawn 触发 subagent spawn
  3. 按 Ctrl+T 打开 subagents 总览视图
  4. 验证状态条 + 选中 subagent 输出
  5. 视图内输入消息并 Enter 发送给 subagent
  6. 按 q 返回 master

输出:
    tests/pty/frames-subagents/
        frame-00-after-spawn.{raw,txt}
        frame-01-view.{raw,txt}
        frame-02-after-send.{raw,txt}
        frame-03-back.{raw,txt}
        verdict.json
"""

import pty
import os
import sys
import time
import select
import re
import json
import struct
import fcntl
import termios

FRAMES_DIR = os.path.join(os.path.dirname(__file__), 'frames-subagents')
CMD = ['node', 'dist/cli/index.js', 'chat', '--mock', '--yolo']
SPAWN_MSG = '调研 #spawn:research #task:调研架构'
# 含 'n' 的英文消息：验证 insert 模式下 n 不被当作导航键捕捉（旧逻辑会输入 'thak you'）
VIEW_MSG = 'thank you'

ANSI_PATTERN = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]')
CR_PATTERN = re.compile(r'\r\n?')

def strip_ansi(text):
    text = ANSI_PATTERN.sub('', text)
    text = CR_PATTERN.sub('\n', text)
    return text

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

def save_frame(buffer, name):
    raw_path = os.path.join(FRAMES_DIR, f'{name}.raw.txt')
    txt_path = os.path.join(FRAMES_DIR, f'{name}.txt')
    text = buffer.decode('utf-8', errors='replace')
    with open(raw_path, 'w') as f:
        f.write(text)
    clean = strip_ansi(text)
    with open(txt_path, 'w') as f:
        f.write(clean)
    return clean

def main():
    os.makedirs(FRAMES_DIR, exist_ok=True)
    master_fd, slave_fd = pty.openpty()
    s = struct.pack('HHHH', 40, 100, 0, 0)
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
            os.execvp(CMD[0], CMD)
        except Exception as e:
            print(f'子进程启动失败: {e}', file=sys.stderr)
            os._exit(1)

    os.close(slave_fd)
    results = {}

    try:
        # ═══ 阶段 0: 等待启动 + spawn subagent ═══
        time.sleep(1.5)
        read_all(master_fd, timeout=0.4)

        for ch in SPAWN_MSG:
            os.write(master_fd, ch.encode())
            time.sleep(0.01)
        time.sleep(0.1)
        read_all(master_fd, timeout=0.2)
        os.write(master_fd, b'\r')

        # 等待 spawn 完成（mock 子代理立即完成）
        time.sleep(2.5)
        buf = read_all(master_fd, timeout=0.8)
        clean = save_frame(buf, 'frame-00-after-spawn')
        results['frame-00-after-spawn'] = {
            'user_msg_sent': SPAWN_MSG in clean,
        }

        # ═══ 阶段 1: Ctrl+T 打开 subagents 视图 ═══
        os.write(master_fd, b'\x14')
        time.sleep(0.8)
        buf = read_all(master_fd, timeout=0.5)
        clean = save_frame(buf, 'frame-01-view')
        results['frame-01-view'] = {
            'view_header': 'Subagents' in clean,
            'subagent_listed': 'research' in clean,
            'status_icon': '●' in clean or '✓' in clean,
            'nav_hint': '[n] next' in clean,
            'insert_hint': '按 [i] 进入输入模式' in clean,  # vim 式：命令模式提示按 i
        }

        # ═══ 阶段 2: vim 式——按 i 进入 insert，输入消息并发送 ═══
        os.write(master_fd, b'i')   # i → insert 模式（否则 n/p 被当作导航键）
        time.sleep(0.5)
        buf = read_all(master_fd, timeout=0.4)
        clean = save_frame(buf, 'frame-01b-insert')
        results['frame-01b-insert'] = {
            'insert_mode_prompt': '[Enter] 发送  [ESC] 退出' in clean,
        }
        for ch in VIEW_MSG:
            os.write(master_fd, ch.encode())
            time.sleep(0.02)
        time.sleep(0.3)
        read_all(master_fd, timeout=0.3)
        os.write(master_fd, b'\r')
        # 等待 send 完成（mock 续跑立即返回）
        time.sleep(1.2)
        buf = read_all(master_fd, timeout=0.5)
        clean = save_frame(buf, 'frame-02-after-send')
        results['frame-02-after-send'] = {
            'view_still_open': 'Subagents' in clean,
            'followup_result_shown': VIEW_MSG in clean,
        }

        # ═══ 阶段 3: q 返回 master ═══
        os.write(master_fd, b'q')
        time.sleep(0.8)
        buf = read_all(master_fd, timeout=0.5)
        clean = save_frame(buf, 'frame-03-back')
        results['frame-03-back'] = {
            'view_closed': '═══ Subagents' not in clean,
            'input_restored': '─' in clean,
        }

        passed = all(all(v for v in checks.values()) for checks in results.values())
        verdict = {
            'passed_checks': sum(sum(1 for v in c.values() if v) for c in results.values()),
            'total_checks': sum(len(c) for c in results.values()),
            'details': results,
        }
        with open(os.path.join(FRAMES_DIR, 'verdict.json'), 'w') as f:
            json.dump(verdict, f, ensure_ascii=False, indent=2)
        print(f'[subagents-view] passed={verdict["passed_checks"]}/{verdict["total_checks"]}')
        return 0 if passed else 1
    finally:
        try:
            os.kill(pid, 15)
        except Exception:
            pass
        try:
            os.waitpid(pid, 0)
        except Exception:
            pass

if __name__ == '__main__':
    sys.exit(main())
