# Memory 未做项 / 挂起项（TODO）

> 来源：`plan/memory-heartbeat-design.md` 评审 A1–A8 与实现收尾（2026-09-13）。
> 状态约定：**挂起** = 已决定暂不做（不阻塞当前工作）；**待定** = 需要用户决策后再做；**已做** = 直接从表中可见（保留行以存档判断依据）。
> 实现现状见设计稿 v2 §12；每条都标了设计依据与落地位置，可直接开工。
> A3 已按"淘汰过时记忆"的缺口拆为 A3a（已做）/ A3b（可选 GC）/ A3c（不做：连续衰减）/ A3d（不做：主动出示）。

---

## A 组：评审提出但暂缓的澄清项

| ID | 事项 | 现状（已实现） | 挂起原因 | 落地位置 / 工作量 |
|:--|:--|:--|:--|:--|
| **A2** | 写入提示通道：StreamEvent `memory_updated` | 用 `SessionManager.setMemoryNoticeCallback` + TUI 一行 dim + headless stderr | 回调方案更简单且已够用；事件化的收益（外部订阅）当前无消费者 | `types/chat.ts` + `session.ts` 事件泵；S |
| **A3a** | ✅ **已做（2026-09-13）**：淘汰过时记忆 —— 归纳代理 `memory_forget` 工具 + 软淘汰（`confidence: 1`）+ 提示词"时效与清理"规则 | `src/tools/memory-forget.ts`（`confidence: 3` 拒绝、每轮上限 3 条、不计写入配额）、`memory-agent.ts` 工具集与配额、`memory-agent-prompt.ts` 规则表；测试 `tests/tools/memory-forget.test.ts`(6) + `tests/core/memory-agent.test.ts`(+3) | 起因：**"静默失效"（没人再提且未被推翻）原本无任何淘汰路径** —— 先前判"无消费者"不准确：原设计的消费者（打分 + fold）被废弃了，而淘汰本身需要有落点，落点就在"归纳时顺带判断" | — |
| **A3b** | 确定性 GC：`/memory gc` 归档「长期未 `memory_read`、注入多次仍未被读、confidence ≤2」的条目到 `legacy/archive/` | 无使用追踪（`markRead`/`surfaced` 只在内存里） | 需要把「最后被读时间 / 读次数」持久化进 `state.json`（信号已有：`session.ts` 的 `collectReadMemorySlugs()` 会扫 turn 里的 `memory_read` 调用），再加低频执行时机（会话创建时或手动命令）。**当前不做**：A3a 已覆盖主观清理，GC 属"无人管时的兜底" | `memory-store.ts`（state 扩展 + `archive()`）、`memory-inject.ts`（写回）、`tui-app.ts`（`/memory gc`）；M |
| **A3c** | 连续数值衰减（半衰期 `0.5^(Δdays/180)`） | 未实现 | **不做**：可见性随日期漂移无法解释、无用户可感知收益；改用离散档位（3→2→1→候选池→superseded），每次动作落 `audit.jsonl` 可审计 | — |
| **A3d** | 会话内"主动出示条目全文" | 未实现（只出示清单与变化提醒） | 每轮多一次 LLM 调用或引入打分噪声，收益边际；`memory_read` 已提供按需通道 | `memory-inject.ts` + `memory-recall.ts`；M–L |
| **A4** | `logs/yyyy/mm/dd.md` 每日日志写入 | `MemoryStore.appendLog()` 已实现但**无调用方** | 归纳的可审计性已由 `audit.jsonl` 的 `agent_run.notes` 承担；再写一份原始日志属重复 | `memory-agent.ts` 在 run 结束追加；S |
| **A5** | CLI/命令面缺口：`--memory-scope`、`--memory-model`、`--quiet`、`/memory show --scope\|--limit\|--audit`、`/memory agent on\|off`、`/memory pin\|unpin` | 未实现 | 多数是调试/便利功能；`--quiet`/`--json` 与实际心跳契约绑定（见 A6） | `cli/index.ts`、`tui-app.ts`、`memory-store.ts`（pin 需加字段）；S–M |
| **A6** | `chat --prompt` 契约不一致：文档写 `--json`、退出码 0/1/2/3、`--session <name>`、`--timeout`、工具白名单 | 实现：stdout 纯文本、退出码 0/1、`--resume`、yolo 直接放行 | 心跳未开工，契约等心跳一起定更省事（见 §心跳） | `cli/index.ts` `runPromptOnce`；M |
| **A7** | 跨层去重未分层：`seen`/`surfaced` 按 slug 全局去重 | 项目层与全局层同 slug（同主题）时"已见/已出示"互相影响 | 需要决定键的形态（`scope:slug` vs 分开两张表），属小改但会影响注入内容 | `memory-inject.ts`（键改 `${scope}:${slug}`）；S |
| **A8** | `agent_max_tokens` 独立配置 | 实现用 `maxInputTokens × 3`（18000）作为运行 token 上限 | 独立字段收益不大；如需精细化再补 | `config.ts` + `memory-agent.ts`；S |

## B 组：实现阶段发现、明确不做的（已写进设计稿 v2 §13 废弃清单）

| ID | 事项 | 不做理由 |
|:--|:--|:--|
| **B1** | JSONL 单文件存储 + fold 折叠 | 可读性/可 git/一主题一文件更好；agent 项目层可直接 `read_file` |
| **B2** | `memory_search` 工具 | 清单整份注入已提供发现通道；全局层改由 `memory_read` 覆盖 |
| **B3** | 相似度阈值去重（Jaccard/阈值/冲突打分） | 清单前置 + 模型判断 + 三条确定性规则已足够，代码量降一个数量级 |
| **B4** | 确定性打分公式（权重 0.45/0.25/…） | 召回交给 flash；公式无消费者 |
| **B5** | reviewer（censor agent）/ YOLO 审查自动续答 | 用户决定删除（A1，已落地） |

## C 组：与心跳相关（等心跳开工时一起处理）

| ID | 事项 | 说明 |
|:--|:--|:--|
| **C1** | 心跳载体契约（`--session`/`--timeout`/`--json`/退出码） | 见 A6；心跳的 systemd/cron 示例依赖它 |
| **C2** | 心跳形态：cron/systemd 调 `chat --prompt`（主）+ TUI 内定时器（备） | 用户已定方向，细节（间隔、与用户输入冲突、token 预算）待定 |
| **C3** | 心跳与 memory 的配合：`remindAt` 到期在无人值守时如何呈现 | 当前到期提醒只在"用户发消息那一轮"注入；心跳可承担"主动唤起" |

---

## 维护提示

- 本文件只登记**已明确暂缓**的事项；不要在此堆想法，想法放 `plan/`。
- 任何一项开工前，先在 `plan/memory-heartbeat-design.md` 对应章节写清最终方案，再改代码（避免"文档与实现漂移"重演）。
