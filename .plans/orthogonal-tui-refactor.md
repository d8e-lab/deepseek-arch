# 前端正交模块化重构计划（orthogonal-tui-refactor）

> 目标：把前端界面划分为独立、可动态自适应的模块，模块间变更正交、互不影响。
> 分支：refactor/orthogonal-tui

## 架构目标

```
TuiApp（组合根：状态机 + 布局组装）
├── ScreenBuffer（新增）      所有输出唯一通道；测试可注入 fake
├── BottomArea（新增）        底部容器：measure 实时测量 → 布局分配
│   ├── InputPane              输入+光标+历史+补全数据
│   ├── CommandResultPane      / 命令输出（visible 随命令动态）
│   └── SuggestionPane         补全建议（visible 随输入动态）
├── ConversationArea           对话输出（scrollback 直写，经 ScreenBuffer）
└── OverlayPane（基类）        alt screen + handler 接管/恢复 + 输出缓冲回放
    ├── ConversationViewer     Ctrl+O
    └── SubagentsViewer        Ctrl+T
```

核心原则：高度是「测量」出来的不是「记账」出来的；模块只回答「我多高、我画什么」，不回答「我在哪」。

## 任务拆解

| ID | 目标 | 验收 | 委派 |
|---|---|---|---|
| T1 | 固化 8 个历史 fix 为回归测试 tests/cli/tui/regression.test.ts | 当前 main 上全绿 | subagent |
| T2 | ScreenBuffer + 95 处输出收口 | npm test 全绿 | subagent |
| T3 | BottomArea 容器化，消除 5 个记账字段 | npm test 全绿 + grep 无记账字段 + 手工验证 | 主 agent |
| T4 | OverlayPane 基类泛化（closeViewer/closeSubagentsView 收敛） | viewer-followup e2e 全绿 | 主 agent |
| T5 | docs/bugs/regression-checklist.md 建立 | 文档完成 | subagent |
| T6 | architecture.md 更新 + 最终三视角验证 | 文档一致 + 全测试绿 | 主 agent |

## 关键取舍

- diff 策略：区域整体重绘（底部区域高度有限）
- 通信：回调注入（不引入事件总线）
- 不做 Step 4 对话区视口化（暂缓）

## 风险与缓解

- T2 机械替换漏改 → 主 agent grep 复核 process.stdout 残留
- T3 重构期间 app-stream.test.ts 内部访问方式可能需微调 → 保留行为断言
- 全程在 refactor/orthogonal-tui 分支，坏了 git checkout -- .
