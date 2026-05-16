# ConfigManager 设计

> 最后更新：2026-05-17 · 实现文件：`src/core/config.ts`

## 职责

1. 加载 `~/.deepseek-arch/config.toml` 主配置
2. 解析 `[paths]` 段的文件跳转引用，加载 providers/pricing/system-prompt 配置
3. 合并为完整的 `ResolvedConfig`
4. 提供点号路径取值 (`get`) 与覆写 (`set`)
5. 支持热重载 (`reload`)
6. 首次运行时自动创建默认配置文件

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
input_cache_hit = 0.10
input_cache_miss = 1.00
output = 2.00
currency = "CNY"
```

### System Prompt (system-prompt.toml)

```toml
[default]
content = "你是一个有用的AI助手..."
```

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
