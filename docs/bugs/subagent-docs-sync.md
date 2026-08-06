# Subagent 文档与代码脱节 — 审查文档声明的状态与实际不符

**类型**: 文档同步（Doc Drift）
**发现日期**: 2026-07-23
**当前基线**: `main` @ `68acdb7`（HEAD）
**涉及文件**: `docs/bugs/subagent.md`、`docs/bugs/subagent-implementation-review.md`

---

## 根因

`docs/bugs/subagent-implementation-review.md` 是 `1a501c0` 提交时写入的，记录了当时 `feat/subagent` 分支上**已修复**的状态。但 `1a501c0`/`a34f8cd` 的修复在合并 `348d82e` 时被冲突解决丢弃（见 [subagent-merge-regression.md](./subagent-merge-regression.md)），当前 main 中这些"已修复"项**全部回退**。文档未同步更新，成为过时状态声明。

---

## Bug 清单

### 🟢 Bug D-1：`subagent-implementation-review.md` 声称已修复的项全部回退

**位置**: `docs/bugs/subagent-implementation-review.md` 全文

**文档声称 vs 实际状态**:

| 文档声称（"已修复"/"已实现"） | 实际状态（main @ 68acdb7） | 对应回归 Bug |
|:---|:---|:---|
| #2 异步模式每轮注入动态状态块 `buildStatusBlock()` | ❌ 已回退，`roundMessages` 无状态块 | M-2 |
| #3 状态块不修改 agentMessages，仅拼到 roundMessages 末尾 | ❌ 已回退，静态提醒仍推入 `agentMessages` | M-2 |
| #5 新增 `subagent_spawned`/`subagent_finished`/`subagent_update` 事件 | ⚠️ 类型定义保留，但 `session.ts` 从不发射 | M-5 |
| `SubagentStore` 内存缓冲捕获每轮 thinking/content/tool_call/tool_result | ❌ 已回退，`SubagentStore` 运行时恒为空 | M-1, M-7 |
| `SubagentCallbacks` 回调参数，每产出条目时触发 | ❌ 已回退，`subagent.ts` 无 callbacks 参数 | M-7 |
| 紧凑 TUI 渲染（`[Sub: name] ⏳/✓`） | ❌ 已回退，事件不发射 → 渲染分支是死代码 | M-5 |
| `/subagent [name]` 命令、`Ctrl+T` 快捷 | ⚠️ 命令保留，但数据源 `SubagentStore` 恒空 → 永远显示 "No subagents" | M-1 |
| Storage 持久化 `saveSubagentRecord` → `sessions/<id>/subagents/<name>.json` | ❌ 已回退，API 存在但无调用者，磁盘永不写入 | M-1 |
| Resume 支持（`/subagent` 加载历史记录） | ❌ 已回退，磁盘无数据可加载 | M-1 |

**影响**: 维护者依据文档判断模块能力，会误以为功能可用；Bug 报告引用文档状态做对照时结论失真。

**建议**: 修复代码（见 merge-regression 文档）后同步更新两份审查文档，使其与修复后代码一致；或将恢复修复作为独立 commit 并更新文档状态。

---

### 🟢 Bug D-2：`subagent.md` 的部分描述已过时

**位置**: `docs/bugs/subagent.md` 全文

**现象**: 该文档（基于 `plan/remove-agent-loop-limit.md` 实现检查，2026-07-10）中的部分现象仍然准确（Bug #1 顺序执行、#2 缺状态块——这些在 main 上依旧存在，见 M-2/M-3），但：#4 MAX_AGENT_ROUNDS 死代码已于 2026-08-06 随常量删除修复；#7 潜在死循环（无 round 上限）因"无轮次上限"设计而不再是 bug（见 subagent-merge-regression.md M-4）。其余：

1. **Bug #5（缺 StreamEvent 类型）已过时**——`src/types/chat.ts:89` 已定义 `subagent_spawned`/`subagent_finished`/`subagent_update` 三种事件类型（类型层保留，发射层缺失，见 M-5）
2. **"✅ 正确实现的部分"清单有误导性**——第 2 项"`subagent.ts` 子代理引擎实现正确"、第 4 项"`runSubagent()` 正确合并 prompt"在**引擎自身上仍成立**，但第 6/8 项（wait 语义、buildMessages 历史重建）基于旧代码行号，需重新核对
3. 文档中的行号引用（如 `session.ts:367-417`、`:489`）与当前 main 的行号已偏移

**影响**: 行号失效导致排查困难；"正确实现"清单让人误以为部分链路（store/事件/持久化）是通的。

**建议**: 与 D-1 一并重写/更新，行号以当前 main 为准，并在文档头部标注"最后核对基线"。

---

## 文档维护建议

1. **修复代码与更新文档绑定**：任何 subagent 代码修复 commit 必须同步更新 `docs/bugs/subagent.md` 与 `docs/bugs/subagent-implementation-review.md` 的状态列
2. **文档头部标注基线**：每份 bug 文档头部注明"最后核对的 commit hash"，便于判断文档是否过时
3. **新增文档引用关系**：本仓库 3 份 subagent bug 文档的关系——
   - `subagent.md`：原始实现检查（7 个 bug，plan 对照）
   - `subagent-implementation-review.md`：分支上修复状态记录（多数已回退）
   - `subagent-merge-regression.md`：当前 main 的功能回退清单（**以此为准**）
   - `subagent-interrupt-lifecycle.md`：中断/生命周期缺陷（**以此为准**）
4. 修复完成后，在 `subagent-implementation-review.md` 顶部加注：⚠️ "本文档描述的是 feat/subagent 分支状态，main 上的对应实现已回退，详见 subagent-merge-regression.md"
