/**
 * P4：切换模型/provider/档位后刷新能力视图（GitHub #5）。
 *
 * 回归背景：`/model` `/provider` `/tier` 只改 cfg.model，cfg.contextWindow 仍是
 * 上一个模型解析出来的值 —— 紧接着的 `/context` 会展示旧模型的窗口。
 *
 * 覆盖点：
 *  1. helper 同步段：切到新模型后 cfg.contextWindow / source 立刻变成新模型的
 *     env 缓存值（不是旧模型残留，也不是旧模型写回的 cfg 值）；
 *  2. helper 异步段：/models 探测完成后再次解析，cfg 更新到探测值；
 *  3. 探测失败静默：不可达网关不影响同步结果、不抛错；
 *  4. 端到端（子进程）：/model、/provider、/tier 之后 `/context` 展示新模型窗口。
 *
 * 全部用临时目录 + 假网关，不碰仓库根 settings.json，不连外网。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  currentModelCapabilityView,
  refreshCapabilitiesAfterModelSwitch,
  resolveAndApplyModelWindow,
} from "../src/env/modelWindows.ts";
import { machineKeyOf, snapshotFile, writeSnapshot } from "../src/env/probe.ts";
import type { EnvStatic } from "../src/env/types.ts";
import type { Config } from "../src/config.ts";
import { sleep } from "./helpers.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "src", "index.ts");

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-switch-refresh-"));
const OLD_ENV_HOME = process.env["NEO_ENV_HOME"];
const made: string[] = [];

beforeAll(() => {
  process.env["NEO_ENV_HOME"] = SANDBOX;
});

afterAll(() => {
  if (OLD_ENV_HOME === undefined) delete process.env["NEO_ENV_HOME"];
  else process.env["NEO_ENV_HOME"] = OLD_ENV_HOME;
  rmSync(SANDBOX, { recursive: true, force: true });
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

function makeCfg(over: Partial<Config> = {}): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    // discard 端口：探测必然失败 → 验证「失败静默」且不污染同步结果。
    baseUrl: "http://127.0.0.1:9/v1",
    model: "m-old",
    modelTier: "default",
    contextWindow: 200_000,
    configuredContextWindow: 200_000,
    contextWindowSource: "config",
    env: {},
    cwd: SANDBOX,
    ...over,
  } as unknown as Config;
}

/** 写一份只有 models 字段的 env 快照（readSnapshot 要求 shell 存在）。 */
function writeSnapshotWithModels(models: Record<string, unknown>): void {
  const key = machineKeyOf(hostname(), platform(), arch());
  const file = snapshotFile(SANDBOX, key, {});
  writeSnapshot(file, {
    version: 1,
    collectedAt: new Date().toISOString(),
    machineKey: key,
    shell: { path: "/bin/bash", kind: "bash", login: false, source: "env", version: null },
    models,
  } as unknown as EnvStatic);
}

/** 只回 /models 的假网关。 */
function serveModels(entry: Record<string, unknown>): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [entry] });
      }
      return new Response("nope", { status: 404 });
    },
  });
  return { port: Number(server.port), stop: () => server.stop(true) };
}

/* ------------------------------------------------------------------ */
/* 1. helper 本身                                                      */
/* ------------------------------------------------------------------ */

describe("refreshCapabilitiesAfterModelSwitch：同步段", () => {
  test("切到新模型后 cfg.contextWindow 立刻变成新模型的 env 缓存值", () => {
    writeSnapshotWithModels({
      "p1|m-old": { contextWindow: 200_000, source: "models_api", updatedAt: "t" },
      "p1|m-new": { contextWindow: 131_072, maxOutputTokens: 32_768, source: "models_api", updatedAt: "t" },
    });

    const cfg = makeCfg();
    // 模拟「旧模型已解析过」：cfg 里是旧模型的值。
    resolveAndApplyModelWindow(cfg);
    expect(cfg.contextWindow).toBe(200_000);

    // 切换：只改 model（与 /model <id> 同一动作）。
    cfg.model = "m-new";
    const applied = refreshCapabilitiesAfterModelSwitch(cfg);

    expect(applied.tokens).toBe(131_072);
    expect(applied.source).toBe("models_api");
    expect(cfg.contextWindow).toBe(131_072);
    expect(cfg.contextWindowSource).toBe("models_api");
    // 能力视图（/context 的展示源）也跟着换到新模型。
    expect(currentModelCapabilityView(cfg).contextWindow).toBe("131,072 tokens");
    expect(currentModelCapabilityView(cfg).maxOutputTokens).toBe("32,768 tokens");
  });

  test("新模型没有 env 事实 → 回落到 settings 手写值，而不是旧模型残留", () => {
    writeSnapshotWithModels({
      "p1|m-old": { contextWindow: 200_000, source: "models_api", updatedAt: "t" },
    });

    const cfg = makeCfg({ contextWindow: 200_000, configuredContextWindow: 64_000 });
    resolveAndApplyModelWindow(cfg);
    expect(cfg.contextWindow).toBe(200_000);

    cfg.model = "m-unknown";
    refreshCapabilitiesAfterModelSwitch(cfg);

    // 旧模型的 200k 不能残留；新模型无事实 → 用 configuredContextWindow。
    expect(cfg.contextWindow).toBe(64_000);
    expect(cfg.contextWindowSource).toBe("config");
  });

  test("provider 切换同样生效（key 含 provider 名）", () => {
    writeSnapshotWithModels({
      "p1|m1": { contextWindow: 100_000, source: "models_api", updatedAt: "t" },
      "p2|m1": { contextWindow: 400_000, source: "models_api", updatedAt: "t" },
    });

    const cfg = makeCfg({ model: "m1" });
    resolveAndApplyModelWindow(cfg);
    expect(cfg.contextWindow).toBe(100_000);

    cfg.providerName = "p2";
    refreshCapabilitiesAfterModelSwitch(cfg);
    expect(cfg.contextWindow).toBe(400_000);
  });
});

describe("refreshCapabilitiesAfterModelSwitch：异步探测", () => {
  test("探测完成后再次解析，cfg 更新到 /models 的值", async () => {
    writeSnapshotWithModels({});
    const s = serveModels({ id: "m-probe", context_length: 262_144, max_output_tokens: 8_192 });
    try {
      const cfg = makeCfg({
        model: "m-probe",
        contextWindow: 32_000,
        configuredContextWindow: 32_000,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
      });
      // 同步段：还没有事实 → 用配置值。
      const applied = refreshCapabilitiesAfterModelSwitch(cfg);
      expect(applied.source).toBe("config");
      expect(cfg.contextWindow).toBe(32_000);

      // 异步段：等探测落盘 + 回调再解析。
      for (let i = 0; i < 40 && cfg.contextWindow !== 262_144; i += 1) await sleep(50);
      expect(cfg.contextWindow).toBe(262_144);
      expect(cfg.contextWindowSource).toBe("models_api");
      expect(currentModelCapabilityView(cfg).maxOutputTokens).toBe("8,192 tokens");
    } finally {
      s.stop();
    }
  });

  test("探测失败静默：不抛错、不改变同步结果", async () => {
    writeSnapshotWithModels({
      "p1|m-x": { contextWindow: 50_000, source: "models_api", updatedAt: "t" },
    });
    const cfg = makeCfg({ model: "m-x", baseUrl: "http://127.0.0.1:9/v1" });
    refreshCapabilitiesAfterModelSwitch(cfg);
    expect(cfg.contextWindow).toBe(50_000);
    await sleep(150);
    // 探测失败后值保持不变（没有把 50k 抹成配置值）。
    expect(cfg.contextWindow).toBe(50_000);
    expect(cfg.contextWindowSource).toBe("models_api");
  });
});

/* ------------------------------------------------------------------ */
/* 2. 端到端：切换命令之后 /context 展示新模型窗口                      */
/* ------------------------------------------------------------------ */

/**
 * 建沙箱：两个 provider（p1 的 m-old / p2 的 m-new / p2 的 fast 档 m-fast），
 * env 快照里三个模型各有不同窗口。base_url 指向 discard 端口 —— 探测失败，
 * 于是断言只依赖「同步段用 env 缓存」，不依赖网络。
 */
function makeProject(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "neo-switch-e2e-")));
  const home = join(cwd, "fakehome");
  mkdirSync(home, { recursive: true });

  writeFileSync(
    join(cwd, "settings.json"),
    JSON.stringify({
      default_provider: "p1",
      model_routes: { fast: { provider: "p2", model: "m-fast" } },
      providers: [
        {
          provider_name: "p1",
          provider_type: "openai",
          base_url: "http://127.0.0.1:9/v1",
          api_key: "sk-test",
          default_model_name: "m-old",
          context_window: 100_000,
        },
        {
          provider_name: "p2",
          provider_type: "openai",
          base_url: "http://127.0.0.1:9/v1",
          api_key: "sk-test",
          default_model_name: "m-new",
          fast_model_name: "m-fast",
          // 路由表：fast 档落在 p2（applyTier 走 routes，不是「当前 provider 的 fast 模型」）。
          context_window: 100_000,
        },
      ],
    }),
    "utf8",
  );

  const key = machineKeyOf(hostname(), platform(), arch());
  const file = snapshotFile(home, key, {});
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      collectedAt: new Date().toISOString(),
      machineKey: key,
      shell: { path: "/bin/bash", kind: "bash", login: false, source: "env", version: null },
      hostname: hostname(),
      os: { platform: platform(), arch: arch(), release: "t", kernelVersion: "t", pretty: "Test OS" },
      cpu: { cores: 1, model: "test-cpu" },
      memoryTotalBytes: 1,
      tools: {},
      container: { docker: false, wsl: false, ssh: false },
      terminal: { term: null, program: null, colorterm: null },
      locale: { lang: null, timezone: null },
      privileges: { uid: null, root: false, sudo: false },
      gui: false,
      runtime: { bun: "test", node: null, parentPath: null },
      models: {
        "p1|m-old": { contextWindow: 100_000, source: "models_api", updatedAt: "t" },
        // /model 只改 model 名、不改 provider —— 所以新模型的事实挂在 p1 下。
        "p1|m-new": { contextWindow: 131_072, source: "models_api", updatedAt: "t" },
        // /provider p2 与 /tier fast 走 p2。
        "p2|m-new": { contextWindow: 131_072, source: "models_api", updatedAt: "t" },
        "p2|m-fast": { contextWindow: 65_536, source: "models_api", updatedAt: "t" },
      },
    }),
    "utf8",
  );

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

describe("P4 切换后 /context 反映新模型", () => {
  test("/model <id> 之后窗口换成新模型的 env 事实", () => {
    const out = runCommands(makeProject(), ["/context", "/model m-new", "/context"]);
    const contexts = out.split("\n").filter((l) => l.trimStart().startsWith("context"));
    // 第一次 /context 是旧模型（p1|m-old = 100k），第二次是新模型（p2|m-new = 131k）。
    expect(contexts[0]).toContain("100,000 tokens");
    expect(contexts[contexts.length - 1]).toContain("131,072 tokens");
  });

  test("/provider p2 之后窗口换成该 provider 模型的 env 事实", () => {
    const out = runCommands(makeProject(), ["/provider p2", "/context"]);
    expect(out).toContain("provider → p2");
    expect(lineWith(out, "context")).toContain("131,072 tokens");
    // /context 的 model 行只打模型名（provider 在 window 来源里体现）。
    expect(lineWith(out, "model")).toContain("m-new");
    expect(lineWith(out, "window")).toContain("models_api");
  });

  test("/tier fast 之后窗口换成 fast 档模型的 env 事实", () => {
    const out = runCommands(makeProject(), ["/tier fast", "/context"]);
    expect(out).toContain("档位 → fast");
    expect(lineWith(out, "context")).toContain("65,536 tokens");
  });

  test("/fast 快捷命令同样刷新", () => {
    const out = runCommands(makeProject(), ["/fast", "/context"]);
    expect(lineWith(out, "context")).toContain("65,536 tokens");
  });

  test("/env 的模型能力行也按新模型展示", () => {
    const out = runCommands(makeProject(), ["/model m-new", "/env"]);
    const line = out.split("\n").find((l) => l.includes("p1|m-new")) ?? "";
    expect(line).toContain("131,072 tokens");
  });
});
