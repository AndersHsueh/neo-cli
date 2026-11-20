/**
 * first-use-onboard-88.test.ts — 初次使用向导（GitHub #88）。
 *
 * 覆盖：触发条件、写出约定、探测/连通失败不落盘、密钥不出现明文、
 * 写出的文件能被现有 loadConfig 加载、-p / 非 TTY / neo acp 不进入向导。
 *
 * 隔离：全部用例使用临时 HOME / cwd，绝不读、写、覆盖或删除本机真实
 * ~/.neo/settings.json。断言失败信息也不回显明文密钥。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadConfig } from "../src/config.ts";
import {
  findSettingsPath,
  packageRoot,
  settingsCandidates,
  userSettingsPath,
} from "../src/config/settingsPath.ts";
import {
  DEFAULT_ONBOARD_MAX_TOKENS,
  FIRST_USE_PROVIDER_NAME,
  MISSING_SETTINGS_MESSAGE,
  buildDefaultProviderSettings,
  redactSecret,
  runFirstUseOnboard,
  shouldEnterFirstUseOnboard,
  shouldFailForMissingSettings,
  writeFirstUseSettings,
} from "../src/cli/firstUseOnboard.ts";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const ORIG_CWD = process.cwd();
const ORIG_HOME = process.env["HOME"];
const ORIG_USERPROFILE = process.env["USERPROFILE"];
const REAL_USER_SETTINGS = join(homedir(), ".neo", "settings.json");

/** 本文件用到的假密钥。断言失败时不得把它写进报错文案。 */
const SECRET = "sk-88-TEST-SECRET-do-not-print";

function assertSecretAbsent(text: string, label: string): void {
  if (text.includes(SECRET)) {
    throw new Error(`${label} unexpectedly contained the plaintext api_key`);
  }
}

function assertSameSecret(actual: unknown): void {
  if (actual !== SECRET) {
    throw new Error("written api_key did not match the typed secret");
  }
}

function assertNotRealUserSettings(path: string): void {
  if (resolve(path) === resolve(REAL_USER_SETTINGS)) {
    throw new Error("refused to use the real ~/.neo/settings.json in tests");
  }
}

function makeSandbox(name: string): { root: string; home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), name));
  const home = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

const sandboxes: string[] = [];

function sandbox(name: string): { root: string; home: string; cwd: string } {
  const s = makeSandbox(name);
  sandboxes.push(s.root);
  return s;
}

function useHomeAndCwd(home: string, cwd: string): void {
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  process.chdir(cwd);
}

function restoreEnv(): void {
  process.chdir(ORIG_CWD);
  if (ORIG_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = ORIG_USERPROFILE;
}

afterEach(() => {
  restoreEnv();
});

process.on("exit", () => {
  restoreEnv();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function isolatedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("NEO_")) continue;
    if (k === "HOME" || k === "USERPROFILE") continue;
    env[k] = v;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  Object.assign(env, extra);
  return env;
}

async function spawnNeo(
  cwd: string,
  home: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: isolatedEnv(home, extra),
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, 8_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code: code ?? 1 };
  } finally {
    clearTimeout(timer);
  }
}

const enterInput = {
  settingsPath: null as string | null,
  print: null as string | null,
  isAcp: false,
  stdinIsTTY: true,
  stdoutIsTTY: true,
};

describe("#88 触发：只在交互 TTY 且没有候选 settings.json 时进入向导", () => {
  test("#88 触发：settingsPath == null 且交互 TTY（无 -p、非 acp）才进入", () => {
    expect(shouldEnterFirstUseOnboard(enterInput)).toBe(true);
    expect(shouldFailForMissingSettings(enterInput)).toBe(false);
  });

  test("#88 触发：任一候选已存在（settingsPath 非空）不进入向导，也不走缺文件失败", () => {
    const input = { ...enterInput, settingsPath: "/tmp/isolated/settings.json" };
    expect(shouldEnterFirstUseOnboard(input)).toBe(false);
    expect(shouldFailForMissingSettings(input)).toBe(false);
  });

  test("#88 触发：-p 不进入向导，走缺文件失败", () => {
    const input = { ...enterInput, print: "hello" };
    expect(shouldEnterFirstUseOnboard(input)).toBe(false);
    expect(shouldFailForMissingSettings(input)).toBe(true);
  });

  test("#88 触发：非 TTY 不进入向导，走缺文件失败", () => {
    const input = { ...enterInput, stdinIsTTY: false, stdoutIsTTY: false };
    expect(shouldEnterFirstUseOnboard(input)).toBe(false);
    expect(shouldFailForMissingSettings(input)).toBe(true);
  });

  test("#88 触发：只有一侧是 TTY 也不进入向导", () => {
    expect(shouldEnterFirstUseOnboard({ ...enterInput, stdinIsTTY: true, stdoutIsTTY: false })).toBe(false);
    expect(shouldEnterFirstUseOnboard({ ...enterInput, stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
  });

  test("#88 触发：neo acp 不进入向导，走缺文件失败", () => {
    const input = { ...enterInput, isAcp: true };
    expect(shouldEnterFirstUseOnboard(input)).toBe(false);
    expect(shouldFailForMissingSettings(input)).toBe(true);
  });
});

describe("#88 候选路径：与 loadConfig 同序，第一份存在的文件全赢", () => {
  test("#88 包装根计算与仓库根一致（不因文件下沉到 src/config/ 而漂移）", () => {
    expect(packageRoot()).toBe(resolve(import.meta.dir, ".."));
  });

  test("#88 清洁环境（cwd / HOME / 包装根都没有 settings.json）时 findSettingsPath 为 null", () => {
    const s = sandbox("neo-88-nopath-");
    useHomeAndCwd(s.home, s.cwd);
    expect(existsSync(userSettingsPath())).toBe(false);
    expect(existsSync(join(packageRoot(), "settings.json"))).toBe(false);
    expect(findSettingsPath()).toBeNull();
    const cands = settingsCandidates();
    expect(cands[0]).toBe(join(s.cwd, "settings.json"));
    expect(cands[cands.length - 1]).toBe(join(s.home, ".neo", "settings.json"));
    expect(cands).toContain(join(packageRoot(), "settings.json"));
  });

  test("#88 工作区已有 settings.json 时不把 HOME 那份当候选赢家", () => {
    const s = sandbox("neo-88-cwd-wins-");
    useHomeAndCwd(s.home, s.cwd);
    writeFileSync(join(s.cwd, "settings.json"), "{}\n");
    mkdirSync(join(s.home, ".neo"), { recursive: true });
    writeFileSync(join(s.home, ".neo", "settings.json"), "{}\n");
    expect(findSettingsPath()).toBe(join(s.cwd, "settings.json"));
  });

  test("#88 ACP settingsDir 且与 cwd 不同时，候选含启动目录那份，顺序不变", () => {
    const s = sandbox("neo-88-acp-cands-");
    const spawn = join(s.root, "spawn");
    const here = join(s.root, "session");
    mkdirSync(spawn);
    mkdirSync(here);
    useHomeAndCwd(s.home, spawn);
    const cands = settingsCandidates({ settingsDir: here });
    expect(cands.slice(0, 2)).toEqual([join(here, "settings.json"), join(spawn, "settings.json")]);
  });
});

describe("#88 写出约定：最小可用配置、0600、不覆盖、能被 loadConfig 加载", () => {
  test("#88 写出字段：provider 名为 default，身份字段都指向它，分类器模型用 fast，max_tokens 保持 8192", () => {
    const raw = buildDefaultProviderSettings({
      baseUrl: "https://gw.test/v1/",
      apiKey: SECRET,
      apiType: "openai",
      defaultModel: "m-default",
      balancedModel: "m-bal",
      fastModel: "m-fast",
      deepModel: "m-deep",
      maxOutputTokens: 4096,
    });
    expect(DEFAULT_ONBOARD_MAX_TOKENS).toBe(8192);
    expect(FIRST_USE_PROVIDER_NAME).toBe("default");
    expect(raw["default_provider"]).toBe("default");
    expect(raw["default_model_tier"]).toBe("default");
    expect(raw["classifier_provider"]).toBe("default");
    expect(raw["classifier_model_name"]).toBe("m-fast");
    const providers = raw["providers"] as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    const p = providers[0]!;
    expect(p["provider_name"]).toBe("default");
    expect(p["api_type"]).toBe("openai");
    expect(p["base_url"]).toBe("https://gw.test/v1");
    assertSameSecret(p["api_key"]);
    expect(p["default_model_name"]).toBe("m-default");
    expect(p["balanced_model_name"]).toBe("m-bal");
    expect(p["fast_model_name"]).toBe("m-fast");
    expect(p["deep_reasoning_model_name"]).toBe("m-deep");
    expect(p["max_tokens"]).toBe(8192);
    expect(p["max_output_tokens"]).toBe(4096);
    expect(raw["model_routes"]).toEqual({
      default: { provider: "default", model: "m-default" },
      balanced: { provider: "default", model: "m-bal" },
      fast: { provider: "default", model: "m-fast" },
      deep_reasoning: { provider: "default", model: "m-deep" },
    });
    expect(raw["hooks"]).toBeUndefined();
    expect(raw["mcpServers"]).toBeUndefined();
    expect(raw["default_provider"]).not.toBe("example");
    expect(JSON.stringify(raw)).not.toContain("your-fast-model-id");
    expect(JSON.stringify(raw)).not.toContain("sk-REPLACE_ME");
  });

  test("#88 写出后能被现有 loadConfig 加载，且不踩模板 example 占位", () => {
    const s = sandbox("neo-88-load-");
    useHomeAndCwd(s.home, s.cwd);
    const dest = userSettingsPath();
    assertNotRealUserSettings(dest);
    const raw = buildDefaultProviderSettings({
      baseUrl: "https://gw.example.test/v1",
      apiKey: SECRET,
      apiType: "anthropic",
      defaultModel: "claude-x",
      balancedModel: "claude-y",
      fastModel: "claude-fast",
      deepModel: "claude-deep",
      maxOutputTokens: 8192,
    });
    writeFirstUseSettings(dest, raw);
    expect((statSync(dest).mode & 0o777)).toBe(0o600);
    const cfg = loadConfig();
    expect(resolve(cfg.settingsPath ?? "")).toBe(resolve(dest));
    expect(cfg.providerName).toBe("default");
    expect(cfg.providerType).toBe("anthropic");
    expect(cfg.modelTier).toBe("default");
    expect(cfg.model).toBe("claude-x");
    assertSameSecret(cfg.apiKey);
    expect(cfg.classifierProvider).toBe("default");
    expect(cfg.classifierModel).toBe("claude-fast");
    expect(cfg.maxTokens).toBe(8192);
    const picked = cfg.providers.find((p) => p.name === "default");
    expect(picked?.maxOutputTokens).toBe(8192);
    expect(picked?.models.balanced).toBe("claude-y");
    expect(picked?.models.deep_reasoning).toBe("claude-deep");
    expect(cfg.routes.default).toEqual({ provider: "default", model: "claude-x", fallbackAllowed: true });
    expect(cfg.routes.fast).toEqual({ provider: "default", model: "claude-fast", fallbackAllowed: true });
  });

  test("#88 写入约定：目录不存在则创建；已有文件绝不覆盖", () => {
    const s = sandbox("neo-88-write-");
    const dest = join(s.home, ".neo", "settings.json");
    assertNotRealUserSettings(dest);
    writeFirstUseSettings(dest, { ok: 1 });
    expect(existsSync(dest)).toBe(true);
    expect((statSync(dest).mode & 0o777)).toBe(0o600);
    let threw = false;
    try {
      writeFirstUseSettings(dest, { ok: 2 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain('"ok": 1');
    expect(readFileSync(dest, "utf8")).not.toContain('"ok": 2');
  });
});

describe("#88 密钥只回显为 * / ***，日志与报错不含明文", () => {
  test("#88 密钥：redactSecret 用 *** 替换明文，绝不留下前后缀", () => {
    const leaked = `Authorization: Bearer ${SECRET}; message boom`;
    const redacted = redactSecret(leaked, SECRET);
    assertSecretAbsent(redacted, "redactSecret result");
    expect(redacted).toContain("***");
    expect(redacted).not.toContain(SECRET.slice(0, 6));
    expect(redacted).not.toContain(SECRET.slice(-4));
  });
});

describe("#88 探测或连通失败不落盘；成功才写 ~/.neo/settings.json", () => {
  test("#88 探测失败：用户选择退出，不创建文件", async () => {
    const s = sandbox("neo-88-probe-fail-");
    useHomeAndCwd(s.home, s.cwd);
    const dest = userSettingsPath();
    assertNotRealUserSettings(dest);
    const logs: string[] = [];
    const result = await runFirstUseOnboard({
      io: {
        write: (t: string) => logs.push(t),
        writeErr: (t: string) => logs.push(t),
        ask: async (prompt: string) => {
          if (prompt.includes("base_url")) return "https://down.example.invalid/v1";
          throw new Error(`unexpected ask: ${prompt}`);
        },
        askSecret: async () => SECRET,
        choose: async <T>(_q: string, options: Array<{ label: string; value: T }>) => options[0]!.value,
        confirmRetry: async () => false,
      },
      services: {
        probeModels: async () => {
          throw new Error(`401 unauthorized for ${SECRET}`);
        },
        testConnectivity: async () => ({ ok: true as const }),
        settingsPath: () => dest,
        writeSettings: (path: string, raw: Record<string, unknown>) => writeFirstUseSettings(path, raw),
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(2);
    expect(existsSync(dest)).toBe(false);
    const joined = logs.join("");
    assertSecretAbsent(joined, "probe-failure logs");
    expect(joined).toContain("***");
  });

  test("#88 连通测试失败：用户选择退出，不创建文件", async () => {
    const s = sandbox("neo-88-conn-fail-");
    useHomeAndCwd(s.home, s.cwd);
    const dest = userSettingsPath();
    assertNotRealUserSettings(dest);
    const logs: string[] = [];
    const result = await runFirstUseOnboard({
      io: {
        write: (t: string) => logs.push(t),
        writeErr: (t: string) => logs.push(t),
        ask: async (prompt: string) => {
          if (prompt.includes("base_url")) return "https://gw.example.test/v1";
          if (prompt.includes("max_output_tokens")) return "4096";
          throw new Error(`unexpected ask: ${prompt}`);
        },
        askSecret: async () => SECRET,
        choose: async <T>(_q: string, options: Array<{ label: string; value: T }>) => options[0]!.value,
        confirmRetry: async () => false,
      },
      services: {
        probeModels: async () => ({ models: ["m-default"], maxOutputTokens: { "m-default": 4096 } }),
        testConnectivity: async () => ({ ok: false as const, error: `connection refused, key=${SECRET}` }),
        settingsPath: () => dest,
        writeSettings: (path: string, raw: Record<string, unknown>) => writeFirstUseSettings(path, raw),
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(2);
    expect(existsSync(dest)).toBe(false);
    const joined = logs.join("");
    assertSecretAbsent(joined, "connectivity-failure logs");
  });

  test("#88 探测与连通都成功：只写 HOME/.neo/settings.json，权限 0600，然后 ok", async () => {
    const s = sandbox("neo-88-success-");
    useHomeAndCwd(s.home, s.cwd);
    const dest = userSettingsPath();
    assertNotRealUserSettings(dest);
    const workspaceCopy = join(s.cwd, "settings.json");
    const logs: string[] = [];
    const result = await runFirstUseOnboard({
      io: {
        write: (t: string) => logs.push(t),
        writeErr: (t: string) => logs.push(t),
        ask: async (prompt: string) => {
          if (prompt.includes("base_url")) return "https://gw.example.test/v1";
          if (prompt.includes("max_output_tokens")) return "2048";
          throw new Error(`unexpected ask: ${prompt}`);
        },
        askSecret: async () => SECRET,
        choose: async <T>(q: string, options: Array<{ label: string; value: T }>) => {
          if (q.includes("协议")) {
            return options.find((o) => String(o.value) === "anthropic")?.value ?? options[0]!.value;
          }
          return options[0]!.value;
        },
        confirmRetry: async () => {
          throw new Error("should not ask to retry on success");
        },
      },
      services: {
        probeModels: async (input) => {
          assertSameSecret(input.apiKey);
          if (input.apiType !== "anthropic") throw new Error("expected anthropic after protocol choice");
          return { models: ["alpha", "beta"], maxOutputTokens: { alpha: 2048 } };
        },
        testConnectivity: async (input) => {
          assertSameSecret(input.apiKey);
          if (input.model !== "alpha") throw new Error("connectivity must use the chosen default model");
          return { ok: true as const };
        },
        settingsPath: () => dest,
        writeSettings: (path: string, raw: Record<string, unknown>) => writeFirstUseSettings(path, raw),
      },
    });
    expect(result).toEqual({ ok: true, path: dest });
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(workspaceCopy)).toBe(false);
    expect((statSync(dest).mode & 0o777)).toBe(0o600);
    const written = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>;
    const prov = (written["providers"] as Array<Record<string, unknown>>)[0]!;
    assertSameSecret(prov["api_key"]);
    expect(prov["api_type"]).toBe("anthropic");
    expect(prov["max_tokens"]).toBe(8192);
    expect(prov["max_output_tokens"]).toBe(2048);
    assertSecretAbsent(logs.join(""), "success logs");
    const cfg = loadConfig();
    expect(cfg.providerName).toBe("default");
    expect(cfg.classifierModel).toBe("alpha");
  });

  test("#88 写出前目标文件已存在：不覆盖，返回失败", async () => {
    const s = sandbox("neo-88-exists-");
    useHomeAndCwd(s.home, s.cwd);
    const dest = userSettingsPath();
    assertNotRealUserSettings(dest);
    mkdirSync(join(s.home, ".neo"), { recursive: true });
    writeFileSync(dest, "{\"preexisting\":true}\n");
    const result = await runFirstUseOnboard({
      io: {
        write: () => {},
        writeErr: () => {},
        ask: async (prompt: string) => {
          if (prompt.includes("base_url")) return "https://gw.example.test/v1";
          if (prompt.includes("max_output_tokens")) return "1024";
          throw new Error(`unexpected ask: ${prompt}`);
        },
        askSecret: async () => SECRET,
        choose: async <T>(_q: string, options: Array<{ label: string; value: T }>) => options[0]!.value,
        confirmRetry: async () => false,
      },
      services: {
        probeModels: async () => ({ models: ["m1"], maxOutputTokens: {} }),
        testConnectivity: async () => ({ ok: true as const }),
        settingsPath: () => dest,
        writeSettings: (path: string, raw: Record<string, unknown>) => writeFirstUseSettings(path, raw),
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(2);
    expect(readFileSync(dest, "utf8")).toBe("{\"preexisting\":true}\n");
  });

  test("#88 探测失败后允许重试，第二次成功才写文件", async () => {
    const s = sandbox("neo-88-retry-");
    useHomeAndCwd(s.home, s.cwd);
    const dest = userSettingsPath();
    assertNotRealUserSettings(dest);
    let probes = 0;
    const result = await runFirstUseOnboard({
      io: {
        write: () => {},
        writeErr: () => {},
        ask: async (prompt: string) => {
          if (prompt.includes("base_url")) return "https://gw.example.test/v1";
          if (prompt.includes("max_output_tokens")) return "1024";
          throw new Error(`unexpected ask: ${prompt}`);
        },
        askSecret: async () => SECRET,
        choose: async <T>(_q: string, options: Array<{ label: string; value: T }>) => options[0]!.value,
        confirmRetry: async () => true,
      },
      services: {
        probeModels: async () => {
          probes += 1;
          if (probes === 1) throw new Error("temporary probe failure");
          return { models: ["m1"], maxOutputTokens: {} };
        },
        testConnectivity: async () => ({ ok: true as const }),
        settingsPath: () => dest,
        writeSettings: (path: string, raw: Record<string, unknown>) => writeFirstUseSettings(path, raw),
      },
    });
    expect(result.ok).toBe(true);
    expect(probes).toBe(2);
    expect(existsSync(dest)).toBe(true);
  });
});

describe("#88 -p / 非 TTY / neo acp 不进入向导，exit 2，不发模型请求", () => {
  test("#88 -p 在无候选 settings.json 时 exit 2，说明需要初次配置，零模型请求；NEO_API_KEY 不能放行", async () => {
    const s = sandbox("neo-88-dash-p-");
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const r = await spawnNeo(s.cwd, s.home, ["-p", "hello", "-y"], {
        NEO_API_KEY: SECRET,
        NEO_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      });
      expect(r.code).toBe(2);
      expect(hits).toBe(0);
      expect(existsSync(join(s.home, ".neo", "settings.json"))).toBe(false);
      const text = `${r.out}\n${r.err}`;
      assertSecretAbsent(text, "-p output");
      expect(text).toContain(MISSING_SETTINGS_MESSAGE);
      expect(text).not.toMatch(/请输入|base_url|api_key|初次配置向导/);
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("#88 非 TTY 无 -p 在无候选 settings.json 时 exit 2，不进入向导，零模型请求", async () => {
    const s = sandbox("neo-88-nontty-");
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const r = await spawnNeo(s.cwd, s.home, ["hello"], {
        NEO_API_KEY: "k",
        NEO_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      });
      expect(r.code).toBe(2);
      expect(hits).toBe(0);
      expect(existsSync(join(s.home, ".neo", "settings.json"))).toBe(false);
      const text = `${r.out}\n${r.err}`;
      expect(text).toContain(MISSING_SETTINGS_MESSAGE);
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("#88 neo acp 在无候选 settings.json 时 exit 2，不进入向导，不启动到发模型请求", async () => {
    const s = sandbox("neo-88-acp-");
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const r = await spawnNeo(s.cwd, s.home, ["acp"], {
        NEO_API_KEY: "k",
        NEO_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      });
      expect(r.code).toBe(2);
      expect(hits).toBe(0);
      expect(existsSync(join(s.home, ".neo", "settings.json"))).toBe(false);
      const text = `${r.out}\n${r.err}`;
      expect(text).toContain(MISSING_SETTINGS_MESSAGE);
      expect(text).not.toMatch(/请输入 base_url/);
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("#88 已有候选 settings.json 时 -p 不走缺文件失败（不误进向导）", async () => {
    const s = sandbox("neo-88-existing-p-");
    const settings = {
      default_provider: "local",
      default_model_tier: "default",
      classifiers_ignored: true,
      providers: [
        {
          provider_name: "local",
          api_type: "openai",
          base_url: "http://127.0.0.1:9/v1",
          api_key: "k",
          default_model_name: "m1",
        },
      ],
    };
    writeFileSync(join(s.cwd, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    const r = await spawnNeo(s.cwd, s.home, ["-p", "hello", "-y", "--output-format", "json"]);
    // 网关不可达会失败，但不应是「尚未找到 settings.json」的 exit 2 文案。
    expect(`${r.out}\n${r.err}`).not.toContain(MISSING_SETTINGS_MESSAGE);
    expect(r.code).not.toBe(0);
  }, 15_000);
});

describe("#88 README 与帮助补充初次启动流程", () => {
  test("#88 README 说明清洁环境下交互 neo 会引导配置并写入 ~/.neo/settings.json", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
    expect(readme).toContain("候选路径都没有 settings.json");
    expect(readme).toContain("~/.neo/settings.json");
    expect(readme).toMatch(/-p/);
    expect(readme).toContain("neo acp");
  });

  test("#88 帮助文本已有配置说明时，补充初次启动流程", () => {
    const help = readFileSync(join(import.meta.dir, "..", "src", "cli", "help.ts"), "utf8");
    expect(help).toContain("候选路径都没有 settings.json");
    expect(help).toContain("~/.neo/settings.json");
  });
});
