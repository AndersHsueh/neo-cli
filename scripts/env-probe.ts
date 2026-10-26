#!/usr/bin/env bun
/**
 * env-probe.ts — 平台适配层手工探针（v0.4.0）。
 *
 * 用途：
 *  - M0 取证：在目标机（macOS / Ubuntu / Windows）上采集平台事实；
 *  - 现场诊断：neo 的 shell / 环境判断与预期不符时，先跑它看真值；
 *  - 不读 settings.json、不依赖 API key、不写任何文件（纯只读）。
 *
 * 用法：
 *   bun run scripts/env-probe.ts          # 人类可读：shell spec + prompt + wiki 块
 *   bun run scripts/env-probe.ts --json   # 原始快照 JSON（入库证据用）
 */
import { homedir } from "node:os";
import { getShell } from "../src/shell.ts";
import { probeDynamic, probeStatic } from "../src/env/probe.ts";
import { formatEnvForCli, formatEnvPrompt, renderEnvPage } from "../src/env/render.ts";
import type { EnvSnapshot } from "../src/env/types.ts";

const asJson = process.argv.includes("--json");

const shell = getShell();
const staticPart = probeStatic({ cwd: process.cwd(), home: homedir(), shell });
const dynamic = probeDynamic({ cwd: process.cwd() });
const snap: EnvSnapshot = { static: staticPart, dynamic };

if (asJson) {
  console.log(JSON.stringify({ shell, snapshot: snap }, null, 2));
  process.exit(0);
}

console.log("=== shell spec");
console.log(
  JSON.stringify(
    {
      path: shell.path,
      args: shell.args,
      kind: shell.kind,
      login: shell.login,
      source: shell.source,
      warnings: shell.warnings,
    },
    null,
    2,
  ),
);
console.log("\n=== system prompt「## 环境」段（主代理）");
console.log(formatEnvPrompt(snap));
console.log("\n=== 子代理紧凑版");
console.log(formatEnvPrompt(snap, { compact: true }));
console.log("\n=== /env 输出");
console.log(formatEnvForCli(snap));
console.log("\n=== wiki 生成块");
console.log(renderEnvPage(snap).block);
