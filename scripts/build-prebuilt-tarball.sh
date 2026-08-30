#!/bin/bash
# build-prebuilt-tarball.sh — 生成预编译 tarball 用于 Arch Linux 打包
#
# 对标 claude-code：发布含 dist/ + node_modules/ 的 tarball 到 GitHub Release，
# PKGBUILD 只需 cp，零构建依赖。
#
# 用法:
#   ./scripts/build-prebuilt-tarball.sh              # 生成到 /tmp/
#   ./scripts/build-prebuilt-tarball.sh ./output     # 指定输出目录
#
# 前置条件: nodejs, npm

set -euo pipefail

OUTDIR="${1:-/tmp}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# 从 package.json 读版本号（唯一来源）
VERSION=$(node -e "console.log(require('./package.json').version)")
TARBALL="deepseek-arch-${VERSION}-prebuilt.tar.gz"
DEST="${OUTDIR}/${TARBALL}"

echo "==> Building prebuilt tarball for v${VERSION}"

# 1. 安装依赖
echo "    npm ci ..."
npm ci --silent

# 2. 编译
echo "    tsc ..."
npm run build --silent

# 3. 剥离开发依赖
echo "    npm prune --production ..."
npm prune --production --silent

# 3.5 校验并同步 node-pty Linux 原生模块（N-API，跨 Node ABI）
#     node-pty 无 linux-x64 官方预编译，必须确认构建机已编译成功，
#     否则 AUR 用户会因 pty.node 缺失而崩溃。
echo "    verifying node-pty native module ..."
if [ ! -f node_modules/node-pty/build/Release/pty.node ]; then
    echo "ERROR: node_modules/node-pty/build/Release/pty.node missing — node-pty 编译失败" >&2
    exit 1
fi
mkdir -p node_modules/node-pty/prebuilds/linux-x64
cp node_modules/node-pty/build/Release/pty.node node_modules/node-pty/prebuilds/linux-x64/
echo "    OK: pty.node present (linux-x64)"

# 4. 打包运行时文件
echo "    tar czf ${DEST} ..."
tar czf "$DEST" \
    dist/ \
    node_modules/ \
    package.json \
    skill/ \
    system_prompt.txt \
    README.md \
    LICENSE

# 5. 校验和
echo ""
echo "==> Done: ${DEST}"
echo "    sha256: $(sha256sum "$DEST" | awk '{print $1}')"
echo "    size:   $(du -h "$DEST" | awk '{print $1}')"
echo ""
echo "    Upload to: https://github.com/d8e-lab/deepseek-arch/releases/tag/v${VERSION}"
echo "    Then update aur/PKGBUILD sha256sums with the value above."
