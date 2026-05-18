# 模块交互与实现详解

> 创建于 2026-05-18 · 目标：完整描述当前代码的每个类、方法、内部实现、类间引用关系

---

## 目录结构一览

```
src/
├── index.ts                  # 入口
├── core/
│   ├── types.ts              # 全部领域类型 + ApiError 类（无其他类）
│   ├── config.ts             # ConfigManager (Singleton)
│   ├── storage.ts            # Storage (Repository)
│   ├── api.ts                # ApiClient (Adapter)
│   └── session.ts            # SessionManager (Facade)
├── cli/
│   ├── index.ts              # CLI 主程序（含 run 函数）
│   └── chat-ui.ts            # ChatUI (全屏 TUI)
├── utils/
│   ├── event-loop.ts         # yieldEventLoop()
│   └── throttle.ts           # Throttle 类
```

---

## 1. `src/core/types.ts` — 领域类型定义（262 行）

**性质**：纯类型文件。包含所有 interface + 一个 class（`ApiError`），**不包含任何业务逻辑或行为方法**。

### 类型/类清单

| 名称 | 种类 | 作用 | 关键字段 |
|------|------|------|---------|
| `MessageRole` | type (字面量联合) | 消息角色枚举 | `'system' \| 'user' \| 'assistant' \| 'tool'` |
| `Message` | interface | 单条对话消息 | `role`, `content`, `reasoning_content?`, `tool_call_id?`, `name?` |
| `TokenUsage` | interface | API 返回的用量 | `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_cache_hit_tokens?`, `prompt_cache_miss_tokens?` |
| `CostBreakdown` | interface | 费用明细 | `cacheHitCost`, `cacheMissCost`, `outputCost`, `totalCost`, `cacheHitRate`, `usage` |
| `TurnRecord` | interface | 一轮对话记录 | `turn`, `user`, `assistant`, `usage?`, `cost_rmb`, `created_at`, `interrupted?` |
| `SessionMeta` | interface | 会话元数据 | `id`, `title`, `created_at`, `updated_at`, `turnCount`, `totalCost`, `lastUsage?` |
| `SessionListItem` | interface | 列表展示项 | `index`, `id`, `title`, `updated_at`, `turnCount` |
| `Session` | interface | 完整会话 | `meta`, `turns[]`, `systemPrompt?` |
| `SessionData` | type 别名 | = `Session` | 兼容旧名 |
| `ProviderConfig` | interface | 供应商配置 | `base_url`, `api_key` |
| `ProvidersConfig` | type | = `Record<string, ProviderConfig>` | — |
| `ModelPricing` | interface | 模型价格 | `input_cache_hit`, `input_cache_miss`, `output`, `currency` |
| `PricingConfig` | type | = `Record<string, Record<string, ModelPricing>>` | — |
| `SystemPromptTemplate` | interface | 提示模板 | `content` |
| `SystemPromptConfig` | type | = `Record<string, SystemPromptTemplate>` | — |
| `ConfigPaths` | interface | 文件跳转路径 | `providers`, `pricing`, `system_prompt`, `sessions` |
| `ConfigDefaults` | interface | 默认值 | `provider`, `model`, `system_prompt` |
| `AppConfig` | interface | 主配置 | `paths`, `defaults` |
| `ResolvedConfig` | interface | 完整合并配置 | `paths`, `defaults`, `providers`, `pricing`, `systemPrompts` |
| `ChatCompletionRequest` | interface | API 请求体 | `model`, `messages[]`, `stream?`, `temperature?`, `max_tokens?`, `top_p?` |
| `StreamDelta` | interface | 流式增量 | `role?`, `content?`, `reasoning_content?` |
| `ChatChoice` | interface | 候选回复 | `index`, `message?`, `delta?`, `finish_reason` |
| `ChatCompletionResponse` | interface | API 响应体 | `id`, `object`, `created`, `model`, `choices[]`, `usage?` |
| `StreamChunk` | interface | SSE 块 | `id`, `object`, `created`, `model`, `choices[]`, `usage?` |
| `StreamOptions` | interface | 流式参数 | `timeoutMs?`, `maxRetries?`, `signal?` |
| `ApiErrorBody` | interface | 错误体 | `message?`, `type?`, `code?` |
| `ApiError` | **class** (extends Error) | API 错误 | `status`, `code?` |

### 跨文件引用关系

```
types.ts 被以下文件引用：
  ← config.ts      (import type { AppConfig, ResolvedConfig, ProvidersConfig, PricingConfig, SystemPromptConfig })
  ← storage.ts     (import type { SessionMeta, Session, SessionListItem, Message, TurnRecord, TokenUsage })
  ← api.ts         (import type { Message, ChatCompletionRequest, ChatCompletionResponse, StreamChunk, StreamOptions })
                    (import { ApiError } from './types' — 类，非 type)
  ← session.ts     (import type { Message, Session, SessionMeta, TurnRecord, TokenUsage, ChatCompletionResponse, StreamChunk })
  ← chat-ui.ts     (import type { Message, ChatCompletionResponse })
  ← 所有测试文件
```

### 依赖方向

```
types.ts — 无依赖（零 import，纯定义）
        ↓ 被所有其他模块 import
```

---

## 2. `src/core/config.ts` — ConfigManager（275 行）

**性质**：Singleton 模式的配置管理器。单类。

### 类：`ConfigManager`

**静态成员**：

| 成员 | 类型 | 作用 |
|------|------|------|
| `DEFAULT_CONFIG_DIR` | `const string` | `resolve(homedir(), '.deepseek-arch')` |
| `instance` | `private static ConfigManager` | 单例实例 |
| `getInstance(configDir?)` | `static` | 获取/创建单例，若已存在直接返回 |
| `resetInstance()` | `static` | 置空单例（仅测试用） |

**实例成员**：

| 成员 | 类型 | 作用 |
|------|------|------|
| `configDir` | `private string` | 配置目录路径 |
| `loaded` | `private boolean` | 是否已加载 |
| `resolved` | `private ResolvedConfig \| null` | 合并后的完整配置 |

**方法**：

| 方法 | 可见性 | 签名 | 内部实现 |
|------|--------|------|---------|
| `constructor` | `private` | `(configDir?: string)` | 保存 configDir，默认 `~/.deepseek-arch` |
| `ensureConfigDir` | `async public` | `(): Promise<void>` | `access()` 检查目录是否存在；ENOENT 则 `mkdir()` 递归创建 |
| `resolvePath` | `private` | `(relativePath: string): string` | `resolve(this.configDir, relativePath)` |
| `loadTomlFile<T>` | `private` | `(filePath: string): Promise<T \| null>` | `readFile()` → `tomlParse()`；ENOENT 返回 null |
| `writeTomlFile` | `private` | `(filePath, data): Promise<void>` | `tomlStringify()` → `writeFile()` |
| `load` | `async public` | `(): Promise<ConfigManager>` | 幂等。1) 读 `config.toml`；2) 若不存在则创建 4 个默认 TOML 文件；3) 并行读 `providers/pricing/system-prompt`；4) 合并为 `ResolvedConfig` |
| `reload` | `async public` | `(): Promise<ConfigManager>` | 重置 `loaded=false, resolved=null` 后调 `load()` |
| `get<T>` | `public` | `(path: string): T \| undefined` | 点号路径遍历。从 `this.resolved` 开始逐层访问 |
| `set` | `async public` | `(path: string, value: unknown): Promise<void>` | 1) 确定目标文件（`fileMap`）；2) `loadTomlFile` 读取原文件；3) `setNested` 设置值；4) `writeTomlFile` 写回；5) 更新内存 |
| `setNested` | `private` | `(obj, path: string[], value): void` | 递归遍历/创建路径，最后一级赋值 |
| `getResolved` | `public` | `(): ResolvedConfig \| null` | 直接返回 `this.resolved` |
| `getConfigDir` | `public` | `(): string` | 返回 `this.configDir` |
| `getSessionsDir` | `public` | `(): string` | `resolvePath(resolved.paths.sessions)` |

### 内部常量（首次运行自动创建）

```typescript
DEFAULT_MAIN_CONFIG: AppConfig
DEFAULT_PROVIDERS: ProvidersConfig
DEFAULT_PRICING: PricingConfig
DEFAULT_SYSTEM_PROMPTS: SystemPromptConfig
```

### fileMap（set 方法的关键映射）

```
paths        → config.toml,       stripRoot=false
defaults     → config.toml,       stripRoot=false
providers    → providers.toml,    stripRoot=true
pricing      → pricing.toml,      stripRoot=true
systemPrompts→ system-prompt.toml, stripRoot=true
```

`stripRoot=true` 表示写入时剥离顶层键（如 `providers.deepseek.api_key` → 文件顶层写入 `deepseek.api_key`）。

### 跨文件引用关系

```
config.ts
  ← types.ts             (import type { AppConfig, ResolvedConfig, ... })
  → 被 CLI/app 的入口调用：
     src/cli/index.ts    (ConfigManager.getInstance().load())
     src/cli/chat-ui.ts  (constructor 接收 ConfigManager 实例，然后 config.get('...'))
```

---

## 3. `src/core/storage.ts` — Storage（291 行）

**性质**：Repository 模式的文件系统持久层。单类。

### 类：`Storage`

**实例成员**：

| 成员 | 类型 | 作用 |
|------|------|------|
| `sessionsDir` | `private string` | 会话存储根目录 |

**内部常量**：

```typescript
TURNS_FILE = 'turns.json';
META_FILE = 'meta.json';
```

**方法**：

#### 私有辅助方法

| 方法 | 签名 | 内部实现 |
|------|------|---------|
| `ensureSessionsDir` | `(): Promise<void>` | `access()` 检查，不存在 `mkdir({ recursive: true, mode: 0o700 })` |
| `sessionDir` | `(id: string): string` | `join(this.sessionsDir, id)` |
| `metaPath` | `(id: string): string` | `join(sessionDir(id), 'meta.json')` |
| `turnsPath` | `(id: string): string` | `join(sessionDir(id), 'turns.json')` |
| `readJSON<T>` | `(path: string): Promise<T \| null>` | `readFile()` → `JSON.parse()`；ENOENT 返回 null |
| `writeJSON` | `(path, data): Promise<void>` | `JSON.stringify(data, null, 2) + '\n'` → `writeFile()` |

#### 公开方法 — Sessions

| 方法 | 签名 | 内部实现 |
|------|------|---------|
| `createSession` | `(title?): Promise<SessionMeta>` | `uuidv4()` → 生成 id / now() → 构造 meta → `mkdir sessionDir` → `writeJSON(metaPath)` → 返回 meta |
| `getSession` | `(id): Promise<Session \| null>` | `readJSON(metaPath)` → 若 null 返回 null → `loadTurns(id)` → 校验 `turnCount` 一致性 → 返回 `{ meta, turns }` |
| `getSessionByName` | `(name): Promise<Session \| null>` | `readdir(sessionsDir)` → 遍历每个目录 → `readJSON(metaPath)` → 匹配 `title === name` → `getSession(id)` |
| `listSessions` | `(): Promise<SessionListItem[]>` | `readdir(sessionsDir)` → 过滤目录 → 逐个读 meta → 收集非空 → `sort(updated_at 降序)` → 赋值 index |
| `updateSessionTitle` | `(id, title): Promise<boolean>` | `readJSON(metaPath)` → 若 null 返回 false → 更新 `title` 和 `updated_at` → `writeJSON` → 返回 true |
| `deleteSession` | `(id): Promise<boolean>` | `access(sessionDir)` → 不存在返回 false → `rm({ recursive: true })` → 返回 true |

#### 公开方法 — Turns

| 方法 | 签名 | 内部实现 |
|------|------|---------|
| `saveTurn` | `(sessionId, user, assistant, usage, costRmb, interrupted?): Promise<TurnRecord>` | `access(sessionDir)` 验证存在 → `loadTurns()` → `turnNumber = len+1` → 清空历史 turns 的 `usage` → 构造新 TurnRecord → 所有 turns 写入 `turns.json` → `updateMeta()` 更新 `turnCount/totalCost/lastUsage` → 返回新 turn |
| `getTurns` | `(sessionId): Promise<TurnRecord[]>` | 直接委托 `loadTurns(sessionId)` |

#### 私有方法

| 方法 | 签名 | 内部实现 |
|------|------|---------|
| `loadTurns` | `(sessionId): Promise<TurnRecord[]>` | 优先读 `turns.json`（新格式）→ 若不存在，回退到扫描 `turn-NNN.json` 文件（旧格式兼容）→ 按文件名排序返回 |
| `updateMeta` | `(id, patch): Promise<void>` | `readJSON(metaPath)` → `Object.assign(meta, patch)` → `updated_at = now()` → `writeJSON` |

### 目录结构（Storage 管理）

```
<sessionsDir>/
└── <uuid>/
    ├── meta.json        # 单个 JSON 对象
    └── turns.json       # TurnRecord[] 数组
```

### 跨文件引用关系

```
storage.ts
  ← types.ts             (import type { SessionMeta, Session, SessionListItem, Message, TurnRecord, TokenUsage })
  ← uuid                 (import { v4 as uuidv4 })
  → 被 session.ts 构造时注入
```

---

## 4. `src/core/api.ts` — ApiClient（250 行）

**性质**：Adapter 模式，封装 DeepSeek Chat Completion API。单类，同时提供非流式 `chat()` 和流式 `chatStream()`。

### 类：`ApiClient`

**构造函数参数**（无单例，每次手动 new）：

| 参数 | 类型 | 说明 |
|------|------|------|
| `baseUrl` | `string` | API 基地址，末尾自动去 `/` |
| `apiKey` | `string` | 密钥 |
| `defaultModel` | `string` | 默认模型名 |

**实例成员**：

| 成员 | 类型 | 作用 |
|------|------|------|
| `baseUrl` | `private string` | 存储（已去尾 `/`） |
| `apiKey` | `private string` | 存储 |
| `defaultModel` | `private string` | 存储 |

**内部常量**：

```typescript
CHAT_ENDPOINT = '/v1/chat/completions';
```

### 方法详解

#### `chat()` — 非流式调用

```
签名: (messages: Message[], options?: { model?, temperature?, max_tokens? }): Promise<ChatCompletionResponse>
```

**内部实现**：

1. 构造 `ChatCompletionRequest` 请求体（`stream: false`）
2. `fetch(url, { method: 'POST', headers: { Content-Type + Authorization }, body: JSON.stringify(body) })`
3. 检查 `response.ok`：
   - 非 2xx → 尝试解析 JSON error body → 抛出 `ApiError(status, message, code)`
4. `response.json()` → 返回 `ChatCompletionResponse`

**错误处理**：网络异常（fetch 本身 throw）未特殊捕获；API 4xx/5xx 统一转为 `ApiError`。

#### `chatStream()` — 流式 SSE 调用

```
签名: (messages: Message[], options?: StreamOptions & { model?, temperature?, max_tokens? }): AsyncGenerator<StreamChunk>
```

**内部实现**：

1. **参数处理**：`timeoutMs` 默认 120s，`maxRetries` 默认 2
2. **外部信号检查**：若 `externalSignal.aborted`，直接 throw
3. **重试循环**（`attempt = 0..maxRetries`）：
   - 每次创建独立 `AbortController`
   - `setTimeout(abort, timeoutMs)` — 超时
   - 注册 `externalSignal` 的 abort 监听器
   - `fetch(url, { method: 'POST', headers, body, signal })`
   - **响应检查**：
     - `4xx` → 立即 throw `ApiError`（不重试）
     - `5xx` → 进入重试（指数退避 `min(1000 * 2^attempt, 10000)ms`）
     - `ok` → 进入 SSE 解析
4. **SSE 解析**（`ReadableStreamDefaultReader`）：
   - `reader.read()` 逐帧读取
   - `TextDecoder` 解码 + `buffer` 拼接断行
   - 按 `\n` 拆分：空行/注释行跳过，`data: [DONE]` 退出
   - `data: {...}` → `JSON.parse` → `yield chunk`
5. **重试退出**：
   - `reader.releaseLock()`（finally 块）
   - 成功退出 for 循环
   - 失败：如果是 `ApiError`(4xx) 或用户中断 → 直接 throw；否则记录 `lastError` → 最后一次尝试仍失败则 throw `lastError`

### 异常路径

```
chatStream() 可抛出：
  - ApiError(status >= 400 && < 500)  — 4xx，不重试
  - Error('请求超时')                  — 内部超时
  - Error('响应体为空')                — response.body 为 null
  - Error(externalSignal.reason)       — 用户外部中断
  - Error(lastError)                   — 重试耗尽
```

### 跨文件引用关系

```
api.ts
  ← types.ts             (import type { Message, ChatCompletionRequest, ChatCompletionResponse, StreamChunk, StreamOptions })
                          (import { ApiError } — 被 re-export）
  → 被 session.ts 构造时注入
  → export { ApiError }（供外部 catch 使用）
```

---

## 5. `src/core/session.ts` — SessionManager（295 行）

**性质**：Facade 模式，协调 `Storage` + `ApiClient`。单类，同时承载非流式/流式/中断/部分回复逻辑。

### 类：`SessionManager`

**构造函数参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `storage` | `Storage` | 注入的文件系统持久层 |
| `client` | `ApiClient` | 注入的 API 适配器 |

**实例成员**：

| 成员 | 类型 | 作用 |
|------|------|------|
| `storage` | `private Storage` | 存储引用 |
| `client` | `private ApiClient` | API 引用 |
| `session` | `private Session \| null` | 当前会话（内存状态） |
| `systemPrompt` | `private Message \| null` | 系统提示消息 |

### 方法详解

#### `setSystemPrompt(prompt)` — 设置系统提示
```
直接赋值 this.systemPrompt
```

#### 会话生命周期

| 方法 | 签名 | 内部实现 |
|------|------|---------|
| `startNewSession(title?)` | `async: Promise<SessionMeta>` | `storage.createSession(title)` → 构造 `{ meta, turns: [], systemPrompt }` → 返回 meta |
| `resumeSession(id)` | `async: Promise<Session>` | `storage.getSession(id)` → null 时 throw → `this.session = session` → 返回 session |
| `getSession()` | `(): Session \| null` | 直接返回 `this.session` |
| `getSessionId()` | `(): string \| null` | `this.session?.meta.id ?? null` |
| `setTitle(title)` | `async: Promise<void>` | `storage.updateSessionTitle()` → 更新内存中的 `meta.title/meta.updated_at` |

#### `sendMessage()` — 非流式发送

```
签名: (userContent: string): Promise<{ turn: TurnRecord; response: ChatCompletionResponse }>
```

**内部实现**：

1. 检查 `this.session` 非 null
2. `buildMessages(userContent)` 构建消息数组
3. `client.chat(messages)` → 拿到 `response`
4. `response.choices[0].message` → 提取 assistant 回复
5. `response.usage ?? { prompt_tokens: 0, ... }` → 提取用量
6. `costRmb = 0`（Phase 7 占位）
7. `storage.saveTurn(sessionId, userMsg, assistantMsg, usage, costRmb)` → 持久化
8. `session.turns.push(turn)` → 更新内存
9. 返回 `{ turn, response }`

#### `sendMessageStream()` — 流式发送

```
签名: (userContent: string, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<TurnRecord | null>
```

**内部实现**：

1. 检查 `this.session` 非 null
2. `buildMessages(userContent)` 构建消息数组
3. `for await (const chunk of client.chatStream(messages, { signal }))`：
   - 首个 chunk：记录 `responseId`、`modelName`
   - `delta.reasoning_content` → 追加到 `fullReasoning` → `onEvent({ type: 'reasoning_delta', text })`
   - `delta.content` → 追加到 `fullContent` → `onEvent({ type: 'content_delta', text })`
   - `chunk.usage` → 记录 `usage`
   - `yieldEventLoop()` — 让出事件循环
4. **正常完成**：
   - `usage = chunk.usage ?? { 0, 0, 0 }`
   - `costRmb = 0`
   - `onEvent({ type: 'done', usage })`
   - `storage.saveTurn(...)` → 持久化完整轮次
   - push 到 `session.turns`
   - 返回 `TurnRecord`
5. **异常/中断**：
   - catch `AbortError` + 已有部分内容（`fullReasoning || fullContent`）→ 持久化 `interrupted=true` 轮次 → `onEvent({ type: 'error', error: '已中断' })`
   - 否则 `onEvent({ type: 'error', error: msg })` → 返回 null

#### `buildMessages()` — 构建请求消息（私有）

```
签名: (currentContent: string): Message[]
```

**内部实现**：

1. 如果 `this.systemPrompt` 存在 → 加入消息队列首位
2. 遍历 `this.session.turns`：
   - 跳过 `turn.interrupted === true`
   - push `turn.user`
   - push `{ role: 'assistant', content: turn.assistant.content, reasoning_content: turn.assistant.reasoning_content }`
3. push `{ role: 'user', content: currentContent }`
4. 返回完整消息数组

### 导出类型

```typescript
export interface StreamEvent {
  type: 'reasoning_delta' | 'content_delta' | 'done' | 'error';
  text?: string;
  usage?: TokenUsage;
  error?: string;
}
```

### 跨文件引用关系

```
session.ts
  ← storage.ts           (import { Storage })
  ← api.ts               (import { ApiClient })
  ← event-loop.ts        (import { yieldEventLoop })
  ← types.ts             (import type { Message, Session, SessionMeta, TurnRecord, TokenUsage, ChatCompletionResponse, StreamChunk })
  → 被 chat-ui.ts 引用    (import { SessionManager, type StreamEvent })
```

---

## 6. `src/cli/chat-ui.ts` — ChatUI（1207 行）

**性质**：全屏 TUI 对话界面。状态机 + 渲染引擎 + 输入处理 + 流式控制全部混在此类中。

### 类：`ChatUI`

**构造函数参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `config` | `ConfigManager` | 配置（用于读 providers, pricing） |
| `sessionManager?` | `SessionManager` | 可选注入，为 resume 场景准备 |

### 内部常量与类型

```typescript
VERSION = '0.4.0';
MAX_INPUT_HEIGHT = 10;            // 输入面板最大行数
SPINNER_FRAMES = ['⠋', '⠙', ...]; // 10 帧 braille 动画
SPINNER_INTERVAL_MS = 80;

type UIState = 'idle' | 'sending' | 'streaming';

interface LiveStreamState {
  reasoning: string;
  content: string;
  phase: 'sending' | 'reasoning' | 'content';
}

type LineColor = 'green' | 'gray' | 'white';

interface RenderedLine {
  text: string;      // 纯文本
  color: LineColor;
}
```

### 实例成员（按职责分组）

#### 配置/依赖
| 成员 | 类型 | 作用 |
|------|------|------|
| `config` | `ConfigManager` | 读取 API 配置 |
| `sessionManager` | `SessionManager \| null` | 对话门面 |

#### 终端状态
| 成员 | 类型 | 作用 |
|------|------|------|
| `termWidth` | `number` | 终端列数（默认 80） |
| `termHeight` | `number` | 终端行数（默认 24） |
| `running` | `boolean` | 是否运行 |
| `rawMode` | `boolean` | stdin 是否已设 raw 模式 |
| `stdinIsTTY` | `boolean` | 是否为交互式终端 |
| `lastInputHeight` | `number` | 上次输入面板高度（增量优化） |

#### 对话内容
| 成员 | 类型 | 作用 |
|------|------|------|
| `displayLines` | `RenderedLine[]` | 历史对话行（环形缓冲区，无上限） |
| `inputText` | `string` | 当前编辑的输入 |
| `cursorPos` | `number` | 输入光标位置（字符索引） |
| `inputHistory` | `string[]` | 发送历史 |
| `historyIndex` | `number` | 历史浏览索引（-1=新输入） |

#### 流式状态
| 成员 | 类型 | 作用 |
|------|------|------|
| `uiState` | `UIState` | 状态机：IDLE/SENDING/STREAMING |
| `liveStream` | `LiveStreamState \| null` | 当前流的累积内容（非 null=流式进行中） |
| `inputQueue` | `string[]` | 流式期间暂存的输入 |
| `streamAbort` | `AbortController \| null` | 中断控制器 |
| `spinnerTimer` | `Timer \| null` | spinner 定时器 |
| `spinnerFrameIdx` | `number` | spinner 当前帧索引 |
| `renderThrottle` | `Throttle` | 60fps 渲染节流 |

### 方法详解（按职责分组）

#### 生命周期

##### `start()`
```
签名: async (): Promise<void>
```

**内部实现**：

1. 检查 `stdin.isTTY` → 否则 `console.error('需要交互式终端'); process.exit(1)`
2. `updateTermSize()` — 读取 `process.stdout.rows/columns`
3. 如果 `sessionManager` 已注入（resume 场景）：遍历 `session.turns`，将历史对话 push 到 `displayLines`
4. **未注入**则创建新的 SessionManager：
   - `config.get('defaults.provider')` 读供应商
   - `config.get('defaults.model')` 读模型
   - `config.get('providers.xxx.base_url')` + `config.get('providers.xxx.api_key')` 读凭据
   - 检查 `apiKey`，缺则报错退出
   - `new ApiClient(...)` → `new Storage(...)` → `new SessionManager(storage, client)`
   - `startNewSession(title?)` 创建会话
   - 读 `/defaults.system_prompt` → `setSystemPrompt()`
5. `enterAltScreen()` — 切换备用缓冲区
6. `startRawMode()` — `stdin.setRawMode(true); stdin.on('data', handleKeyPress)`
7. `fullDraw()` — 全屏重绘
8. `readline.emitKeypressEvents(stdin)` — 启用键事件
9. `process.on('SIGWINCH', updateTermSize)` — 终端 resize 事件
10. `cleanup` 注册清理函数

##### `cleanup()`
```
移除 SIGWINCH 监听 → 恢复原始 stdin 模式 → 退出备用缓冲区 → 显示光标
```

##### `enterAltScreen() / exitAltScreen()`
```
writeSync(1, ENTER_ALT_SCREEN) / EXIT_ALT_SCREEN
```

##### `startRawMode()`
```
stdin.setRawMode(true); process.stdin.resume()
```

##### `updateTermSize()`
```
this.termWidth = process.stdout.columns ?? 80;
this.termHeight = process.stdout.rows ?? 24;
```

#### 键盘事件

##### `handleKeyPress(str, key)`

**内部实现**（状态机调度）：

1. 流式状态（`uiState !== 'idle'`）：
   - `Ctrl+C / ESC` → `interruptStream()` 中断流式
   - `key.name === 'return'` → `this.inputQueue.push(inputText)` + 清空输入 + 显示 `⏳ 等待中 (N 条)...`
   - 否则正常编辑输入
2. 空闲状态：
   - `Ctrl+C` 或 `/exit` → 调用 `printExitSummary()` → `cleanup()` → `process.exit(0)`
   - `Ctrl+L` 或 `/clear` → 清空 `displayLines` → `fullDraw()`
   - `Enter` → `handleEnter()`
   - `Ctrl+Enter / Ctrl+J` → 插入换行
   - `Backspace` → 删除光标前字符
   - `Delete` → 删除光标处字符
   - `Left / Right` → 移动光标
   - `Up / Down` → 浏览输入历史
   - `/title xxx` → `sessionManager.setTitle('xxx')`
   - 普通字符 → 插入到光标位置

##### `handleEnter()`
```
签名: (): Promise<void>
```

**内部实现**：

1. `inputText.trim() === ''` → 跳过
2. 命令检查（`/exit`, `/clear`, `/title xxx`）→ 对应处理
3. 普通消息：
   - 保存到 `inputHistory`，重置 `historyIndex`
   - `appendLine(inputText, 'green')` — 追加用户消息到显示
   - 清空 `inputText`，重置 `cursorPos`
   - 启动流式发送：
     - `this.uiState = 'sending'`
     - `this.liveStream = { reasoning: '', content: '', phase: 'sending' }`
     - `startSpinner()`
     - `renderThrottle.reset()`
     - 创建 `AbortController` → `this.streamAbort = controller`
     - `this.sessionManager.sendMessageStream(inputText, this.handleStreamEvent, controller.signal)`
     - `await` 流式完成
     - 完成后 `this.uiState = 'idle'`
     - `processInputQueue()` — 处理队列中等待的输入

#### 流式控制

##### `handleStreamEvent(event)`
```
签名: (event: StreamEvent): void
```

**内部实现**：

1. `reasoning_delta`：
   - `liveStream.reasoning += event.text`
   - `liveStream.phase` 保持在 `'reasoning'`
   - `renderThrottle.run(() => this.drawStreamUpdate())`
2. `content_delta`：
   - 如果是首个 content_delta（`liveStream.phase !== 'content'`）：
     - `liveStream.phase = 'content'`
     - 追加 `[gray]reasoning[/gray]` 到 `displayLines`
     - 清空 `liveStream.reasoning`
     - 追加 `[white]` 前缀行到 `displayLines`
     - `stopSpinner()`
   - `liveStream.content += event.text`
   - `renderThrottle.run(() => this.drawStreamUpdate())`
3. `done`：
   - 追加最终 `liveStream.content` 到 `displayLines`
   - 刷新状态栏显示 token 摘要
   - 重置 `liveStream = null`
4. `error`：
   - 追加 `[gray]${error}[/gray]` 到 `displayLines`
   - 重置 `liveStream = null`

##### `interruptStream()`
```
签名: (): void
```

**内部实现**：
1. `this.streamAbort?.abort()`
2. `stopSpinner()`
3. `liveStream` 中已有内容 → 按 `content` / `reasoning` 追加到 `displayLines` + 追加 `[已中断]` 行
4. 重置 `liveStream = null`

##### Spinner 控制
| 方法 | 实现 |
|------|------|
| `startSpinner()` | `spinnerTimer = setInterval(() => { spinnerFrameIdx = (spinnerFrameIdx+1) % 10; drawStreamUpdate() }, 80)` |
| `stopSpinner()` | `clearInterval(spinnerTimer); spinnerTimer = null` |

#### 渲染

##### `fullDraw()`
```
签名: (): void
```

**内部实现**（终端全量重绘）：

1. `writeSync(1, CURSOR_HOME + CLEAR_SCREEN)`
2. 输出顶部信息栏（2 行）：版本号 + Provider/Model
3. 输出分隔线 `─` * termWidth
4. 输出对话区域：`displayLines` 截取末尾可见行数 → `colorize` → 填充空白 → 逐行输出
5. 输出分隔线
6. 输出输入面板（灰底）：`renderInputLines` 计算换行 → `bgGray` → 逐行输出
7. 光标定位到 `calcCursorInInput` 计算的位置

##### `drawStreamUpdate()`
```
签名: (): void
```

**内部实现**（增量重绘，仅重绘流式区域）：

1. **sending 阶段**：只有 spinner
   - `cursorTo(对话区域最后一行)`
   - `ERASE_LINE` → `writeSync(spinnerFrame)`
2. **reasoning 阶段**：
   - 计算 `liveStream.reasoning` 的显示行数
   - 定位到分隔线下固定行
   - `ERASE_SCREEN_BELOW` → 清空从该行起的所有内容
   - 输出 `colorize(reasoning, 'gray')`
3. **content 阶段**：
   - 定位到 `liveStream.content` 起始行
   - `ERASE_SCREEN_BELOW`
   - 输出 reason 内容（gray）+ content（white），通过 `colorize` 和 `wrapText` 处理换行
   - 重新绘制输入面板

##### `printExitSummary()`
```
签名: (): void
```

**内部实现**：
1. `exitAltScreen()` → `fullDraw()` 再次 → `CURSOR_HOME`
2. 显示恢复命令：
   ```
   会话已保存 (id: ${sessionId})
   deepseek-arch resume --id ${sessionId}
   ```

#### 文本工具

| 方法 | 实现 |
|------|------|
| `appendLine(text, color)` | `displayLines.push({ text, color })` |
| `colorize(text, color)` | 按 `LineColor` 选择 `chalk.green/gray/white` |
| `bgGray(text)` | `CSI 48;5;236m`（灰底） + text + `CSI 49m`（重置） |
| `charDisplayWidth(char)` | CJK 范围判断（8 个区间）→ 返回 2 或 1 |
| `strDisplayWidth(s)` | 遍历 `charDisplayWidth` 求和 |
| `wrapTextForInput(text, width)` | 按 charWidth 截断换行（保留 `\n` 自然换行） |
| `calcInputHeight()` | 基于 `wrapTextForInput` 的结果行数，上限 `MAX_INPUT_HEIGHT` |
| `calcCursorInInput(inputHeight)` | 从 `inputText[0..cursorPos]` 计算行列位置 |
| `renderInputLines(inputHeight)` | 调用 `wrapTextForInput` → 每行加 `> ` 前缀 → `bgGray` |
| `getVisibleLines()` | 从 `displayLines` 取最后 `termHeight - 5` 行 |

### 跨文件引用关系

```
chat-ui.ts
  ← node:readline           (readline.emitKeypressEvents)
  ← node:fs                 (writeSync)
  ← chalk                   (chalk.green, chalk.gray, chalk.white)
  ← ConfigManager           (import { ConfigManager })
  ← ApiClient               (import { ApiClient })
  ← Storage                 (import { Storage })
  ← SessionManager/StreamEvent (import { SessionManager, type StreamEvent })
  ← Throttle                (import { Throttle })
  ← types                   (import type { Message, ChatCompletionResponse })
  → 被 cli/index.ts 构造   (new ChatUI(config, sessionManager))
```

---

## 7. `src/cli/index.ts` — CLI 主程序（179 行）

**性质**：Commander.js 命令行入口，非类，纯函数。

### 常量

```typescript
VERSION = '0.4.0';
AUTHOR = 'helcksun';
RELEASE_DATE = '2026-05-18';
```

### 函数

#### `createProgram()`

```
签名: (): Command
```

**内部实现**：

1. `new Command()` — 配置 name / description / version / helpOption
2. 注册 `chat` 子命令：
   - `--title <name>` 选项
   - `.action()` → 读取 `ConfigManager` → `new ChatUI(config)` → `ui.start()`
3. 注册 `resume` 子命令：
   - `--id <id>` / `--name <name>` 选项
   - `.action()` → 读取 `ConfigManager` + `Storage`
   - **无参数**：`storage.listSessions()` 展示表格 → 用户输入序号 → 选择会话
   - **--id/--name**：`storage.getSession(id/name)` → 存在则继续，否则报错 `exit(1)`
   - 读取 `provider/model/apiKey` → `new ApiClient(...)` → `new SessionManager(storage, apiClient)` → `resumeSession(id)`
   - 读取 system prompt → `setSystemPrompt()`
   - `new ChatUI(config, sessionManager)` → `ui.start()`
4. 返回 `program`

#### `truncateTitle(title, maxWidth)`

```
签名: (title: string, maxWidth: number): string
```

**内部实现**：按 CJK 显示宽度截断，超宽时截断到 `maxWidth`。

#### `run()`

```
签名: async (): Promise<void>
```

**内部实现**：
```
const program = createProgram();
await program.parseAsync(process.argv);
```

### 跨文件引用关系

```
cli/index.ts
  ← commander              (import { Command })
  ← ConfigManager          (import { ConfigManager })
  ← chat-ui.ts             (动态 import)
  ← Storage / ApiClient / SessionManager (动态 import)
  ← chalk                  (动态 import)
  ← node:readline          (动态 import)
```

---

## 8. `src/index.ts` — 入口（11 行）

```typescript
import { run } from './cli/index.js';

run().catch((err) => {
  console.error('致命错误:', err.message);
  process.exit(1);
});
```

**跨文件引用**：→ `cli/index.ts`

---

## 9. `src/utils/event-loop.ts` — 事件循环让出（25 行）

### 函数 `yieldEventLoop()`

```
签名: (): Promise<void>
```

**实现**：`return new Promise<void>(resolve => setImmediate(resolve))`

作用：在 `for await` 循环中让出事件循环，使 timers（spinner）和 I/O（终端渲染）有机会执行。

### 跨文件引用

```
← session.ts  (import { yieldEventLoop })
```

---

## 10. `src/utils/throttle.ts` — 帧率节流（38 行）

### 类：`Throttle`

**构造函数**：`(fps = 60)`
- `intervalMs = Math.floor(1000 / fps)` — 例如 60fps → 16ms

**实例成员**：`lastTime: number`, `intervalMs: number`

| 方法 | 签名 | 实现 |
|------|------|------|
| `run(fn)` | `(fn: () => void): boolean` | `Date.now() - lastTime >= intervalMs` → 执行 fn + 更新 lastTime，返回 true；否则返回 false |
| `reset()` | `(): void` | `lastTime = 0`，下次 `run()` 必定执行 |

### 跨文件引用

```
← chat-ui.ts  (import { Throttle })
```

---

## 类间交互图（文本版）

```
                          ┌──────────────────────────┐
                          │      src/index.ts         │
                          │      (入口点)             │
                          │  run() → program.parse()  │
                          └──────────┬───────────────┘
                                     │
                          ┌──────────▼───────────────┐
                          │   src/cli/index.ts        │
                          │   createProgram()         │
                          │   run()                   │
                          │                           │
                          │   chat 子命令:            │
                          │     ConfigManager→load()  │
                          │     → ChatUI(config)      │
                          │     → ui.start()          │
                          │                           │
                          │   resume 子命令:          │
                          │     ConfigManager→load()  │
                          │     → Storage(sessionsDir)│
                          │     → listSessions()      │
                          │     → ApiClient(...)      │
                          │     → SessionManager(...) │
                          │     → resumeSession(id)   │
                          │     → ChatUI(config, mgr) │
                          │     → ui.start()          │
                          └──────────────────────────┘
                                     │
                   ┌─────────────────┼────────────────────┐
                   │                 │                    │
          ┌────────▼───────┐  ┌──────▼───────┐   ┌───────▼──────────┐
          │  ChatUI        │  │ ConfigManager │   │   命令行 stdout  │
          │  (1207 行)     │  │ (Singleton)   │   │   (console.log)  │
          │                │  │               │   └──────────────────┘
          │  组合对象：     │  │  get<T>       │
          │   Throttle      │  │  set<T>       │
          │   SessionManager│  │  reload()     │
          │   writeSync(1)  │  │  getSessionsDir│
          └───────┬────────┘  └───────┬───────┘
                  │                   │
                  │                   │  文件系统
                  │                   │  ~/.deepseek-arch/
                  │                   │  ├── config.toml
                  │                   │  ├── providers.toml
                  │                   │  ├── pricing.toml
                  │                   │  └── system-prompt.toml
                  │                   │
                  │    ┌──────────────▼──────────────┐
                  │    │     SessionManager           │
                  └───►│     (Facade)                 │
                       │                              │
                       │  startNewSession()           │
                       │  resumeSession()             │
                       │  sendMessage()               │
                       │  sendMessageStream()         │
                       │  buildMessages()             │
                       └──────┬──────────────┬───────┘
                              │              │
                     ┌────────▼───┐    ┌─────▼──────────┐
                     │  Storage   │    │  ApiClient      │
                     │(Repository)│    │  (Adapter)      │
                     │            │    │                 │
                     │  meta.json │    │  chat()         │
                     │  turns.json│    │  chatStream()   │
                     │  文件系统   │    │  fetch → API    │
                     └────────────┘    └─────┬──────────┘
                                             │
                                      DeepSeek API
                                     (HTTPS + SSE)
```

### 数据流路径（运行时）

```
用户键盘输入 →  process.stdin (raw mode)
  → ChatUI.handleKeyPress()
    → handleEnter()
      → sessionManager.sendMessageStream(text, onEvent, signal)
        → buildMessages()
        → apiClient.chatStream(messages, { signal, timeout, retries })
          → fetch POST → SSE reader
            → yield StreamChunk
          ← 增量 chunks
        → onEvent({ type, text })
      → ChatUI.handleStreamEvent(event)
        → drawStreamUpdate()
          → writeSync(1, ANSI)
        → stderr → 终端渲染
    → 流完成 → storage.saveTurn()
```

### 文件系统 I/O 路径

```
Storage.saveTurn(sessionId, ...)
  → 读 turns.json 或创建空数组
  → 清空历史 turns.usage
  → JSON.stringify([...turns, newTurn])
  → writeFile(turns.json)
  → readJSON(meta.json)
  → Object.assign(meta, { turnCount, totalCost, lastUsage })
  → writeFile(meta.json)
```

---

## 总结：当前架构的类间依赖

```
index.ts
  └→ cli/index.ts
       ├→ ConfigManager (Singleton)
       ├→ ChatUI ←┬→ Throttle
       │           ├→ ConfigManager (读取 API 配置)
       │           ├→ SessionManager ←┬→ Storage (Repository, 文件 I/O)
       │           │                   │
       │           │                   └→ ApiClient (Adapter, HTTPS/SSE)
       │           │                        │
       │           │                        └→ types.ts (ApiError)
       │           │
       │           └→ types.ts (Message, ChatCompletionResponse)
       │
       └→ Storage (临时，resume 子命令用)
            └→ types.ts
```

**核心依赖规则**：

1. `types.ts` → 零依赖，被所有模块引用
2. `utils/throttle.ts` → 零依赖
3. `utils/event-loop.ts` → 零依赖
4. `core/config.ts` → `types.ts`
5. `core/storage.ts` → `types.ts`
6. `core/api.ts` → `types.ts`
7. `core/session.ts` → `storage.ts + api.ts + event-loop.ts + types.ts`
8. `cli/chat-ui.ts` → `throttle.ts + ConfigManager + ApiClient + Storage + SessionManager + types.ts`
9. `cli/index.ts` → `ConfigManager + ChatUI(动态) + Storage/ApiClient/SessionManager(动态)`
10. **无循环依赖**
