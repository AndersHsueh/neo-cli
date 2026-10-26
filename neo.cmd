@echo off
rem neo Windows 启动器（v0.4.0 平台适配层，实验性；需要 Bun 在 PATH）
bun run "%~dp0src\index.ts" %*
