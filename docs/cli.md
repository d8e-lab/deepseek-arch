# CLI 设计

> 最后更新：2026-05-17 · 实现文件：`src/cli/index.ts`, `src/index.ts`

## 概述

基于 Commander.js v14 的命令行接口，提供全局选项和子命令。

## 入口

```
src/index.ts  →  src/cli/index.ts (run)
```

`src/index.ts` 是 npm bin 入口，调用 `run()` 并处理致命错误。

## 全局选项

| 选项 | 输出 |
|------|------|
| `-V, --version` | `deepseek-arch vX.Y.Z`<br>`作者: helcksun`<br>`发布日期: YYYY-MM-DD` |
| `-h, --help` | 全局帮助（含子命令列表） |

## 子命令

### chat

```
deepseek-arch chat [options]

开始新对话

Options:
  --title <name>  设置对话标题
  -h, --help      显示 chat 命令帮助
```

Phase 5 实现完整对话循环。

### resume

```
deepseek-arch resume [options]

恢复历史对话。不带参数时展示对话列表供选择。

Options:
  --id <id>      按对话 ID 精确匹配
  --name <name>  按对话标题精确匹配
  -h, --help     显示 resume 命令帮助
```

**不带参数时：**
```
┌────┬──────────────────────┬──────┬──────────────────────┐
│ #  │ 标题                 │ 轮次 │ 更新时间             │
├────┼──────────────────────┼──────┼──────────────────────┤
│ 1  │ 分析 Rust 内存模型   │ 5    │ 2026-05-17 14:30     │
│ 2  │ Python 性能优化      │ 3    │ 2026-05-17 10:00     │
└────┴──────────────────────┴──────┴──────────────────────┘
输入序号恢复会话: _
```

**错误处理：**
- `--id` 无匹配 → `未找到会话: <id>`，exit 1
- `--name` 无匹配 → `未找到标题为 '<name>' 的会话`，exit 1

## 退出提示格式（Phase 5+）

```
会话已保存 (id: a1b2c3d4)
──────────────────────────────────────
本轮 Token 消耗:
  输入: 1,234  (缓存命中: 800, 未命中: 434)
  输出: 567
  缓存命中率: 64.8%
  本次费用: ¥0.0123
  累计费用: ¥0.0456
──────────────────────────────────────
恢复此会话:
  deepseek-arch resume --id a1b2c3d4
```

## 版本信息

版本号、作者、发布日期硬编码在 `src/cli/index.ts` 的常量中：

```typescript
const VERSION = '0.1.0';
const AUTHOR = 'helcksun';
const RELEASE_DATE = '2026-05-16';
```

发版时更新这些常量。

## 测试

8 个 e2e 测试，通过 `execSync` 运行编译后的 CLI 验证输出：

- `--version` 包含版本号、作者、日期
- `-V` 等价于 `--version`
- `--help` 包含 chat 和 resume
- `-h` 等价于 `--help`
- `chat` 无参数时运行 action
- `chat --help` 显示 `--title`
- `resume --help` 显示 `--id` 和 `--name`
- `resume` 无参数时运行 action

测试在 `beforeAll` 中执行 `npx tsc` 确保代码已编译。
