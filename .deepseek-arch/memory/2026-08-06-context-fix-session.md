# 会话记忆 — 2026-08-06 上下文丢失修复与会话重构

> 会话日期: 2026-08-06
> 涉及分支: `feat/api-request-monitor`、`feat/session-refactor`（均已合并 main）
> 关键提交: `bbf0f3d`(api-monitor) → `a7cc07c`(C-1+方案C) → `b194bda`(移除轮次上限) → `68e781e`(windows-path) → `202f7ad`(cache.log 修复)

---

## 一、Goal（本轮要解决什么问题）

用户报告核心问题：**对话上下文丢失**——"resume 之后丢失的内容会恢复，可能是落盘和内存数据不一致"。具体表现：
1. 用户在 agent loop 中中断后，之前抛给模型的问题在上下文中消失
2. 同一进程内连续对话上下文不完整，但 resume 后恢复
3. 附带排查：顶层 assistant 数据冗余、轮次上限死代码、TUI 前端 bug

## 二、怎么解决的（解决路径）

1. **实证**：创建 API 请求镜像监听（`deepseek-arch api-monitor`），每次 API 请求原样保存 → 对比请求序列与磁盘 turns，确认"resume 后请求完整、同进程丢失"
2. **定位**：代码审查确认 **Bug C-1**——agent loop 轮次只写磁盘不更新内存，结束分支用 `length-1` 覆盖上一轮
3. **修复**：
   - C-1：首次 `saveTurn` 后立即 `turns.push(inProgress)`（内存与磁盘对齐）
   - 方案 C：有 messages 的轮次顶层只存 `{id, role}`，content 由 `turn-utils.ts` 从 messages 推导（消除双份存储）
   - 顺带修复 C-3（cache.log 编号用 `turn.turn`）、C-4（meta.turnCount 随 C-1 自愈）
4. **清理**：移除 `MAX_AGENT_ROUNDS`/`MAX_SUBAGENT_ROUNDS` 轮次上限（含 M-6 截断误触发 bug）、修复 cache.log 路径 bug、合并 windows-path、删除过时分支与文档
5. **审查**：架构/提示词/skill/对话一致性/TUI 前端五份审查，产出 `docs/bugs/` 8 份权威文档

## 三、已解决问题 ✅

| # | 问题 | 修复 |
|---|------|------|
| 1 | **C-1** 内存 turns 错位覆盖（上下文丢失根因） | saveTurn 后 push 内存（`session.ts`） |
| 2 | **C-2** 顶层 assistant 与 messages 双份存储 | 方案 C：顶层只存 id，helper 推导 |
| 3 | **C-3** cache.log turn 编号偏移 | 用 `turn.turn` 替代 `length+1` |
| 4 | **C-4** 内存 meta.turnCount 少 1 | 随 C-1 修复 |
| 5 | **M-4** MAX_AGENT_ROUNDS 死代码 / **M-6** 截断误触发 | 轮次上限整体移除 |
| 6 | **cache.log 从未生成**（id 重复一层路径 bug） | `join(sessionDir, 'cache.log')` |
| 7 | **api-monitor 功能缺失** | 新 `api-monitor` 子命令 + ApiClient 镜像 |
| 8 | **windows 路径不一致** | 合并 `fix/windows-path-inconsistency`（5 提交） |
| 9 | **README 声称与功能脱节** | 移除 voice-io/browser-live-view 声称，删除 4 个过时分支 |
| 10 | **审查文档整理** | 8 份权威文档入库，删除 4 份已修复/过时文档 |

## 四、未解决问题 ⏳（后续任务）

### P0 — subagent 接线恢复（merge 回退，M-1~M-7）
- **M-1** SubagentStore 永不填充 + `saveSubagentRecord` 无调用者（`/subagent` 永远空）
- **M-2** 异步模式无状态块注入（模型无法感知子代理状态）
- **M-3** 同步模式串行而非并行（应为 Promise.all）
- **M-5** `subagent_spawned/finished` 事件从不发射（TUI 状态行死代码）
- **M-7** `subagent.ts` 丢失输出条目发射（callbacks/emit）
- 修复路径：从 `1a501c0`/`a34f8cd` cherry-pick 恢复 session.ts/subagent.ts 核心接线

### P0 — 中断生命周期
- **I-1** 用户中断时 subagent 被连坐杀死（signal 共享，`session.ts:675`）→ 独立 AbortController
- **I-2** 被取消的 subagent 误标 `completed`（`r.startsWith('Error:')` 判断）

### P0 — TUI 前端
- **Bug 1** 模型输出时输入框消失（输出不重绘输入区，需渲染架构调整）
- **Bug 2** subagent 无法查看（依赖 M-1/M-5 接线）
- **F-2** `captureScreen` 读方案 C 废弃字段（tui_capture 数据错误）
- **F-3** `/subagent` 不在命令模式验证列表
- **F-4** `execSync` 阻塞事件循环 / **F-5** CONFIRMING/ERROR 死状态 / F-6~F-10 小问题

### P1 — 提示词（docs/bugs/prompt-review.md）
- S8 `git reset --hard` 自相矛盾（system_prompt.txt:89 vs :105）
- S1/S2/S3/S4/S5/S6/S7/S10 缺漏（工具确认机制、浏览器/subagent 总纲、agent loop 说明等）
- 子代理 prompt 与主 prompt 冲突（A1-A3、A5-A8）→ 独立子代理 system prompt

### P1 — Skill（docs/bugs/skill-design-review.md）
- release.skill 无触发链路（零引用）
- skill 更新到不了老用户（copyPlanSkill 已存在即跳过）
- plan.skill 确认断点漏 save_plan、fa02940 工具描述增强丢失

### P2 — 架构（docs/bugs/architecture-code-review.md）
- SessionManager 拆分（AgentLoopEngine + SubagentCoordinator）
- storage 原子写（临时文件 rename）、saveTurn 增量追加
- StreamEvent 判别联合、setSubagentRunner 全局回调 → 构造注入
- 文档与代码脱节（architecture.md 工具数 13→30、module-interaction.md 过时）

## 五、关键文件索引

- 审查文档：`docs/bugs/`（architecture-code-review / conversation-consistency / prompt-review / skill-design-review / subagent-merge-regression / subagent-interrupt-lifecycle / subagent.md / tui-frontend-review）
- 请求监听：`src/core/api-monitor.ts` + `deepseek-arch api-monitor` 命令
- 会话推导 helper：`src/utils/turn-utils.ts`
- 命中率监控：`src/core/cache-log.ts`（已修复）+ `turn.round_usage`
