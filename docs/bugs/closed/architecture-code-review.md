# 架构与代码设计审查 — SessionManager God Object、文档脱节、依赖环

> 🟡 **部分解决 2026-08-08（v1.3.9）——已解决项见下，剩余待办已转 [open-issues.md](./open-issues.md)**
> ✅ 已解决：
> - **C-1 修复后的内存/磁盘一致性**（`a7cc07c`）与**数据格式 v2**（`8bb24b7`，messages 恒存、删 turn/user/assistant）——缓解 storage 全量读写的结构性问题（原子写仍未做，见待办）
> - **storage.ts 头注释脱节**（`8bb24b7` 修正为 turns.json 单文件）
> - **getTermSize columns=0 崩溃**（`f886d71`）
> - **documentation 部分更新**：架构文档中工具数量/依赖描述已随各功能提交更新（architecture.md/module-interaction.md 仍有残留，见待办）
> ⏳ 剩余待办（详见 open-issues.md）：SessionManager 拆分、storage 原子写、StreamEvent 判别联合、setSubagentRunner 构造注入、PACKAGE_VERSION 注入、any 清理、setModel 收紧、文档脱节残留

**类型**: 架构审查（Architecture Review）
**发现日期**: 2026-08-06
**当前基线**: `main` @ `68acdb7`（HEAD）
**涉及文件**: `src/core/session.ts`、`src/core/storage.ts`、`src/core/config.ts`、`src/core/subagent.ts`、`src/tools/index.ts`、`src/tools/subagent-spawn.ts`、`src/types/chat.ts`、`src/cli/index.ts`、`docs/architecture.md`、`docs/module-interaction.md`

**健康度评分**: 6.5 / 10 —— 分层方向正确、依赖注入在 ApiClient/Storage 层面做得好，但 SessionManager 膨胀为 God Object，文档与实际代码严重脱节，存在隐式依赖环。

---

## 一、架构层面的问题

### P1. SessionManager 职责过载（God Object）

**位置**: `src/core/session.ts:67-1016`（全文件 1016 行）

**描述**: 单个类同时承担 8 类职责：
- 会话生命周期（startNewSession/resumeSession/setTitle）
- Agent Loop（sendMessageStream 主体）
- 消息构建与 KV-cache 回放（buildMessages）
- 工具调用累积（accumulateToolCalls:204-218）
- 子代理编排（runSubagent:174、PendingSubagent 接口:59-65、subagentStore 字段:74）
- 浏览器 URL 恢复（_restoreBrowserUrl:127-136、_browserLastUrl:223-231）
- 审查触发（import reviewConversation:18）
- 直接文件写入（startNewSession 写 system-prompt.txt:99-102）+ 缓存日志（appendCacheLog:17）

**影响**:
- 单一类依赖 8+ 模块，任何变更波及整个类
- Agent Loop 核心逻辑与持久化、UI 回调（15 种事件）、确认流程耦合在同一方法，难以单独测试
- 1016 行超出合理范围（建议 <400 行）

**重构建议**:
1. `AgentLoopEngine`：提取 sendMessageStream 循环主体（消息构建、tool_calls 累积、执行、round 记录），接收 `{ provider, tools, onEvent, onConfirm, signal }`
2. `SubagentCoordinator`：把 PendingSubagent 追踪、subagentStore 剥离
3. SessionManager 保留 Facade 职责（生命周期 + 编排）

### P2. 文档与代码严重脱节

**位置**: `docs/architecture.md:49,62`；`docs/module-interaction.md:28-83`；`src/tools/index.ts:70-116`；`src/core/storage.ts:1-13`

**描述**:
- `architecture.md:49` 宣称 "Tools 无内部依赖。无循环依赖"，实际注册 **30 个工具**（文档写 13 个），且 subagent-spawn 通过 `setSubagentRunner` 全局回调反向依赖 core 层
- `architecture.md:63` 标注 TokenCalculator 为 "Phase 7 ❌"，`session.ts:268` 注释仍写 "费用暂为 0"
- `module-interaction.md:28` 说类型在 `src/core/types.ts`（零依赖），实际已拆分到 `src/types/` 且 `types/chat.ts:6` import `../tools/types.js`
- `storage.ts:5-12` 头部注释宣称"每轮对话一个 JSON 文件 turn-001.json"，实际是**单个 turns.json 全量重写**（:32 `TURNS_FILE = 'turns.json'`，:231-264 saveTurn 读写整个数组）——注释与实现完全相反

**影响**: 文档失去可信度，新开发者按文档理解架构会得到错误模型。

### P3. 依赖方向倒置与隐式环

**位置**: `src/types/chat.ts:6`（types→tools）；`src/core/session.ts:37`（core→tools 静态 import）；`src/tools/subagent-spawn.ts:29`（setSubagentRunner 全局回调）

**描述**:
- `types/chat.ts` 的 `TurnRecord.tool_calls` 依赖 `tools/types.js` 的 `ToolCallRecord`——types 与 tools 双向依赖
- `session.ts` 静态 import `getAllTools`，而 `cli/index.ts:65` 把 `sessionMgr.runSubagent` 通过 `setSubagentRunner` 塞回 tools——编译期 core→tools、运行时 tools→core，环被回调注入掩盖

**影响**: 模块加载顺序敏感（模块级 ALL_TOOLS 在 import 时求值）；全局可变函数指针使测试必须 reset，否则跨测试污染。

**重构建议**: `ToolCallRecord` 上移到 types 层；subagent runner 改为构造注入（工具工厂函数），消除模块级全局可变状态。

### P4. 全局单例与可变全局状态偏多

**位置**: `src/core/config.ts:129`（单例）；`src/tools/index.ts:70`（模块级 ALL_TOOLS）；`src/tools/subagent-spawn.ts:29`、`src/tools/tui-capture.ts:33`（setXxx 函数指针）；`src/cli/index.ts:65`（注入点）

**描述**: ConfigManager 单例（含测试专用 resetInstance:148-150 类型 hack）、browser-state 全局单例、工具运行器模块级可变函数——与 MockProvider 的构造注入风格（mock-provider.ts:82）不一致。

**影响**: 测试隔离成本高；并行场景（多 SessionManager 实例）共享状态互相干扰。

### P5. Agent Loop 的 UI 通信协议过载（上帝事件）

**位置**: `src/types/chat.ts:84-125`（StreamEvent）

**描述**: 单个 `StreamEvent` 接口承载 15 种事件类型、20+ 可选字段——典型的 God Event 反模式，每次新增功能都往接口加字段。

**影响**: TUI 消费端需 switch 全部 15 种 type 且忽略大量无关字段；类型安全被稀释（字段全可选，误用不报错）。

**重构建议**: 拆分为判别联合（discriminated union）：`type StreamEvent = ReasoningDelta | ContentDelta | ToolCallStart | ToolCallResult | SubagentUpdate | …`。

---

## 二、代码层面的问题

### 🔴 严重

1. **storage.ts:231-264 saveTurn 全量读写 turns.json** — 每次 saveTurn 都 loadTurns（读全文件）+ 追加 + writeJSON（写全文件），长对话 O(n²) 写放大；read-modify-write 非原子，并发落盘会丢数据。storage.ts:291 updateLastTurn 同样先读后写。建议：增量追加或临时文件 + rename 原子替换，加写锁。

2. **session.ts:118 `this._restoreBrowserUrl(session);` 未 await** — fire-and-forget 异步，resume 后用户立即发消息时浏览器 URL 可能未恢复完成，产生竞态。应 await 或显式 catch。

3. **config.ts:171、storage.ts:74 `catch (err: any)` 后 `err?.code === 'ENOENT'`** — any 滥用 + 依赖隐式属性。应 `catch (err: unknown)` + `err instanceof Error && 'code' in err` 类型收窄。全仓库 `: any` 应清零。

4. **session.ts:150 `this.provider.setModel?.(model)`** — ModelProvider.setModel 是可选成员（model-provider.ts:36），provider 未实现时**静默失败**，/model 切换无反馈。应在接口强制实现或返回 boolean/抛错。

### 🟡 中等

5. **config.ts:199-206 连续 4 处 `as unknown as Record<string, unknown>`** — 强转绕过类型系统，常量本可直接声明为 Record 类型。

6. **config.ts:149 `ConfigManager.instance = undefined as unknown as ConfigManager`** — 测试专用 reset 用类型断言，运行时代码混入测试逻辑。改为 `private static instance: ConfigManager | undefined`。

7. **tools/types.ts:36 `parameters: Record<string, any>`** — 工具参数 schema 用 any，可收敛为 `Record<string, unknown>`。

8. **storage.ts:278 `return turn as unknown as TurnRecord`** — 手工构造对象再强转，绕过类型检查，应显式填充类型化对象。

9. **reviewer.ts:103-111 parseVerdict 文本 fallback 脆弱** — 多层 `includes` 关键词匹配（stalled/deflecting/asking/completed 靠分支顺序），且 fallback 默认 completed，审查失败时静默放行，与 YOLO 模式"严格"语义相悖。

10. **subagent.ts:78 tool_calls JSON 解析失败静默忽略** — `catch { /* ignore */ }` 后 args 保持 `{}`，工具以空参数执行且无日志。应把解析失败信息写入 tool result。

11. **mock-provider.ts:174 `new Promise(r => setTimeout(r, ...))`** — r 隐式 any，delay 无取消。

12. **cli/index.ts:35 `PACKAGE_VERSION = "1.3.7"` 硬编码** — 与 package.json 重复，发版易漂移。应从 package.json 读取或构建时注入。

13. **api.ts:205 `trimmed.startsWith('data: ')`** — 只匹配带空格的 SSE 格式，`data:{...}`（无空格）整行被跳过。解析应更宽容。

### 🟢 轻微

14. **storage.ts:118-121 getSession 修正 turnCount/totalCost 只改内存不写回** — 逻辑正确但冗余。
15. **storage.ts:135-172 getSessionByName / listSessions 顺序遍历所有会话目录逐个读 meta.json** — O(N) 次文件 IO，无索引缓存，会话多时 resume 列表慢。
16. **subagent-store.ts:7 注释"单线程下无竞态"表述易误导**；Map 以 name 为 key，同名子代理互相覆盖（需确认 spawn 是否保证唯一名）。
17. **session.ts:33 `export type { StreamEvent }` 向后兼容 re-export** — 类型迁移遗留垃圾，清理期可删。
18. **docs/module-interaction.md 目录结构（:9-24）与实际 src/ 完全不符** — 仍停留在 chat-ui.ts 时代。

---

## 三、推荐重构清单

| 优先级 | 重构项 | 涉及文件 | 预估收益 |
|:---|:---|:---|:---|
| P0 | 拆分 SessionManager：提取 AgentLoopEngine + SubagentCoordinator | src/core/session.ts（1016 行→~300 行） | 可测试性、可维护性大幅提升 |
| P0 | storage 并发写 + 原子写（临时文件 rename），saveTurn 增量追加 | src/core/storage.ts | 消除数据丢失风险与 O(n²) 写放大 |
| P1 | StreamEvent 改判别联合 | src/types/chat.ts + cli/tui/app.ts | 类型安全回归，消费端简化 |
| P1 | 消除模块级全局回调（setSubagentRunner/setCaptureFn → 构造注入） | src/tools/subagent-spawn.ts、tui-capture.ts、cli/index.ts | 测试隔离，去掉隐式环 |
| P1 | 修 session.ts:118 未 await 的 _restoreBrowserUrl | src/core/session.ts | 消除 resume 竞态 |
| P2 | types/tools 依赖倒置修正：ToolCallRecord 上移 types 层 | src/types/chat.ts、src/tools/types.ts | 恢复"types 零依赖"宣称 |
| P2 | 清理 any：config.ts:171/199-206、storage.ts:74、tools/types.ts:36、mock-provider.ts:174 | 多处 | 类型严谨性 |
| P2 | setModel 可选性收紧或失败显式化 | src/core/model-provider.ts、session.ts:150 | 消除静默失败 |
| P3 | 更新 architecture.md/module-interaction.md/storage.ts 头注释，工具数量 13→30 | docs/ + storage.ts:1-13 | 文档可信度 |
| P3 | PACKAGE_VERSION 从 package.json 注入 | src/cli/index.ts:35 | 消除版本漂移 |
| P3 | reviewer fallback 简化（正则或结构化输出优先） | src/core/reviewer.ts:103-112 | 减少误判 |

---

## 四、做得好的地方

1. **ModelProvider 抽象 + MockProvider 双实现** — 接口小、语义清晰，测试通过构造注入即可，是全局单例乱局中的亮点。
2. **ApiClient 构造注入** — baseUrl/apiKey/model 外部传入，与 ConfigManager 完全解耦。
3. **流式请求健壮性**（api.ts:118-252）— 超时 + 外部 signal 转发 + 4xx 不重试/5xx 指数退避 + 每次尝试独立 controller。
4. **Barrel file 工具注册模式**（tools/index.ts）— 新增工具一行 export，按主代理/子代理/self-interaction 分组过滤，扩展成本极低。
5. **子代理循环独立成 runSubagentLoop**（subagent.ts:18-104）— 不依赖 SessionManager，任何 ModelProvider 可驱动，是拆分 Agent Loop 的正面范例。
6. **文件权限与原子性意识**（storage.ts:83 writeJSON mode 0o600、config.ts:180/:157 mkdir 0o700）— 敏感数据权限到位。
7. **KV-cache 命中优先的持久化设计** — 把"精确回放消息前缀"作为一等公民设计。
8. **文档体系完整**（architecture.md、module-interaction.md、docs/todo、docs/bugs）— 虽已过时，但"先文档后代码"文化少见。

---

## 关联文档

- [subagent-merge-regression.md](./subagent-merge-regression.md) — SessionManager 内 subagent 编排层的具体功能回退（M-1~M-7）
- [prompt-review.md](./prompt-review.md) — 提示词体系问题（含 agent loop 轮次上限死代码）
