#!/bin/bash
# build-pkg.sh — 使用 makepkg 构建 Arch Linux 包（遵循 ABS 规范）
#
# 前置条件: base-devel, nodejs, npm
#
# 用法:
#   ./build-pkg.sh            # 构建包（产物在当前目录）
#   ./build-pkg.sh -i         # 构建并安装
#   ./build-pkg.sh -c         # 干净构建后清理
#
# 推荐使用 devtools 在干净 chroot 中构建:
#   cd aur && extra-x86_64-build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}/aur"

# 传递参数给 makepkg（默认 -s 安装依赖，-f 强制重建）
exec makepkg -sf "$@"
