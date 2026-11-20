/**
 * issue #91：/doctor 配置体检（别名 /checkup；CLI `neo doctor`）。
 *
 * 覆盖建议最小验收 1–4：
 *  1. 交互 /doctor（/checkup）与 CLI `neo doctor`：检查实际载入的 settings 是否可解析、
 *     provider/api_key 是否缺、MCP 连接失败原因、hooks 配置告警、技能/规则损坏或重名、
 *     AGENTS.md / 项目规则是否被找到。
 *  2. 可读报告含 问题 / 位置 / 建议；默认不改文件。
 *  3. 密钥与 api_key 只显示是否存在或掩码，不把明文写入报告、日志或测例输出。
 *  4. 与 #70 --safe-mode、#88 初次向导分工清晰：检查已有配置，不替代干净启动，
 *     也不从 doctor 启动向导。
 *
 * 退出码：成功打印报告为 0（即便有发现，体检不是闸门）；用法错误为 2。
 * CLI 不实时连接 MCP（避免挂起）；交互 /doctor 使用已加载的 MCP 状态。
 *
 * 隔离：全部用例使用临时 HOME / cwd，绝不读、写、覆盖或删除本机真实
 * ~/.neo/settings.json。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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

import { parseArgs } from "../src/cli/args.ts";
import { helpText } from "../src/cli/help.ts";
import { SAFE_MODE_NOTICE } from "../src/cli/safeMode.ts";
import { dispatchCommand } from "../src/cli/commands.ts";
import { COMMANDS, knownSlashCommand } from "../src/input/commands.ts";
import { findSettingsPath } from "../src/config/settingsPath.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import {
  DOCTOR_OK_EXIT,
  DOCTOR_USAGE_EXIT,
  formatDoctorReport,
  maskSecretStatus,
  runDoctorCheckup,
} from "../src/cli/doctor.ts";
import { captureConsole } from "./helpers.ts";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const ORIG_CWD = process.cwd();
const ORIG_HOME = process.env["HOME"];
const ORIG_USERPROFILE = process.env["USERPROFILE"];
const ORIG_SAFE = process.env["NEO_SAFE_MODE"];
const REAL_USER_SETTINGS = join(homedir(), ".neo", "settings.json");

/** 测例用的假密钥：报告 / stdout / stderr 里绝不能出现这段明文。 */
const SECRET_CANARY = "sk-secret-DO-NOT-LEAK-91-CANARY";

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
  if (ORIG_SAFE === undefined) delete process.env["NEO_SAFE_MODE"];
  else process.env["NEO_SAFE_MODE"] = ORIG_SAFE;
}

afterEach(() => {
  restoreEnv();
});

afterAll(() => {
  restoreEnv();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

process.on("exit", () => {
  restoreEnv();
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
  env.NEO_SESSIONS_DIR = join(home, ".neo", "sessions");
  env.NEO_LOG_DIR = join(home, ".neo", "logs");
  env.NEO_MAILBOX_DIR = join(home, ".neo", "mailbox");
  env.NEO_ENV_HOME = join(home, ".neo", "env");
  Object.assign(env, extra);
  return env;
}

function writeSettings(cwd: string, extra: Record<string, unknown> = {}, apiKey: string | null = SECRET_CANARY): string {
  const settingsPath = join(cwd, "settings.json");
  assertNotRealUserSettings(settingsPath);
  const provider: Record<string, unknown> = {
    provider_name: "fake",
    provider_type: "openai",
    base_url: "http://127.0.0.1:9/v1",
    default_model_name: "fake-model",
    deep_reasoning_model_name: "fake-model",
    balanced_model_name: "fake-model",
    fast_model_name: "fake-model",
    max_tokens: 64,
    temperature: 0,
    context_window: 100_000,
  };
  if (apiKey !== null) provider.api_key = apiKey;
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        default_provider: "fake",
        default_model_tier: "default",
        classifier_provider: "fake",
        classifier_model_name: "fake-model",
        providers: [provider],
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return settingsPath;
}

function assertNoSecret(text: string, label: string): void {
  expect(text, `${label} must not contain plaintext api_key`).not.toContain(SECRET_CANARY);
}

function reportHasFixColumns(text: string): void {
  expect(text).toContain("问题");
  expect(text).toContain("位置");
  expect(text).toContain("建议");
}

async function spawnNeo(
  cwd: string,
  home: string,
  args: string[],
  extra: Record<string, string> = {},
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    env: isolatedEnv(home, extra),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function commandCtx(cwd: string, home: string, mcp?: () => import("../src/mcp/client.ts").McpServerState[]) {
  useHomeAndCwd(home, cwd);
  const cfg = loadConfig();
  const cap = captureConsole();
  const agent = new Agent({ cfg, console: cap.ui, mode: "ask", systemPrompt: "sys" });
  const ctx = {
    agent,
    ui: cap.ui,
    cfg,
    memory: {} as never,
    classifier: {} as never,
    meta: { id: "s91", model: cfg.model, cwd: cfg.cwd } as never,
    shutdown: () => {},
    selectDeps: {} as never,
    mailbox: null,
    checkpoints: null,
    rules: () => ({ alwaysOn: [], loaded: [], total: 0 }),
    ...(mcp ? { mcp } : {}),
  };
  return { ctx, cap, cfg };
}

describe("#91 声明 / 帮助 / 退出码常量", () => {
  test("COMMANDS 含 doctor 与别名 checkup，且能被 knownSlashCommand 识别", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain("doctor");
    expect(names).toContain("checkup");
    expect(COMMANDS.find((c) => c.name === "doctor")?.description.length).toBeGreaterThan(0);
    expect(knownSlashCommand("/doctor")).toBe("doctor");
    expect(knownSlashCommand("  /checkup  ")).toBe("checkup");
  });

  test("helpText 与用法提到 /doctor、/checkup、neo doctor", () => {
    const text = helpText();
    expect(text).toContain("/doctor");
    expect(text).toContain("/checkup");
    expect(text).toContain("neo doctor");
  });

  test("退出码：成功报告为 0，用法错误为 2", () => {
    expect(DOCTOR_OK_EXIT).toBe(0);
    expect(DOCTOR_USAGE_EXIT).toBe(2);
  });

  test("maskSecretStatus：有值是 present / 掩码，空值是 missing，绝不回显原文", () => {
    expect(maskSecretStatus(SECRET_CANARY)).toBe("present");
    expect(maskSecretStatus("")).toBe("missing");
    expect(maskSecretStatus(undefined)).toBe("missing");
    expect(maskSecretStatus("   ")).toBe("missing");
    expect(String(maskSecretStatus(SECRET_CANARY))).not.toContain(SECRET_CANARY);
  });
});

describe("#91 无 settings.json：指出缺失并指向向导，不启动向导、不写文件", () => {
  test("runDoctorCheckup 报告未找到 settings，并建议交互运行 neo 或参考 settings.example.json", () => {
    const s = sandbox("neo-91-missing-");
    useHomeAndCwd(s.home, s.cwd);
    expect(findSettingsPath()).toBeNull();
    const userPath = join(s.home, ".neo", "settings.json");
    expect(existsSync(userPath)).toBe(false);

    const report = runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home) });
    expect(report.settingsPath).toBeNull();
    expect(report.settingsParseable).toBeNull();
    const text = formatDoctorReport(report);
    reportHasFixColumns(text);
    expect(text).toMatch(/settings\.json/);
    expect(text).toMatch(/尚未找到|未找到|没有/);
    expect(text).toMatch(/交互/);
    expect(text).toContain("settings.example.json");
    expect(existsSync(userPath)).toBe(false);
    expect(existsSync(join(s.cwd, "settings.json"))).toBe(false);
  });
});

describe("#91 settings 可解析性、路径与密钥掩码", () => {
  test("实际载入的 settings 路径出现在报告中，且可解析", () => {
    const s = sandbox("neo-91-ok-");
    useHomeAndCwd(s.home, s.cwd);
    const settingsPath = writeSettings(s.cwd);
    const report = runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home) });
    expect(report.settingsPath).toBe(settingsPath);
    expect(report.settingsParseable).toBe(true);
    const text = formatDoctorReport(report);
    expect(text).toContain(settingsPath);
    expect(text).toMatch(/可解析/);
    assertNoSecret(text, "report");
    expect(text).toMatch(/已配置|\*{3}|\*/);
  });

  test("损坏的 JSON：报告路径与不可解析，且不把文件里的密钥明文写进报告", () => {
    const s = sandbox("neo-91-badjson-");
    useHomeAndCwd(s.home, s.cwd);
    const settingsPath = join(s.cwd, "settings.json");
    assertNotRealUserSettings(settingsPath);
    writeFileSync(
      settingsPath,
      `{ "api_key": "${SECRET_CANARY}", this is not valid json\n`,
      "utf8",
    );
    const report = runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home) });
    expect(report.settingsPath).toBe(settingsPath);
    expect(report.settingsParseable).toBe(false);
    const text = formatDoctorReport(report);
    reportHasFixColumns(text);
    expect(text).toContain(settingsPath);
    expect(text).toMatch(/无法解析|不可解析|解析失败/);
    assertNoSecret(text, "unparseable report");
  });

  test("缺 api_key / 缺 providers 会作为发现列出，不出现密钥明文", () => {
    const s = sandbox("neo-91-missing-key-");
    useHomeAndCwd(s.home, s.cwd);
    writeSettings(s.cwd, {}, null);
    const report = runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home) });
    const text = formatDoctorReport(report);
    reportHasFixColumns(text);
    expect(text).toMatch(/api_key/);
    expect(text).toMatch(/缺失|缺少|未配置/);
    assertNoSecret(text, "missing key report");
  });
});

describe("#91 hooks / 技能 / 规则 / AGENTS.md", () => {
  test("hooks 配置告警进入报告", () => {
    const s = sandbox("neo-91-hooks-");
    useHomeAndCwd(s.home, s.cwd);
    writeSettings(s.cwd, {
      hooks: {
        enabled: true,
        PreToolUse: [{ matcher: "shell" }],
      },
    });
    const text = formatDoctorReport(runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home) }));
    reportHasFixColumns(text);
    expect(text).toMatch(/hooks/);
    expect(text).toMatch(/command/);
  });

  test("损坏或重名的技能、规则，以及是否找到 AGENTS.md / 项目规则", () => {
    const s = sandbox("neo-91-skills-");
    useHomeAndCwd(s.home, s.cwd);
    writeSettings(s.cwd);

    mkdirSync(join(s.cwd, "skills", "good-skill"), { recursive: true });
    writeFileSync(
      join(s.cwd, "skills", "good-skill", "SKILL.md"),
      "---\nname: good-skill\ndescription: a fine skill\n---\n\n# Good\n",
      "utf8",
    );
    mkdirSync(join(s.cwd, "skills", "broken-skill"), { recursive: true });
    // 无 SKILL.md → 损坏
    mkdirSync(join(s.home, ".neo", "skills", "good-skill"), { recursive: true });
    writeFileSync(
      join(s.home, ".neo", "skills", "good-skill", "SKILL.md"),
      "---\nname: good-skill\ndescription: duplicate global skill\n---\n\n# Dup\n",
      "utf8",
    );

    writeFileSync(join(s.cwd, "AGENTS.md"), "# Agents\n\nproject instructions\n", "utf8");
    mkdirSync(join(s.cwd, ".neo", "rules"), { recursive: true });
    writeFileSync(
      join(s.cwd, ".neo", "rules", "alpha.md"),
      "---\ntitle: shared-name\n---\n\nrule a\n",
      "utf8",
    );
    writeFileSync(
      join(s.cwd, ".neo", "rules", "beta.md"),
      "---\ntitle: shared-name\n---\n\nrule b\n",
      "utf8",
    );
    const unreadable = join(s.cwd, ".neo", "rules", "unreadable.md");
    writeFileSync(unreadable, "cannot read me\n", "utf8");
    chmodSync(unreadable, 0);

    const text = formatDoctorReport(runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home) }));
    reportHasFixColumns(text);
    expect(text).toMatch(/broken-skill|SKILL\.md/);
    expect(text).toMatch(/重名|重复/);
    expect(text).toContain("good-skill");
    expect(text).toContain("AGENTS.md");
    expect(text).toMatch(/已找到|找到/);
    expect(text).toMatch(/shared-name|规则/);
    try {
      chmodSync(unreadable, 0o644);
    } catch {
      /* restore for cleanup */
    }
  });

  test("没有 AGENTS.md / 规则时也说清楚", () => {
    const s = sandbox("neo-91-no-agents-");
    useHomeAndCwd(s.home, s.cwd);
    writeSettings(s.cwd);
    const text = formatDoctorReport(runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home) }));
    expect(text).toMatch(/AGENTS\.md|项目指令|项目规则/);
    expect(text).toMatch(/未找到|没有找到|未发现/);
  });
});

describe("#91 MCP：配置层错误 + 已加载状态；CLI 不实时连接", () => {
  test("mcpServers 配置告警进入报告", () => {
    const s = sandbox("neo-91-mcp-cfg-");
    useHomeAndCwd(s.home, s.cwd);
    writeSettings(s.cwd, {
      mcpServers: {
        bad: { transport: "stdio" },
      },
    });
    const text = formatDoctorReport(runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home) }));
    reportHasFixColumns(text);
    expect(text).toMatch(/mcpServers|MCP/);
    expect(text).toMatch(/command/);
  });

  test("交互路径使用已加载的 MCP 状态，报告连接失败原因", () => {
    const s = sandbox("neo-91-mcp-live-");
    useHomeAndCwd(s.home, s.cwd);
    writeSettings(s.cwd, {
      mcpServers: {
        livefail: { command: "true" },
      },
    });
    const text = formatDoctorReport(
      runDoctorCheckup({
        cwd: s.cwd,
        env: isolatedEnv(s.home),
        mcpStates: [
          {
            name: "livefail",
            transport: "stdio",
            status: "error",
            tools: [],
            error: "mcpServers.livefail 启动失败：connection refused 91",
          },
        ],
      }),
    );
    expect(text).toContain("connection refused 91");
    expect(text).toContain("livefail");
  });

  test("未传入已加载状态时，不启动配置里的 MCP 进程（CLI 避免挂起）", () => {
    const s = sandbox("neo-91-mcp-noconn-");
    useHomeAndCwd(s.home, s.cwd);
    const mark = join(s.root, "mcp-started.txt");
    const starter = join(s.root, "mcp-start.sh");
    writeFileSync(starter, `#!/bin/sh\necho started > "${mark}"\nexec sleep 30\n`, { mode: 0o755 });
    writeSettings(s.cwd, {
      mcpServers: {
        hang: { command: starter },
      },
    });
    const report = runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home) });
    const text = formatDoctorReport(report);
    expect(existsSync(mark)).toBe(false);
    expect(text).toMatch(/未尝试|没有.*连接|不.*实时连接|避免挂起/);
  });
});

describe("#91 --safe-mode：披露未加载自定义面，仍检查 settings 与磁盘文件", () => {
  test("safe-mode 下报告说明自定义项未加载，但仍指出磁盘上的技能/AGENTS 问题", () => {
    const s = sandbox("neo-91-safe-");
    useHomeAndCwd(s.home, s.cwd);
    writeSettings(s.cwd);
    writeFileSync(join(s.cwd, "AGENTS.md"), "# Agents\n", "utf8");
    mkdirSync(join(s.cwd, "skills", "broken-skill"), { recursive: true });
    const text = formatDoctorReport(
      runDoctorCheckup({ cwd: s.cwd, env: isolatedEnv(s.home), safeMode: true }),
    );
    expect(text).toContain(SAFE_MODE_NOTICE);
    expect(text).toContain("AGENTS.md");
    expect(text).toMatch(/broken-skill|SKILL\.md/);
  });
});

describe("#91 斜杠命令 /doctor 与 /checkup", () => {
  test("/doctor 与 /checkup 打印同一份报告，默认不改 settings", async () => {
    const s = sandbox("neo-91-slash-");
    writeSettings(s.cwd, {
      hooks: { enabled: true, PreToolUse: [{ matcher: "shell" }] },
    });
    const { ctx, cap } = commandCtx(s.cwd, s.home);
    const settingsPath = join(s.cwd, "settings.json");
    const before = statSync(settingsPath);
    const rawBefore = readFileSync(settingsPath, "utf8");

    await dispatchCommand("/doctor", ctx);
    const doctorOut = cap.out();
    reportHasFixColumns(doctorOut);
    expect(doctorOut).toContain(settingsPath);
    assertNoSecret(doctorOut, "/doctor output");

    cap.clear();
    await dispatchCommand("/checkup", ctx);
    const checkupOut = cap.out();
    reportHasFixColumns(checkupOut);
    expect(checkupOut).toContain(settingsPath);
    assertNoSecret(checkupOut, "/checkup output");

    const after = statSync(settingsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(settingsPath, "utf8")).toBe(rawBefore);
  });
});

describe("#91 CLI `neo doctor`", () => {
  test("parseArgs 把 doctor 放进 rest[0]", () => {
    expect(parseArgs(["doctor"]).rest[0]).toBe("doctor");
    expect(parseArgs(["--safe-mode", "doctor"]).rest[0]).toBe("doctor");
    expect(parseArgs(["doctor"]).safeMode).toBe(false);
    expect(parseArgs(["doctor", "--safe-mode"]).safeMode).toBe(true);
  });

  test("成功打印报告并 exit 0（即使有发现）；不进 TUI、不发模型请求、不改文件、不写密钥明文", async () => {
    const s = sandbox("neo-91-cli-ok-");
    const settingsPath = writeSettings(s.cwd, {}, null);
    const before = statSync(settingsPath);
    const started = Date.now();
    const r = await spawnNeo(s.cwd, s.home, ["doctor"], {}, { timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.code).toBe(DOCTOR_OK_EXIT);
    reportHasFixColumns(r.stdout);
    expect(r.stdout).toContain(settingsPath);
    expect(r.stdout).toMatch(/api_key/);
    assertNoSecret(r.stdout, "cli stdout");
    assertNoSecret(r.stderr, "cli stderr");
    const after = statSync(settingsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(s.home, ".neo", "settings.json"))).toBe(false);
  });

  test("没有 settings.json 时 exit 0，提示去跑交互 neo，不写文件、不进向导", async () => {
    const s = sandbox("neo-91-cli-missing-");
    const r = await spawnNeo(s.cwd, s.home, ["doctor"], {}, { timeoutMs: 10_000 });
    expect(r.code).toBe(DOCTOR_OK_EXIT);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/settings\.json/);
    expect(out).toContain("settings.example.json");
    expect(existsSync(join(s.home, ".neo", "settings.json"))).toBe(false);
  });

  test("用法错误 exit 2：多余参数或与 -p 同时使用", async () => {
    const s = sandbox("neo-91-cli-usage-");
    writeSettings(s.cwd);
    const extra = await spawnNeo(s.cwd, s.home, ["doctor", "leftover"], {}, { timeoutMs: 10_000 });
    expect(extra.code).toBe(DOCTOR_USAGE_EXIT);
    const withPrint = await spawnNeo(s.cwd, s.home, ["doctor", "-p", "hi"], {}, { timeoutMs: 10_000 });
    expect(withPrint.code).toBe(DOCTOR_USAGE_EXIT);
  });

  test("CLI 不启动 MCP（配置了会写标记的 server）", async () => {
    const s = sandbox("neo-91-cli-mcp-");
    const mark = join(s.root, "mcp-started.txt");
    const starter = join(s.root, "mcp-start.sh");
    writeFileSync(starter, `#!/bin/sh\necho started > "${mark}"\nexec sleep 30\n`, { mode: 0o755 });
    writeSettings(s.cwd, { mcpServers: { hang: { command: starter } } });
    const r = await spawnNeo(s.cwd, s.home, ["doctor"], {}, { timeoutMs: 10_000 });
    expect(r.code).toBe(DOCTOR_OK_EXIT);
    expect(existsSync(mark)).toBe(false);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/未尝试|没有.*连接|不.*实时连接|避免挂起/);
  });
});
