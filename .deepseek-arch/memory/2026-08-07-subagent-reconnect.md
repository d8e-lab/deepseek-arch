# 会话记忆 — 2026-08-07 子代理接线恢复 + 数据格式 v2 + TUI 修复

> 会话日期: 2026-08-07
> 涉及分支: `fix/subagent-reconnect`（基于 main @ 202f7ad）
> 关键提交: `24186ed`(子代理接线) → `944a40c`(bump 1.3.8 + tag v1.3.8) → `8bb24b7`(数据格式 v2) → `b01d6c1`(TUI F-4~F-10) → `0dba56e`(Bug 1 输入框)

---

## 一、Goal

根据 memory + docs/bugs 修复 bug，并分析 bug 间关联关系。用户决策：放弃磁盘写入策略优化、数据格式 v2 按方案执行、加 version 标记、提示词/skill 机制不动（事后提醒）、TUI Bug 1 本次做（先 subagent 后 TUI，subagent 完成先打 tag）。

## 二、关联关系结论（交付物）

8 个根因聚类：
- **根因1 merge 丢失子代理接线** → M-1/M-2/M-3/M-5/M-7 + Bug2 + F-3 同源，一批次修
- **根因2 中断 signal 共享** → I-1 连带 I-2，并入批次 1
- **根因3 持久化双路径** → C-2（userMsg 重复，memory 误判为已修——实际未修）+ C-5
- **根因4 方案 C 遗漏消费方** → F-2（captureScreen）
- **根因5-8** TUI 小问题/提示词/skill/架构清洁 相互独立

## 三、已解决 ✅

### 批次 1（24186ed + tag v1.3.8）
- M-1: runSubagent 接线 SubagentStore + saveSubagentRecord 持久化
- M-7: subagent.ts 恢复 callbacks/onEntry（thinking/content/tool_call/tool_result）
- O-1: 子代理 usage 并入主会话入账；O-2: 子代理累积 reasoning_content
- I-1: 子代理独立 AbortController（主 agent 中断不连坐）+ pendingSubagents 提升实例级
- I-2: 状态机加 cancelled；runSubagentLoop 捕获 chatStream AbortError
- M-5: async 模式 subagent_spawned/finished 事件
- M-2: buildStatusBlock 状态块（roundMessages 末尾）；删除静态提醒+强制 continue
- M-3: allDeferredSpawns 并行（Promise.all）
- 新增 subagent_cancel 工具 + /subagent_cancel 命令（Selector 列表含全部取消）
- F-3: AVAILABLE_COMMANDS 补 /subagent 与 /subagent_cancel
- 测试: tests/core/subagent.test.ts（9 用例）

### 批次 2（8bb24b7）
- 数据格式 v2：messages 恒存、删 turn/user/assistant、加 version: 2
- C-2 修复（storage 不再二次拼 userMessage）；C-5（updateLastTurn null 回退 saveTurn）
- F-2: captureScreen 用 turn-utils；F-6: conversation.ts 去 any
- 旧数据 v1 兼容保留

### 批次 3（b01d6c1 + 0dba56e）
- Bug 1: 流式输出期间输入框固定在底部（writeOutputLine 统一收口 + 每行后重绘）
- F-4: execSync→spawn 异步；F-5: CONFIRMING/ERROR 状态；F-7: emoji 宽度
- F-8: 历史上限 100；F-9: // 转义；F-10: Home/End 1~/4~
- 测试: app-stream.test.ts（3 用例锁定 Bug 1 机制）

## 四、未解决 ⏳（需提醒用户）

### 提示词体系（用户明确本次不动，事后提醒）
- S8: system_prompt.txt:89 vs :105 `git reset --hard` 自相矛盾
- A1-A3/A5-A7: 子代理 prompt 与主 prompt 冲突（独立子代理 system prompt）
- P4/P6: shell/subagent_spawn description 补充（主代理确认、输出截断、async/sync 差异）

### Skill 机制（用户明确本次不动，事后提醒）
- release.skill 无触发链路（零引用）
- copyPlanSkill 更新策略（老用户永远旧版）
- plan.skill 确认断点漏 save_plan；:95 残缺文案
- fa02940 subagent_spawn/wait 描述增强丢失（与提示词 P6 重叠）

### 架构清洁（P2）
- SessionManager 拆分（AgentLoopEngine + SubagentCoordinator）
- storage 原子写 / StreamEvent 判别联合 / setSubagentRunner 构造注入
- PACKAGE_VERSION 从 package.json 注入（当前 cli/index.ts 硬编码 1.3.8）
- 文档脱节（architecture.md 工具数、module-interaction.md）

### 遗留失败测试（预先存在，非本次引入）
- ✅ 已清理：voice-service.test.ts（死测试已删）、cli/index.test.ts 版本断言（改读 package.json）
- ⏳ tests/pty/streaming.test.ts（脚本用已删除的 --mock + dist/index.js 路径，需重建 mock 支持）

---

## 五、追加：前端双工交互修复（c6bce7a + f886d71）

用户报告三个前端 bug（根因关联）：
1. **think 时输入框消失**：reasoning 走增量 flush 无换行不重绘 → 改按完整行输出（每行后重绘输入区），半行留 pending（超 60 字符强制输出）
2. **content 时显示上一轮内容**：`input.clear()` 原在下一轮 inputCycle 才调用 → 发送消息后立即 clear
3. **无法交互**：流式期间 stdinHandler 只处理 Ctrl+C → 双工：复用 handleInputData 完整编辑，Enter 中断当前输出 + 排队 nextMessage（finally 递归发送），/ 命令输出期间提示不可用

验证：
- 逻辑测试 6 用例（think 逐行重绘、输入清空、双工排队）
- PTY 冒烟（mock sessionMgr 驱动真实 TUI）：think/content 期间 input_bg 可见、Enter 中断 + 第二轮回复 ✓
- 顺带修复 getTermSize columns=0 崩溃（PTY 环境 repeat(-1)）

## 六、追加：展示优化——紧凑工具行 + think 折叠（5aa33a5）

- 工具调用：`[T: command] {...}` → `· run <tool> <摘要>`；execute_command 显示命令本身、文件工具显示路径、browser 显示 URL、search 显示 pattern、其他 JSON 截断（renderer.formatToolCallSummary）
- think：前 5 行实时显示，超出折叠为动态省略号（400ms 动画），结束定稿 `[Think] 已折叠 N 行`；**Ctrl+O 查看完整思考**（流式/IDLE 都可用）
- 修复 flush 尾部伪空行 bug（pending 以 \n 结尾时 split 产生空行计入 fullThink，导致折叠计数 +1）
- 测试：formatToolCallSummary 5 用例 + think 折叠 1 用例；PTY 冒烟（紧凑格式/折叠/Ctrl+O）全通过

## 七、追加：Ctrl+O 全屏对话浏览视图 + ● 圆点（1ad1747）

- 全屏浏览（alternate screen）：每轮完整展示 user（绿）/think（灰不折叠）/● run 工具行/回复
- 导航：←→ 切轮次（跳该轮顶部）、↑↓ 行滚动、PgUp/PgDn 翻页、`/` 搜索（n/N 循环+高亮）、Esc/q 退出
- **流式期间打开视图 = 后台静默**：writeOutputLine 缓冲 streamLines；done 归档打开时轮增量；退出时从 turns resume 补渲染完整轮 + 补增量（内存封顶单轮、无临时文件、崩溃安全天然）
- 缓冲方案演进：临时文件 → turns.json+resume（用户提出）→ 结合 streamLines 补进行中半轮
- `·` → `●`（tool_call_start + conversation.ts）
- 修复 viewer 输入逐字符处理（PTY 一次写多字符）
- PTY 冒烟：视图/●/完整 think/搜索匹配/左右键轮次切换/流式静默退出补渲染 全通过
