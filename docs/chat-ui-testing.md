# ChatUI 测试策略

## 目标

`ChatUI` 是一个基于 PTY/TTY 的终端前端。它的职责不只是状态变更，还包含：

- 键盘事件处理
- 全屏切换与光标控制
- ANSI 渲染
- 输入框编辑与多行布局
- 流式输出刷新
- 中断与退出流程

这类模块可以测试，但不适合只靠单一端到端用例覆盖。更合理的做法是分层测试，把纯逻辑、渲染输出和伪终端集成拆开。

## 当前情况

当前 `ChatUI` 位于 [src/cli/chat-ui.ts](../src/cli/chat-ui.ts)，已经把部分逻辑拆到了独立组件中：

- [src/cli/components/input-panel.ts](../src/cli/components/input-panel.ts)
- [src/cli/components/display-lines.ts](../src/cli/components/display-lines.ts)
- [src/cli/components/ansi.ts](../src/cli/components/ansi.ts)
- [src/cli/components/spinner.ts](../src/cli/components/spinner.ts)

这些模块适合直接做自动化单元测试。问题主要在于 `ChatUI` 本体仍然强依赖全局副作用：

- `process.stdin` / `process.stdout`
- `writeSync(1, ...)`
- `process.exit(...)`
- `process.on('SIGWINCH', ...)`
- raw mode / alt screen / cursor 控制
- 实时 spinner / throttle

所以，`ChatUI` 本体可以测，但直接测试整个类的成本比较高，稳定性也一般。

## 结论

前面提到的测试方案，绝大部分都应该是自动化测试，不是靠人工盯着终端输出检查。

人工检查只适合作为补充，用来观察：

- 刷新是否顺手
- 是否闪烁
- 中文宽度与光标定位是否观感正常
- 不同终端下的展示差异

正确性验证应该尽量自动化。

## 分层测试方案

### 1. 纯逻辑层

这是最稳定的一层，适合用 `vitest` 做标准单元测试。

建议继续把 `ChatUI` 中的逻辑拆成纯函数或轻状态对象，例如：

- `handleKey(state, key) -> next state / action`
- `renderFrame(state, viewport) -> string | render ops`

适合自动化断言的内容包括：

- `Ctrl+L` 是否清空显示
- `/title foo` 是否触发改标题动作
- streaming 时按 `Enter` 是否进入输入队列
- resize 后可见区域怎么算
- 输入框换行、光标位置、历史消息浏览是否正确

这类测试不依赖真实终端，速度快，回归成本最低。

### 2. 渲染快照层

这一层也是自动化测试，不是“跑出来给人看”。

核心思路是把 `fullDraw()` / `drawStreamUpdate()` 的输出收集起来，而不是直接写到真实终端。最简单的做法是引入可注入的 writer：

```ts
interface TerminalWriter {
  write(text: string): void;
}
```

测试里用 fake writer 收集输出：

```ts
const writes: string[] = [];
const writer = {
  write(text: string) {
    writes.push(text);
  },
};
```

然后自动断言：

- 是否进入 alt screen
- header 是否包含 provider / model
- 输入面板是否带灰底 ANSI
- streaming 时先出现 spinner，再出现 reasoning，再出现 content
- 中断时是否出现 `[已中断]`

为了降低快照脆弱性，建议同时保留两类断言：

- 原始 ANSI 输出快照
- strip ANSI 后的纯文本断言

### 3. PTY 集成层

如果目标是验证“像真实用户一样输入按键后终端行为是否正确”，就应该用 pseudo-terminal 做自动化集成测试。

常见做法：

- 用 `node-pty` 或等价工具启动 `node dist/index.js chat`
- 注入测试专用配置，走 `MockProvider`
- 向 PTY 发送按键序列
- 自动读取终端输出并断言关键内容

适合放在这一层的场景：

- 启动后成功进入全屏
- 输入一条消息后，出现用户消息和模型回复
- `Ctrl+C` 在 idle 状态下退出
- streaming 时 `Esc` / `Ctrl+C` 中断
- `Ctrl+Enter` 换行
- `/title foo` 后显示标题提示
- `resume` 恢复后历史消息被重新渲染

这类测试可以自动化，但通常更慢，也更容易受时序影响，所以数量应控制在少量关键流程。

## 推荐改造点

如果要让 `ChatUI` 真正变得可测，建议先做下面几项重构。

### 1. 抽出 TerminalAdapter

建议把下面这些能力从 `process.*` 和 `writeSync()` 中抽离出来：

- `write()`
- `setRawMode()`
- `resume()` / `pause()`
- `getSize()`
- `onKeypress()`
- `onResize()`
- `exit(code)`

这样测试里就可以完全 fake 掉终端环境，而不是必须拉起真实进程。

### 2. 抽出 Renderer

把渲染逻辑从 `ChatUI` 中拆成纯函数或单独类：

- 输入：display、input、liveStream、termWidth、termHeight
- 输出：字符串或 render ops

这样：

- `fullDraw()` 会变成薄壳
- 可以直接对“某个状态下应该画出什么”做自动化断言

### 3. 注入时钟/调度器

当前 spinner 和 throttle 依赖真实时间。测试时更适合注入可控时钟，否则流式场景容易不稳定。

建议可注入：

- spinner interval
- throttle 时间源
- `setInterval` / `clearInterval` 包装

### 4. 把退出行为改成可注入

`process.exit()` 直接写死，会让单元测试很难做。

建议改成：

- `exit(code)` 由 adapter 注入

这样就能在测试中验证“是否请求退出”和“退出码是否正确”，而不必真的终止测试进程。

## 推荐实施顺序

如果要按投入产出比推进，建议顺序如下：

1. 抽出 `TerminalAdapter`
2. 抽出 `Renderer`
3. 补纯逻辑测试和渲染快照测试
4. 最后补少量 PTY 集成测试

这样可以先把大部分正确性验证自动化，再用少量 PTY 用例验证真实交互流程。

## 适合自动化测试的内容

下面这些都适合做自动化测试，而不是人工检查：

- 键位是否触发正确行为
- 输入队列是否正确入队/出队
- 流式状态切换是否正确
- 中断后是否追加 `[已中断]`
- resize 后的可见行数和光标位置
- 某一帧渲染出来的文本和 ANSI 序列
- PTY 场景下的关键交互流程

## 适合人工补充检查的内容

下面这些更适合作为少量人工冒烟测试：

- 视觉刷新是否自然
- 是否有明显闪烁
- 不同终端模拟器下的观感差异
- 极端中文/emoji 输入时的展示体验

## 实际建议

如果只是问“`chat-ui` 能不能测”，答案是可以，而且应该测。

如果问“当前代码结构下直接测整个 `ChatUI` 舒不舒服”，答案是不太舒服。

如果问“是否值得先做一轮可测试性重构再补测试”，答案是值得。

对这个项目来说，最合理的路线不是把测试建立在“跑出来给人看”上，而是：

1. 先做自动化单元测试和渲染测试
2. 再补少量自动化 PTY 集成测试
3. 最后用少量人工冒烟检查交互观感

这样回归成本更低，也更稳定。
