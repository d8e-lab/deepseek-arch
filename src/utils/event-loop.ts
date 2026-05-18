/**
 * 事件循环让出 — 工具函数
 *
 * 通过 setImmediate 让出当前事件循环迭代，
 * 使得 timers (setInterval/setTimeout) 和 I/O poll 阶段有机会执行。
 *
 * 用于流式数据处理中，防止微任务风暴阻塞 spinner 动画和终端渲染。
 */

/**
 * 让出当前事件循环迭代。
 *
 * 调用后 await 会使当前 async 函数挂起，
 * 下一个事件循环迭代的 check 阶段恢复执行。
 * 在两次调用之间，timers 阶段和 poll 阶段可以正常执行。
 *
 * @example
 *   for await (const chunk of stream) {
 *     processChunk(chunk);
 *     await yieldEventLoop();  // 给 spinner / I/O 让路
 *   }
 */
export function yieldEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}
