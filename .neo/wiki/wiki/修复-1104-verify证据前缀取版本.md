# 修复-1104-verify 证据前缀取自 package.json

> 最后更新:2026-11-04

## 摘要

v0.4.9 修 `scripts/verify.sh` 的 `EVIDENCE_PREFIX`：从手写常量 `v0.4.4` 改为从 `package.json` 的 `version` 解析。根因是「每版更新」这条人工纪律从 v0.4.5 到 v0.4.8 连续四版失守，四版闸门证据全部写进 `docs/evidence/v0.4.4-*` 互相覆盖，而 `v0.4.8-*` 是手工落的、与闸门产物不同源。解析用 `sed` 取第一处 `"version": "..."`（不引入 jq/node），解析失败（得到空串）直接 `FAILED` 退出，不退化成空前缀。验证：`bash -n` 通过、前缀解析正反例实测、`bash scripts/verify.sh` ALL GREEN 并产出 `v0.4.9-{tsc,tests,pty}.txt`（tsc 0 · 1074 pass / 0 fail / 69 文件 · PTY 21/21）。未加单测：`docs/evidence/` 在 .gitignore 内，测试断言闸门产物属跨层耦合。

## 推理与依据

- **为什么是「自动取版本」而不是「记得改」**：`src/cli/version.ts` 早已确立「package.json 是唯一发布真源，入口不再手写常量」的约定（v0.4.4 拆分时写进 release notes）。`verify.sh` 的证据前缀是同一类事实的第二份副本，属于同一根因的漏网处。
- **为什么不加测试**：闸门产物落在 `docs/evidence/`（已被 .gitignore 排除），单测去断言它需要真跑一遍 verify.sh（约 20s+ 且依赖 PTY），成本远高于收益；前缀解析本身用「构造无 version 的 JSON → 得到 `v` → 走失败分支」的反例实测覆盖。
- **为什么失败即退**：空前缀会写出 `-tsc.txt`，比写错前缀更难排查；宁可闸门当场红。
- **副作用**：`v0.4.4-*` 证据文件此前已被 v0.4.5–v0.4.8 覆盖，历史内容不可恢复（`docs/evidence/` 不进 git）。这是本次修复的动因，也是既成损失。
