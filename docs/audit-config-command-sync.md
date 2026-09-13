# 配置 ↔ 命令 ↔ 配置文件 同步缺口审计报告

> 审计日期：2026-08-19 · 基线 commit：main（v1.4.1）
> 范围：`src/core/config.ts`、`src/cli/index.ts`、`src/presentation/tui-app.ts`、`src/core/session.ts`、`src/core/skill.ts`、`src/tools/*.ts`、`src/types/config.ts`
> 结论先行：**全项目只有 1 个配置写回点（`/model` → `defaults.model`），9 个斜杠命令中有 2 个改内存不落盘，8 个 CLI 选项 / 4 个环境变量无配置文件对应项，pricing.toml 整表未被运行时消费。**

---

## 1. 配置项总表

配置体系：`config.toml`（paths/defaults）+ `providers.toml` + `pricing.toml` + `system-prompt.toml`，由 `ConfigManager.load()` 合并（`src/core/config.ts:199-252`）。读取全部集中在 `src/cli/index.ts` 的 `createTuiConfig()` 与 `createSessionManager()`；**除 `defaults.model` 外无任何运行期写回**。

| 配置键 | 含义 | 读取位置（文件:行） | 可修改途径 |
|---|---|---|---|
| `paths.providers` | providers.toml 跳转引用 | config.ts:231, 297 | 仅手改 config.toml |
| `paths.pricing` | pricing.toml 跳转引用 | config.ts:232, 298 | 仅手改 config.toml |
| `paths.system_prompt` | system-prompt.toml 跳转引用 | config.ts:233, 299 | 仅手改 config.toml |
| `paths.sessions` | 会话存储目录 | config.ts:343-344（`getSessionsDir()`，被 cli/index.ts:65,148,190,233 及 tui-app.ts:730 间接调用） | 仅手改 config.toml |
| `defaults.provider` | 默认供应商 | cli/index.ts:43 | 仅手改 config.toml |
| `defaults.model` | 默认模型 | cli/index.ts:44 | **`/model` 命令写回**（tui-app.ts:530）+ 手改 |
| `defaults.system_prompt` | system prompt 模板名 | cli/index.ts:80 | 仅手改 config.toml |
| `defaults.review_model` | ~~YOLO 审查模型~~ **已移除（2026-09-13，reviewer 删除）** | — | 配置键已不再读取（旧 config.toml 中的该键被忽略） |
| `providers.<name>.base_url` | 供应商 API 地址 | cli/index.ts:45 | 仅手改 providers.toml |
| `providers.<name>.api_key` | API 密钥 | cli/index.ts:46 | 仅手改 providers.toml |
| `systemPrompts.<name>.content` | system prompt 内容 | cli/index.ts:81 | 仅手改 system-prompt.toml |
| `pricing.<provider>.<model>.*` | 价格（input_cache_hit/miss/output/currency） | **无任何读取者**（见 §4-G） | 仅手改 pricing.toml |

## 2. 斜杠命令总表

命令常量：`src/presentation/tui-app.ts:62`（`AVAILABLE_COMMANDS`）；分发：`handleCommand()` tui-app.ts:451-522；帮助文案 tui-app.ts:545-556。

| 命令 | 参数 | 行为 | 写回配置？ |
|---|---|---|---|
| `/model [name]` | 可选模型名；缺省弹选择器 | 切换模型：`this.config.model` + `sessionMgr.setModel()` + **`configMgr.set('defaults.model', ...)`**（tui-app.ts:457-479, 524-536） | ✅ `defaults.model`（tui-app.ts:530） |
| `/help` | 无 | 显示命令列表（tui-app.ts:481-483, 538-564） | ❌ |
| `/context` | 无 | 显示会话上下文/Token/费用（tui-app.ts:485-487, 566-624） | ❌ |
| `/yolo` | 无 | 切换 YOLO：仅翻转内存 `this.yolo`（tui-app.ts:489-491, 651-660） | ❌ **仅内存** |
| `/async` | 无 | 切换子代理异步：翻转内存 `this.asyncMode` + `sessionMgr.setSubagentAsync()`（tui-app.ts:493-495, 662-674；session.ts:180-186 也仅内存） | ❌ **仅内存** |
| `/subagent_cancel` | 无 | 交互式取消子代理（tui-app.ts:497-500, 676-717） | ❌ |
| `/subagent [name]` | 可选子代理名 | 列表/详情（tui-app.ts:502-505, 719-790） | ❌ |
| `/compact` | 无 | 压缩会话上下文（tui-app.ts:507-509, 626-649） | ❌ |
| `/exit` | 无 | 退出会话（tui-app.ts:511-515） | ❌ |

**注意**：`/model` 的合法值被硬编码 `AVAILABLE_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']`（tui-app.ts:59），且 `includes(arg)` 校验（tui-app.ts:459）——若配置中 `defaults.model` 或 pricing.toml 含其他模型，无法通过 `/model` 切换或切回。

## 3. CLI 选项与环境变量总表

### 3.1 CLI 子命令与选项（`src/cli/index.ts`）

| 子命令 | 选项 | 定义位置 | 落盘？ |
|---|---|---|---|
| `chat` | `-r/--resume <id>` `--yolo` `--browser` `--cdp <url>` `--async` `--debug` `--self-interaction` `--mock` `--monitor <url>` | cli/index.ts:112-120 | 均不落盘 |
| `resume [id]` | `--browser` `--cdp` `--async` `--debug` `--self-interaction` `--mock` `--monitor`（**缺 `--yolo`**） | cli/index.ts:223-229 | 均不落盘 |
| `clear` | 无 | cli/index.ts:184-218 | — |
| `api-monitor` | `-p/--port`（默认 8899）`-o/--out`（默认 {workspace}/.deepseek-arch/api-requests） | cli/index.ts:339-367 | — |
| `completion [bash\|zsh]` | 位置参数 | cli/index.ts:463-474 | — |

### 3.2 环境变量

| 变量 | 读取位置 | 用途 | 配置对应项 |
|---|---|---|---|
| `DEEPSEEK_API_MONITOR_URL` | cli/index.ts:126, 235 | `--monitor` 的兜底 | ❌ 无 |
| `BROWSER_CDP` | tools/browser-state.ts:172 | `--cdp` 的兜底 | ❌ 无 |
| `BROWSER_HEADED` | tools/browser-state.ts:205 | `--browser` 的兜底（`=== '1'`） | ❌ 无 |
| `NO_PROXY` / `no_proxy` | tools/browser-state.ts:176, 179 | CDP 代理绕过 | ❌ 无 |
| `https_proxy` / `HTTPS_PROXY` | tools/browser-state.ts:206 | 浏览器代理 | ❌ 无 |
| `DEEPSEEK_ARCH_SESSION_CWD` | session.ts:99-100 及 tools/shell.ts:92、read-file.ts:54、write-file.ts:53,83、edit-file.ts:70,116、search-content.ts:124、browser-state.ts:168 等 | 会话基准目录（由 SessionManager 自动设置） | ❌ 无 |
| `SHELL` | cli/index.ts:468 | completion 默认 shell | ❌ 无 |
| `USER` / `USERNAME` | core/system-info.ts:80 | system prompt 环境信息 | ❌ 无 |
| `DEEPSEEK_API_KEY` | **仅 cli/index.ts:137 错误提示文案**，从未被真正读取 | 文档声称可用，实现缺失 | ⚠️ 见 §4-D |

## 4. 缺口清单

### a. 存在于配置但无法通过斜杠命令修改

| 配置键 | 证据 | 建议 |
|---|---|---|
| `defaults.provider` | 读取 cli/index.ts:43，无任何写点 | 新增 `/provider [name]`，调用 `configMgr.set('defaults.provider', name)`（ConfigManager.set 已支持，config.ts:294-300） |
| `defaults.system_prompt` | 读取 cli/index.ts:80，无写点 | 新增 `/system <name>` 切换模板并 `set('defaults.system_prompt', name)`；`/system list` 枚举 `systemPrompts` 键 |
| `defaults.review_model` | 读取 cli/index.ts:48，无写点，且**类型缺失**（types/config.ts:42-47 `ConfigDefaults` 只有 provider/model/system_prompt 三项） | ① 补 `review_model?: string` 到 `ConfigDefaults`；② 新增 `/review_model <name>` 或并入 `/model --review`，调用 `set('defaults.review_model', name)` |
| `providers.*.base_url / api_key` | 读取 cli/index.ts:45-46，无写点 | 新增 `/provider` 命令支持子参数（如 `/provider set deepseek --base-url --api-key`）；至少提供 `/apikey` 命令 → `set('providers.<name>.api_key', ...)` |
| `systemPrompts.*.content` | 读取 cli/index.ts:81，无写点 | 文件本质是长文本，建议仅支持 `/system edit`（打开编辑器）而非 set() |
| `paths.*` | config.ts:231-233, 297-299 | 不建议提供命令（移动文件需同步迁移），保持手改 |

### b. 斜杠命令修改了但未写回配置文件（仅内存）

| 命令 | 证据 | 建议 |
|---|---|---|
| `/yolo` | tui-app.ts:652-660 只翻转 `this.yolo`；构造函数 `yolo ?? false`（tui-app.ts:148）；CLI `--yolo`（cli/index.ts:113）也不落盘 | ① `defaults` 增加 `yolo?: boolean`；② `toggleYolo()` 里 `configMgr.set('defaults.yolo', this.yolo)`；③ 初始化时 `cfg.get('defaults.yolo')` 作为兜底（cli/index.ts createTuiConfig 或 TuiApp 构造） |
| `/async` | tui-app.ts:663-674 只翻转内存 + `sessionMgr.setSubagentAsync()`（session.ts:180-186 无持久化）；`asyncMode` 初始来自 CLI `--async`（cli/index.ts:123） | 同上：`defaults.async?: boolean` + `configMgr.set('defaults.async', this.asyncMode)` |

### c. 运行时可变但重启后丢失的项

| 项 | 证据 | 说明 |
|---|---|---|
| YOLO 模式 | §4-b `/yolo` 仅内存 | 重启后回到 `--yolo` 或缺省 false |
| 子代理异步模式 | §4-b `/async` 仅内存 | 重启后回到 `--async` 或缺省 false |
| reviewModel | 无任何命令修改；读取 cli/index.ts:48 后仅存 TuiConfig（tui-app.ts:150） | 虽可写配置，但无法在会话内变更，重启后沿用旧值 |
| 会话内模型 | `/model` 已写回 `defaults.model`（tui-app.ts:530），**不丢** | — |

### d. CLI 选项与环境变量覆盖配置但配置文件中无对应项

| 项 | 证据 | 建议 |
|---|---|---|
| `--monitor <url>` / `DEEPSEEK_API_MONITOR_URL` | cli/index.ts:126, 235 → api.ts mirrorUrl（api.ts:42-46, 66-69） | 属调试通道，可不落盘；若要落盘需新增 `monitor.url` 配置段并在 api.ts 读取（当前 ApiClient 为构造注入，与 ConfigManager 解耦，改动面大，建议保持现状并文档化） |
| `--browser` / `BROWSER_HEADED`、`--cdp` / `BROWSER_CDP` | browser-state.ts:172, 205（configureBrowser 仅内存全局，browser-state.ts:29-33） | 建议新增 `browser.headed?: boolean`、`browser.cdp_url?: string` 配置段，createTuiConfig 时读入并传给 `configureBrowser`，优先级 CLI > 配置 > 环境变量 |
| `--debug` / `--self-interaction` / `--mock` | cli/index.ts:117-119, 142, 158-176 | 开发/调试开关，可不落盘；建议文档标注"仅会话级" |
| `--async` / `--yolo` | 见 §4-b（建议落盘到 `defaults`） | 同上 |
| `DEEPSEEK_API_KEY` | **文档与实现不符**：cli/index.ts:135-139 报错提示"set DEEPSEEK_API_KEY env var"，但 apiKey 只来自 `providers.<name>.api_key`（cli/index.ts:46），`DEEPSEEK_API_KEY` 全库无 `process.env.DEEPSEEK_API_KEY` 读取 | 二选一：① 在 createTuiConfig 中补 `cfg.get(...api_key) || process.env.DEEPSEEK_API_KEY` 兜底；② 删除/修改误导性提示文案 |

## 5. 其他架构不一致（附）

| 项 | 证据 | 说明 |
|---|---|---|
| **pricing.toml 整表未被运行时消费** | pricing 读取点仅 config.ts:232, 236, 246, 298（加载/合并/写回）；`cost_rmb` 在 session.ts:415、1149 硬编码为 `0` | 费用恒 0（tui-app.ts:293, 620 显示 ¥0.0000），pricing 表纯摆设。若需计费：在 session.ts 计算处按 `pricing.<provider>.<model>` 与 usage（cache_hit/miss/output）计算 |
| `defaults.review_model` 类型缺失 | 读取 cli/index.ts:48；`ConfigDefaults`（types/config.ts:42-47）无此字段 | `get<string>` 动态取值可运行，但类型/文档失真，易被重构误删 |
| 模型白名单硬编码 | `AVAILABLE_MODELS`（tui-app.ts:59）与 `includes` 校验（tui-app.ts:459） | 与配置中的 `providers`/`pricing` 模型集脱节；建议从 `pricing.<provider>` 的模型键动态生成候选列表 |
| `resume` 缺 `--yolo` | chat 选项含 `--yolo`（cli/index.ts:113），resume 选项无（cli/index.ts:223-229），resume 分支 TuiApp 传 `undefined`（cli/index.ts:259, 322） | chat/resume 能力不对称；若 §4-b 落盘后此差异影响减小，但当前一致性问题仍在 |
| shell 补全与实际选项脱节 | bash 补全仅列 `--resume --yolo --browser --cdp --async`（cli/index.ts:391）；zsh 补全同样缺 `--debug --self-interaction --mock --monitor`（cli/index.ts:437-443） | 补全列表落后于真实选项 |
| skill 目录硬编码 `DEFAULT_CONFIG_DIR` | skill.ts:254 `resolve(DEFAULT_CONFIG_DIR, 'skill')`，而 ConfigManager 支持自定义 configDir（config.ts:148-150, 338-340） | CLI 未暴露 `--config-dir`，实际无影响；但若未来支持自定义配置目录，skill 加载会指向错误位置 |
| `ConfigManager.set` 能力远大于使用面 | set 支持 paths/defaults/providers/pricing/systemPrompts 五段并落盘对应文件（config.ts:281-319, 294-300），测试覆盖 set（tests/core/config.test.ts:99, 113, 129） | 基础设施完备，只缺命令层接线——上述 a/b 缺口补法均无需改 ConfigManager |

## 6. 缺口补法汇总（按优先级）

| 优先级 | 动作 | 涉及文件 |
|---|---|---|
| P0 | 补 `DEEPSEEK_API_KEY` 环境变量兜底或修正提示文案 | cli/index.ts:135-139 |
| P0 | `/yolo`、`/async` 写回 `defaults.yolo` / `defaults.async`，初始化读取 | tui-app.ts:651-674, 148；cli/index.ts:113, 123；types/config.ts |
| P1 | 新增 `/provider [name]` 与 `/system [name]`（含 list），写回 `defaults.provider` / `defaults.system_prompt` | tui-app.ts handleCommand + AVAILABLE_COMMANDS；cli/index.ts:80 |
| P1 | 补 `defaults.review_model` 类型 + 新增 `/review_model` 或并入 `/model` | types/config.ts:42-47；tui-app.ts:457-479 |
| P1 | 模型候选列表改从配置（pricing/providers 键）动态生成 | tui-app.ts:59, 459 |
| P2 | 新增 `browser.headed` / `browser.cdp_url` 配置段 | browser-state.ts:29-33, 172, 205；cli/index.ts:130-133 |
| P2 | `resume` 补 `--yolo`；补全脚本同步选项 | cli/index.ts:223-229, 391, 437-443 |
| P3 | pricing 计费接线（session.ts:415, 1149 处按 pricing 计算 cost_rmb） | session.ts、core/pricing 读取 |
