/**
 * P2：`/context` 与 `/env` 展示当前模型的五项能力。
 *
 * 运行：bun test tests/context-command.test.ts
 *
 * ============================================================================
 * 【为什么用子进程】
 * ============================================================================
 * 同 skills-command.test.ts：src/index.ts 顶层自执行 main() 并 process.exit，
 * handleCommand 未导出。只有交互模式读到以 `/` 开头的行才走命令分支。
 *
 * ============================================================================
 * 【env 快照怎么注入】
 * ============================================================================
 * modelWindows 的事实源是 ~/.neo/env/<machineKey>.json（envHome() = homedir()，
 * 可用 NEO_ENV_HOME 覆盖）。测试把 HOME 与 NEO_ENV_HOME 都指向沙箱假 home，
 * 预先写好一份 models 记录，让 /context 读到「探测值」。
 * 快照里只放 models 字段 —— 旧快照兼容也顺带被覆盖（缺字段不炸）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { machineKeyOf, snapshotFile } from "../src/env/probe.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "src", "index.ts");
const made: string[] = [];

const PROVIDER = "test";
const MODEL = "m-caps";

/**
 * 建沙箱：settings.json 里 provider 手写 vision=false / reasoning=true（tools 留空），
 * env 快照里同一模型探测到 vision=true / tools=true / reasoning=false + 输出上限。
 * 于是「手写优先」与「探测补空缺」两条路径都能在同一份输出里验到。
 */
function makeProject(
  opts: { snapshot?: "full" | "legacy" | "none" | "thin"; handwritten?: "default" | "window-only" } = {},
): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "neo-ctx-cmd-")));
  const home = join(cwd, "fakehome");
  mkdirSync(home, { recursive: true });

  const provider: Record<string, unknown> = {
    provider_name: PROVIDER,
    provider_type: "openai",
    base_url: "http://127.0.0.1:9/v1",
    api_key: "sk-test",
    default_model_name: MODEL,
    max_tokens: 8_192,
    context_window: 100_000,
  };
  if (opts.handwritten !== "window-only") {
    provider["vision"] = false;
    provider["reasoning"] = true;
  }
  writeFileSync(
    join(cwd, "settings.json"),
    JSON.stringify({ providers: [provider] }),
    "utf8",
  );

  const kind = opts.snapshot ?? "full";
  if (kind !== "none") {
    const key = machineKeyOf(hostname(), platform(), arch());
    const file = snapshotFile(home, key, {});
    mkdirSync(dirname(file), { recursive: true });
    const models =
      kind === "full"
        ? {
            [`${PROVIDER}|${MODEL}`]: {
              contextWindow: 131_072,
              maxOutputTokens: 32_768,
              vision: true,
              tools: true,
              reasoning: false,
              source: "models_api",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : kind === "thin"
          ? {
              // ipsa-thor 一类瘦网关：探测跑过，但卡片上没有能力字段。
              [`${PROVIDER}|${MODEL}`]: {
                contextWindow: null,
                maxOutputTokens: null,
                vision: "unknown",
                tools: "unknown",
                reasoning: "unknown",
                source: "models_api",
                updatedAt: "2026-01-01T00:00:00.000Z",
                evidence: "http://thin.example/v1/models",
              },
            }
          : {
              // v0.4.1 时期的旧记录：只有窗口字段。
              [`${PROVIDER}|${MODEL}`]: {
                contextWindow: 131_072,
                source: "overflow_error",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            };
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        // 必须是「新鲜」时间戳：过期的快照会被 loadEnv 重新探测并重写。
        collectedAt: new Date().toISOString(),
        machineKey: key,
        // readSnapshot 会校验 shell 是否存在；缺了它整份快照被判为损坏（返回 null），
        // models 也随之丢失 —— 所以这里必须给一个最小 shell 结构。
        // /env 还会渲染 os/memory 等字段，一并给齐，避免 formatEnvForCli 读到 undefined。
        shell: { path: "/bin/bash", kind: "bash", login: false, source: "env", version: null },
        hostname: hostname(),
        os: { platform: platform(), arch: arch(), release: "test", kernelVersion: "test", pretty: "Test OS" },
        cpu: { cores: 1, model: "test-cpu" },
        memoryTotalBytes: 1,
        tools: {},
        container: { docker: false, wsl: false, ssh: false },
        terminal: { term: null, program: null, colorterm: null },
        locale: { lang: null, timezone: null },
        privileges: { uid: null, root: false, sudo: false },
        gui: false,
        runtime: { bun: "test", node: null, parentPath: null },
        models,
      }),
      "utf8",
    );
  }

  made.push(cwd);
  return cwd;
}

function runCommands(cwd: string, cmds: string[]): string {
  return execFileSync(process.execPath, [ENTRY], {
    cwd,
    input: `${cmds.join("\n")}\n/exit\n`,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: join(cwd, "fakehome"),
      USERPROFILE: join(cwd, "fakehome"),
      NEO_ENV_HOME: join(cwd, "fakehome"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** 取含某标签的行（kv 输出形如 `context    131,072 tokens`）。 */
function lineWith(out: string, label: string): string {
  return out.split("\n").find((l) => l.trimStart().startsWith(label)) ?? "";
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("P2 /context 展示五项能力", () => {
  test("五项 kv 都在，手写 settings 优先、探测补空缺", () => {
    const out = runCommands(makeProject(), ["/context"]);

    expect(lineWith(out, "context")).toContain("131,072 tokens");
    expect(lineWith(out, "max_output")).toContain("32,768 tokens");
    // 手写 false 压过探测 true
    expect(lineWith(out, "vision")).toContain("否");
    // 手写未填 → 用探测值
    expect(lineWith(out, "tools")).toContain("是");
    // 手写 true 压过探测 false
    expect(lineWith(out, "reasoning")).toContain("是");
  });

  test("旧快照缺字段：不炸，未探测项显示「未知」", () => {
    const out = runCommands(makeProject({ snapshot: "legacy" }), ["/context"]);
    expect(out).toContain("context");
    expect(lineWith(out, "max_output")).toContain("未知");
    // 手写值仍在（旧快照不影响 settings 手写）
    expect(lineWith(out, "vision")).toContain("否");
    expect(lineWith(out, "reasoning")).toContain("是");
    // tools 既没手写也没探测 → 未知
    expect(lineWith(out, "tools")).toContain("未知");
  });

  test("完全没有 env 快照：五项不炸，能力回落「未知」", () => {
    const out = runCommands(makeProject({ snapshot: "none" }), ["/context"]);
    expect(lineWith(out, "max_output")).toContain("未知");
    expect(lineWith(out, "tools")).toContain("未知");
    // 窗口回落到 settings 的 context_window
    expect(lineWith(out, "context")).toContain("100,000 tokens");
  });
});

describe("瘦网关：输出上限未探测到", () => {
  test("/context 与 /env 区分请求预算和能力上限，并提示手写", () => {
    const out = runCommands(makeProject({ snapshot: "thin", handwritten: "window-only" }), ["/context", "/env"]);
    expect(out).toContain("未探测到");
    expect(out).toContain("max_output_tokens");
    expect(out).toContain("请求预算");
    expect(out).toContain("能力上限");
    const outputLine = lineWith(out, "max_output");
    expect(outputLine).toContain("未知");
    expect(outputLine).toContain("能力上限");
    expect(outputLine).not.toContain("8,192");
    const budgetLine = lineWith(out, "max_tokens");
    expect(budgetLine).toContain("8,192");
    expect(budgetLine).toContain("请求预算");
    // 窗口是手写的，不能被瘦网关的 null 探测值抹掉。
    expect(lineWith(out, "context")).toContain("100,000 tokens");
  });
});

describe("P2 /env 模型能力行", () => {
  test("标题改为「模型能力」，行内含五项", () => {
    const out = runCommands(makeProject(), ["/env"]);
    expect(out).toContain("模型能力");
    const line = out.split("\n").find((l) => l.includes(`${PROVIDER}|${MODEL}`)) ?? "";
    expect(line).toContain("131,072 tokens");
    expect(line).toContain("能力上限 max_output_tokens 32,768 tokens");
    expect(line).toContain("请求预算 max_tokens 8,192");
    expect(line).toContain("vision 否");
    expect(line).toContain("tools 是");
    expect(line).toContain("reasoning 是");
  });
});
