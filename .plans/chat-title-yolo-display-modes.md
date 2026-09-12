# 计划：首句标题 / 默认 YOLO / 展示模式（short-normal-detail）

## 需求与已确认决策

1. **会话标题**：新建会话第一条普通消息 → 标题（取第一行、剥 `[shell_start]...[shell_end]` 上下文、trim、≤20 字符、不加省略号）。
2. **默认 YOLO**：模板/DEFAULT_DEFAULTS `yolo=true`、代码兜底 `?? true`、新增 `--no-yolo`；**不覆盖已有 config 中显式 yolo=false**。
3. **展示模式**（默认 **normal**；flag `--short/--normal/--detail` 互斥，冲突报错）：

| 维度 | short | normal | detail(现状) |
|---|---|---|---|
| 实时 think 可见行（超出折叠） | 4 | 4 | 5 |
| 实时工具输出流 tool_output | 隐藏 | 保留（逐行） | 保留（现状） |
| tool_result 最大行数 | 仅文件工具（≤6） | 6 | 12 |
| 非文件工具结果 | 隐藏，显示成功 ✓ / 失败 ✖+首行错误 / [Denied] | 正常显示 | 正常显示 |
| 文件 diff 预览 / 错误 | 始终显示 | 始终显示 | 始终显示 |
| 历史渲染(ConversationView) | 非文件工具结果隐藏+✓/✖ | 现状(think4/result6) | 现状 |
| Ctrl+O 全屏完整 think | 不变 | 不变 | 不变 |

- 模式为纯数据预设表，放 `src/render/display-mode.ts`（render SDK 层，ConversationView 与 TuiApp 共同消费，避免分层倒挂）。
- TuiApp 构造函数尾部追加 `displayMode: DisplayMode = 'detail'`（现有测试不破坏）；CLI 默认传 `normal`。

## 文件清单

| 文件 | 改动 |
|---|---|
| `src/render/display-mode.ts`（新） | DisplayMode/DISPLAY_PRESETS/isFileModTool |
| `src/render/conversation.ts` | render opts.mode：short 过滤非文件工具结果 + ✓/✖ |
| `src/presentation/tui-app.ts` | 消费 preset：thinkVisibleLines 字段化、tool_output/tool_result 分支 |
| `src/core/session.ts` | 首句标题派生 + sendMessageStream 插入 |
| `src/core/config.ts` | yolo 模板/DEFAULTS → true |
| `src/cli/index.ts` | yolo `?? true`、`--no-yolo`、`--short/--normal/--detail`（chat+resume）、默认 normal、resume 列表 Title 列宽 18→20 |
| `README.md` | 选项/默认值说明 |
| 测试 | display-mode 单测、conversation short 测试、session 标题测试、cli help 断言扩展 |

## 子任务顺序（每步 tsc + vitest 相关用例 + commit）

1. `src/render/display-mode.ts` + 单测
2. `conversation.ts` short 过滤 + 单测
3. `tui-app.ts` 模式消费（构造参数、think 阈值、tool 分支）
4. `config.ts` yolo 默认 + `cli/index.ts`（yolo 兜底/--no-yolo/模式 flag/列宽）
5. `session.ts` 首句标题 + 单测
6. README 更新
7. 全量 `npm test` + `tsc` 验证
