# 测试目录分离与伪装模型提供商设计

> 目标：把测试代码从 `src/` 中分离出去，并提供一个“看起来像真实模型提供商”的测试提供商，避免每次测试都消耗真实 API 配额。

## 1. 现状

当前仓库有两个现象：

1. 测试文件和源码同目录，例如 `src/core/api.test.ts`
2. `ApiClient` 直接通过 `fetch` 调真实 provider 的 OpenAI 兼容接口

这会带来两个问题：

- 代码目录混在一起，源码和测试职责不够清楚
- 集成测试和交互测试容易消耗真实 token，成本高

## 2. 目标

你要做的事情可以拆成两部分：

1. 测试代码和开发代码分离，不再放在同一个目录下
2. 开发一个伪装的模型服务商，在测试模式下返回与真实 provider 一致的请求/响应格式

## 3. 推荐目录方案

建议把测试统一移动到独立目录：

```text
src/
tests/
├── core/
│   ├── config.test.ts
│   ├── storage.test.ts
│   ├── api.test.ts
│   └── session.test.ts
├── cli/
│   └── index.test.ts
└── utils/
    └── throttle.test.ts
```

对应规则：

- 源码只放 `src/`
- 测试只放 `tests/`
- 测试文件仍然用 `*.test.ts`
- 测试文件路径尽量镜像源码目录结构

这种方式对新手最友好，因为你一眼就能知道：

- `src/` 是生产代码
- `tests/` 是验证代码

## 4. 测试目录分离怎么做

### 第一步：先改 Vitest 扫描范围

把 `vitest.config.ts` 从：

```ts
include: ['src/**/*.test.ts']
```

改成：

```ts
include: ['tests/**/*.test.ts']
```

如果要兼容过渡期，可以临时写成：

```ts
include: ['src/**/*.test.ts', 'tests/**/*.test.ts']
```

但这只是迁移期用法，最后应只保留 `tests/`。

### 第二步：更新 TypeScript 排除规则

`tsconfig.json` 里现在排除了 `**/*.test.ts`，这已经足够让测试文件不参与生产构建。

如果测试移到 `tests/`，通常不用额外改 `tsconfig`，但要确认：

- `include` 仍然只编译 `src/**/*.ts`
- `exclude` 继续排除测试文件

### 第三步：迁移测试文件

建议按模块逐个迁移：

1. 先迁移纯单元测试：`config`, `storage`, `api`, `session`, `throttle`
2. 再迁移 CLI e2e 测试
3. 每迁移一个目录就跑一次测试

这样出问题时更容易定位。

### 第四步：更新文档和命令示例

要同步改：

- `README.md`
- `agent.md`
- `docs/architecture.md`
- `docs/refactoring-analysis.md`

避免文档继续写“测试在源码旁边”，因为那会误导以后的人。

## 5. 伪装模型提供商的设计

## 5.1 设计原则

伪装 provider 的关键不是“随便返回一段字符串”，而是：

- 请求格式要和真实 provider 一样
- 响应字段要和真实 provider 一样
- 非流式和流式都要支持
- 错误结构也要尽量一致

这样你的上层代码 `ApiClient`、`SessionManager`、`ChatUI` 才能在测试模式下不改逻辑地工作。

## 5.2 推荐实现方式

最稳妥的做法是把“真实 provider”与“伪装 provider”放在同一个抽象层后面。

建议新增一个接口，例如：

```ts
interface ModelProvider {
  chat(messages, options): Promise<ChatCompletionResponse>;
  chatStream(messages, options): AsyncGenerator<StreamChunk>;
}
```

然后实现两个 provider：

- `DeepSeekProvider`：真实 HTTP 调用
- `MockProvider`：本地伪装返回

上层不直接依赖 `fetch`，而是依赖 `ModelProvider`。

## 5.3 MockProvider 应该模拟什么

至少要模拟这些字段：

### 非流式响应

```ts
{
  id: string,
  object: 'chat.completion',
  created: number,
  model: string,
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: string,
        reasoning_content?: string
      },
      finish_reason: 'stop'
    }
  ],
  usage?: {
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number,
    prompt_cache_hit_tokens?: number,
    prompt_cache_miss_tokens?: number
  }
}
```

### 流式响应

每个 chunk 也要符合 `StreamChunk`：

```ts
{
  id: string,
  object: 'chat.completion.chunk',
  created: number,
  model: string,
  choices: [
    {
      index: 0,
      delta: { content?: string, reasoning_content?: string, role?: 'assistant' },
      finish_reason: null | 'stop'
    }
  ],
  usage?: TokenUsage
}
```

## 5.4 MockProvider 的行为建议

建议它不要“随机乱答”，而是有稳定规则，这样测试更可靠。

### 建议规则

1. 只看最后一条 `user` 消息作为输入
2. 如果消息里包含 `stream` 场景，就按固定 chunk 顺序吐出
3. 如果消息里包含特殊标记，可以模拟错误
4. `reasoning_content` 和 `content` 分开输出，便于测试 UI 的灰字和白字

### 示例行为

- `你好` -> 回复 `你好，我是测试提供商`
- 包含 `#error-401` -> 返回 401 错误结构
- 包含 `#error-500` -> 返回 500 错误结构
- 包含 `#stream` -> 走流式 chunk 输出
- 包含 `#tool` -> 预留未来工具调用解析格式

## 5.5 未来工具解析怎么预留

你提到“未来工具解析”，这意味着 mock provider 最好提前支持这些字段：

- `tool_calls`
- `tool_call_id`
- `name`
- `role: 'tool'`

即使现在 UI 还不处理，也要先把数据结构保留下来。这样后面做工具调用时，不需要重新改整个响应模型。

## 5.6 测试模式怎么切换

建议不要把“测试模式”写死在代码里，而是通过配置切换。

可以考虑在 `providers.toml` 里加一个测试 provider：

```toml
[mock]
base_url = "http://127.0.0.1:3001"
api_key = "mock-key"

[defaults]
provider = "mock"
model = "mock-chat"
```

这样上层依然按“provider/base_url/api_key/model”工作，只是 `base_url` 指向本地 mock 服务。

## 5.7 两种实现路线

### 路线 A：纯内存 MockProvider

优点：

- 最简单
- 不需要启动额外进程
- 单元测试最快

缺点：

- 不够接近真实 HTTP 边界

适合：

- `SessionManager`
- `ChatUI`
- 大部分单元测试

### 路线 B：本地 HTTP 伪装服务

优点：

- 最接近真实 provider
- 可以测试完整 HTTP/SSE 路径

缺点：

- 要多一个本地服务
- 测试更慢

适合：

- `ApiClient`
- 流式 SSE 解析
- 集成测试

### 我的建议

两种都做，但分层使用：

- 单元测试用纯内存 `MockProvider`
- 集成测试用本地 HTTP 伪装服务

这是最均衡的方案。

## 6. 推荐改造顺序

### 第一阶段：测试目录分离

1. 建 `tests/` 目录
2. 迁移所有测试文件
3. 改 `vitest.config.ts`
4. 跑通 `npm test`

### 第二阶段：抽象 provider

1. 新增 `ModelProvider` 接口
2. 把 `ApiClient` 的 HTTP 逻辑包进真实 provider
3. 新增 `MockProvider`
4. 让 `SessionManager` 只依赖 provider 接口

### 第三阶段：补 mock 行为

1. 非流式响应
2. 流式 SSE 响应
3. 错误响应
4. future tool 字段

## 7. 实施时的注意点

1. 不要一次性大改，先迁移测试，再做 provider 抽象
2. 先保证接口不变，再换内部实现
3. 测试数据要稳定，尽量不要随机内容
4. mock 响应字段名要严格对齐真实 provider
5. 文档要跟着代码一起改，不然以后会重新混乱

## 8. 你现在最该做什么

如果按风险和收益排序，建议先做：

1. 把测试搬到 `tests/`
2. 把 `vitest.config.ts` 改成只扫 `tests/`
3. 新增 `MockProvider`
4. 让 `ApiClient` 或更上层支持切换 provider

这样你立刻就能减少真实 token 消耗。
