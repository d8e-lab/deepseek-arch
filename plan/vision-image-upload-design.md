# 视觉图片上传（base64 内联）设计

> 参考：DeepSeek《图像理解》文档 — Base64 编码图片（内联）与限制章节
> 目标版本：v2.1.0

## 1. 目标与非目标

**目标**

- 用户把本地图片交给模型，走文档中的 **方式 1：Base64 内联 data URL**（`content` 为块数组）。
- 三种入口（用户已确认）：
  1. `/image <路径>` 斜杠命令 → 附加到待发消息；
  2. 消息文本内联 `@路径` 自动识别；
  3. 终端拖拽/粘贴产生的路径文本自动识别。
- 完整落地文档「限制」表：格式、单图体积、请求体体积、图片数量、像素尺寸。
- 图片只出现在 `user` 消息中（`system`/`assistant` 带图会 400）。

**非目标**

- 外部 `http(s)` URL 与 Files API `file_id`（后续可加，接口预留）。
- 图片上传进度条 / 缩略图渲染（终端能力有限，只显示文件名与体积）。
- 自动压缩、缩放、转码（超限直接拒绝并给出可执行的提示）。

## 2. 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 领域模型 | `Message.content` 保持 `string`，图片走旁路字段 `Message.images?: ImageAttachment[]` | 标题推导、compact 摘要、记忆归纳、TUI 渲染等 30+ 处都按字符串消费 content；把图片做成「附件」而非「内容联合类型」，改动面收敛在类型边界 |
| 上线报文 | 新增 `ApiMessage`（`content: string \| ApiContentBlock[]`），由 `materializeMessages()` 在调用 provider 前生成 | 适配器边界唯一：只有 `ApiClient` 关心 OpenAI 兼容结构；持久化/领域层不受影响 |
| 字节存储 | 复制到 `<sessionDir>/images/<sha256>.<ext>`，`turns.json` 只存引用与元数据 | 单图上限 32 MiB，base64 内联进 turns.json 会让会话文件膨胀数十 MB；内容寻址天然去重，会话自包含（原文件删除/移动不影响历史轮次） |
| 编码时机 | 每次请求前从资产目录读取并 base64 编码 | 同一文件字节稳定 → data URL 稳定 → 命中供应商 KV 前缀缓存；避免内存里常驻大字符串 |
| 路径解析 | `@路径`（任意相对/绝对）、`~/路径`、`file://`、绝对路径；**相对裸路径不自动识别** | 避免「讨论仓库里的 `logo.png`」被误判为附件；拖拽产物一定是绝对路径 |
| 视觉模型 | 默认模型改为 `deepseek-flash`；非视觉模型带图发送时告警但不拦截 | 用户决策：默认即视觉模型；`/model` 切走后仍要能自我解释失败原因 |

## 3. 模块划分

```
src/types/image.ts        ImageAttachment / ImageMime / ImageDetail（持久化契约）
src/types/api.ts          ApiContentBlock / ApiMessage（上线契约）
src/core/image.ts         ImageError、格式嗅探、尺寸解析、限制常量、ImageStore、materializeMessages
src/core/image-refs.ts    文本 → 图片路径扫描（@路径 / 拖拽路径 / 引号 / 转义空格）
src/utils/message-text.ts ApiMessage.content（可能是块数组）→ 纯文本提取
```

依赖方向：`image-refs` →（文件系统）；`image` →（`types`、`storage` 的目录约定）；`session` → `image` + `image-refs`。

### 3.1 数据契约

```ts
interface ImageAttachment {
	path: string;        // 相对会话目录：images/<sha256>.<ext>
	mime: ImageMime;     // image/jpeg | image/png | image/gif | image/webp
	bytes: number;       // 原始字节数
	sha256: string;      // 内容寻址（去重键）
	name: string;        // 展示用文件名
	width?: number;      // 像素（解析失败则缺省）
	height?: number;
}
```

`turns.json` 中一条带图用户消息：

```json
{ "role": "user", "content": "这张图里有什么？",
  "images": [{ "path": "images/9f2c….png", "mime": "image/png", "bytes": 184320,
               "sha256": "9f2c…", "name": "screenshot.png", "width": 1280, "height": 720 }] }
```

上线时物化为：

```json
{ "role": "user", "content": [
  { "type": "text", "text": "这张图里有什么？" },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } } ] }
```

### 3.2 限制落地

| 文档限制 | 常量 | 校验时机 |
|----------|------|----------|
| 支持 JPEG/PNG/GIF/WebP（按内容判定） | `SUPPORTED_IMAGE_MIMES` | attach（魔数嗅探，拒绝伪装扩展名） |
| 单图 ≤ 32 MiB | `MAX_IMAGE_BYTES` | attach |
| 请求体 ≤ 48 MiB | `MAX_REQUEST_BODY_BYTES` | materialize（按 base64 膨胀 4/3 估算整包） |
| 单请求 ≤ 600 张 | `MAX_IMAGES_PER_REQUEST` | materialize |
| 单请求图片总大小 ≤ 64 MiB | `MAX_TOTAL_IMAGE_BYTES` | materialize |
| 单边 ≤ 8192 px（≥15 张时 4096） | `MAX_IMAGE_DIMENSION(_MANY)` | attach + materialize |

超限抛 `ImageError`，消息里带人类可读的数值与建议（如「改用 Files API / 减少图片」）。

## 4. 关键流程

**附加（`/image a.png` 或发送时扫描）**

```
路径 → realpath/存在性 → 读文件 → 嗅探魔数 + 解析尺寸
     → 限制校验 → sha256 → 复制到 <sessionDir>/images/<sha>.ext（已存在则复用）
     → 返回 ImageAttachment（进 pendingImages 或直接进本轮 userMsg.images）
```

**发送**

```
sendMessageStream(text, …, images)
  ├─ userMsg = { role:'user', content:text, images }   ← 落盘时只存引用
  ├─ baseMessages = buildMessages(text)                ← 历史轮次含各自的 images
  ├─ apiBase = materializeMessages(baseMessages, sessionDir)   ← 读盘 + base64 + 整包限额
  └─ 每轮 provider.chatStream([...apiBase, ...agentMessages, statusBlock])
        └─ ApiClient 直接序列化 ApiMessage（块数组原样上线）
```

**自动 compact 之后**：重建并**重新物化** baseMessages（`baseMessages` 清空重填），保证新前缀仍是块数组。

**compact 摘要 / 记忆归纳 / 子代理**：只消费文本（`turnUserContent`、`serializeTurns`），不物化图片 —— 摘要不含图片字节，token 成本可控。

## 5. 失败与降级

| 场景 | 行为 |
|------|------|
| 路径不存在 / 不是图片 / 格式不支持 | `/image` 报错；内联扫描静默忽略（该 token 当普通文本） |
| 资产文件缺失（会话被手工改动） | 跳过该图并在该消息追加 `[image unavailable: name]` 文本块，不阻断整轮 |
| 单图 > 32 MiB、请求体 > 48 MiB、> 600 张 | 抛 `ImageError`，TUI 以 error 事件呈现并保留待发附件 |
| 当前模型非视觉模型 | 附加/发送时黄色告警，提示 `/model deepseek-flash`；不拦截 |

## 6. 测试计划

| 文件 | 覆盖 |
|------|------|
| `tests/core/image.test.ts` | 四种格式魔数嗅探（含伪装扩展名）、尺寸解析、各限额边界、ImageStore 落盘/去重/缺失、materialize 块结构与预算、isVisionModel |
| `tests/core/image-refs.test.ts` | `@相对`、`@绝对`、引号、`\ ` 转义、`~/`、`file://`、非图片扩展、相对裸路径不识别、重复去重 |
| `tests/core/session-image.test.ts` | 带图 `sendMessageStream` → provider 收到块数组；turn 落盘只有引用不含 base64；resume 后重放仍能物化；缺资产降级 |

## 7. 文档同步

- `docs/vision-images.md`：用户视角（三种入口、限额表、常见错误）。
- `docs/types.md`：`Message.images` / `ApiMessage` / `ImageAttachment`。
- `README.md`：特性列表 + 更新日志。
- `docs/config.md` / `agent.md`：默认模型变更说明。
