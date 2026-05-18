# 流式渲染修复方案

> 创建于 2026-05-18 · 流式渲染实时性问题分析与解决方案

## 问题现象

1. 流式 SSE 数据已到达，但终端面板没有逐 chunk 实时渲染
2. Spinner 动画静止不动
3. 所有内容在流完成后一次性显示

## 根因

### 微观时序问题（非架构问题）

链路：

```
DeepSeek API → TCP → undici (16KB buffer) → reader.read() → SSE parser → yield → consumer
```

1. **undici 的 BodyReadable 缓冲区**：Node.js 内置 `fetch` 基于 undici，其 `ReadableStream` 的 `highWaterMark` 默认为 **16KB**。服务端虽然逐 token 发送 SSE 事件（每条几十到几百字节），但 undici 会在内部缓冲区攒满 16KB 后才让 `reader.read()` 返回。

2. **同一宏任务周期内的微任务风暴**：当 `reader.read()` 一次性返回包含 50-200 条 SSE 事件的 buffer 时，SSE 解析器的 `for (const line of lines)` 循环逐个 `yield chunk`。虽然 `yield` 暂停 async generator，但 consumer 的 `generator.next()` 恢复 generator 是在同一个宏任务周期内同步完成的（generator 从 `yield` 恢复后继续走 `for` 循环的下一次迭代，立即碰到下一个 `yield`）。50 次 `yield → consumer → process.stdout.write()` 全部完成在同一个微任务风暴中。

3. **pty 写入与终端读取的竞争**：`process.stdout.write()` 将数据写入 pty（`/dev/pts/N`），但**终端模拟器进程**（Alacritty / Kitty / GNOME Terminal 等）在它自己的事件循环中从 pty 读取。如果 Node.js 在终端读取之前写入了 50 帧，终端只会读到合并后的最终状态。

4. **`setInterval` 被微任务队列阻挡**：Spinner 动画依赖 `setInterval(80ms)` 在 **timers 阶段**触发。微任务队列必须清空才能进入下一个宏任务阶段（包括 timers），因此 spinner 回调在数据批处理期间根本没有机会执行。

### 错误时序

```
[Node.js 进程]                         [终端模拟器]
																				↓ pty 空闲
reader.read() → 50 events
	yield #1 → write frame1
	yield #2 → write frame2
	...
	yield #50 → write frame50
spinnerTimer ❌ 没机会触发
																				← 读 pty, 读到 50 帧
																				↓ 渲染最终状态
```

### 期望时序

```
reader.read() → 1 event
	yield #1 → write frame1
	[事件循环]
		timers → spinner ✓
		poll → 终端读 pty, 渲染 frame1
																				↓ 渲染 frame1
reader.read() → 1 event
	yield #2 → write frame2
	[事件循环]
		timers → spinner ✓
		poll → 终端读 pty, 渲染 frame2
																				↓ 渲染 frame2
...
```

---

## 方案一（首选）：setImmediate 事件循环让出

### 原理

在 async generator 的 consumer 端，每次处理完一个 chunk 后通过 `setImmediate` 让出事件循环。`setImmediate` 的回调在 **Check 阶段**执行，在此之前事件循环会依次经过：

| 阶段 | 做的事 | 对谁有用 |
|------|--------|---------|
| **timers** | 触发 `setInterval` | spinner 动画更新 |
| **pending callbacks** | 处理延迟 I/O | — |
| **poll** | 处理新 I/O 事件 | 终端从 pty 读取内容 |
| **check** | `setImmediate` 回调 | 我们的 yield 恢复 |

### 改动

#### 1. `src/core/session.ts` — 在 `sendMessageStream` 的 for 循环内让出

```typescript
// session.ts — sendMessageStream
for await (const chunk of this.client.chatStream(messages, { signal })) {
	const delta = chunk.choices[0]?.delta;

	if (delta?.reasoning_content) {
		fullReasoning += delta.reasoning_content;
		onEvent({ type: 'reasoning_delta', text: delta.reasoning_content });
	}

	if (delta?.content) {
		fullContent += delta.content;
		onEvent({ type: 'content_delta', text: delta.content });
	}

	if (chunk.usage) {
		usage = chunk.usage;
	}

	// ★ 让出事件循环给 timers 和 I/O 阶段
	await new Promise<void>(resolve => setImmediate(resolve));
}
```

#### 2. `src/cli/chat-ui.ts` — 渲染节流

`drawStreamUpdate` 最多每秒 60 帧（~16ms），中间累积状态：

```typescript
// ChatUI 类新增属性
private lastDrawTime = 0;
private readonly FRAME_INTERVAL = 16; // 60fps, ms

/** 节流后的 drawStreamUpdate */
private throttledDrawStreamUpdate(): void {
	const now = Date.now();
	if (now - this.lastDrawTime >= this.FRAME_INTERVAL) {
		this.lastDrawTime = now;
		this.drawStreamUpdate();
	}
}
```

然后在 `handleStreamEvent` 中将所有 `drawStreamUpdate()` 调用替换为 `throttledDrawStreamUpdate()`。Spinner 定时器的 `drawStreamUpdate()` 调用保持不变（它自带 80ms 间隔，不会过频）。

### 涉及修改的文件

| 文件 | 变更 |
|------|------|
| `src/core/session.ts` | `sendMessageStream()` 的 `for await...of` 体内末尾加 `await setImmediate()` |
| `src/cli/chat-ui.ts` | 新增 `throttledDrawStreamUpdate()`，替换 `handleStreamEvent` 中的 `drawStreamUpdate()` 调用 |

### 评估

| 维度 | 评估 |
|------|------|
| 架构改动 | **小** — 两个方法内的局部修改 |
| 每 chunk 额外延迟 | ~1-4ms（事件循环一次完整阶段周期） |
| 是否解决 spinner | **是** — timers 阶段能正常触发 |
| 是否解决增量渲染 | **是** — poll 阶段终端能读到 pty |
| 测试影响 | **小** — session.test.ts 的流式 test 可能需微调超时 |
| 风险 | 低 |

---

## 方案二（备选）：worker_threads 生产者-消费者

### 原理

将 SSE 流读取和解析放入 Worker 线程（生产者），主线程（消费者）通过 `postMessage` 接收逐条 token。Worker 的 `message` 事件是**宏任务**，天然让事件循环走过完整阶段。

```
Worker 线程（生产者）                主线程（消费者）
fetch SSE 流                          │
reader.read() → 逐条 data: 行        │
postMessage({ delta, type }) ──────→ 接收 message 事件
																			│ → 宏任务（非微任务）
																			│ → 事件循环走完整阶段
																			│   timers → spinner ✓
																			│   poll → 终端读 pty ✓
																			│ → drawStreamUpdate()
```

### 架构变化

#### 新增文件

**`src/core/stream-worker.ts`** — Worker 线程入口

```typescript
import { parentPort } from 'node:worker_threads';
import { ApiClient } from './api.js';

// 通过 message 接收任务
parentPort?.on('message', async (task: {
	type: 'start_stream';
	messages: Message[];
	options: StreamOptions;
}) => {
	const client = new ApiClient(baseUrl, apiKey, model);
	// client 需要在 Worker 内构造或在 message 中传参

	for await (const chunk of client.chatStream(task.messages, task.options)) {
		parentPort?.postMessage({
			type: 'chunk',
			data: chunk,
		});
	}

	parentPort?.postMessage({ type: 'done' });
});
```

#### 涉及修改的文件

| 文件 | 变更 |
|------|------|
| `src/core/stream-worker.ts` | **新建** — Worker 线程 |
| `src/core/session.ts` | `sendMessageStream()` 改为启动 Worker + 监听 message 事件 |
| `src/core/api.ts` | 可能需要暴露内部方法以便 Worker 使用 |
| `src/core/types.ts` | 可能需要新增 Worker 消息类型 |
| `src/cli/chat-ui.ts` | 无需变动（`onEvent` 回调接口不变） |

### 构造约束

Worker 中需要 ApiClient 的 `baseUrl`、`apiKey`、`defaultModel`。传入方式：

```typescript
// session.ts — 启动 Worker
const worker = new Worker(new URL('./stream-worker.ts', import.meta.url));

worker.postMessage({
	type: 'start_stream',
	messages,
	options: { signal, timeoutMs: 120_000, maxRetries: 2 },
	// 需要传递 ApiClient 构造参数
	clientConfig: {
		baseUrl: this.client['baseUrl'],
		apiKey: this.client['apiKey'],
		defaultModel: this.client['defaultModel'],
	},
});

worker.on('message', (msg) => {
	if (msg.type === 'chunk') {
		onEvent({ type: 'reasoning_delta', text: msg.data.choices[0]?.delta?.reasoning_content });
		onEvent({ type: 'content_delta', text: msg.data.choices[0]?.delta?.content });
		// ...
	}
	if (msg.type === 'done') {
		// 完成处理
	}
});
```

### 注意事项

1. **SharedArrayBuffer**：可考虑用 `SharedArrayBuffer` 共享数据缓冲区，避免结构化克隆序列化开销（`postMessage` 默认的结构化克隆对于频繁小消息可能成为瓶颈）
2. **Worker 生命周期**：流中断或错误时需正确 terminate Worker，否则可能资源泄漏
3. **ConfigManager 访问**：Worker 是独立上下文，不能直接访问主线程的 ConfigManager 单例，需通过 `postMessage` 传入配置
4. **错误传播**：Worker 内的异常需通过 `worker.on('error')` 和 `worker.on('messageerror')` 捕获并转发
5. **测试**：Worker 的测试需要特殊处理（`vitest` 对 `worker_threads` 的支持有限）

### 评估

| 维度 | 评估 |
|------|------|
| 架构改动 | **大** — 新增 Worker 文件，session.ts 重写流式逻辑，错误处理复杂 |
| 每 chunk 额外延迟 | 低（postMessage 结构化克隆 ~0.01ms） |
| 是否解决 spinner | **是** — message 事件是宏任务，timers 阶段正常 |
| 是否解决增量渲染 | **是** — 原理同上 |
| 测试影响 | **大** — Worker 需要特殊测试策略 |
| 风险 | 中高（跨线程异常传播、资源泄漏） |

---

## 推荐路径

**阶段一（当前）**：实施方案一（setImmediate + 渲染节流）

- 改动最小，风险最低
- 可在 Phase 7（Token 统计）之前完成
- 如果不能完全解决问题，可以作为方案二的 foundation（`sendMessageStream` 的回调接口不变）

**阶段二（备选）**：如果 setImmediate 的 yield 效果不足（例如终端读取频率仍低于写入频率），升级到 worker_threads

- `sendMessageStream` 的回调接口 `onEvent: (event: StreamEvent) => void` 不变
- ChatUI 层无需任何修改
- 只需替换 session.ts 中 `sendMessageStream` 的内部实现
