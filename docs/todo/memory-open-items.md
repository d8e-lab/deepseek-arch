# Memory 未做项 / 挂起项（TODO）

> 来源：`plan/memory-heartbeat-design.md` 评审 A1–A8 与实现收尾（2026-09-13）。
> 状态约定：**挂起** = 已决定暂不做（不阻塞当前工作）；**待定** = 需要用户决策后再做。
> 实现现状见设计稿 v2 §12；每条都标了设计依据与落地位置，可直接开工。

---

## A 组：评审提出但暂缓的澄清项

| ID | 事项 | 现状（已实现） | 挂起原因 | 落地位置 / 工作量 |
|:--|:--|:--|:--|:--|
| **A2** | 写入提示通道：StreamEvent `memory_updated` | 用 `SessionManager.setMemoryNoticeCallback` + TUI 一行 dim + headless stderr | 回调方案更简单且已够用；事件化的收益（外部订阅）当前无消费者 | `types/chat.ts` + `session.ts` 事件泵；S |
| **A3** | 衰减 / LRU 淘汰 / 折叠(fold) / 容量清理 / 会话内"主动出示条目全文" | 只做了置信度升级（merge 取 max）与到期提醒 | **衰减与淘汰在当前架构下没有消费者**：选择已交给 flash（R20），淘汰原本挂在 fold 上而 fold 已不需要（每主题一个文件）。"主动出示全文"每轮增加一次 LLM 调用或引入打分噪声，收益边际 | 若恢复确定性打分：`memory-store.ts` 加 `effectiveConfidence()`；出示：`memory-inject.ts` + `memory-recall.ts`；M–L |
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
