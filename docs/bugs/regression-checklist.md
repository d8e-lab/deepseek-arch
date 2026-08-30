# 前端回归清单 — 修改 src/presentation/ 或 src/render/ 前必跑

> 本清单汇总 TUI 前端（`src/presentation/`、`src/render/`）全部已修复 bug 及其回归测试覆盖状态，
> 以及修改前端前必须执行的验证命令与自查规则。
> 创建于 2026-08-30（分支 `refactor/orthogonal-tui`，HEAD `ec5403d`）。
> 数据来源：`docs/bugs/closed/`（tui-frontend-review.md / subagent-merge-regression.md 等）+ `git log` 前端修复提交 + `tests/` 现有测试清单。

---

## 一、使用说明

**触发条件（满足任一即必跑）**：

- 修改 `src/presentation/` 或 `src/render/` 下任何文件
- 涉及底部区域（输入区 / 命令结果区 / 建议列表）行数定位、键盘按键处理、视图开关（Ctrl+O / Ctrl+T）、流式输出渲染的改动
- 任何前端 bug fix（修复必须同时补回归测试，见自查清单 #6）

**必跑命令**（完整流程，约 2-3 分钟）：

```bash
# 1) 构建（PTY e2e 依赖 dist/cli/index.js，beforeAll 会检查）
npm run build

# 2) 前端单元回归（L0 快速层）
npx vitest run tests/cli/tui/ tests/render/ tests/cli/input-editor.test.ts

# 3) 全量单测（L1 层，含 core/subagent 等核心回归）
npm test

# 4) PTY 端到端（L2 层，真实终端帧级验证）
npx vitest run tests/pty/
```

**目的**：前端已修复 bug 在新功能加入后频繁复发（行数定位类 8 连发、merge 回退、视图竞态），
根因之一是修复未固化为回归测试、也没有"修改前必跑"清单。本清单把每个已修复 bug 映射到
**回归测试文件** 或 **手动验证点**，确保改动前能快速发现复发。

---

## 二、历史 bug 回归表

### A. 行数定位类 fix（`git log -- src/presentation/ src/render/` 底部区域系列）

> 此类 bug 同根因：输入区/命令结果区的行数记账与光标定位基准错误。已连续复发 8 次，
> 任何涉及底部区域行数计算的改动都必须重点回归。除 PTY 两例外其余无直接自动化覆盖，需手动验证。

| # | 提交 | 现象 / 根因（一句话） | 回归测试 | 覆盖状态 |
|:--|:--|:--|:--|:--|
| A1 | `572bb26` | 命令结果区超宽行触发终端 wrap 破坏行数定位 → 输入区逐次下移/残留 | — | ⚠️ 未覆盖（需手动：超宽命令输出） |
| A2 | `930ce77` | 输出结束后命令结果区消失 — inputCycle 重建未用 renderInput 画完整底部 | — | ⚠️ 未覆盖（需手动：命令输出结束后底部完整） |
| A3 | `af2693e` | 命令执行后输入区残留命令文本 — 命令路径 return 前未清空输入区 | — | ⚠️ 未覆盖（需手动：`/help` 后输入框为空） |
| A4 | `03dec44` | 双工中断 + 视图关闭 fire-and-forget 竞态 → 流式期间键盘失效与双流并发 | `tests/pty/viewer-followup.test.ts` | ✅ 已覆盖 |
| A5 | `0838994` | 键入字符时输入框逐字符上移 — 上移基准误用区域总高，应为 `lastCmdRows` + `lastCursorDisplayRow` | `tests/pty/input-stability.test.ts` | ✅ 已覆盖 |
| A6 | `f827d93` | 键入命令时输入框上移、对话内容逐行消失 — 冗余建议列表残留清除过度 | `tests/pty/input-stability.test.ts`（命令模式段） | ✅ 已覆盖 |
| A7 | `6f537df` | 命令结果区导致模型输出被截断 — 底部区域行数管理混乱 | `tests/pty/input-stability.test.ts` / `viewer-followup.test.ts`（间接） | ⚠️ 部分覆盖 |
| A8 | `41828a5` | 命令结果区移至输入框下方（布局重构，A1-A7 系列 bug 的起点） | — | ⚠️ 未覆盖（布局基准改动时必手动验证） |

### B. TUI 前端评审（`docs/bugs/closed/tui-frontend-review.md`，已解决 v1.3.9）

| # | 提交 | 现象 / 根因（一句话） | 回归测试 | 覆盖状态 |
|:--|:--|:--|:--|:--|
| Bug 1 | `0dba56e` | 模型输出时输入框消失 — 输入区只在 IDLE 绘制，流式期间裸写屏幕不重绘 | `tests/cli/tui/app-stream.test.ts` | ✅ 已覆盖 |
| Bug 2 | `24186ed` | subagent 无法查看 — store 永不填充 + 事件不发射（合并丢失，见 M-1/M-5） | `tests/core/subagent.test.ts` + `tests/pty/subagents.test.ts` | ✅ 已覆盖 |
| Bug 3 | `c6bce7a` + `03dec44` | 双工交互：流式期间键盘失效、输入框不可编辑 — 缺 Enter 中断与消息排队 | `tests/cli/tui/app-stream.test.ts`（双工用例）+ `tests/pty/viewer-followup.test.ts` | ✅ 已覆盖 |
| F-2 | `8bb24b7` | `captureScreen` 读方案 C 废弃顶层字段 — 工具调用轮次回复行数恒为 0 | — | ⚠️ 未覆盖 |
| F-3 | `24186ed` | `/subagent` 不在 `AVAILABLE_COMMANDS` — 命令模式无法提交 | — | ⚠️ 未覆盖 |
| F-4 | `b01d6c1` | shell 命令 `execSync` 同步阻塞 — 执行期间终端冻结、Ctrl+C 无效 | — | ⚠️ 未覆盖 |
| F-5 | `b01d6c1` | `CONFIRMING`/`ERROR` 死状态 — 状态机声明与实现不一致 | — | ⚠️ 未覆盖 |
| F-6 | `8bb24b7` | `conversation.ts` 用 `(turn as any).tool_calls` 绕类型 | —（类型层面，tsc 兜底） | ⚠️ 未覆盖 |
| F-7 | `b01d6c1` | emoji/ZWJ 未计宽度 2 — 含 emoji 输入/表格对齐错位 | `tests/cli/tui/renderer.test.ts`（`isWideChar` 基础用例） | ⚠️ 部分覆盖 |
| F-8 | `b01d6c1` | 输入历史无上限 — 长会话内存增长 | — | ⚠️ 未覆盖 |
| F-9 | `b01d6c1` | 未知 `/` 开头文本被丢弃 — 无法发送 "/usr/bin 在哪" | — | ⚠️ 未覆盖 |
| F-10 | `b01d6c1` | Home/End 依赖 `\x1b[H`/`\x1b[F` — 部分终端发 `1~`/`4~` 失效 | — | ⚠️ 未覆盖 |

### C. Subagent 合并回退（`docs/bugs/closed/subagent-merge-regression.md`，已解决 v1.3.9）

> 根因：`feat/subagent` 分支修复在 merge 冲突解决时被整体丢弃（`348d82e`），UI 层保留但数据链路全空。
> 教训：**无回归测试的合并会静默回退** — 本清单强制 M 系列逐项回归。

| # | 提交 | 现象 / 根因（一句话） | 回归测试 | 覆盖状态 |
|:--|:--|:--|:--|:--|
| M-1 | `24186ed` | SubagentStore 永不填充 + 持久化缺失 — `/subagent` 与 Ctrl+T 永远 "No subagents" | `tests/core/subagent.test.ts`（M-1/M-5 用例）+ `tests/pty/subagents.test.ts` | ✅ 已覆盖 |
| M-2 | `24186ed` | 异步模式无状态块 — 模型无法感知子代理 running/completed 状态 | — | ⚠️ 部分覆盖（subagent.test.ts 未断言状态块文本） |
| M-3 | `24186ed` | 同步模式子代理串行 — 应 `Promise.all` 并行启动 | `tests/core/subagent.test.ts`（M-3 用例：B 在 A 完成前被调用） | ✅ 已覆盖 |
| M-4 | `b194bda` | 轮次上限死代码 `MAX_AGENT_ROUNDS` — 已整体删除（无轮次上限） | —（代码已删除，不回归） | ✅ 已解决 |
| M-5 | `24186ed` | `subagent_spawned`/`subagent_finished` 事件从不发射 — TUI 紧凑状态行是死代码 | `tests/core/subagent.test.ts`（事件断言） | ✅ 已覆盖 |
| M-6 | `b194bda` | 截断消息误触发 — 正常终止被误报"达到最大轮次上限" | —（逻辑已删除，不回归） | ✅ 已解决 |
| M-7 | `24186ed` | `subagent.ts` 丢失输出条目发射（thinking/content/tool_call/tool_result）— 详情视图无数据 | `tests/core/subagent.test.ts`（M-7 用例）+ `tests/render/subagent-record-view.test.ts` | ✅ 已覆盖 |

### D. 其他前端修复（git log 补充）

| # | 提交 | 现象 / 根因（一句话） | 回归测试 | 覆盖状态 |
|:--|:--|:--|:--|:--|
| D1 | `1b9c1d7` | subagent content 每 chunk 一条碎 entry — 每几个词换行 | `tests/render/subagent-record-view.test.ts` + `tests/core/subagent.test.ts` | ✅ 已覆盖 |
| D2 | `02b104b` + `9c6cb7a` | agent loop 中 content 正文不实时渲染 — 无换行正文堆积到 loop 结束才 flush | `tests/render/markdown.test.ts` + `tests/cli/tui/app-stream.test.ts` | ✅ 已覆盖 |
| D3 | `a63ae6c` | 命令补全建议列表滚动窗口 — 第 9+ 项不可达 | — | ⚠️ 未覆盖 |
| D4 | `68acdb7` | 命令补全建议列表渲染偏移和过滤失效 | — | ⚠️ 未覆盖 |
| D5 | `2fdacc4` | raw mode 下输入区域内容上移和重复渲染 | — | ⚠️ 未覆盖 |
| D6 | `2e692c6` + `a82fdda` | 粘贴 `\r\n` 未归一化、行数统计 +1 — 跨平台粘贴错乱 | `tests/cli/input-editor.test.ts`（21 用例） | ✅ 已覆盖 |
| D7 | `7552c6a` | IDLE 状态打开视图退出后无法输入 — `readUserInput` 挂起等待 | — | ⚠️ 未覆盖 |
| D8 | `b23407a` | 视图打开期间输出结束时退出后输入无反馈 — handler 所有权管理 | `tests/pty/viewer-followup.test.ts`（间接） | ⚠️ 部分覆盖 |
| D9 | `f886d71` | `getTermSize` 对 columns/rows=0 崩溃 — PTY/非 TTY 环境 `printSeparator` 挂死 | — | ⚠️ 未覆盖 |
| D10 | `53b9846` | Subagents 视图 vim 式输入模式 — i 进入 insert，n/p 不再捕捉输入字符 | `tests/pty/subagents.test.ts` | ✅ 已覆盖 |
| D11 | `6de321a` + `5316f5b` | Ctrl+T 总览视图 / TUI 全双工 + 命令结果区（功能基线） | `tests/pty/subagents.test.ts` + `tests/cli/tui/app-stream.test.ts` | ✅ 已覆盖 |

**覆盖统计**：共 33 项，✅ 已覆盖 16 项，⚠️ 部分/间接 4 项，⚠️ 未覆盖 13 项。
**未覆盖项是最危险的复发源**（尤其 A1-A3/A7/A8 行数定位、F-2~F-10、D3-D5/D7-D9），
修改对应模块后必须按第三节的命令集跑测试，并对未覆盖项做手动验证。

---

## 三、验证命令集（按速度分层）

> 前提：`npm install` 已完成。PTY 层（L2）需要先 `npm run build`（测试 beforeAll 检查 `dist/cli/index.js`）。

### L0 快速层 — 前端单元回归（≈秒级，改动前端代码后必跑）

```bash
npx vitest run tests/cli/tui/ tests/render/ tests/cli/input-editor.test.ts
```

| 测试文件 | 覆盖内容 |
|:--|:--|
| `tests/cli/tui/app-stream.test.ts` | Bug 1/2/3：流式期间输入区固定底部、逐行重绘、双工排队、think 折叠 + Ctrl+O、agent loop content 实时输出 |
| `tests/cli/tui/renderer.test.ts` | ansi 纯函数：stripAnsi / 显示宽度 / truncate / 工具调用摘要（F-7 相关） |
| `tests/render/conversation.test.ts` | ConversationView / wrapText / truncateThink 折行逻辑 |
| `tests/render/markdown.test.ts` | MarkdownTableRenderer 缓冲与 flush 时机（D2 相关） |
| `tests/render/subagent-record-view.test.ts` | SubagentRecordView 渲染（D1 / M-7 相关） |
| `tests/cli/input-editor.test.ts` | InputEditor 粘贴归一化、行数统计、#N 标记（D6 相关） |

### L1 全量层 — 全量单测（≈1-2 分钟，合入前必跑）

```bash
npm test
```

| 覆盖内容 |
|:--|
| L0 全部 + `tests/core/`（session / subagent / compact / storage / skill / config / mock-provider — M 系列、I 系列核心回归）+ `tests/tools/`（编辑/浏览器/子代理工具）+ `tests/utils/` |
| 历史门禁参考：v1.3.8 全量 327/327、v1.3.7 全量 316/316 通过 |

### L2 PTY 层 — 端到端帧级验证（≈1-2 分钟，底部区域/键盘/视图改动必跑）

```bash
npm run build && npx vitest run tests/pty/
```

| 测试文件 | 覆盖内容 |
|:--|:--|
| `tests/pty/input-stability.test.ts` | A5/A6：逐字符键入（普通文本 + 命令模式）输入区不上移、对话不消失 |
| `tests/pty/viewer-followup.test.ts` | A4/Bug 3：流式排队 → 视图开关 → 无双流并发、键盘不失效 |
| `tests/pty/streaming.test.ts` | 流式渲染帧级验证（D11 功能基线） |
| `tests/pty/subagents.test.ts` | Ctrl+T 总览视图：spawn → 状态条 → 视图内交互 → 返回 master（M-1/Bug 2/D10） |

---

## 四、前端修改自查清单（8 条硬性规则）

修改 `src/presentation/` 或 `src/render/` 前逐条核对，全部通过才能合入：

1. **输出走统一收口**：所有屏幕写入必须经 `writeOutputLine` / `renderInput` 等收口函数，禁止裸 `process.stdout.write` 绕过重绘（Bug 1 根因：流式期间裸写导致输入框消失）。
2. **改底部区域必须检查记账字段**：涉及输入区/命令结果区行数定位时，检查 `lastCmdRows` / `lastCursorDisplayRow` / `lastBottomRows` 的**基准与全部消费方**（A1/A5 教训：上移基准误用导致逐字符上移）。改动后必跑 L2 的 `input-stability.test.ts`。
3. **ESC/按键解码复用统一入口**：新增按键处理必须复用现有序列解码（含 `\x1b[H`/`\x1b[F` 与 `1~`/`4~` 兼容分支），禁止各自重复解析（F-10 教训）。
4. **stdinHandler 对称恢复**：`setHandler` 打开视图/子界面后，**所有退出路径**必须对称还原主 handler（D7/D8 教训：退出后无法输入、无反馈）；fire-and-forget 异步任务在视图关闭后不得继续写屏（A4 教训：双流并发）。
5. **修改 render 公共函数先 grep 消费方**：改动 `ConversationView` / `wrapText` / `strDisplayWidth` / `MarkdownTableRenderer` / `truncateByWidth` 等公共函数前，grep 全部调用点（F-2 教训：captureScreen 漏改废弃字段；D2 教训：flush 时机影响 agent loop 实时性）。
6. **修复必须附回归测试**：每个 bug fix 提交必须同时带"修复前会失败"的测试（subagent merge 回退未被 CI 捕获的教训；F 系列多数未覆盖的现状）。测试放 `tests/cli/tui/`、`tests/render/`（单元）或 `tests/pty/`（帧级）。
7. **跑全量测试**：`npm test` 全量通过才能合入（历史门禁 327/327、316/316）。
8. **回归清单逐项通过**：按第二节表格逐项核对覆盖状态——已覆盖项跑对应测试确认绿，⚠️ 未覆盖项做手动验证（尤其是 A1-A3/A7/A8 行数定位与 F-2~F-10）；修改前后各跑一遍 L0 + L2。

---

## 五、维护约定

- 新修复的 bug：在第二节表格新增一行（提交 + 现象一句话 + 回归测试文件 + 覆盖状态），并更新覆盖统计。
- 新增回归测试：同步更新第三节命令集的覆盖内容说明。
- 归档新 closed 文档：把其中前端相关 bug 合并进第二节，并指向回归测试。
