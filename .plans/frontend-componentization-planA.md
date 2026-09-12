# 方案 A：前端组件化（正交化第二阶段）

> 分支：refactor/orthogonal-tui
> 目标：TuiApp（2481 行）内嵌的两个全屏视图与底部子窗格抽成独立组件类；同时把组件间重复实现下沉为共享纯计算抽象。用户可见行为 100% 不变。

## 组件清单（v2，已确认）

```
src/render/（共享纯计算抽象，新增）
├── list.ts           renderSelectList / computeListWindow / renderListLine（滚动窗口+高亮+折叠）
├── scroll.ts         ScrollState（滚动 clamp + followTail + page）
├── markdown-text.ts  renderMarkdownText(text, termWidth, indent)
└── csi.ts            parseCsiSequence(data, i)

src/presentation/
├── screen-buffer.ts  +renderViewportLines()（视口渲染循环收口）
└── views/（新增，ViewComponent 契约 render/handleInput/cleanup）
    ├── types.ts
    ├── conversation-viewer.ts   Ctrl+O（数据源 getTurns）
    ├── subagents-viewer.ts      Ctrl+T（数据源 listSubagents/sendToSubagent）
    ├── command-result-pane.ts
    └── suggestion-pane.ts       （复用 list.ts，本体极薄）
```

## 刻意不抽
- 两个全屏视图的"页面骨架"（差异大，OverlayPane 已管生命周期）
- tui-app 裸写光标移动序列（20+ 处语义各异）
- Header/分隔线/think 折叠一次性片段

## 任务拆解

| ID | 目标 | 验收 | 委派 |
|---|---|---|---|
| A1 | render 共享抽象：list.ts/scroll.ts/markdown-text.ts/csi.ts + 单测 | tsc + 新单测绿 | 主 agent |
| A2 | ScreenBuffer.renderViewportLines + views/types.ts 契约 | tsc | 主 agent |
| A3 | 抽取 ConversationViewer | Ctrl+O 行为不变；单测 | 主 agent |
| A4 | 抽取 SubagentsViewer | Ctrl+T 行为不变（滚动/输入/timer） | subagent |
| A5 | BottomArea 子窗格化（CommandResultPane/SuggestionPane） | 底部行为不变 | subagent |
| A6 | TuiApp 瘦身接线（删 19 字段 + 21 方法） | tsc + 全量测试绿 | 主 agent |
| A7 | 测试迁移为组件级 + 文档更新 | 全量测试绿 + architecture.md 一致 | 主 agent + subagent |

## 约束
- 行为不变：现有 tests/cli/tui/* 是安全网，A6 后全绿
- 每步 tsc + 相关测试 + commit
- 全程 refactor/orthogonal-tui 分支，坏了 git checkout -- .
