# 流式渲染修复 — 第二阶段调查结论

> 2026-05-18 · 基于 debug.log 的实测分析

## 调查历程

1. **streaming-fix.md 初始诊断**：认为是 async generator 的 yield + for await 在微任务风暴中不让出事件循环，导致 spinner 和增量渲染失败。

2. **方案一实施**（`yieldEventLoop()` + `Throttle`）：
   - `src/utils/event-loop.ts` — `yieldEventLoop()` 通过 setImmediate 让出
   - `src/utils/throttle.ts` — `Throttle` 帧率节流（60fps）
   - `src/core/session.ts` — `sendMessageStream()` 每个 chunk 后 `await yieldEventLoop()`
   - `src/cli/chat-ui.ts` — `handleStreamEvent` 中 `drawStreamUpdate()` 改为节流调用

3. **debug.log 实测结论**：事件循环**没有被阻塞**。spinner timer 每 80ms 稳定触发，`handleStreamEvent` 每个有数据的 chunk 都被调用。问题不在事件循环层。

## 实测日志关键证据

```
+0ms     handleEnter → fullDraw() 渲染 ⠋ (spinnerFrameIdx=0)
+81ms    spinner tick #1 → drawStreamUpdate() 写 ⠙
+160ms   spinner tick #2 → drawStreamUpdate() 写 ⠹
+242ms   chatStream 收到空 chunk（delta 为空，不触发 handleStreamEvent）
+562ms   第一个 reasoning_delta → handleStreamEvent → Throttle → drawStreamUpdate()
+964ms   content_delta → stopSpinner
```

spinner 帧索引从 #1 到 #12 每 80ms 稳定递增，`drawStreamUpdate()` 每次都调用了。但用户看不到动画 — 说明 `process.stdout.write()` 的数据没有及时到达终端渲染循环。

## 确认的根因

**Node.js TTY WriteStream 内部缓冲**。`process.stdout` 是一个 `tty.WriteStream`，其内部有缓冲机制。即使每次 `drawStreamUpdate()` 发出单次 `process.stdout.write()` 调用，Node.js 的 TTY stream 层仍可能将多次 write 合并后才 flush 到 pty。加上 pty 内核缓冲，终端进程看到的是合并后的最终状态。

## 下一步行动计划

### 试验：用 `fs.writeSync` 绕过 stream 缓冲

`fs.writeSync(1, data)` 直接写入 fd 1，绕过 Node.js stream 缓冲层，数据立即进入 pty。

**试验修改**（最小化验证）：

`src/cli/chat-ui.ts` 的 `drawStreamUpdate()` 方法中：

```typescript
// 原来：
process.stdout.write(parts.join(''));

// 改为：
import { writeSync } from 'node:fs';
writeSync(1, parts.join(''));
```

同理，`fullDraw()` 中的所有 `process.stdout.write()` 也需要改。

### 如果 writeSync 验证有效

将 `ChatUI` 中所有终端输出改为统一的底层写入方法：

```typescript
// 新增私有方法
private write(data: string): void {
    writeSync(1, data);
}
```

替换所有 `process.stdout.write(...)` 调用。

### 回退调试日志

验证通过后删除所有 `process.stderr.write('[DEBUG] ...')` 日志。

## 当前代码变更清单（调试日志待清理）

| 文件 | 状态 | 说明 |
|------|------|------|
| `src/utils/event-loop.ts` | **保留** | yieldEventLoop() 工具，仍有价值（防止微任务风暴） |
| `src/utils/throttle.ts` | **保留** | Throttle 帧率节流，降低 CPU 消耗 |
| `src/utils/throttle.test.ts` | **保留** | 8 tests passed |
| `src/core/session.ts` | **保留修改** | for-await 末尾的 yieldEventLoop() |
| `src/cli/chat-ui.ts` | **待修改** | `process.stdout.write` → `writeSync`，清理 DEBUG 日志 |
| `src/core/api.ts` | **待清理** | 删除 DEBUG 日志 |

## 新 session 恢复步骤

1. 阅读本文件（`docs/streaming-investigation.md`）
2. 阅读项目文档：`agent.md`、`README.md`、`docs/streaming-fix.md`
3. 关键代码文件：`src/cli/chat-ui.ts`（drawStreamUpdate + fullDraw）、`src/core/session.ts`
4. 试验：将 `chat-ui.ts` 中所有 `process.stdout.write` 替换为 `writeSync(1, ...)`
5. 清理所有调试日志
6. 用户测试验证
