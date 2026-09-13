# Goal 工具设计文档 — 长程任务目标锚定

> 状态：**设计稿（未实现）**
> 日期：2026-08-20
> 分支：feat/api-config-and-docs-sync（仅文档，无代码）
> ⚠️ **前提已失效（2026-09-13）**：本文依赖的 reviewer（censor agent）已随 YOLO 审查机制一并移除
> （见 `plan/memory-heartbeat-design.md` A1）。若日后重启该设计，需先确定新的锚点（agent loop 自然终止处的其它钩子）。
>
> 原目标：为"长程任务不偏离目标"提供机制设计，含 goal × reviewer 配合方案、compact 集成、prompt 影响面分析。

---

## 一、问题陈述

当前系统缺少**跨轮次目标追踪**能力：

| 现状 | 证据 |
|---|---|
| plan skill 是一次性规划（确认后执行），执行中无"目标回看"机制 | `skill/plan.skill.md`：Phase 3 执行循环不引用 Phase 0 目标 |
| compact 摘要类别含"用户目标"但**被动**——只从对话推断，无结构化目标源 | `compact.ts:297-312` SUMMARY_PROMPT 类别 1 |
| YOLO 审查器（reviewer）判定 completed/stalled/deflecting/asking_user，**无目标感知**——模型输出与目标无关时被判 completed | `reviewer.ts:13-33` REVIEW_SYSTEM_PROMPT |
| 子代理 prompt 无目标注入，子代理可能偏离主任务方向 | `session.ts:55-66` SUBAGENT_APPEND_PROMPT |

**后果**：长任务（多轮、多工具、多子代理）中模型可能逐渐漂移——完成无关工作、重复已做步骤、忘记用户核心诉求。现有机制无法自动检测或回拉。

---

## 二、设计目标与原则

1. **目标可设、可查、可更新**：用户（或模型经确认）设定当前目标；模型可随时查看；目标变化时更新。
2. **低侵入**：不改变现有消息流（buildMessages 追加状态块，前缀稳定保 KV-cache）。
3. **reviewer 闭环**：YOLO 审查输入增加 goal，判定"偏离目标"并自动回拉。
4. **compact 集成**：compact 摘要保留/引用 goal，压缩后目标不丢。
5. **向后兼容**：goal 未设置时所有行为与现状完全一致。

**明确不做**（本期）：
- 不做复杂目标树/子目标分解（plan skill 已承担任务拆解）
- 不做跨会话目标持久化（goal 是会话级；跨会话由 memory 机制草案承载，见 `plan/memory-mechanism.md`）
- 不做 goal 自动推导（只接受显式设定）

---

## 三、核心概念

| 概念 | 定义 |
|---|---|
| **Goal（目标）** | 会话级单条目标声明（文本 + 可选验收标准），描述"用户最终要什么" |
| **goal 工具** | 模型可调用的工具：`goal set` / `goal show` / `goal clear`（主代理可见，子代理只读） |
| **[Current Goal] 状态块** | buildMessages 注入的消息块（仿 `[Subagent Status]` 模式，session.ts:492-520），每轮请求可见 |
| **off_target 判定** | reviewer 新增第 5 类判决：模型回复与 Current Goal 无关/未推进 |

---

## 四、数据流全景图

```
用户："/goal 重构 session 模块，保持对外接口不变"
        │
        ▼
   TUI /goal 命令 ──► ConfigManager? 否，会话级 ──► SessionManager.setGoal(text)
        │                                              │
        │                                    goal 存 SessionMeta.goal（meta.json 持久化）
        ▼                                              ▼
   buildMessages()  ──────────────►  消息队列末尾追加 [Current Goal] 块
                                              │
        ◄─────────────────────────────────────┤
        │   每轮请求 model 都能看到当前目标     │
        ▼                                     │
   agent loop 自然终止 ──► reviewer 审查 ──────┤
        │                    输入：recentUserInputs + modelReply + Current Goal
        │                    判定：completed / stalled / deflecting / asking_user / off_target
        │                                          │
        │                              off_target → 注入 [auto-continue] 纠正提示回拉
        ▼                                          ▼
   compactContext() ──► SUMMARY_PROMPT 类别"用户目标"引用 goal
                          compact 后 [Current Goal] 状态块自动重建（不随分代丢弃）
```

---

## 五、接口与数据格式设计

### 5.1 数据模型

```typescript
// SessionMeta 扩展（types/session.ts）
interface SessionMeta {
  // ...现有字段
  /** 会话级当前目标（goal 工具/命令设定，compact 后保留） */
  goal?: string;
}
```

- 存 `meta.json` 的 `goal` 字段（storage.ts `createSession`/`updateMeta` 天然支持，无需新文件）
- 会话级、单条、文本格式（≤ 2000 字符，超长截断）

### 5.2 goal 工具定义（src/tools/goal.ts，主代理工具集）

```typescript
export const goalTool: Tool = {
  name: 'goal',
  description:
    'Manage the session goal (long-running task anchor). ' +
    'Operations: set <text> — record/update the current goal; ' +
    'show — display the current goal; clear — remove it. ' +
    'Use set at the start of long tasks, and check periodically to stay on target.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'show', 'clear'], description: 'Operation' },
      text: { type: 'string', description: 'Goal text (required for set)' },
    },
    required: ['action'],
  },
  requiresConfirm: false,
  async execute(params): Promise<ToolResult> { /* 经 SessionManager 读写 */ },
};
```

- `goal set` 需用户确认？——**建议 requiresConfirm: true**（目标锚定影响后续所有行为，模型不应擅自设目标）；`show`/`clear` 无需确认（clear 也可确认）
- 工具注册：`tools/index.ts` ALL_TOOLS 添加（主代理）；SUBAGENT_TOOLS **不添加**（子代理只读目标，见 §七）

### 5.3 注入时机：buildMessages 状态块

仿 `[Subagent Status — async mode]`（session.ts:492-520）模式，在 `buildMessages()`（session.ts:1282）返回前追加：

```
[Current Goal]
<goal 文本>

（无 goal 时不注入该块，保持前缀不变）
```

- **位置**：消息队列末尾（当前用户消息之后），每轮重建——与 statusBlock 同模式，**不写入 agentMessages**，保证 KV-cache 前缀稳定
- 无 goal 时零成本（不产生额外消息）

---

## 六、goal × reviewer（censor agent）配合方案 ⭐

> 用户确认的核心方案：审查输入除用户输入外，增加 goal 输入。

### 6.1 reviewer 签名扩展（reviewer.ts:47-52）

```typescript
export async function reviewConversation(
  recentUserInputs: string[],
  modelReply: string,
  provider: ModelProvider,
  reviewModelName?: string,
  goal?: string,          // ← 新增：当前会话目标（可选）
): Promise<{ verdict: ReviewVerdict; reason: string }>
```

- `goal` 为可选参数；未传时行为与现状完全一致（向后兼容）
- 传入时，content 增加 `## Current Goal` 段（在 Recent User Inputs 之后）

### 6.2 REVIEW_SYSTEM_PROMPT 扩展（reviewer.ts:13-33）

新增第 5 类判决：

```
5. **off_target** — The assistant's response does not advance the Current Goal,
   or addresses a different topic entirely. Examples: working on unrelated files,
   repeating already-completed steps, drifting into side quests when the goal
   is clear. If no Current Goal is provided, never classify as off_target.
```

同时补充判例区分（与 deflecting/asking_user 的边界）：
- "完成了目标之外的 X 功能" → **off_target**
- "我需要你确认范围"（目标模糊时）→ **asking_user**
- "我不能执行，你自己跑" → **deflecting**

### 6.3 判决类型扩展（types/chat.ts:80）

```typescript
export type ReviewVerdict = 'completed' | 'stalled' | 'deflecting' | 'asking_user' | 'off_target';
```

### 6.4 session 调用点（session.ts:813-850）

```typescript
const { verdict, reason } = await reviewConversation(
  recentInputs,
  roundContent,
  this.provider,
  reviewModelName,
  this.session?.meta.goal,   // ← 传入当前目标
);
```

- `off_target` 与 stalled/deflecting 同等触发 auto-continue（`autoContinueCount < MAX_AUTO_CONTINUE`），注入纠正提示：

```
[auto-continue] 你偏离了当前目标「<goal 摘要>」。请回到目标轨道，
仅完成与目标相关的操作。若目标已无法达成或需要调整，请说明原因。
```

### 6.5 影响面

| 文件 | 改动 |
|---|---|
| `types/chat.ts` | ReviewVerdict 联合类型 + 'off_target' |
| `reviewer.ts` | 签名（goal 参数）、REVIEW_SYSTEM_PROMPT（第 5 类 + 判例）、parseVerdict（'off_target' 关键词匹配） |
| `session.ts` | 审查调用点传 goal；auto-continue 分支处理 off_target |
| `tests/core/session.test.ts` | reviewer 相关测试补 off_target 用例 |

---

## 七、对 prompt 的影响面分析

### 7.1 system_prompt.txt（项目根）

- **不改模板本身**：goal 状态块由 session 注入，不需要在 system_prompt.txt 写死
- 可选（文档层面）：Task Execution 板块增加"长任务先设目标、定期回看"指引——属于行为规则增强，建议实现 goal 工具后同步更新

### 7.2 plan skill（skill/plan.skill.md）

- Phase 0 增加："若会话已有 [Current Goal]，规划必须与目标对齐；目标冲突时先向用户确认"
- 规划输出（Phase 2B）可引用目标："本计划服务于目标：<goal>"

### 7.3 compact skill 与 compact.ts

| 位置 | 改动 |
|---|---|
| `compact.ts` SUMMARY_PROMPT（:297-312） | 类别 1"用户目标"改为："若会话有显式 goal（[Current Goal]），**原文引用**；否则从对话推断用户最初目标" |
| `compact.ts` buildCompactMessages（:360-379） | 摘要消息后追加 `[Compact Goal]` 块（goal 原文），确保 compact 后目标不丢 |
| `.plans/compact.md` | 文档同步：Phase 2 摘要类别表"用户目标"行加"引用 [Current Goal]" |

### 7.4 SUBAGENT_APPEND_PROMPT（session.ts:55-66）

- 子代理 **不持有 goal 工具**（防子代理改目标），但**应看到目标**：
  - 方案 A（推荐）：`runSubagent()`（session.ts:264）拼 prompt 时，若 session 有 goal，在 SUBAGENT_APPEND_PROMPT 后追加：

    ```
    ## Session Goal
    主代理当前目标：<goal>
    你的子任务应服务于该目标。如果任务指令与目标冲突，按任务指令执行并在结果中说明冲突。
    ```

  - 方案 B：子代理消息队列注入 `[Current Goal]` user 消息（改动 runSubagentLoop 消息构造）
- 方案 A 更简单（纯字符串拼接，不动 subagent.ts 循环逻辑），推荐

### 7.5 skill listing（cli/index.ts:86-94）

- goal 不增加新 skill（是工具不是技能）；若未来做"目标分解技能"再考虑

---

## 八、关键取舍

| 决策点 | 方案 A | 方案 B | 推荐 | 理由 |
|---|---|---|---|---|
| goal 存储 | SessionMeta.goal（meta.json） | 独立 goal.json 文件 | **A** | meta.json 已随会话持久化，`updateMeta` 现成，零新增文件 |
| goal 工具确认 | set 需确认 | 全部免确认 | **set 需确认** | 目标锚定影响后续行为，防模型擅自改写 |
| 子代理目标注入 | prompt 拼接 | 消息队列注入 | **A** | 不动 subagent.ts 循环，改动最小 |
| reviewer 集成 | 同步扩展现有 reviewer | 新建独立 censor agent | **扩展现有** | 用户确认"和 censor agent 配合"即现有 YOLO 审查器；新建代理成本高、无收益 |
| 注入位置 | 消息末尾状态块 | system prompt 动态拼 | **消息末尾** | 前缀稳定（KV-cache），与 [Subagent Status] 同模式 |

---

## 九、范围与分期

| 阶段 | 内容 | 工作量 |
|---|---|---|
| **M1 基础设施** | SessionMeta.goal + SessionManager setGoal/getGoal/clearGoal + meta.json 持久化 | 🟢 小 |
| **M2 goal 工具** | src/tools/goal.ts + barrel 注册 + TUI `/goal` 命令 + [Current Goal] 状态块注入 | 🟡 中 |
| **M3 reviewer 集成** | ReviewVerdict + off_target + reviewer 签名/prompt/parse + session 调用点 + auto-continue 回拉 | 🟡 中 |
| **M4 compact 集成** | SUMMARY_PROMPT 类别更新 + [Compact Goal] 重注入块 + .plans/compact.md 文档 | 🟢 小 |
| **M5 子代理目标** | SUBAGENT_APPEND_PROMPT 拼接目标段 | 🟢 小 |
| **M6 文档** | plan skill / system_prompt.txt 行为规则更新 + 测试 | 🟢 小 |

建议顺序：M1 → M2 → M3（闭环先跑通）→ M4 → M5 → M6。

---

## 十、风险与缓解

| 风险 | 缓解 |
|---|---|
| goal 注入污染 KV-cache 前缀 | 固定 `[Current Goal]` 前缀 + 无 goal 不注入 + 不写 agentMessages |
| reviewer 误判 off_target（模型被错误回拉） | goal 为空不判 off_target；MAX_AUTO_CONTINUE=3 防无限循环；reason 供用户查看 |
| 模型擅自 set goal | requiresConfirm: true，用户确认后才写入 |
| goal 与用户即时指令冲突 | prompt 指引"即时指令优先于目标，但需说明"；用户可随时 /goal clear |
| 子代理看到目标但任务冲突 | 方案 A 文本注明"任务指令优先，冲突时说明" |
| compact 后 goal 丢失 | [Compact Goal] 块 + meta.json.goal 双保险（meta 不受分代影响） |

---

## 十一、相关文件清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `src/types/session.ts` | 核心 | SessionMeta.goal |
| `src/core/session.ts` | 核心 | setGoal/getGoal/clearGoal、buildMessages 注入、runSubagent prompt 拼接、reviewer 调用点 |
| `src/tools/goal.ts` | 新文件 | goal 工具 |
| `src/tools/index.ts` | 工具 | ALL_TOOLS 注册 goal |
| `src/presentation/tui-app.ts` | TUI | /goal 命令、/context 显示目标 |
| `src/types/chat.ts` | 类型 | ReviewVerdict + 'off_target' |
| `src/core/reviewer.ts` | 核心 | 签名 + prompt + parseVerdict |
| `src/core/compact.ts` | 核心 | SUMMARY_PROMPT + buildCompactMessages |
| `.plans/compact.md` | 文档 | 类别表更新 |
| `skill/plan.skill.md` | 文档 | Phase 0/2B 目标对齐指引 |
| `system_prompt.txt` | 文档 | 行为规则增强（可选） |
| `tests/core/session.test.ts` | 测试 | off_target / goal 持久化 / 子代理 prompt |

---

## 十二、验收标准（实现时）

1. `/goal 目标文本` 后，`~/.deepseek-arch/sessions/<id>/meta.json` 出现 goal 字段；resume 后仍可见
2. 设置 goal 后，下轮请求消息末尾出现 `[Current Goal]` 块；未设置时不出现
3. mock 模式下触发 YOLO 审查，模型回复与 goal 无关 → 判决 off_target → 注入 [auto-continue] 回拉
4. compact 后 meta.json.goal 保留，摘要含 [Compact Goal] 块
5. 子代理 system prompt 尾部出现 `## Session Goal` 段
6. 全量测试通过；goal 未设置时 reviewer 行为与现状完全一致（回归验证）
