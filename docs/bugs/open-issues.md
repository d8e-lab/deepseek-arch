# 开放问题清单 — 未解决 Bug 与待办（2026-08-08 快照）

> 本文件汇总当前**未解决**的 bug 与待办项（已解决项归档于 [closed/](./closed/)）。
> 更新于 2026-08-08（v1.3.9 发布后）。

---

## 一、提示词体系（用户 2026-08-07 决策：暂不处理，事后提醒）

来源：[closed/prompt-review.md](./closed/prompt-review.md)

| # | 问题 | 位置 |
|:--|:--|:--|
| **S8** | `git reset --hard` 自相矛盾（system_prompt.txt:89 鼓励自查点回退 vs :105 要求确认） | system_prompt.txt |
| **S1** | 工具确认机制未说明（实际每次 execute_command 都弹 y/N） | system_prompt.txt |
| **S2** | 浏览器工具完全没提（无总纲） | system_prompt.txt |
| **S3** | Subagent 工具完全没提（无 spawn/wait 使用指引） | system_prompt.txt |
| **S4** | Agent loop 机制未告知模型（并行发起/结果送回/输出截断 8192B） | system_prompt.txt |
| **S5** | `[system]`/`[auto-continue]` 注入消息未预告 | system_prompt.txt + session.ts |
| **S6** | 错误恢复指引不完整 | system_prompt.txt |
| **S7** | 主代理与子代理产物衔接未说明 | system_prompt.txt + subagent-spawn.ts |
| **S10** | 主 prompt"等用户确认"与子代理无用户环境冲突 | system_prompt.txt + session.ts:44-56 |
| **A1-A3/A5-A7** | 子代理 prompt 与主 prompt 冲突、输出格式未约束、安全语义缺失、结束语缺失、衔接缺失 | session.ts SUBAGENT_APPEND_PROMPT |
| **P4** | execute_command description 缺：主代理确认、输出截断、10min 超时、非交互 | src/tools/shell.ts:47-49 |
| **P6** | subagent_spawn description 缺 async/sync 差异与"结果只取一次" | src/tools/subagent-spawn.ts:20-27 |
| **P12** | tts_speak/--voice 名存实亡（README 列了但无实现） | README / dist/ |
| **P15** | agent.md:21 better-sqlite3 过时、版本号对齐 | agent.md |

## 二、Skill 机制（用户 2026-08-07 决策：暂不处理，事后提醒）

来源：[closed/skill-design-review.md](./closed/skill-design-review.md)

| # | 问题 |
|:--|:--|
| P0 | release.skill 零引用（模型不可达，无触发链路） |
| P0 | copyPlanSkill 已存在即跳过（老用户永远旧版 skill） |
| P1 | fa02940 subagent_spawn/wait 描述增强在 merge 丢失（未恢复） |
| P1 | plan.skill 确认断点漏 save_plan 步骤 |
| P1 | release.skill 步骤 5/6 顺序颠倒 + 上传动作重复 |
| P2 | skill 无元数据（frontmatter/版本） |
| P3 | paste-retrospective 4 条建议未落实；plan.skill:95 残缺文案 |

## 三、架构清洁

来源：[closed/architecture-code-review.md](./closed/architecture-code-review.md)

| # | 问题 | 备注 |
|:--|:--|:--|
| P0 | **SessionManager 拆分**（1221 行 God Object → AgentLoopEngine + SubagentCoordinator） | 大重构，风险高 |
| P0 | **Storage 原子写**（writeFile 非原子，saveTurn/updateLastTurn O(n²) 写放大） | 用户 2026-08-07 曾放弃磁盘策略优化；若补只需 atomic write helper |
| P1 | StreamEvent 判别联合（15 种事件 + 20+ 可选字段 God Event） | |
| P1 | setSubagentRunner/setCaptureFn 全局回调 → 构造注入 | |
| P2 | `any` 清理（config.ts/storage.ts/tools/types.ts/mock-provider.ts） | |
| P2 | setModel 可选性收紧（静默失败） | |
| P3 | PACKAGE_VERSION 从 package.json 注入（cli/index.ts:37 硬编码） | 小改动 |
| P3 | 文档脱节残留（architecture.md 工具数、module-interaction.md 目录结构） | |

## 四、测试遗留

| # | 问题 |
|:--|:--|
| 1 | `tests/pty/streaming.test.ts` 依赖已删除的 `--mock` + `dist/index.js` 路径，需给 CLI 接 MockProvider 后重建 |
| 2 | 子代理端到端测试（async 模式多轮、状态块注入断言）未覆盖完整 |

## 五、新需求（2026-08-08 用户提出）

| # | 需求 | 状态 |
|:--|:--|:--|
| 1 | **subagent 实时输出视图**：Ctrl+T 当前仅查看列表；用户期望"切换 agent"——在主 agent 与 subagent 之间切换焦点，实时查看某 subagent 输出（可基于 Ctrl+O 全屏视图模式做） | 待确认方案 B |

## 六、依赖与环境（2026-08-20）

| # | 问题 | 状态 |
|:--|:--|:--|
| 1 | **Playwright 版本宽松导致浏览器二进制不匹配**：`^1.61.1` 被解析到 1.62.1（需 chromium-1234，本机只有 1228），Agent 浏览器工具全部报 "Chromium is not available"。已修复：下载匹配浏览器 + 报错分类提示。**版本声明是否收紧为 `~1.61.1` 用户待决策**，详见 [playwright-browser-mismatch.md](./playwright-browser-mismatch.md) | ⚠️ 部分解决，未 close |

