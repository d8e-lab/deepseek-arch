# Skill 机制人工验收测试文档

> 版本：针对 `feature/skill-rework` 分支的 skill 机制重构（v1.0.0）
> 测试方式：人工操作 + 命令旁证，不依赖自动化测试框架

---

## 1. 测试范围

| 能力 | 场景编号 | 说明 |
|------|---------|------|
| Listing 注入 | S1 | 模型能发现可用 skill（plan/release/research） |
| Inline 执行 | S2 | plan skill 内容展开 + 确认断点 |
| Fork 执行 | S3 | research skill 子代理执行 + 结构化报告 |
| 条件激活 | S4 | docs skill 触碰文件后激活 |
| 错误路径 | S5 | 未知 skill 的错误消息 |
| Compact 保留 | S6 | 压缩后已用 skill 内容重注入 |
| requires-confirm | S7 | frontmatter 声明后调用弹确认 |
| 工具级验收 | S8 | 不依赖模型的直接验证 |

---

## 2. 前置条件

```bash
# 1. 在 feature/skill-rework 分支
git checkout feature/skill-rework

# 2. 构建最新 dist
npm run build            # npx tsc

# 3. 配置就绪（~/.deepseek-arch/ 存在且有 api_key）
ls ~/.deepseek-arch/config.toml
grep api_key ~/.deepseek-arch/providers.toml   # 非空

# 4. 启动会话
node dist/cli/index.js chat
```

**当前分支 skill 清单**（4 个）：

| skill | 模式 | 是否 listing 可见 | 触发条件 |
|-------|------|------------------|---------|
| plan | inline | ✅ | 直接可见 |
| release | inline | ✅ | 直接可见 |
| research | fork | ✅ | 直接可见 |
| docs | inline | ❌ 初始隐藏 | 触碰 `docs/**` 文件后激活 |

---

## 3. 测试场景

### S1 — Listing 注入（地基，必须先验）

**目的**：验证模型能发现 skill 及其适用场景。

**步骤**：
1. 启动对话
2. 提问："你有哪些 skill 可用？各自在什么场景下用？"

**期望**：
- 模型列出 **plan / release / research** 三个 skill，且能说出各自 when_to_use
- **docs 不出现**（条件激活，未触发）

**旁证命令**（不依赖模型）：
```bash
ls -t ~/.deepseek-arch/sessions/*/system-prompt.txt | head -1 | xargs grep -A6 skill_listing
```
应输出：
```
<skill_listing>
Available skills — invoke with the "skill" tool: ...
- plan: 编码任务规划与自检框架 ... - when to use: ...
- release: 版本发布全流程 ... - when to use: ...
- research: 独立技术调研 ... - when to use: ...
</skill_listing>
```

**判定**：模型能报出 3 个 skill + 各自用途；落盘文件含 `<skill_listing>`。

---

### S2 — Inline 执行（plan）

**目的**：验证 inline 模式：skill 内容展开进当前对话，模型按内容执行。

**步骤**：提问："用 plan 规划这个任务：给 session 模块加日志持久化"

**期望**：
1. 模型调用 `skill` 工具，参数 `{"skill": "plan"}`
2. 输出完整规划框架：复杂度评估 → Phase 0（理解需求）→ Phase 1（定位）→ Phase 2（决策拆解）→ Phase 2.5（自检）→ **用户确认断点**
3. **在确认断点处停下**，等待用户回复（强制锁）

**判定**：内容展开 + 确认断点处停止等待。

**失败排查**：模型没调 skill 工具 → 检查 S1 的 listing 是否注入；或手动提示"用 skill 工具，skill 参数填 plan"。

---

### S3 — Fork 执行（research）

**目的**：验证 fork 模式：子代理隔离执行，只回传结果。

**步骤**：提问："用 research 调研一下本项目 src/core/ 的模块职责划分"

**期望**：
1. 模型调用 `skill` 工具，参数 `{"skill": "research", "args": "..."}`
2. 出现子代理执行过程（`subagent_spawned` / 进度事件）
3. 返回**结构化报告**，格式含：
   ```
   ## 结论摘要
   ## 关键证据（<文件路径>:<行号>）
   ## 风险与不确定点
   ```
4. 主对话**看不到**子代理中间过程（只看到结果）

**判定**：子代理执行 + 结构化报告返回 + 中间过程不可见。

---

### S4 — 条件激活（docs）

**目的**：验证 paths frontmatter：触碰匹配文件后 skill 激活并通知模型。

**步骤**：
1. 提问："看一下 docs/ 目录的结构"（让模型实际 Read/Grep docs/ 下的文件）
2. 观察对话中是否出现激活通知
3. 追问："你现在能用 docs skill 吗？它管什么？"

**期望**：
- 模型触碰 `docs/**` 后，对话出现：
  ```
  <system-reminder>
  New skill(s) now available — invoke with the "skill" tool:
  - docs: 文档维护规范 ... - when to use: ...
  </system-reminder>
  ```
- 后续模型可用 `{"skill": "docs"}` 并简述其内容（目录结构约定、维护规则）

**对照实验**：新开会话（不碰 docs/），问"你有哪些 skill" → docs 不应出现。

**判定**：触碰后出现激活通知 + 模型可用 docs。

---

### S5 — 错误路径

**目的**：验证未知 skill 的错误消息带可发现性。

**步骤**：提问："调用 skill abcdefg"

**期望**：
```
Unknown skill: abcdefg. Available skills: plan, release, research
```

**判定**：错误消息含 Unknown skill + 可用列表。

---

### S6 — Compact 保留（进阶）

**目的**：验证 compact 后已用 skill 内容被重注入（跨压缩保留）。

**步骤**：
1. 先完成一次 S2（plan 已调用）
2. 继续对话若干轮（制造足够上下文）
3. 触发 compact：输入 `/compact`（或等待自动 compact）
4. 问："我刚才的 plan 流程要点还记得吗？"

**期望**：
- compact 后模型仍能复述 plan 框架要点
- 磁盘上有重注入块：

```bash
# 找到最近会话的 turns 文件，检查 [Compact Skills]
ls -t ~/.deepseek-arch/sessions/*/ | head -5
grep -l "Compact Skills" ~/.deepseek-arch/sessions/*/*.json 2>/dev/null
# 或检查 compact 摘要轮内容
grep -o "plan.skill.md" ~/.deepseek-arch/sessions/*/turns*.json 2>/dev/null | head
```

**判定**：压缩后 skill 要点可复述；磁盘含 `[Compact Skills]` / `plan.skill.md` 引用。

---

### S7 — requires-confirm（可选，验完改回）

**目的**：验证 frontmatter `requires-confirm: true` 触发确认流程。

**步骤**：
1. 给 `skill/release.skill.md` frontmatter 临时加一行：
   ```yaml
   requires-confirm: true
   ```
2. 重新构建：`npm run build`
3. 提问："帮我发个 release，版本 1.5.0"
4. 观察确认弹窗：
   - **拒绝** → 工具被拒，模型收到 "The user rejected this operation..."，不执行
   - **同意** → 正常展开 release 流程
5. **验完删除该行**（否则每次发版都弹确认），重新构建

**判定**：确认弹窗出现；拒绝被拦截；同意正常执行。

---

### S8 — 工具级验收（不依赖模型，兜底）

**目的**：直接验证工具层行为，绕过模型行为不确定性。

**S8.1 inline（plan）**：
```bash
node -e "import('./dist/tools/skill.js').then(async ({skillTool}) => {
  const r = await skillTool.execute({skill:'plan'});
  console.log('error:', r.error ?? '(none)');
  console.log('含 Phase 0:', r.content.includes('Phase 0'));
  console.log('frontmatter 已剥离:', !r.content.includes('when_to_use'));
})"
```

**S8.2 fork（research，注入假 runner）**：
```bash
node -e "import('./dist/tools/skill.js').then(async ({skillTool,setSkillForkRunner}) => {
  setSkillForkRunner(async (name, task) => '[fake] ' + name + ' done');
  const r = await skillTool.execute({skill:'research', args:'测试问题'});
  console.log('forked execution:', r.content.includes('forked execution'));
  console.log('args 替换:', r.content.includes('测试问题'));
})"
```

**S8.3 未知 skill**：
```bash
node -e "import('./dist/tools/skill.js').then(async ({skillTool}) => {
  const r = await skillTool.execute({skill:'nope'});
  console.log('error:', r.error, '| 列可用:', r.content.includes('Available'));
})"
```

**S8.4 条件激活**：
```bash
node -e "import('./dist/core/skill.js').then(async (m) => {
  await m.loadSkills();
  console.log('激活前条件数:', m.getConditionalSkillCount());          // 期望 1
  const act = m.activateSkillsForPaths(['docs/x.md'], process.cwd());
  console.log('激活:', act.map(s=>s.name).join(','));                  // 期望 docs
  console.log('激活后可用:', (await m.loadSkills()).map(s=>s.name).join(',')); // 期望含 docs
})"
```

**S8.5 listing 输出**：
```bash
node -e "import('./dist/core/skill.js').then(async (m) => {
  const s = await m.loadSkills();
  console.log(m.buildSkillListing(s));
})"
```

---

## 4. 判定矩阵（汇总）

| 编号 | 场景 | 通过标准 | 结果 |
|------|------|---------|------|
| S1 | Listing 注入 | 模型报出 3 skill + 用途；落盘含 `<skill_listing>` | ☐ |
| S2 | Inline（plan） | 内容展开 + 确认断点停下 | ☐ |
| S3 | Fork（research） | 子代理执行 + 结构化报告 | ☐ |
| S4 | 条件激活（docs） | 触碰后激活通知 + 模型可用 | ☐ |
| S5 | 错误路径 | Unknown skill + 可用列表 | ☐ |
| S6 | Compact 保留 | 压缩后要点可复述 + 磁盘重注入块 | ☐ |
| S7 | requires-confirm | 确认弹窗 + 拒绝被拦 | ☐ |
| S8 | 工具级 | 5 个子脚本输出符合期望 | ☐ |

**判定结论**：S1-S5 全过 = 核心机制可用；S6-S7 为进阶；S8 为兜底验证。

---

## 5. 常见问题排查

| 现象 | 可能原因 | 处理 |
|------|---------|------|
| 模型报不出 skill / 不调 skill 工具 | listing 未注入 | 先验 S1 旁证命令；确认 `npm run build` 后重启会话 |
| listing 缺某个 skill | frontmatter 解析失败 | 检查 `skill/*.skill.md` frontmatter 格式（`---` 包裹、键值合法）；`node -e "import('./dist/core/skill.js').then(m=>m.loadSkills().then(console.log))"` |
| docs 出现在初始 listing | paths 未生效 | 确认 frontmatter `paths: docs/**` 且构建最新 |
| fork skill 报 not_configured | fork runner 未注入 | 确认 `src/cli/index.ts` 有 `setSkillForkRunner(...)` 且走 chat 入口（非直接调工具） |
| 调 skill 不弹确认 | requires-confirm 未生效 | S7 步骤确认 frontmatter 行存在 + 已重建 |
| compact 后 skill 丢失 | 识别失败 | 确认调用记录是 `{"name":"skill","arguments":{"skill":"plan"}}`（旧 plan_on 记录有兼容） |
| 用户目录 skill 不生效 | 路径不对 | 用户级目录为 `~/.deepseek-arch/skill/<name>.skill.md`（不是 `~/.deepseek-arch/skill.md`） |

---

## 6. 验收记录

- 测试日期：__________
- 测试分支：__________
- 测试人：__________
- 结论：☐ 全部通过  ☐ 部分通过（S____ 未过）  ☐ 未通过
- 备注：______________________________________________
