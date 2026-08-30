#!/bin/bash
# prepare-node-pty-prebuilds.sh — 将编译好的 node-pty Linux 原生模块注入 npm 包
#
# node-pty 的 npm 包只自带 darwin/win32 预编译二进制（无 linux-x64），
# Linux 用户安装时需 node-gyp 源码编译，无工具链或 install 脚本被跳过时会崩溃。
# 本脚本在 npm pack/publish（prepack 生命周期）前把 build/Release/pty.node
# 复制到 prebuilds/linux-x64/，使发布包自带 Linux 二进制（N-API，跨 Node ABI 通用），
# 用户安装后开箱即用，无需本地编译。
#
# 用法: bash scripts/prepare-node-pty-prebuilds.sh
# 前置条件: 已执行 npm ci / npm install（node-pty 已编译出 pty.node）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

SRC="node_modules/node-pty/build/Release/pty.node"
DEST_DIR="node_modules/node-pty/prebuilds/linux-x64"

if [ ! -f "$SRC" ]; then
  echo "ERROR: $SRC not found. Run 'npm ci' (or 'npm install') first so node-pty gets compiled." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST_DIR/pty.node"
echo "OK: Linux pty.node copied to $DEST_DIR"
