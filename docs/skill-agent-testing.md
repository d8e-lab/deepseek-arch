# Agent 自主验收 Skill 机制的能力分析

> 关联文档：`docs/skill-mechanism-acceptance.md`（人工验收测试文档）
> 问题：能否让 AI agent 自己使用验收测试用例测试 skill 机制？
> 结论：**部分可以** —— 工具层/逻辑层可全自动；真实模型端到端受限于交互式 TUI，暂不可自动。

---

## 1. 结论速览

| 层面 | 能力 | 说明 |
|------|------|------|
| 工具层（S8 / S5 / S4 逻辑） | ✅ 可自动 | `node -e` 直接调 dist 模块 |
| 单元层（S2/S3/S6/S7 底层） | ✅ 可自动 | 已有 38 例 vitest 单测 |
| 集成层（S2-S5 对话流程） | ⚠️ 需补测试 | mock provider 可模拟，尚未覆盖 |
| 真实模型端到端（S1 感知等） | ❌ 不可自动 | 交互式 TUI + 真实模型，需人工 |

---

## 2. 可自主执行清单（现在就能跑）

### 2.1 工具级脚本（对应验收文档 S8）

```bash
# S8.1 inline（plan）
node -e "import('./dist/tools/skill.js').then(async ({skillTool}) => {
  const r = await skillTool.execute({skill:'plan'});
  console.log('error:', r.error ?? '(none)');
  console.log('含 Phase 0:', r.content.includes('Phase 0'));
  console.log('frontmatter 已剥离:', !r.content.includes('when_to_use'));
})"

# S8.2 fork（research，注入假 runner）
node -e "import('./dist/tools/skill.js').then(async ({skillTool,setSkillForkRunner}) => {
  setSkillForkRunner(async (name, task) => '[fake] ' + name + ' done');
  const r = await skillTool.execute({skill:'research', args:'测试问题'});
  console.log('forked execution:', r.content.includes('forked execution'));
})"

# S8.3 未知 skill（S5）
node -e "import('./dist/tools/skill.js').then(async ({skillTool}) => {
  const r = await skillTool.execute({skill:'nope'});
  console.log('error:', r.error, '| 列可用:', r.content.includes('Available'));
})"

# S8.4 条件激活（S4 逻辑层）
node -e "import('./dist/core/skill.js').then(async (m) => {
  await m.loadSkills();
  console.log('激活前条件数:', m.getConditionalSkillCount());          // 期望 1
  const act = m.activateSkillsForPaths(['docs/x.md'], process.cwd());
  console.log('激活:', act.map(s=>s.name).join(','));                  // 期望 docs
})"

# S8.5 listing 输出（S1 旁证）
node -e "import('./dist/core/skill.js').then(async (m) => {
  const s = await m.loadSkills();
  console.log(m.buildSkillListing(s));
})"
```

### 2.2 自动化测试（S2/S3/S6/S7 底层逻辑）

```bash
npm test    # 含 38 例 skill 相关单测
```

覆盖：frontmatter 解析、两级加载去重、listing 预算、别名查找、fork 分支、
requires-confirm 动态确认、compact 双识别、条件激活（glob 匹配/激活/绝对路径）。

### 2.3 旁证命令（S1/S4 落盘检查）

```bash
ls -t ~/.deepseek-arch/sessions/*/system-prompt.txt | head -1 | xargs grep -A6 skill_listing
```

---

## 3. 不可自主执行清单 + 根本限制

| 场景 | 卡点 |
|------|------|
| S1 模型感知（问模型"有哪些 skill"） | 需要真实对话 |
| S2 完整 inline 流程（确认断点停下） | 需要真实对话 + 交互 |
| S3 真实 fork（子代理结构化报告） | 需要真实对话 |
| S4 对话内激活通知 | 需要真实对话 |
| S6 真实 compact | 需要长对话触发 |
| S7 确认弹窗点击 | 需要 TTY 交互 |

**根本限制**：
1. **CLI 无非交互模式** —— `chat/resume/clear/api-monitor` 均为交互式 TUI，
   `-p` 是 api-monitor 的端口参数（非 prompt 模式）；agent 无法在无 TTY 环境驱动对话
2. **真实模型端到端** —— 模型行为、API 成本、确认框交互无法脱离人工

---

## 4. 弥补路径

### 路径 A：补集成测试文件（推荐）

`tests/core/session.test.ts` 已验证可行模式：**mock chatStream 生成器模拟模型行为**
→ SessionManager 跑完整 agent loop → 断言工具调用/消息注入/事件流。

补 `tests/core/skill-e2e.test.ts`（约 150 行）可将对话场景转自动化：

| mock 场景 | 覆盖验收 |
|-----------|---------|
| 模型第一轮调 `skill(plan)` | S2 inline：断言 tool_result 是 plan 全文 + 下一轮消息含展开内容 |
| 模型调 `skill(research)` + fake forkRunner | S3 fork：断言 fork 分支执行 |
| 模型调 `read_file(docs/xxx)` | S4 条件激活：断言 system-reminder 通知注入 |
| 模型调 `skill(nope)` | S5 错误：断言 error + 可用列表 |
| （S7 动态确认已有测试覆盖） | S7 |

之后 `npm test` 一次跑完，agent 可完全自主执行除"真实模型感知"外的全部验证面。

### 路径 B：agent 直接跑现有能力（零改动）

S8 五脚本 + S5 + S4 逻辑 + `npm test`（38 例）——覆盖除"真实模型感知"外的全部验证面。

### 路径 C：给 CLI 加 `-p "prompt"` 非交互模式（远期工程）

`session.ts` 已有 `sendMessage()` 非流式方法（返回完整响应），加 `-p` 成本可控。
有了它，agent 能用真实模型做端到端自主测试（含 S1 模型感知）。
属于新功能，超出验收范围，列入后续规划。

---

## 5. 建议路线

```
立即（零改动）：路径 B —— agent 跑 S8 + 旁证 + npm test
短期（补测试）：路径 A —— skill-e2e.test.ts 把 S2-S5 对话场景转 mock 集成测试
远期（新功能）：路径 C —— -p 非交互模式，真实模型端到端自主测试
```

---

## 6. 决策记录

| 项 | 状态 | 备注 |
|----|------|------|
| 路径 B 执行 | 待执行 | agent 可随时跑现有能力 |
| 路径 A skill-e2e.test.ts | 未实施 | 待确认是否补写 |
| 路径 C -p 非交互模式 | 未规划 | 新功能，独立任务 |
