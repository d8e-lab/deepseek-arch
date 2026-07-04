# deepseek-arch Makefile
# 对标 ABS/Ports 体系的 build/check/install/clean/package 标准目标
#
# 用法:
#   make           # 安装依赖并编译（= make all）
#   make build     # 仅编译 TypeScript
#   make check     # 运行测试
#   make install   # npm link 全局安装
#   make clean     # 清理构建产物
#   make package   # 构建 Arch Linux 包（调用 makepkg）
#   make release   # 发布构建（无 sourceMap）

.PHONY: all build check install clean package release dev

all: node_modules build

node_modules: package.json package-lock.json
	npm ci

build: node_modules
	npm run build

release: node_modules
	npm run build:release

check: build
	npm test

install: build
	npm link

clean:
	rm -rf dist coverage

dev:
	npm run dev

package:
	cd aur && makepkg -sf

dist: release package
	@echo "==> 发布构建 + Arch 包完成"
