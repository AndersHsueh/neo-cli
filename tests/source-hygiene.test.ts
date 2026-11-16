/**
 * source-hygiene.test.ts — 拆分后小残留守卫（无行为变化的源码整洁度）。
 *
 * v0.4.87 拆分大文件后留下三类机械残留：
 *   - 命令组文件整段复制原 import 区，大量 import / 解构从未使用；
 *   - 共享可变字段改写成 `s.x = …` 时，后一行的注释或语句被挤到同一行；
 *   - src/config.ts 用 `export *` 再导出 config/types.ts，把原本内部的
 *     解析辅助（Raw、TIER_FIELD、num/bool/str 等）一并变成公共 API。
 *
 * 规格：
 *   H1 src/config.ts 的运行时导出与拆分前（68bd217）完全一致，不多不少；
 *   H2 src/config.ts 不用 `export *`，导出的类型名与拆分前一致；
 *   H3 src 下没有「分号/左花括号后隔两个以上空格又接代码或 JSDoc」的挤行；
 *   H4 `tsc --noUnusedLocals` 在 src 下零告警（只查局部与 import；参数属接口签名，不查）。
 *      tsconfig 自 noUnusedLocals 打开后已对 src/tests/scripts 全仓生效；H4 仍保留为 src 的
 *      独立守卫：只跑 bun test 时也生效，tsconfig 开关被误删时仍拦得住。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC_ROOT = join(ROOT, "src");

/** 拆分前 src/config.ts 的运行时导出（git show 68bd217:src/config.ts）。 */
const CONFIG_RUNTIME_API = [
  "API_TYPE_PREFERENCE", "ConfigError", "DEFAULT_LSP", "DEFAULT_OUTPUT_PROBE",
  "DEFAULT_PARALLEL_TOOL_CALLS", "DEFAULT_REPO_MAP", "DEFAULT_RETRY_CONFIG",
  "IMPLEMENTED_PROVIDER_TYPES", "MAX_MODEL_FALLBACKS", "MODEL_TIERS",
  "applyModelTarget", "applyTier", "auditMaxTokens", "describeRoute", "isImplemented",
  "isModelTier", "loadConfig", "maskKey", "normalizeBaseUrl", "normalizeTierName",
  "parseFallbackTarget", "parseMcpServers", "parseSkillsExtraPaths", "providerBaseUrl",
  "resolveLspConfig", "resolveModelFallback", "resolveOutputProbe", "resolveParallelToolCalls",
  "resolveRepoMapConfig", "resolveRetryConfig", "switchProvider", "switchTier",
  "tierAvailable", "tierChoiceLabel", "tierDisplayName",
].sort();

/** 拆分前 src/config.ts 导出的类型名（interface / type）。 */
const CONFIG_TYPE_API = [
  "Config", "LspConfig", "LspServerConfig", "McpHttpServerConfig", "McpServerBase",
  "McpServerConfig", "McpSseServerConfig", "McpStdioServerConfig", "MemoryConfig",
  "ModelTarget", "ModelTier", "OutputProbeSettings", "ParallelToolCallsMode", "PasteConfig",
  "ProviderConfig", "ProviderType", "RepoMapConfig", "RetryConfig", "RouteConfig",
].sort();

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 从源码里收集导出的类型名：`export interface/type X` 与 `export type { A, B } from …`。 */
function exportedTypeNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/^export (?:interface|type) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!);
  for (const m of text.matchAll(/^export type \{([^}]*)\}/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const part of m[1]!.split(",")) {
      const t = part.trim();
      if (!t.startsWith("type ")) continue;
      const name = t.slice(5).split(/\s+as\s+/).pop()!.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

describe("拆分残留守卫", () => {
  test("H1 src/config.ts 运行时导出与拆分前一致（不暴露 TIER_FIELD/num/bool/str 等内部辅助）", async () => {
    const mod = await import("../src/config.ts");
    expect(Object.keys(mod).sort()).toEqual(CONFIG_RUNTIME_API);
  });

  test("H2 src/config.ts 不用 export *，类型导出与拆分前一致（不暴露 Raw）", () => {
    const text = readFileSync(join(SRC_ROOT, "config.ts"), "utf8");
    expect(text).not.toMatch(/^export \*/m);
    expect(exportedTypeNames(text)).toEqual(CONFIG_TYPE_API);
  });

  test("H3 src 下没有挤在同一行的语句或注释", () => {
    const squashed: string[] = [];
    for (const file of listTsFiles(SRC_ROOT).sort()) {
      const rel = relative(ROOT, file).replaceAll("\\", "/");
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // 行尾注释（`;  // …`）是正常写法，不算挤行。
        if (/[;{][ \t]{2,}(?!\/\/)\S/.test(line)) squashed.push(`${rel}:${i + 1}`);
      });
    }
    expect(squashed).toEqual([]);
  });

  test("H4 tsc --noUnusedLocals 在 src 下零告警（未用 import / 局部 / 解构）", () => {
    const r = Bun.spawnSync([process.execPath, "x", "tsc", "--noEmit", "--noUnusedLocals"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    // tsc 必须真的跑起来：退出码非 0 时输出里必须有 TS 诊断行。否则（bun x 解析失败、
    // tsc 崩溃等）输出里没有 `error TS`，下面两条过滤都为空，守卫会静默通过。
    expect(r.exitCode === 0 || /error TS\d+/.test(out)).toBe(true);
    const unused = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("src/") && /error TS(6133|6192|6196|6198|6205)\b/.test(l));
    expect(unused).toEqual([]);
    // 除未用告警外，tsc 不应报别的错（防止 tsc 本身没跑起来却算通过）。
    const other = out.split("\n").filter((l) => /error TS\d+/.test(l) && !/error TS(6133|6192|6196|6198|6205)\b/.test(l));
    expect(other).toEqual([]);
  });
});
