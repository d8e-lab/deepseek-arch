# 测试指南

> 最后更新：2026-05-19 · 当前版本：v0.4.0
> 测试总数：**7 文件，117 条用例**

## 目录

1. [测试哲学](#1-测试哲学)
2. [目录结构](#2-目录结构)
3. [各层测试策略](#3-各层测试策略)
4. [MockProvider 使用指南](#4-mockprovider-使用指南)
5. [运行测试](#5-运行测试)
6. [覆盖率](#6-覆盖率)
7. [编写新测试](#7-编写新测试)
8. [最佳实践](#8-最佳实践)

---

## 1. 测试哲学

### 分层策略

```
┌─────────────────────────────┐
│       CLI e2e 测试          │  ← 黑盒，通过子进程运行 CLI
│   tests/cli/index.test.ts   │     验证输出内容，不耦合内部实现
├─────────────────────────────┤
│      核心单元测试            │  ← 白盒，mock 外部依赖
│   tests/core/*.test.ts      │     使用 MockProvider 替代真实 API
├─────────────────────────────┤
│     工具函数测试             │  ← 纯函数测试
│   tests/utils/*.test.ts     │     无依赖，无 mock
└─────────────────────────────┘
```

### 三条原则

1. **不消耗真实 token** — 所有 `core/` 层测试使用 mock（mock fetch 或 MockProvider），从不调用真实 API
2. **数据可预测** — MockProvider 的响应是确定性的，同一输入总是同一输出
3. **测试与源码分离** — 测试文件在 `tests/` 下，不混入 `src/`

---

## 2. 目录结构

```
tests/
├── core/                       # 核心业务层测试
│   ├── config.test.ts          #  ConfigManager（12 tests）
│   ├── storage.test.ts         #  Storage 文件系统 CRUD（25 tests）
│   ├── api.test.ts             #  ApiClient fetch mock（20 tests）
│   ├── session.test.ts         #  SessionManager（16 tests）
│   └── mock-provider.test.ts   #  MockProvider 自身（26 tests）
├── cli/
│   └── index.test.ts           #  CLI e2e 子进程（10 tests）
└── utils/
    └── throttle.test.ts        #  Throttle 工具（8 tests）
```

**命名规则**：`<module>.test.ts`，镜像 `src/` 的子目录结构。

---

## 3. 各层测试策略

### 3.1 工具函数（utils/）

**测试方式**：纯函数测试，无需 mock，无需文件系统。

**示例**（throttle.test.ts）：
```typescript
import { Throttle } from '../../src/utils/throttle.js';

describe('Throttle', () => {
  it('首次调用 run() 应该执行回调', () => {
    const fn = vi.fn();
    const throttle = new Throttle(60);
    const executed = throttle.run(fn);
    expect(executed).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

**关键点**：使用 `vi.useFakeTimers()` 控制时间，避免真实等待。

---

### 3.2 配置（config.test.ts）

**测试方式**：使用临时目录，不污染 `~/.deepseek-arch`。

```typescript
import { mkdtemp, rm } from 'node:fs/promises';

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'deepseek-arch-test-'));
  ConfigManager.resetInstance();
});

afterEach(async () => {
  ConfigManager.resetInstance();
  await rm(testDir, { recursive: true, force: true });
});
```

**关键点**：
- 每个测试独立临时目录，互不干扰
- `ConfigManager.resetInstance()` 确保单例被重置
- 测试 ConfigManager 的单例行为、加载/持久化、点号路径取值

---

### 3.3 存储（storage.test.ts）

**测试方式**：真实文件 I/O，使用临时目录隔离，不依赖 mock。

```typescript
async function createStore(): Promise<Storage> {
  const dir = await mkdtemp(join(tmpdir(), 'deepseek-storage-test-'));
  return new Storage(dir);
}
```

**关键点**：
- `beforeEach` / `afterEach` 创建和销毁临时目录
- 模拟完整的会话 CRUD + turn CRUD 路径
- 边界情况：大量轮次（50轮）、超长 content（50KB）、特殊字符

---

### 3.4 API 客户端（api.test.ts）

**测试方式**：mock `globalThis.fetch`，不发起真实 HTTP 请求。

```typescript
beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it('正确发送请求并返回响应', async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(expected),
  });
  globalThis.fetch = mockFetch;
  // ... 断言 URL、请求体、响应
});
```

**流式测试**（chatStream）：
```typescript
function mockSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}
```

**注意**：SSE 事件行如果独占一行（非 SSE 数据格式），必须保证有 `\n` 换行。例如 `': comment line'` 应写作 `': comment line\n'`，否则解析器会将其缓存并在下一个 chunk 到达时误拼接。

---

### 3.5 对话管理（session.test.ts）

**测试方式**：
- 真实 `Storage`（临时目录）
- mock 的 `ModelProvider`（使用 `as unknown as ModelProvider` 进行类型转型）

```typescript
function mockClient(response?: ChatCompletionResponse): ModelProvider {
  const mockChat = vi.fn().mockResolvedValue(response ?? makeResponse());
  return { chat: mockChat } as unknown as ModelProvider;
}
```

**流式 mock**：
```typescript
function mockStreamClient(chunks: StreamChunk[]): ModelProvider {
  async function* gen(): AsyncGenerator<StreamChunk> {
    for (const c of chunks) yield c;
  }
  return { chatStream: gen } as unknown as ModelProvider;
}
```

**关键点**：
- 每次重建 `SessionManager` 后必须调用 `startNewSession()` 或 `resumeSession()`
- 流式中断测试依赖 `AbortController`，注意设置超时让 signal 传播

---

### 3.6 CLI e2e（index.test.ts）

**测试方式**：通过 `child_process.execSync` 运行编译后的 CLI，验证 stdout/stderr/exit code。

```typescript
const CLI_PATH = resolve(import.meta.dirname!, '..', '..', 'dist', 'index.js');

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args.join(' ')}`, { ... });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status };
  }
}
```

**关键点**：
- 测试前编译：`beforeAll` 中执行 `npx tsc`
- 测试黑盒行为：`--help` 输出包含子命令、`--version` 输出版本号
- 错误路径：不存在的会话 ID、非 TTY 环境

---

## 4. MockProvider 使用指南

### 4.1 基本用法

```typescript
import { MockProvider } from '../../src/core/mock-provider.js';
import type { ModelProvider } from '../../src/core/model-provider.js';

// 创建实例
const provider = new MockProvider();          // 默认模型 mock-chat
const provider2 = new MockProvider('my-model'); // 自定义模型
```

### 4.2 响应规则

| 用户消息包含 | 回复 |
|-------------|------|
| `你好` / `hello` | "你好，我是测试提供商。" |
| `你是谁` / `你叫什么` | "我是 MockProvider，一个本地测试用的伪装模型提供商。" |
| `测试` | "测试通过！MockProvider 运行正常。" |
| 其他 | `你说了: "{输入}"。这是 MockProvider 的默认回复。` |

### 4.3 特殊标记

| 标记 | 作用 |
|------|------|
| `#error-401` | 抛出 `ApiError(401, 'Invalid API Key')` |
| `#error-429` | 抛出 `ApiError(429, 'Rate limit exceeded')` |
| `#error-500` | 抛出 `Error('Internal Server Error')` |
| `#stream` | 流式模式下按字符逐个 yield（默认一次性 yield 全部） |
| `#nothink` | 跳过 `reasoning_content` 输出 |

### 4.4 在 SessionManager 测试中使用

```typescript
import { Storage } from '../../src/core/storage.js';
import { MockProvider } from '../../src/core/mock-provider.js';
import { SessionManager } from '../../src/core/session.js';

// 用 MockProvider 代替 ApiClient
const storage = new Storage(testDir);
const provider = new MockProvider();
const manager = new SessionManager(storage, provider);
```

### 4.5 在 ApiClient 测试中使用

ApiClient 测试仍然 mock `globalThis.fetch`（因为要测试 HTTP 逻辑和 SSE 解析），不应使用 MockProvider。MockProvider 用于：
- SessionManager 测试（替代 ApiClient）
- 未来 ChatUI 组件的集成测试
- 任何需要"看起来像真实 API"但又不消耗真实 token 的场景

---

## 5. 运行测试

### 5.1 命令一览

| 命令 | 用途 |
|------|------|
| `npm test` | 单次运行全部测试 |
| `npm run test:watch` | 持续监听模式，文件变更自动重跑 |
| `npm run test:coverage` | 运行测试并生成覆盖率报告 |
| `npx vitest tests/core/api.test.ts` | 运行单个测试文件 |
| `npx vitest -t "流式"` | 按测试名称过滤运行 |

### 5.2 调试单个测试

```bash
# 指定文件 + 断点调试
npx vitest tests/core/session.test.ts --inspect-brk

# 然后打开 chrome://inspect 连接
```

### 5.3 配置说明

`vitest.config.ts` 当前配置：

```typescript
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],    // 只扫描 tests/
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],     // 只统计 core 模块
      exclude: ['src/core/types.ts'],
      thresholds: {
        lines: 80, branches: 80, functions: 80, statements: 80,
      },
    },
    clearMocks: true,                     // 测试间自动清除 mock
  },
});
```

`clearMocks: true` 确保每个测试后自动调用 `vi.clearAllMocks()`，无需手动清理。

---

## 6. 覆盖率

### 6.1 目标

| 指标 | 要求 |
|------|------|
| Lines | ≥ 80% |
| Branches | ≥ 80% |
| Functions | ≥ 80% |
| Statements | ≥ 80% |

### 6.2 查看报告

```bash
npm run test:coverage
# 打开 coverage/index.html 浏览
```

### 6.3 覆盖范围

当前覆盖率统计仅覆盖 `src/core/` 目录（除 `types.ts`），因：
- `src/cli/` 含大量终端交互逻辑，不宜纯单元测试覆盖
- `src/types/` 为类型定义，零运行时行为
- 后期可扩展覆盖范围

---

## 7. 编写新测试

### 7.1 新增测试文件的步骤

1. 确定被测试模块在 `src/` 中的位置
2. 在 `tests/` 下创建镜像目录路径
3. 创建 `<module>.test.ts`
4. 如果是新的模块类型，在 `vitest.config.ts` 中确认 `include` 模式已覆盖

### 7.2 从属模块测试组织结构

根据 `docs/refactoring-analysis.md` 的规划，后续拆分出独立组件时应同步创建测试：

```
tests/
├── cli/
│   ├── components/
│   │   ├── input-panel.test.ts       ← 输入面板组件
│   │   ├── spinner.test.ts           ← 等待动画组件
│   │   └── display-lines.test.ts     ← 显示缓冲区组件
│   ├── state/
│   │   └── chat-state.test.ts        ← 流式状态机
│   └── handlers/
│       ├── input-handler.test.ts     ← 输入事件处理
│       └── stream-handler.test.ts    ← 流式事件处理
├── core/
│   └── stream-sender.test.ts         ← 流式发送逻辑（从 session.ts 提取后）
```

### 7.3 测试模板

```typescript
/**
 * <ModuleName> 单元测试
 *
 * 描述：<测试策略，如 "使用临时目录" / "mock fetch" / "无依赖">
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('<ModuleName>', () => {
  // 测试夹具（fixture）搭建
  beforeEach(() => {
    // 创建依赖、重置状态
  });

  afterEach(() => {
    // 清理资源、重置 mock
  });

  describe('正常场景', () => {
    it('基本功能', async () => {
      // Arrange
      // Act
      // Assert
    });
  });

  describe('边界情况', () => {
    it('空输入', () => { /* ... */ });
    it('大量数据', () => { /* ... */ });
    it('错误输入', () => { /* ... */ });
  });

  describe('错误处理', () => {
    it('网络错误', async () => { /* ... */ });
  });
});
```

---

## 8. 最佳实践

### 8.1 通用规则

1. **每个 `describe` 块聚焦一个职责** — 模块的一个方法或一个状态
2. **测试命名清晰** — `it('空内容抛出错误')` 而非 `it('test1')`
3. **Arrange-Act-Assert 模式** — 准备 → 执行 → 断言，用空行分隔三个阶段
4. **避免测试间共享可变状态** — `beforeEach` 重置一切
5. **不要 mock 不需要 mock 的东西** — 纯函数直接测试

### 8.2 Mock 策略

| 场景 | Mock 方法 |
|------|-----------|
| HTTP 调用（ApiClient 测试） | `globalThis.fetch = vi.fn()` |
| 模型提供商（SessionManager 测试） | MockProvider 或 `as unknown as ModelProvider` |
| 文件系统（Storage 测试） | 真实文件 I/O + 临时目录 |
| 时间相关（Throttle 测试） | `vi.useFakeTimers()` |
| 终端 TTY（CLI 测试） | 子进程调用，非 TTY 环境自然退出 |

### 8.3 避免的陷阱

| 陷阱 | 正确做法 |
|------|---------|
| 测试调用真实 API | 始终 mock fetch 或使用 MockProvider |
| MockProvider 的随机回复 | MockProvider 是确定性的，不要修改为 `Math.random()` |
| `vi.fn()` 忘记 restore | 使用 `clearMocks: true` 或 `vi.restoreAllMocks()` |
| SessionManager 重建后缺 startNewSession | 每个新 `SessionManager` 实例必须调用 `startNewSession()` 或 `resumeSession()` |
| 硬编码路径 | 使用 `import.meta.dirname` + 相对路径，或临时目录 |
| SSE 流式测试缺少换行 | 每个 SSE 事件行（含注释行）以 `\n` 结尾 |

### 8.4 覆盖率不达标时的排查

```bash
# 生成详细覆盖率报告
npm run test:coverage

# 查看哪些行 / 分支没覆盖
# 打开 coverage/index.html 点击具体文件查看
```

常见原因：
- 错误处理分支未测试（`if (!response.ok)` 等）
- 边界条件（空数组、undefined 字段）
- 配置/环境分支（istty、headless 等）

### 8.5 提交前检查清单

- [ ] `npm test` 全部通过
- [ ] `npm run test:coverage` 覆盖率达标
- [ ] `npx tsc --noEmit` 零编译错误
- [ ] 新增的模块有其对应的 `.test.ts` 文件
- [ ] 测试使用临时目录，不污染真实配置
- [ ] 文档（README / docs/）中的测试统计已更新
