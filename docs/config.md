# ConfigManager 设计

> 最后更新：2026-08-20 · 实现文件：`src/core/config.ts`

## 职责

1. 加载 `~/.deepseek-arch/config.toml` 主配置
2. 解析 `[paths]` 段的文件跳转引用，加载 providers/pricing/system-prompt 配置
3. 合并为完整的 `ResolvedConfig`
4. 提供点号路径取值 (`get`) 与覆写 (`set`)
5. 支持热重载 (`reload`)
6. 首次运行时自动创建默认配置文件（config.toml / providers.toml / pricing.toml / skill/）
7. **每次启动**检查 `system-prompt.toml`，缺失时从项目根 `system_prompt.txt` 生成默认模板快照（`ensureSystemPromptSnapshot`）

## 设计模式：Singleton

```typescript
const cfg = await ConfigManager.getInstance().load();
const apiKey = cfg.get("providers.deepseek.api_key");
```

- 私有构造函数，`static getInstance(configDir?)` 获取唯一实例
- `static resetInstance()` 用于测试隔离
- `load()` 幂等，已加载时直接返回

## 配置文件体系

### 主配置 (config.toml)

```toml
[paths]
providers = "./providers.toml"
pricing = "./pricing.toml"
system_prompt = "./system-prompt.toml"
sessions = "./sessions"

[defaults]
provider = "deepseek"
model = "deepseek-v4-pro"
system_prompt = "default"
```

### 文件跳转引用

`config.toml` 的 `[paths]` 段指向其他配置文件。ConfigManager 加载主配置后，解析每个 path（相对于 config.toml 目录），加载并合并。

```
config.toml  ──paths.providers──► providers.toml
             ──paths.pricing────► pricing.toml
             ──paths.system_prompt──► system-prompt.toml
```

### 供应商配置 (providers.toml)

```toml
[deepseek]
base_url = "https://api.deepseek.com"
api_key = "sk-xxx"
```

### 价格配置 (pricing.toml)

```toml
[deepseek."deepseek-v4-pro"]
input_cache_hit = 0.10    # ¥/1M tokens
input_cache_miss = 1.00
output = 2.00
currency = "CNY"
```

### System Prompt（system-prompt.toml 快照）

> **启动自动生成**：每次启动时 `ConfigManager.load()` 检查 `system-prompt.toml`，若不存在则从项目根
> `system_prompt.txt` 读取内容生成默认模板（`[default]`）快照（`ensureSystemPromptSnapshot`）。
> 运行时系统 prompt 一律以 `system-prompt.toml` 为准——不直接读 `system_prompt.txt`，也不直接用硬编码兜底。
> 因此：编辑项目根 `system_prompt.txt` 后需删除（或修改）`~/.deepseek-arch/system-prompt.toml` 才会在下次启动生效；
> 用户也可直接编辑 `system-prompt.toml` 自定义模板，并让 `defaults.system_prompt` 指向它。

```toml
[default]
content = "你是一个有用的AI助手..."
```

### 记忆配置（`config.toml` 的 `[memory]` 段）

跨会话记忆（偏好/约定/边界的自动归纳与注入）。设计依据与完整规则见
`plan/memory-heartbeat-design.md`（§4 生命周期、§6 注入、§10 配置）。

```toml
[memory]
enabled = true                 # 总开关（`/memory off` 与 CLI `--no-memory` 亦会关闭）
inject = true                  # 会话创建 / resume 首轮把清单注入 system prompt
max_inject_tokens = 800        # 清单注入预算（超出时用 recall_model 挑选相关行）
delta_inject_tokens = 200      # 会话内变化提醒预算
master_min_confidence = 2      # 主代理可见的最低置信度（建议保持 2；设 1 会让"候选区"概念失效）
recall_model = "deepseek-v4-flash"   # 召回/挑选用模型
agent_model = "deepseek-v4-flash"    # 后台归纳代理用模型
agent_on_turn_end = true       # 每轮用户消息后异步归纳
agent_min_interval_sec = 30    # 同会话两次归纳最小间隔
agent_max_writes_per_run = 3   # 单次归纳最多写 3 条（配额在工具层强制）
agent_max_input_turns = 3      # 归纳输入最多轮数（游标之后的保护上限）
agent_max_input_tokens = 6000  # 归纳输入 token 预算（同时决定 watchdog 上限 = ×3）
agent_timeout_ms = 90000       # 单次归纳最长时长
notify_read_updates = true     # 「你读过的条目被更新」是否提醒
lru_enabled = true             # LRU 维护总开关（档位升降级 + 窗口换出 + 容量淘汰 + 销毁）
lru_decay_active_days = 90     # 闲置超过该「活动日」数 → 置信度降一级（下限 1，闲置不会致销毁）
lru_promote_uses = 2           # 累计被读/被重申该次数且最近有使用 → 升一级
lru_window_size = 200          # 可见条目上限（超出按 LRU 把最久未用者降到 conf 1）
lru_total_limit = 400          # 记忆总量上限（可见+候选）；超限才把最久未用的候选降到 conf 0（待销毁）
lru_destroy_after_days = 180   # conf 0 的销毁期限（活动日）；期间被触达 → 回到 conf 1 重新观察
lru_destroy_mode = "archive"   # 销毁方式：archive（移入 legacy/archive/）或 delete（物理删除）
```

要点（细节见设计稿 §4）：

- **`confidence` 档位就是生命周期**：`3/2` = 可见；`1` = 待观察（不可见）；`0` = 待销毁。
- **时间单位是"活动日"**（程序实际被使用的天数）——**缺席不老化**，长期不启动程序不会一次性清空。
- **闲置不致死**：闲置最多降到 `1`；只有 `lru_total_limit` 超限（真的装不下）才会出现 `0`。
- **`--no-memory`（CLI）与 `/memory off`（TUI）** 都可即时关闭：不注入、不归纳、并从工具集中剔除
  `memory_read`/`memory_write`（`--no-memory` 还会避免创建任何记忆 runtime 文件）。
- 命令面：`/memory`（状态）、`/memory show [kw]`、`/memory candidates`（待观察 / ⏳待销毁）、
  `/memory gc [--dry-run]`、`/memory pin|unpin <slug>`、`/memory forget <slug>`、`/memory refresh`。

## API

| 方法 | 说明 |
|------|------|
| `getInstance(dir?)` | 获取单例 |
| `load()` | 加载配置（幂等），首次运行自动创建默认文件 |
| `reload()` | 热重载所有配置文件 |
| `get<T>(path)` | 点号路径取值，如 `"providers.deepseek.base_url"` |
| `set(path, value)` | 设置配置值并持久化回对应文件 |
| `getResolved()` | 获取完整已解析配置（只读） |
| `getConfigDir()` | 获取配置目录路径 |
| `getSessionsDir()` | 获取会话存储目录完整路径 |

## `set()` 的路径分发

```
set("defaults.model", "deepseek-chat")  → config.toml
set("providers.deepseek.api_key", "x")  → providers.toml
set("pricing.deepseek.xxx.output", 3.0) → pricing.toml
```

`fileMap` 记录了每个顶层键对应的文件和路径剥离策略：

```typescript
const fileMap = {
  paths:        { file: 'config.toml',        stripRoot: false },
  defaults:     { file: 'config.toml',        stripRoot: false },
  providers:    { file: './providers.toml',    stripRoot: true },
  pricing:      { file: './pricing.toml',      stripRoot: true },
  systemPrompts:{ file: './system-prompt.toml',stripRoot: true },
};
```

- `stripRoot: false` — config.toml 内含多个子表，写入时保留完整路径（如 `defaults.model`）
- `stripRoot: true` — 独立文件顶层即对应数据，写入时剥离根键（如 `providers.xxx` → `xxx`）

## 安全

- 配置目录权限：`0o700`
- 配置文件权限：`0o600`
- api_key 明文存储，用户自行管理权限

## 测试

12 个单元测试覆盖：单例、首次加载（默认值）、幂等性、get（嵌套/不存在/未加载）、set（持久化+跨实例验证）、reload、getSessionsDir。
