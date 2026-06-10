# 文件修改工具设计文档

> 创建于 2026-06-10 · v0.6.0

## 概述

为 Agent 新增两个文件写入工具：`write_file`（创建/覆盖）和 `edit_file`（精确替换），遵循"预览后确认"的安全交互模式。

## 设计原则

### 1. 精确字符串匹配

编辑使用 `old_string` + `new_string` 精确搜索替换，**不使用行号**。行号在模型输出与实际文件之间极易漂移（模型可能在两次 read 之间已修改文件），精确字符串匹配是更可靠的方式。

### 2. 乐观并发

编辑前不预检查文件是否被外部修改。直接尝试替换，`old_string` 找不到或不唯一时报错，模型重新 read 文件后重试即可。

### 3. 预览后确认

所有写操作在执行前生成 diff 预览，用户看过变更内容后再决定是否执行。确认流程为 agent loop 的内置步骤：

```
tool_call_start → preview (生成 diff) → onConfirm → execute
```

### 4. 原子写入

文件写入使用"临时文件 + rename"方式，防止崩溃时写一半。rename 在同文件系统内是原子操作。

### 5. 不备份

不创建 `.bak` 快照文件。用户依赖 git 管理变更历史，走 `git diff` / `git checkout` / `git revert` 查看和回滚。

---

## 工具定义

### write_file

| 属性 | 值 |
|------|------|
| 名称 | `write_file` |
| requiresConfirm | `true` |
| 参数 | `path` (string, required), `content` (string, required) |

**行为**：
- 文件不存在 → 创建新文件，diff 展示全部新增行
- 文件已存在 → 覆盖，diff 展示新旧差异
- 自动创建不存在的父目录（`mkdir -p`）
- 原子写入（写 tmp file → rename）

### edit_file

| 属性 | 值 |
|------|------|
| 名称 | `edit_file` |
| requiresConfirm | `true` |
| 参数 | `path` (string, required), `old_string` (string, required), `new_string` (string, required), `replace_all` (boolean, optional, default false) |

**行为**：
- `replace_all=false`（默认）→ 要求 `old_string` 在文件中唯一匹配，否则报错
- `replace_all=true` → 替换所有匹配项
- `old_string` 匹配数为 0 → 报错，提示文件可能已被修改
- 原子写入

**preview**：读取文件 → 内存中替换 → 生成 unified diff → 返回给 TUI 渲染

---

## Diff 实现

### 当前实现：系统 diff -u（`src/tools/diff.ts`）

使用 Linux `diff -u` 命令生成 unified diff。核心函数签名：

```typescript
async function unifiedDiff(
  oldText: string,
  newText: string,
  oldLabel?: string,  // 如 "a/src/foo.ts"
  newLabel?: string,  // 如 "b/src/foo.ts"
): Promise<string>
```

**执行机制——临时文件对比：**

磁盘上的文件从头到尾都不被修改。preview 阶段的操作全部在内存中完成，diff 通过临时文件进行：

```
edit_file preview 流程：

  磁盘 foo.ts                 内存                    /tmp/deepseek-diff-xxx/
  ──────────                 ────                    ───────────────────────
  const a = 1;   readFile    const a = 1;   写入    a 文件: const a = 1;
  const b = 2;  ─────────►   const b = 2;  ──────►              const b = 2;
  const c = 3;               const c = 3;                       const c = 3;
                                    │
                              old_string = "const b = 2;"
                              String.replace()  ← 仅在内存中
                                    │
                                    ▼
                              const a = 1;   写入    b 文件: const a = 1;
                              const b = 99;  ──────►           const b = 99;
                              const c = 3;                      const c = 3;
                                                          │
                                                    diff -u a b
                                                    --label a/foo.ts
                                                    --label b/foo.ts
                                                          │
                                                          ▼
                                                    unified diff 文本
                                                    (stdout 作为字符串返回)
                                                          │
                                                    立即 rm -rf 清理
```

**实现细节：**

1. `mkdtemp('/tmp/deepseek-diff-xxx')` 创建独立临时目录
2. `Promise.all([writeFile(a), writeFile(b)])` 并行写入两份内容
3. `execFile('diff', ['-u', '--label', oldLabel, oldPath, '--label', newLabel, newPath])` 执行对比
4. 根据 exit code 判断结果：
   - 0 → 内容相同，返回空字符串
   - 1 → 有差异，返回 diff 文本
   - ≥2 → diff 命令自身出错，抛出异常
5. `finally { rm(dir, { recursive: true }) }` 无论成功失败都清理临时目录

### write_file 的特殊情况

`write_file` 的 preview 根据文件是否存在有两种路径：

**文件不存在（新建）：**
```
旧内容 = ""（空字符串）
新内容 = 用户指定的完整内容
  ↓
diff -u /dev/null b   效果等价 → 全部行显示为新增（+ 前缀）
```

**文件已存在（覆盖）：**
```
旧内容 = readFile(磁盘文件)
新内容 = 用户指定的完整内容
  ↓
正常 diff 对比，展示全部变更
```

> 关键：无论是哪种情况，磁盘文件都没有被修改——preview 只读文件、在内存中处理、通过临时文件生成 diff。真正的写入只在用户确认后由 `execute()` 完成。

### 已弃用：LCS 自实现（`src/tools/line-diff.ts`）

> @deprecated — 保留归档，供参考。

之前使用最长公共子序列（LCS）动态规划算法自实现 diff。包含以下导出：

| 导出 | 说明 |
|------|------|
| `unifiedDiff(oldText, newText, oldLabel?, newLabel?, context?)` | 生成 unified diff 文本 |
| `generateDiffHunks(a, b, context?)` | 生成 DiffHunk 数组 |
| `DiffLine`, `DiffHunk` | 类型定义 |

**为什么弃用**：
- 系统 `diff -u` 更稳定，无 bug 风险
- LCS 时间复杂度 O(m×n)，大文件（几千行）可能 OOM
- 纯内存实现无法流式处理
- 边界情况（空文件、文件末尾缺换行符等）需要自己处理

代码仍保留以作参考，测试文件 `tests/tools/line-diff.test.ts` 也一并保留。

---

## Agent Loop 中的确认流程

在 `SessionManager.sendMessageStream()` 的 agent loop 中：

```
for each tool_call:
  1. onEvent('tool_call_start')   → TUI 渲染 [T: xxx] + 参数
  2. tool.preview(args)           → 生成 diff（仅内存，不写盘）
  3. onEvent('tool_preview')      → TUI 渲染着色 diff
  4. onConfirm(toolName, args)    → 用户看到 diff 后决定
     ├─ approve → tool.execute(args) → 实际写盘
     └─ deny    → 记录拒绝消息到上下文，终止 agent loop
  5. onEvent('tool_result')       → TUI 渲染执行结果
```

## TUI 渲染

diff 输出使用原生 unified diff 格式，按行前缀着色：

| 前缀 | 含义 | ANSI | 效果 |
|------|------|------|------|
| `+` | 新增行 | `\x1b[48;5;22m` | 深绿色背景 |
| `-` | 删除行 | `\x1b[48;5;52m` | 深红色背景 |
| `@@` | hunk header | `\x1b[2m` | dim（暗色） |
| `---` / `+++` | 文件头 | `\x1b[2m` | dim |
| 其他 | 上下文 | `\x1b[2m` | dim |

与 `tool_result` 不同，`tool_preview` 不加 ` │ ` 竖线前缀——diff 格式有自己的前缀体系，加额外装饰反而干扰阅读。

### 渲染效果示例

```
[T: edit_file] {"path":"src/tools/index.ts","old_string":"...","new_string":"..."}
--- a/src/tools/index.ts
+++ b/src/tools/index.ts
@@ -10,3 +10,5 @@
 export { shellTool } from './shell.js';
+export { writeFileTool } from './write-file.js';     ← 绿底
+export { editFileTool } from './edit-file.js';       ← 绿底
 export { readFileTool } from './read-file.js';

Apply changes? [y/N]
```

## 用户拒绝处理

当用户查看 diff 后拒绝执行（输入 `n`）：

1. 拒绝消息写入 `agentMessages`：`"The user rejected this operation. Do not retry the same approach. Explain the reason for the change and suggest an alternative, or ask the user for guidance."`
2. `agentMessages` 在下一轮 `buildMessages()` 中重建为上下文
3. 模型在后续对话中能感知"上次操作被拒绝"，不会重复同样方案
4. 截断消息区分场景：用户拒绝 → `(User denied the operation — stopping.)`，达到最大轮次 → `(Reached max tool rounds — stopping.)`

## 安全约束

所有文件修改工具复用 `src/tools/utils.ts` 中的 `checkPath()`：
- 路径必须在 `DEEPSEEK_ARCH_SESSION_CWD` 或其子目录内
- 不允许 `../` 跳出 workspace
- 不允许绝对路径访问 workspace 外部文件

## 文件清单

| 文件 | 角色 |
|------|------|
| `src/tools/types.ts` | Tool 接口（含 `preview?` 方法） |
| `src/tools/diff.ts` | 系统 diff -u 封装 |
| `src/tools/line-diff.ts` | 已弃用，LCS diff 归档 |
| `src/tools/edit-file.ts` | edit_file 工具 |
| `src/tools/write-file.ts` | write_file 工具 |
| `src/tools/index.ts` | Barrel file 注册 |
| `src/core/session.ts` | Agent loop 确认流程 |
| `src/types/chat.ts` | StreamEvent 类型（含 `tool_preview`） |
| `src/cli/tui/app.ts` | TUI diff 着色渲染 |
| `src/cli/tui/renderer.ts` | `renderDiffLine` / 背景色常量 |
| `tests/tools/line-diff.test.ts` | LCS diff 测试（归档） |
| `tests/tools/edit-file.test.ts` | edit_file 测试 |
| `tests/tools/write-file.test.ts` | write_file 测试 |
