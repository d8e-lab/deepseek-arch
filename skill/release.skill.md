# Release Skill — 版本发布流程

> 当用户要求"发版""打 tag""发布 release""打包"等操作时激活。
> 目标：自动化发布流程，确保版本号一致、包体完整、Release Notes 面向新用户。

## 0. 前置检查

```
□ 确认当前在 main 分支
□ 确认所有要发布的代码已合并到 main（git log origin/main..HEAD 为 0）
□ 确认工作区 clean（git status）
□ 确认 dist/ 已构建（npm run build）
```

---

## 1. 版本号更新

修改以下文件中的版本号（同时更新）：

| 文件 | 字段 |
|------|------|
| `package.json` | `"version": "X.Y.Z"` |
| `src/cli/index.ts` | `const PACKAGE_VERSION = "X.Y.Z"` |

**规则**：
- x.y.z 遵循 semver：修复→patch、新功能→minor、破坏性变更→major
- 所有文件版本号必须一致

**强制产物**：`git commit -m "chore: bump version to X.Y.Z"`

---

## 2. 构建 & 打包

### npm 包

```bash
npm run build
npm pack    # 生成 deepseek-arch-X.Y.Z.tgz
```

### AUR 预构建包

```bash
bash scripts/build-prebuilt-tarball.sh /tmp
# 生成 /tmp/deepseek-arch-X.Y.Z-prebuilt.tar.gz
```

产物：
- `deepseek-arch-X.Y.Z.tgz`（npm 包，~170 KB）
- `/tmp/deepseek-arch-X.Y.Z-prebuilt.tar.gz`（AUR 包，~19 MB）

---

## 3. AUR 文件更新

```
□ aur/PKGBUILD — 更新 pkgver 为新版本号
□ aur/PKGBUILD — 更新 sha256sums 为 tarball 的新校验值
□ aur/.SRCINFO — 同步更新 pkgver 和 sha256sums
```

**强制产物**：`git commit -m "chore: update AUR packaging for vX.Y.Z"`

---

## 4. Git Tag

```bash
git tag -a vX.Y.Z -m "vX.Y.Z — 简短描述"
git push origin main vX.Y.Z
```

---

## 5. GitHub Release

使用 `gh` CLI：

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z — 标题" \
  --notes-file RELEASE-vX.Y.Z.md \
  deepseek-arch-X.Y.Z.tgz \
  /tmp/deepseek-arch-X.Y.Z-prebuilt.tar.gz
```

---

## 6. Release Notes（最重要！）

**必须面向新用户撰写**，不是写给开发者的技术报告。按以下优先级排列：

### 第一优先级：用户体验改善
- 🧠 **Plan Skill 增强** — 规划框架优化、subagent 委派引导
- 🤖 **Subagent 工具描述** — 工具说明优化鼓励模型使用
- 🖥️ **UI/UX 优化** — 界面改进、操作便利性提升

### 第二优先级：新功能
- 🛠 **新工具/新模式** — 简洁描述功能 + 使用示例

### 第三优先级：Bug 修复
- 🔧 **修复清单** — 面向用户描述，不说技术细节

### 格式规范
```
# DeepSeek Arch vX.Y.Z

> 一句话摘要（吸引用户）

## 🧠 第一优先级标题
描述...

## 🤖 第二优先级标题
描述...

## 🛠 第三优先级标题
描述...

## 🔧 Bug 修复
- 修复了...

## 📦 安装
```bash
# Arch Linux (AUR)
yay -S deepseek-arch

# npm
npm install -g deepseek-arch
```
```

**禁止**：
- ❌ 写技术内部细节（"修复了 getAllTools 逻辑反转" → ✅ "修复了工具过滤逻辑"）
- ❌ 写代码行号、变量名、Git commit SHA
- ❌ 写开发流程信息
- ❌ 列出所有改动文件

**强制产物**：`RELEASE-vX.Y.Z.md` → `gh release edit` 上传

---

## 7. 发布后验证

```
□ gh release view vX.Y.Z — 确认显示正确
□ 确认两个 asset 已上传（npm tgz + AUR tarball）
□ 确认 Release Notes 内容正确渲染
□ 浏览器打开 release 页面检查最终效果
```

---

## 技巧

- **版本号先改再打包**：`npm pack` 和 build 脚本都会读 package.json 的版本号
- **预构建包要给 AUR 用**：含 node_modules（生产依赖）+ dist/，用户安装零构建
- **Release Notes 不要写"本次更新了 X 个文件"**——用户不关心改动量
- **Think in user's perspective**：用户打开 release 页面想知道"这个版本对我有什么好处"，不是"开发者做了什么"
