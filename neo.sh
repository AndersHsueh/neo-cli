#!/usr/bin/env bash
# neo 启动脚本：按脚本自身位置解析入口，任意目录可用。
# 用法：neo [参数]（参数透传给 src/index.ts，如 -p "问题"、-C <dir>）
DIR="$(cd "$(dirname "$0")" && pwd)"
exec bun run "$DIR/src/index.ts" --yes --no-reasoning "$@"
