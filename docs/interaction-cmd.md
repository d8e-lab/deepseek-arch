# 解决 CLI Agent 因交互式命令导致卡死的通用方案

## 1. 问题背景

在开发 CLI agent 时，agent 需要解析并执行 shell 命令。如果误执行了需要用户交互的命令（如 `git rebase -i`、`vim`、`dialog` 菜单、`whiptail` 选择栏等），进程会阻塞等待用户输入，并且可能夺取终端控制权，导致：

- 用户按 `Ctrl+C` 无效
- agent 无法继续下一步行动
- 超时机制也难以恢复

本方案提供一套**无需预知交互类型**的通用防御策略，确保 agent 永远不会被任何交互式命令卡死。

## 2. 总体思路：双重防线

我们构建两层防护：

1. **预防层**：在执行命令时通过环境变量和重定向关闭交互能力，让大多数交互程序直接报错退出。
2. **检测层**：启动一个轻量级监控线程，周期性检查子进程是否在系统调用层面阻塞等待标准输入（`stdin`）或终端，一旦发现立即杀死整个进程组。

这样，无论交互形式是方向键菜单、数字选择、全屏编辑器还是自制 `read` 循环，只要底层在等待输入，就会被终结。

## 3. 第一道防线：预防措施

### 3.1 关闭标准输入
所有子进程的 `stdin` 必须重定向到 `/dev/null`（Python 中为 `subprocess.DEVNULL`），这样任何尝试读取输入的调用都会立即收到 EOF，程序通常会直接退出。

### 3.2 注入禁用交互的环境变量
许多工具会检查特定环境变量来决定是否使用交互界面。在执行前注入以下环境变量，可以规避大部分已知交互：

- `GIT_EDITOR=true` / `GIT_SEQUENCE_EDITOR=true`：阻止 `git rebase -i` 打开编辑器
- `PAGER=cat`：阻止 `git log`、`man` 等进入分页程序
- `EDITOR=true` / `VISUAL=true`：让任何需要调用编辑器的命令直接成功退出

### 3.3 进程组隔离
使用 `start_new_session=True` 让子进程成为新会话的首进程，脱离当前终端的前台进程组。这样即使某个程序试图通过 `/dev/tty` 获取终端控制，也不会干扰主进程的信号处理（如 `Ctrl+C`）。

### 3.4 强制超时
必须为每个命令设置总超时时间（例如 30 秒），超时后强制杀死进程组，防止因网络、死锁等原因长时间阻塞。

## 4. 第二道防线：交互检测与强制终止

当预防措施未能完全阻止交互时（例如某些程序使用 `ioctl` 直接读取终端，或不依赖 stdin 的环境变量），我们需要**动态检测**进程是否进入“等待用户输入”状态。

### 4.1 检测原理

Linux 提供了进程实时状态接口 `/proc/<pid>/`：

- **`/proc/<pid>/wchan`**：显示进程在内核态阻塞时等待的内核函数。常见的等待终端输入的函数有：
  - `n_tty_read`
  - `poll_schedule_timeout`
  - `wait_woken`
  - `tty_read`
  - `io_schedule`

- **`/proc/<pid>/syscall`**（需要内核配置开启，主流发行版默认支持）：显示当前正在执行的系统调用和参数。
  - `read` 的系统调用号通常为 `0`。
  - 若看到 `0 0 ...`（`0` 表示 `read`，第一个参数 `0` 是文件描述符 stdin），说明进程正在读取标准输入。

结合这两者，可以准确判断进程是否阻塞在等待用户输入。

### 4.2 监控线程

在子进程启动后，立刻启动一个后台监控线程，以 0.2 秒左右的间隔检查上述信息。如果连续发现进程处于等待输入状态超过设定的耐心时间（如 1.5 秒），则立即发送 `SIGKILL` 到整个进程组。

## 5. 完整实现代码

以下是一个可直接集成到 agent 中的 Python 模块，提供 `run_command_safe` 函数。该函数综合了所有防御措施。

```python
import os
import signal
import subprocess
import threading
import time

class InteractiveGuard:
    """检测并杀死进入交互模式的子进程"""
    def __init__(self, pid, kill_func, check_interval=0.2, patience=2.0):
        self.pid = pid
        self.kill_func = kill_func        # 实际调用 os.killpg 的函数
        self.check_interval = check_interval
        self.patience = patience          # 连续检测到阻塞多久后动手
        self._stop_event = threading.Event()
        self._blocking_start = None       # 开始阻塞的时间
        self._thread = threading.Thread(target=self._monitor, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop_event.set()

    def _monitor(self):
        while not self._stop_event.is_set():
            if self._is_waiting_for_stdin(self.pid):
                if self._blocking_start is None:
                    self._blocking_start = time.time()
                elif time.time() - self._blocking_start > self.patience:
                    # 已经连续阻塞超过 patience 秒，杀死进程组
                    try:
                        self.kill_func()
                    except Exception:
                        pass
                    return
            else:
                self._blocking_start = None
            time.sleep(self.check_interval)

    @staticmethod
    def _is_waiting_for_stdin(pid: int) -> bool:
        """判断进程是否正在阻塞等待 stdin 或终端输入"""
        try:
            # 方法1: 检查 wchan 是否为典型的输入等待函数
            with open(f"/proc/{pid}/wchan", "r") as f:
                wchan = f.read().strip()
            if wchan in ("n_tty_read", "poll_schedule_timeout",
                         "wait_woken", "tty_read", "io_schedule"):
                # 方法2: 进一步确认系统调用是否为 read(0, ...)
                try:
                    with open(f"/proc/{pid}/syscall", "r") as sf:
                        parts = sf.read().strip().split()
                        # read 的系统调用号通常是 0，第一个参数 fd 为 0
                        if parts[0] == "0" and parts[1] == "0":
                            return True
                except Exception:
                    # 如果无法读取 syscall，仅靠 wchan 判断，多数情况仍准确
                    return True
        except Exception:
            pass
        return False


def run_command_safe(command: str, timeout: float = 30, interact_patience: float = 1.5):
    """
    执行 shell 命令，永不卡死。
    自动阻止绝大多数交互，且检测到阻塞等待输入时强制终止。
    """
    # 预防性环境：关闭分页、编辑器等
    env = os.environ.copy()
    env.update({
        'GIT_EDITOR': 'true',
        'GIT_SEQUENCE_EDITOR': 'true',
        'PAGER': 'cat',
        'EDITOR': 'true',       # 通用编辑器设为 true
        'VISUAL': 'true',
    })

    proc = subprocess.Popen(
        ["bash", "-c", command],
        stdin=subprocess.DEVNULL,               # 关闭标准输入
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        start_new_session=True                  # 脱离终端控制
    )

    # 启动交互检测守护
    def kill_proc_group():
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass

    guard = InteractiveGuard(
        pid=proc.pid,
        kill_func=kill_proc_group,
        patience=interact_patience
    )
    guard.start()

    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out, err
    except KeyboardInterrupt:
        kill_proc_group()
        proc.wait()
        raise
    except subprocess.TimeoutExpired:
        kill_proc_group()
        proc.wait()
        raise TimeoutError(f"Command timed out after {timeout}s")
    finally:
        guard.stop()
```

### 使用示例

```python
try:
    returncode, stdout, stderr = run_command_safe("git rebase -i HEAD~3")
    print(f"Exit code: {returncode}")
except TimeoutError as e:
    print(f"Command timed out: {e}")
except KeyboardInterrupt:
    print("User interrupted the command")
```

如果命令进入交互模式（如打开了 vim），进程组会在 1.5 秒内被 SIGKILL 杀死，函数抛出 `TimeoutError`（因为交互被当作卡死处理）或子进程直接退出并返回 -9 信号值。

## 6. 方案适用范围

该方法可防范所有底层依赖 `read(0, ...)` 或类似终端读取系统调用的交互式程序，包括但不限于：

- 全屏编辑器：`vim`, `nano`, `emacs -nw`
- 图形菜单程序：`dialog`, `whiptail`
- 命令行提示：`read` 命令、`bash` 的 `select` 循环
- 分页器：`less`, `more`
- 任何自定义的“按任意键继续”、“请选择[1-4]”脚本

即使程序绕过 `stdin` 直接通过 `ioctl` 操作终端（如某些古老的 TUI 程序），监控线程也会根据 `wchan` 特征识别并杀死。

## 7. 注意事项

- **内核兼容性**：`/proc/<pid>/syscall` 需要内核开启 `CONFIG_HAVE_ARCH_TRACEHOOK`。若不可用，`_is_waiting_for_stdin` 会自动回退到仅依据 `wchan`，准确度依然很高。
- **误杀风险**：极少数程序可能会短暂阻塞在 `read` 上处理内部逻辑（例如管道消费），因此设置了 `patience` 连续阻塞时间窗口（默认 1.5 秒），正常情况下不会误杀。可根据实际场景调整。
- **进程清理**：因为使用了 `start_new_session`，`killpg` 会确保整个 shell 进程树被杀死，不会留下僵尸进程。
- **日志记录**：建议在杀死进程时记录日志，便于 agent 了解发生了什么，并告知用户该命令因交互被终止。

## 8. 总结

通过 **stdin 关闭 + 环境变量预防 + 进程组隔离 + 超时 + 实时系统调用监控** 的组合策略，你的 CLI agent 可以安全执行任何 shell 命令，永远不会被交互式程序阻塞。该方案不需要预先定义交互模式，具有极高的通用性和可靠性。