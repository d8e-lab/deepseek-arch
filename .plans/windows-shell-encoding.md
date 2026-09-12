# Windows 命令输出编码修复 — 执行计划

## 目标
修复 `src/tools/shell.ts` 在 Windows 下执行命令输出乱码的问题，分两层：
1. **源头 UTF-8 化**：Windows 分支注入 PowerShell 编码前缀（PS_PROLOGUE），强制管道输出为 UTF-8。
2. **流式解码**：用 `StringDecoder('utf8')` 替代逐 chunk `chunk.toString('utf-8')`，修复多字节字符被 chunk 边界切断产生的 U+FFFD（现有 bug，Linux 同样受益）。

## 不做（超出范围）
- pwsh 优先探测链
- 按 ACP 探测的 GBK 兜底转码
- env 加固（PYTHONUTF8 等）
- 架构层文案调整

## 改动文件
| 文件 | 改动 | 理由 |
|---|---|---|
| `src/tools/shell.ts` | ① 新增 `PS_ENCODING_PREAMBLE` 常量并导出；② 将 `getShellBin()` 改造为导出的 `buildInvocation(command, platform?)`，Windows 返回 `powershell.exe -NoProfile -NonInteractive -Command <前缀+命令>`，非 Windows 保持 `/bin/bash -c <命令>`；③ stdout/stderr 改用 StringDecoder 流式解码，close/error 收尾 flush decoder 尾串 | 主修复点 |
| `tests/tools/shell.test.ts`（新增） | ① `buildInvocation` 平台分支断言（win32 注入前缀 + 参数、非 win32 原样）；② 端到端：执行 `node -e` 输出 >64KB 中文字符串，断言无 U+FFFD 且内容完整 | 覆盖注入逻辑（可注入 platform）+ 跨 chunk 回归 |

## 验收标准
- `npm run build`（tsc）通过
- `npx vitest run tests/tools/shell.test.ts` 通过
- 全量 `npm test` 无回归
- 非 Windows 命令行为完全不变（bash 路径原样透传）

## 执行步骤
1. git checkout -b fix/windows-shell-encoding
2. 修改 shell.ts（前缀 + buildInvocation + StringDecoder）
3. npm run build
4. 新增 shell.test.ts
5. vitest 运行新测试 + 全量测试
6. git add + commit（中文说明）
