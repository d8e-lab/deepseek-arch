# 图片输入（视觉 / base64 内联）

> 参考：DeepSeek API 文档《图像理解》——Base64 编码图片（内联）与限制
> 设计决策见 `plan/vision-image-upload-design.md`

`deepseek-flash` 支持图片输入：把本地图片交给模型，可以描述图片、识别截图中的文字、分析图表。
本项目的实现走文档中的**方式 1：Base64 编码图片（内联 data URL）**，无需图床、无需 Files API。

## 三种使用方式

### 1. `/image <路径>` 命令（TUI 推荐）

```
/image /tmp/shot.png            附加单张
/image a.png b.jpg              一次附加多张（相对路径以会话工作目录为基准）
/image                          查看待发列表
/image remove 2                 移除第 2 张
/image clear                    清空待发列表
```

附加成功后，输入区上方会提示 `Pending: N image(s)`，这些图片随**下一条消息**一起发送；
发送成功即出队（发送失败或超限时保留，便于修正后重发）。

### 2. 消息内联 `@路径`

直接写在消息里，发送时自动识别（图片仍按原样随消息发出）：

```
看看这张图 @/tmp/shot.png 里有什么
@"带 空格的图.png" 是什么颜色
@~/Pictures/chart.webp 分析一下趋势
```

### 3. 终端拖拽 / 粘贴路径

终端里拖入文件会插入**绝对路径**文本，发送时自动识别：

```
/tmp/screenshot-2026-10-05.png 识别里面的文字
```

也支持 `file://` 前缀、引号包裹、`\ ` 转义空格（`/tmp/my\ shot.png`）。

> **相对裸路径不会自动识别**（例如正文里提到 `assets/logo.png`），避免普通对话被误判成附件；
> 需要相对路径时用 `@` 显式声明，或用 `/image` 附加。

非 TUI 的单轮模式同样支持内联写法：

```bash
deepseek-arch chat --prompt "描述这张图 @/tmp/a.png" --workspace . --no-memory
```

## 存储：会话资产目录

图片字节**不会写进 `turns.json`**，而是内容寻址地复制到会话目录：

```
~/.deepseek-arch/sessions/<session-id>/
├── images/
│   └── <sha256>.png        # 0600 权限；同一张图重复附加只占一份
├── turn_0.json             # 只存引用与元数据（path/mime/bytes/sha256/name/width/height）
└── meta.json
```

```json
{
  "role": "user",
  "content": "这张图里有什么？",
  "images": [
    { "path": "images/9f2c….png", "mime": "image/png", "bytes": 184320,
      "sha256": "9f2c…", "name": "screenshot.png", "width": 1280, "height": 720 }
  ]
}
```

发送时才读出字节并编码为 `data:image/png;base64,…` 内容块。好处：

- 会话文件不会被几十 MB 的 base64 撑爆（单图上限 32 MiB）；
- 原文件删除、移动、改名都不影响历史轮次（副本在会话里）；
- 同一文件字节稳定 → data URL 稳定 → 不破坏供应商侧的前缀 KV 缓存。

## 限制（与官方文档一致）

| 限制项 | 数值 | 本项目行为 |
|---|---|---|
| 支持格式 | JPEG、PNG、GIF、WebP | 按**文件内容**魔数判定，扩展名只用于预筛；伪装扩展名会被拒绝 |
| 外部 URL 长度 | 8192 字符 | 不适用（本实现走内联） |
| 请求体大小 | 48 MiB | 发送前按 base64 膨胀估算，超限直接报错并保留待发附件 |
| 单张图片（base64 / URL） | 32 MiB | `/image` 附加时即拒绝 |
| 单张图片（Files API `file_id`） | 64 MiB | 未实现（内联路径不适用） |
| 单请求图片张数 | 600 | 物化前校验 |
| 单请求图片总量 | 不含 `file_id` 最多 64 MiB | 物化前校验 |
| 图片最大尺寸 | 单边 8192 px；≥15 张时 4096 px | 附加时校验 8192；发送时按张数收紧到 4096 |
| 图片位置 | 仅 `user` 消息 | 领域模型只允许 user 消息携带 `images` |

超限时的错误信息包含实际数值与建议（如改用更小的图 / 减少张数）。

## 细节级别

`image_url` 支持 `detail` 字段（`low` / `high` / `original` / `auto`）。
当前 UI 未暴露该开关，默认按原图处理（等价 `auto`/`original`）；`ImageAttachment.detail` 字段已预留，
后续加 `/image --detail low` 之类的开关即可生效。

## 模型要求

图片只能由支持视觉的模型处理（文档中的 `deepseek-flash`）。
默认模型已经是 `deepseek-flash`，因此开箱即可发送图片。

如果用 `/model` 切到了非视觉模型，附加/发送时会给出黄色告警（不阻断发送，供应商侧会返回 400）。
告警依据 `defaults.vision_models` 名单（缺省 `["deepseek-flash", "deepseek-v4-flash-vision-exp"]`），
模型名中含 `vision` 的也会被认作视觉模型。

## 降级与容错

| 场景 | 行为 |
|---|---|
| 路径不存在 / 不是图片 | 内联写法静默忽略（该片段仍作为普通文本）；`/image` 直接报错 |
| 格式不支持 / 超过 32 MiB / 单边超 8192 px | `/image` 报错且不附加；内联识别跳过并提示原因 |
| 资产文件被手工删除 | 该消息降级为 `[image unavailable: <name>]` 文本块，不阻断整轮 |
| 超过请求体 / 张数 / 总量限制 | 发送前抛错，界面显示 `Error: ...`，待发附件保留 |

## 相关代码

| 模块 | 职责 |
|---|---|
| `src/core/image.ts` | 格式嗅探、尺寸解析、限制常量、`ImageStore`、`materializeMessages` |
| `src/core/image-refs.ts` | 文本 → 图片路径扫描（`@路径` / 拖拽路径 / 引号 / 转义空格） |
| `src/core/session.ts` | `attachImage` / `resolveInlineImages`，发送前物化，落盘引用 |
| `src/types/image.ts` | `ImageAttachment`（持久化契约） |
| `src/types/api.ts` | `ApiMessage` / `ApiContentBlock`（上线契约） |
| `src/utils/message-text.ts` | 从内容块中提取纯文本（MockProvider 等消费方） |
| `src/presentation/tui-app.ts` | `/image` 命令、待发列表、内联识别、视觉模型告警 |

## 测试

```bash
npx vitest run tests/core/image.test.ts tests/core/image-refs.test.ts tests/core/session-image.test.ts
```

- `image.test.ts`：四种格式嗅探与尺寸解析、各限额边界、`ImageStore` 落盘/去重、`materializeMessages` 块结构与预算
- `image-refs.test.ts`：`@相对`/`@绝对`/引号/转义空格/`~/`/`file://`、标点剥离、相对裸路径不识别、去重
- `session-image.test.ts`：附加 → 物化 → 落盘只存引用 → resume 重放 → 资产缺失降级 → 限流报错
