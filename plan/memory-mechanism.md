# Long-Term Memory 机制 — 方案设计（草案）

> 状态：规划中（未实现）
> 日期：2026-08-08
> 背景：基于 2026-08-07/08 子代理 + TUI 重构会话中的用户偏好信号设计

---

## 一、总览

**目标**：让 agent 跨会话记住用户偏好与工作习惯，随对话累积而自动更新，在相关任务时自动注入，提升个性化体验。

**核心问题**：
- 当前 agent 每次会话从零开始（system prompt + 历史 turns），**不记得用户"喜欢紧凑展示、先讨论再动手、复用现有机制"这类偏好**
- 用户需要在每次会话重复表达偏好，或 agent 重复犯同样的错误
- 现有 `.deepseek-arch/memory/*.md` 是人工会话记忆（记录"本次做了什么"），非机器可消费的偏好库

**范围**：不做通用对话记忆（turns.json 已承担），只做**可注入、可更新、可过期的偏好/知识记忆**。

---

## 二、Memory 分类

| 类别 | 内容 | 示例（本仓库真实信号） |
|:--|:--|:--|
| `ui` | 界面展示/交互偏好 | 紧凑工具行（● run）、think 折叠可展开、键盘导航浏览、流式期间可编辑 |
| `workflow` | 工作流/协作节奏 | 先讨论方案→确认→再执行、渐进式交付 + tag、验收标准明确 |
| `design` | 设计原则/技术取向 | 复用现有机制、反对过度设计、关注内存/性能边界、持久化优先 |
| `priority` | 优先级/暂缓/提醒 | "提示词体系先不动，事后提醒"（可过期 + remindAt） |
| `domain` | 领域知识/项目约定 | 技术栈、目录约定、文档归档习惯 |

---

## 三、触发机制（谁在何时写）

### 3.1 Main Agent（实时，对话中）

主 agent 在 `sendMessageStream` 的事件流/工具调用中识别信号，**立即写入 memory**：

| 信号 | 识别方式 | 置信度 |
|:--|:--|:--|
| A. 显式偏好陈述 | 用户以"我希望/我喜欢/不要/以后/应该"开头 | 3（高） |
| B. 否决/纠正 | 用户否定 agent 做法并给出替代方案 | 2（中） |
| C. 决策确认 | 用户确认方案后进入执行（"开始"/"按你说的做"） | 2 |
| D. 范围/边界声明 | 用户划界限（"X 先不动"）→ 暂缓项 + remindAt | 3 |
| E. 显式放弃 | 用户主动放弃某方案（"放弃磁盘写入策略优化"） | 3 |
| F. 重复模式（隐式） | 同一偏好出现 ≥2 次 → 打标累计，阈值触发归纳 | 1（低，交 memory agent） |

**实现方式**（可选其一）：
- **轻量**：`sendMessageStream` 的 onEvent 回调加偏好识别钩子（正则 + 关键词）
- **模型化**：由 YOLO 审查模型（`reviewer.ts` 已有）在轮次结束时判断"本轮是否有可记忆偏好"

### 3.2 Memory Agent（离线/异步，维护）

| 触发点 | 职责 |
|:--|:--|
| G. 会话结束归纳 | 扫描本轮 turns，提炼 1-3 条高价值偏好（去重、定级） |
| H. 跨会话模式检测 | 对比新偏好与历史 → 重复提升置信度、冲突标记 |
| I. 冲突调和 | 新旧矛盾时保留最新 + 记录演化（如"先详细后紧凑"） |
| J. 相关性选择 | 新会话/新任务开始时注入 top-K 相关条目 |
| K. 时效管理 | 处理暂缓项到期（remindAt）→ 主动提醒用户 |
| L. 衰减清理 | 低频/被推翻的偏好降权或删除 |

**实现方式**：会话结束（done 事件后）异步 spawn 一个 memory agent（复用 `subagent.ts` 的 `runSubagentLoop`），给受限工具集（只读写 memory 存储），返回归纳结果。

---

## 四、数据结构

```typescript
interface MemoryEntry {
  id: string;                    // uuid
  category: 'ui' | 'workflow' | 'design' | 'priority' | 'domain';
  content: string;               // 偏好本体（一句话，注入时直接可用）
  signal: 'explicit' | 'correction' | 'confirmation' | 'pattern';
  confidence: 1 | 2 | 3;         // 3=明说 2=纠正/确认 1=模式观察
  context: string;               // 触发时对话摘要（溯源）
  sourceTurnId: string;          // 来源轮次（可回查）
  createdAt: string;
  updatedAt: string;
  ttl?: number;                  // 过期时间戳（暂缓项）
  remindAt?: string;             // 提醒时间（如 v1.4.0 发布）
  tags: string[];                // 相关性检索用
  lastUsedAt?: string;           // 最近注入时间（衰减用）
  useCount: number;              // 注入次数
}
```

---

## 五、存储

- **路径**：`~/.deepseek-arch/memory/preferences.json`（单文件，参照 turns.json 全量读写；量小无性能问题）
- **格式**：`MemoryEntry[]`，按 `updatedAt` 排序
- **权限**：`0o600`（敏感偏好，同 storage.ts 约定）
- **可选版本**：`version: 1` 字段，便于未来迁移
- **当前 `.deepseek-arch/memory/*.md`**（人工会话记录）保留，两者职责分离：md 是"过程记录"，json 是"机器偏好库"

---

## 六、注入时机（memory 如何影响行为）

| 时机 | 注入内容 | 效果 |
|:--|:--|:--|
| 新会话构建 system prompt | 按任务相关性注入 top-K（3-5 条） | agent 一开始就记得用户偏好 |
| 工具调用前 | `ui` 类偏好 → 渲染参数 | 如 compact 模式、● run 圆点 |
| 任务开始 | `workflow` 类 → 流程选择 | 如"先规划"→ 激活 plan_on |
| 决策点 | `design` 类 → 方案否决 | 如"复用现有机制"→ 否决临时文件 |
| 里程碑/版本发布 | `priority` 类 remindAt 触发 | agent 主动提醒"暂缓的 X 该处理了" |

**注入格式**：system prompt 追加一段 `<memory>` 块（纯文本，稳定前缀保证 KV-cache 友好，参照 `[Subagent Status]` 的做法）。

---

## 七、与现有架构的整合点

| 现有模块 | 整合方式 |
|:--|:--|
| `src/core/config.ts` | 配置 memory 文件路径、注入条数上限、置信度阈值 |
| `src/core/session.ts` | `sendMessageStream` 加偏好识别钩子（onEvent 或 done 后） |
| `src/core/subagent.ts` | 复用 `runSubagentLoop` 作为 memory agent 引擎 |
| `src/core/reviewer.ts` | 复用审查模型做"是否有可记忆偏好"判断（可选） |
| `src/core/storage.ts` | 复用 writeJSON 模式（或顺带做原子写） |
| `src/cli/tui/app.ts` | 新会话 header 显示 memory 注入条数（可选） |

---

## 八、里程碑（粗略）

| 阶段 | 内容 | 工作量 |
|:--|:--|:--|
| **M1 基础设施** | preferences.json 存储 + CRUD + 配置项 | 🟢 小 |
| **M2 实时触发** | main agent 识别 A-E 信号 → 写 memory（关键词/正则版） | 🟡 中 |
| **M3 注入** | 新会话 system prompt 注入 top-K + `<memory>` 块 | 🟢 小 |
| **M4 memory agent** | 会话结束归纳（G/H/I）+ 相关性选择（J） | 🟡 中 |
| **M5 时效与提醒** | 暂缓项 remindAt 到期提醒（K）+ 衰减（L） | 🟢 小 |
| **M6 模型化识别** | 用 review 模型做偏好判断（替代正则，可选） | 🟡 中 |

建议顺序：M1 → M2 → M3（先跑通闭环）→ M4 → M5 → M6。

---

## 九、风险与权衡

| 风险 | 缓解 |
|:--|:--|
| 偏好注入污染上下文（KV-cache 失效） | 固定 `<memory>` 前缀 + 只注入相关条目（top-K） |
| 错误偏好固化（agent 记错） | 置信度分级 + 用户可 `/memory` 查看/删除 + 冲突调和 |
| memory agent 归纳质量不可控 | 复用主模型 + 受限工具集 + 输出格式约束 |
| 隐私（偏好可能敏感） | 本地存储 0o600，不进 turns.json 之外的其他位置 |
| 注入导致行为偏差（用户未明确要的偏好生效） | 只注入 confidence ≥2 的条目；weak 仅作参考标记 |

---

## 十、待确认问题

1. memory 的写入是否**默认开启**，还是需要用户 `/memory on` 显式开启？
2. 偏好注入的条数上限（3 / 5 / 8 条）与相关性算法（tag 匹配 / 分类匹配 / 全量最近）？
3. memory agent 用主模型（深 think）还是 flash（便宜）？
4. 是否需要 UI：`/memory` 命令查看/删除偏好、Ctrl+M 查看注入结果？
