# DeepSeek Arch v2.1.0

> 现在可以直接把图片交给模型了：截图、图表、报错界面，拖进来就能问。

## 🖼️ 让模型看图

三种方式把本地图片发给模型，不需要图床、不需要上传到别处：

**1. `/image` 命令（推荐）**

```
/image /tmp/shot.png          附加一张
/image a.png b.png            一次附加多张
/image                        查看待发列表
/image clear                  清空
```

附加后图片随**下一条消息**一起发送；发送成功自动出队，失败会保留给你重试。

**2. 直接写在消息里**

```
看看这张图 @/tmp/shot.png 里有什么
@~/Pictures/chart.webp 分析一下趋势
```

**3. 终端拖拽**

把文件拖进终端，路径会插到输入框里，发送时自动识别：

```
/tmp/screenshot-2026-10-05.png 识别里面的文字
```

也支持带空格的路径（引号包裹或 `\ ` 转义）与 `file://` 链接。
非交互模式同样可用：`deepseek-arch chat --prompt "描述这张图 @/tmp/a.png" --workspace .`

## 🔒 自动守住官方限额，也不会撑爆会话

- 只接受 **JPEG / PNG / GIF / WebP**，并且按**文件内容**判断——把 `.txt` 改名成 `.png` 会被拒绝
- 超限直接告诉你原因：单张 >32 MiB、一次请求 >48 MiB、单次 >600 张、图片总量 >64 MiB、单边 >8192 像素（一次 15 张以上时上限收紧为 4096）
- 图片不会塞进会话文件：按内容存进会话目录，**同一张图重复发送只占一份**；原图删掉、改名字都不影响历史对话
- 一次请求的图片会按尺寸折算 token（每张最多约 1024），发大图前心里有数

## ⚙️ 默认模型改为 `deepseek-flash`

`deepseek-flash` 是支持图片输入的视觉模型，已设为默认。想换回纯文本模型用 `/model`；
如果切到了不支持图片的模型，附加图片时会给出提示（不阻断发送，服务端会拒）。

## 🔧 其它改进

- 相对路径不会被误判：正文里提到 `assets/logo.png` 不会当成附件，需要相对路径时用 `@` 前缀显式声明
- 会话视图里带图的消息会显示 `[image: 文件名]`，一眼能看出哪轮带了图
- 历史对话中的图片在继续对话时会原样重放，上下文不丢
- 若图片文件被手工删除，那一轮会降级为文字提示，不会导致整个对话报错

## 📦 安装

**Arch Linux（AUR）**

> ⚠️ AUR 尚未同步到 2.1.0（仍停留在 1.5.3），`yay -S deepseek-arch` 会装到旧版本；请用下面的 GitHub Release 方式。

**GitHub Release（推荐，无需 AUR）**

```bash
npm install -g https://github.com/d8e-lab/deepseek-arch/releases/download/v2.1.0/deepseek-arch-2.1.0.tgz
```

**源码安装**

```bash
git clone https://github.com/d8e-lab/deepseek-arch.git
cd deepseek-arch && npm install && npm run build
```

> 升级提示：图片输入走 `deepseek-flash`，如果你之前的配置里写死了旧模型名，升级后可用 `/model` 切换。
