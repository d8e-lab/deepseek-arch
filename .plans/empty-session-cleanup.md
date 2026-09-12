# 空会话清理：turns=0 不保存 + clear --below 参数

## 需求
1. 会话退出时若活跃会话 turnCount === 0（未产生任何对话轮次），删除该会话目录不落盘。
2. clear 新增 `--below <N>`：删除所有 turnCount < N 的会话（忽略"保留最近 10 条"默认保护）。

## 文件清单
- src/core/session.ts: 新增 discardEmptySession()
- src/presentation/tui-app.ts: start() 循环出口钩子 + printExitInfo 文案
- src/cli/index.ts: clear --below 选项 + 过滤删除逻辑 + 描述/补全文本
- README.md: clear 命令说明行更新
- tests/core/session.test.ts: discardEmptySession 单元测试
- tests/cli/index.test.ts: clear --below e2e（temp HOME 隔离）+ 默认行为回归

## 关键设计
- discardEmptySession(): 无活跃会话或 turnCount>0 → false；否则 deleteSession + this.session=null
- TuiApp.start(): cleanupRawMode() 后检查空会话并丢弃，printExitInfo 区分"已丢弃"文案
- clear --below N: N 须为正整数；命中 filter(turnCount < N) 删除

## 验证
- npx tsc 通过
- npx vitest run 全绿（重点 tests/core/session.test.ts、tests/cli/index.test.ts）
- 手动：temp HOME 造数验证 clear --below 3