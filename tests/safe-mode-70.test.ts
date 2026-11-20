/**
 * issue #70：`--safe-mode` / `NEO_SAFE_MODE` 以干净配置启动，排查自定义项故障。
 *
 * 覆盖建议最小验收 1–4：
 *  1. 不加载 AGENTS.md / 路径规则 / 技能 / hooks / MCP / LSP / 仓库地图 / 记忆 wiki；
 *     /hooks、/mcp、/skills、/context 能看出这些面未加载。
 *  2. 登录 / provider / 模型、内置工具、/mode 仍按常规工作。
 *  3. 启动有一行「当前为干净配置，自定义项未加载」。
 *  4. 不改 settings.json，只影响本次进程。
 *
 * 隔离：全部用例使用临时 HOME / cwd，绝不读、写、覆盖或删除本机真实
 * ~/.neo/settings.json。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
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

import { parseArgs } from "../src/cli/args.ts";
import { helpText } from "../src/cli/help.ts";
import {
  SAFE_MODE_NOTICE,
  applySafeMode,
  isSafeModeEnabled,
} from "../src/cli/safeMode.ts";
import { dispatchCommand } from "../src/cli/commands.ts";
import { loadConfig } from "../src/config.ts";
import { writeBackCapabilities } from "../src/env/modelCaps.ts";
import { discoverSkills } from "../src/skills.ts";
import { discoverProjectRules } from "../src/rules/index.ts";
import { Agent } from "../src/agent.ts";
import { captureConsole } from "./helpers.ts";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const ORIG_CWD = process.cwd();
const ORIG_HOME = process.env["HOME"];
const ORIG_USERPROFILE = process.env["USERPROFILE"];
const ORIG_SAFE = process.env["NEO_SAFE_MODE"];
const REAL_USER_SETTINGS = join(homedir(), ".neo", "settings.json");

const CANARY_AGENTS = "SAFE_MODE_CANARY_AGENTS_70";
const CANARY_RULE = "SAFE_MODE_CANARY_RULE_70";
const CANARY_SKILL = "safe-mode-canary";
const CANARY_SKILL_DESC = "SAFE_MODE_CANARY_SKILL_70";

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

function hookScript(dir: string, mark: string): string {
  const p = join(dir, "hook-mark.sh");
  writeFileSync(p, `#!/bin/sh\necho SessionStart >> "${mark}"\n`, { mode: 0o755 });
  return p;
}

function writeCustomProject(
  cwd: string,
  home: string,
  extra: Record<string, unknown> = {},
): { settingsPath: string; hookMark: string } {
  const hookMark = join(cwd, "..", "hook-mark.txt");
  const hook = hookScript(cwd, hookMark);

  mkdirSync(join(cwd, "skills", CANARY_SKILL), { recursive: true });
  writeFileSync(
    join(cwd, "skills", CANARY_SKILL, "SKILL.md"),
    `---\nname: ${CANARY_SKILL}\ndescription: ${CANARY_SKILL_DESC}\n---\n\n# Canary\n`,
    "utf8",
  );
  writeFileSync(join(cwd, "AGENTS.md"), `# Agents\n\n${CANARY_AGENTS}\n`, "utf8");
  mkdirSync(join(cwd, ".neo", "rules"), { recursive: true });
  writeFileSync(
    join(cwd, ".neo", "rules", "always.md"),
    `---\npaths: []\n---\n\n${CANARY_RULE}\n`,
    "utf8",
  );
  mkdirSync(join(home, ".neo", "skills", "global-canary"), { recursive: true });
  writeFileSync(
    join(home, ".neo", "skills", "global-canary", "SKILL.md"),
    `---\nname: global-canary\ndescription: SAFE_MODE_CANARY_GLOBAL_70\n---\n\n# Global\n`,
    "utf8",
  );

  const settingsPath = join(cwd, "settings.json");
  assertNotRealUserSettings(settingsPath);
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        default_provider: "fake",
        default_model_tier: "default",
        classifier_provider: "fake",
        classifier_model_name: "fake-model",
        providers: [
          {
            provider_name: "fake",
            provider_type: "openai",
            base_url: "http://127.0.0.1:9/v1",
            api_key: "sk-test-safe-mode",
            default_model_name: "fake-model",
            deep_reasoning_model_name: "fake-model",
            balanced_model_name: "fake-model",
            fast_model_name: "fake-model",
            max_tokens: 64,
            temperature: 0,
            context_window: 100_000,
          },
        ],
        hooks: {
          enabled: true,
          SessionStart: [{ command: hook }],
        },
        mcpServers: {
          canary: { command: "echo", args: ["mcp-should-not-start"] },
        },
        lsp: { enabled: true, servers: [{ command: "false", args: [] }] },
        repo_map: { enabled: true, budget_tokens: 2000 },
        memory: { enabled: true },
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { settingsPath, hookMark };
}

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

describe("#70 parseArgs / 环境变量", () => {
  test("识别 --safe-mode，默认关闭，无 --no-safe-mode", () => {
    expect(parseArgs([]).safeMode).toBe(false);
    expect(parseArgs(["--safe-mode"]).safeMode).toBe(true);
    expect(parseArgs(["--safe-mode", "-p", "hi"]).safeMode).toBe(true);
    expect(parseArgs(["-p", "hi"]).safeMode).toBe(false);
    expect(parseArgs(["--no-safe-mode"]).safeMode).toBe(false);
    expect(parseArgs(["--no-safe-mode"]).rest).toContain("--no-safe-mode");
  });

  test("NEO_SAFE_MODE 只认 1/true/yes（大小写不敏感）", () => {
    expect(isSafeModeEnabled(false, {})).toBe(false);
    expect(isSafeModeEnabled(true, {})).toBe(true);
    for (const v of ["1", "true", "TRUE", "Yes", " yes "]) {
      expect(isSafeModeEnabled(false, { NEO_SAFE_MODE: v })).toBe(true);
    }
    for (const v of ["0", "false", "no", "on", "", "maybe"]) {
      expect(isSafeModeEnabled(false, { NEO_SAFE_MODE: v })).toBe(false);
    }
    expect(isSafeModeEnabled(true, { NEO_SAFE_MODE: "0" })).toBe(true);
  });

  test("--help 与帮助文本说明旗标与环境变量", () => {
    const text = helpText();
    expect(text).toContain("--safe-mode");
    expect(text).toContain("NEO_SAFE_MODE");
    expect(text).toContain("干净配置");
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

describe("#70 applySafeMode 隔离自定义面且不改 settings", () => {
  test("settings 里配齐自定义面时，apply 后内存里全部卸下，文件不动", () => {
    const s = sandbox("neo-70-apply-");
    useHomeAndCwd(s.home, s.cwd);
    const { settingsPath } = writeCustomProject(s.cwd, s.home);
    const before = statSync(settingsPath);
    const rawBefore = readFileSync(settingsPath, "utf8");

    const cfg = loadConfig();
    expect(cfg.settingsPath && resolve(cfg.settingsPath)).toBe(resolve(settingsPath));
    expect(cfg.providerName).toBe("fake");
    expect(cfg.model).toBe("fake-model");
    expect(cfg.hooks.enabled).toBe(true);
    expect((cfg.mcpServers ?? []).length).toBeGreaterThan(0);
    expect(cfg.lsp.enabled).toBe(true);
    expect(cfg.repoMap.enabled).toBe(true);
    expect(cfg.memory.enabled).toBe(true);
    expect(discoverSkills(cfg).some((x) => x.name === CANARY_SKILL)).toBe(true);
    expect(discoverProjectRules(cfg.cwd).length).toBeGreaterThan(0);

    applySafeMode(cfg);

    expect(cfg.safeMode).toBe(true);
    expect(cfg.providerName).toBe("fake");
    expect(cfg.model).toBe("fake-model");
    expect(cfg.apiKey).toBe("sk-test-safe-mode");
    expect(cfg.hooks.enabled).toBe(false);
    expect(Object.values(cfg.hooks.hooks).every((list) => list.length === 0)).toBe(true);
    expect(cfg.mcpServers ?? []).toEqual([]);
    expect(cfg.lsp.enabled).toBe(false);
    expect(cfg.lsp.servers).toEqual([]);
    expect(cfg.repoMap.enabled).toBe(false);
    expect(cfg.memory.enabled).toBe(false);
    expect(discoverSkills(cfg)).toEqual([]);

    const after = statSync(settingsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(after.mode).toBe(before.mode);
    expect(readFileSync(settingsPath, "utf8")).toBe(rawBefore);
  });

  test("能力写回在 safe-mode 下不改 settings.json", () => {
    const s = sandbox("neo-70-writeback-");
    useHomeAndCwd(s.home, s.cwd);
    const { settingsPath } = writeCustomProject(s.cwd, s.home);
    const rawBefore = readFileSync(settingsPath, "utf8");
    const before = statSync(settingsPath);
    const cfg = applySafeMode(loadConfig());
    const r = writeBackCapabilities(cfg, {
      contextWindow: 128_000,
      maxOutputTokens: 4096,
      vision: true,
      tools: true,
      reasoning: true,
    });
    expect(r.persisted).toBe(false);
    expect(r.written).toEqual([]);
    const after = statSync(settingsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(settingsPath, "utf8")).toBe(rawBefore);
  });
});

describe("#70 斜杠命令展示未加载，/mode 仍可用", () => {
  test("/hooks /mcp /skills /context 标明未加载，/mode 仍显示权限模式", async () => {
    const s = sandbox("neo-70-cmds-");
    useHomeAndCwd(s.home, s.cwd);
    writeCustomProject(s.cwd, s.home);
    const cfg = applySafeMode(loadConfig());
    const cap = captureConsole();
    const agent = new Agent({ cfg, console: cap.ui, mode: "ask", systemPrompt: "sys" });
    const ctx = {
      agent,
      ui: cap.ui,
      cfg,
      memory: {} as never,
      classifier: {} as never,
      meta: { id: "s70", model: cfg.model, cwd: cfg.cwd } as never,
      shutdown: () => {},
      selectDeps: {} as never,
      mailbox: null,
      checkpoints: null,
      rules: () => ({ alwaysOn: [], loaded: [], total: 0 }),
    };

    await dispatchCommand("/hooks", ctx);
    await dispatchCommand("/mcp", ctx);
    await dispatchCommand("/skills", ctx);
    await dispatchCommand("/context", ctx);
    await dispatchCommand("/mode", ctx);
    const out = cap.out();

    expect(out).toContain(SAFE_MODE_NOTICE);
    expect(out).toContain("未加载");
    expect(out).not.toContain("hook-mark.sh");
    expect(out).not.toContain("canary");
    expect(out).not.toContain(CANARY_SKILL);
    expect(out).not.toContain("已启用");
    expect(out).toContain("当前模式");
    expect(out).toContain("ask");
  });
});

describe("#70 -p --safe-mode 启动提示且不执行自定义项", () => {
  test("启动打印提示、不跑 SessionStart hook、不把项目记忆/技能送进模型、不改 settings", async () => {
    const s = sandbox("neo-70-p-");
    const { settingsPath, hookMark } = writeCustomProject(s.cwd, s.home);
    const before = statSync(settingsPath);
    const rawBefore = readFileSync(settingsPath, "utf8");

    const bodies: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/models")) {
          return Response.json({ object: "list", data: [{ id: "fake-model" }] });
        }
        if (url.pathname.endsWith("/chat/completions")) {
          bodies.push(await req.text());
          const answer =
            'data: {"choices":[{"delta":{"content":"pong-safe"}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
            "data: [DONE]\n\n";
          return new Response(answer, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const settings = JSON.parse(rawBefore) as { providers: Array<Record<string, unknown>> };
      const provider = settings.providers[0];
      if (!provider) throw new Error("test fixture missing providers[0]");
      provider["base_url"] = `http://127.0.0.1:${server.port}/v1`;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      const afterRewrite = statSync(settingsPath);

      const proc = Bun.spawn(
        ["bun", INDEX, "--safe-mode", "--auto", "off", "--no-fallback", "-p", "ping"],
        {
          cwd: s.cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: isolatedEnv(s.home),
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const combined = `${out}\n${err}`;
      expect(code).toBe(0);
      expect(combined).toContain(SAFE_MODE_NOTICE);
      expect(out).toContain("pong-safe");
      expect(existsSync(hookMark)).toBe(false);
      const sent = bodies.join("\n");
      expect(sent).toContain("ping");
      expect(sent).not.toContain(CANARY_AGENTS);
      expect(sent).not.toContain(CANARY_RULE);
      // 技能目录可能出现在工作区目录树里，那不是“加载技能”；描述与索引才是。
      expect(sent).not.toContain(CANARY_SKILL_DESC);
      expect(sent).not.toContain(`${CANARY_SKILL}：`);
      expect(sent).not.toContain("SAFE_MODE_CANARY_GLOBAL_70");
      const after = statSync(settingsPath);
      expect(after.mtimeMs).toBe(afterRewrite.mtimeMs);
      expect(readFileSync(settingsPath, "utf8")).toBe(
        `${JSON.stringify(settings, null, 2)}\n`,
      );
      // 对照：真实用户 settings 路径不得被本测试当作 settingsPath
      expect(resolve(settingsPath)).not.toBe(resolve(REAL_USER_SETTINGS));
      void before;
    } finally {
      server.stop(true);
    }
  }, 40_000);

  test("等价环境变量 NEO_SAFE_MODE=1 同样打印提示且不跑 hook", async () => {
    const s = sandbox("neo-70-env-");
    const { settingsPath, hookMark } = writeCustomProject(s.cwd, s.home);
    const rawBefore = readFileSync(settingsPath, "utf8");
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/models")) {
          return Response.json({ object: "list", data: [{ id: "fake-model" }] });
        }
        if (url.pathname.endsWith("/chat/completions")) {
          const answer =
            'data: {"choices":[{"delta":{"content":"pong-env"}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
            "data: [DONE]\n\n";
          return new Response(answer, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const settings = JSON.parse(rawBefore) as { providers: Array<Record<string, unknown>> };
      const provider = settings.providers[0];
      if (!provider) throw new Error("test fixture missing providers[0]");
      provider["base_url"] = `http://127.0.0.1:${server.port}/v1`;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      const proc = Bun.spawn(["bun", INDEX, "--auto", "off", "--no-fallback", "-p", "ping"], {
        cwd: s.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: isolatedEnv(s.home, { NEO_SAFE_MODE: "1" }),
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(`${out}\n${err}`).toContain(SAFE_MODE_NOTICE);
      expect(out).toContain("pong-env");
      expect(existsSync(hookMark)).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 40_000);
});
