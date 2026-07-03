#!/bin/bash
# build-pkg.sh — 本地构建 Arch Linux 包
# 在 git 仓库根目录运行即可。
# 依赖: base-devel, nodejs, npm
#
# 用法: ./build-pkg.sh
# 产物: /tmp/deepseek-arch-*.pkg.tar.zst

set -euo pipefail

PKGNAME="deepseek-arch"
PKGVER="1.2.1"
PKGDIR="$(mktemp -d)"
trap 'rm -rf "$PKGDIR"' EXIT

echo "==> 安装依赖 & 编译..."
npm ci
npm run build
npm prune --production

echo "==> 打包运行时文件..."
MODDIR="${PKGDIR}/usr/lib/node_modules/${PKGNAME}"
install -dm755 "$MODDIR"

cp -r dist node_modules package.json package-lock.json "$MODDIR/"
cp -r skill "$MODDIR/"
cp LICENSE README.md "$MODDIR/"

install -dm755 "${PKGDIR}/usr/bin"
ln -s "/usr/lib/node_modules/${PKGNAME}/dist/cli/index.js" "${PKGDIR}/usr/bin/${PKGNAME}"

echo "==> 构建 .pkg.tar.zst..."
cd "$PKGDIR"
tar -cJf "/tmp/${PKGNAME}-${PKGVER}-any.pkg.tar.zst" .

echo "==> 完成: /tmp/${PKGNAME}-${PKGVER}-any.pkg.tar.zst"
echo "    安装: sudo pacman -U /tmp/${PKGNAME}-${PKGVER}-any.pkg.tar.zst"
echo ""
echo "==> 浏览器工具需要 Chromium:"
echo "    sudo pacman -S chromium"
