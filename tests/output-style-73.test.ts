/**
 * issue #73：`/output-style` 输出风格。
 *
 * 覆盖已签协议的关键行为：命令与确认口径、不写配置文件、未知值、
 * 发现路径与冲突、style 段位置与选档开销、缓存指纹、子代理不加 style、
 * keep-coding-instructions 提示、状态栏、/clear 不撤风格。
 * 全部用临时目录 / 隔离 HOME，不碰真实 ~/.neo/settings.json。
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { Agent, type AgentIO } from "../src/agent.ts";
import { dispatchCommand, wireCommands } from "../src/cli/commands.ts";
import type { CommandContext } from "../src/cli/commandContext.ts";
import { helpText } from "../src/cli/help.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { COMMANDS, knownSlashCommand } from "../src/input/commands.ts";
import { PromptManager } from "../src/prompt/manager.ts";
import { renderSubagentPrompt } from "../src/prompt/subagent.ts";
import { renderStatus, statusSegments, type StatusSnapshot } from "../src/tui/status.ts";
import {
  BUILTIN_OUTPUT_STYLES,
  applyOutputStyle,
  buildOutputStyleOptions,
  discoverOutputStyles,
  keepCodingInstructionsNotice,
  matchOutputStyle,
  normalizeBuiltinOutputStyle,
  persistOutputStyleHint,
  renderStyleSection,
  resolveOutputStyleConfig,
} from "../src/outputStyle/index.ts";
import { captureConsole } from "./helpers.ts";

const ROOTS: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  ROOTS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

function initRepo(cwd: string): void {
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "test"]);
}

const MINIMAL_PROVIDER = {
  provider_name: "test",
  provider_type: "openai",
  base_url: "http://127.0.0.1:9/v1",
  api_key: "sk-test",
  default_model_name: "m-default",
  deep_reasoning_model_name: "m-deep",
  balanced_model_name: "m-balanced",
  fast_model_name: "m-fast",
};

function writeSettings(dir: string, extra: Record<string, unknown> = {}): string {
  const path = join(dir, "settings.json");
  write(
    path,
    `${JSON.stringify(
      {
        default_provider: "test",
        providers: [MINIMAL_PROVIDER],
        memory: { enabled: false },
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

function withHome<T>(home: string, fn: () => T): T {
  const prevHome = process.env["HOME"];
  const prevProfile = process.env["USERPROFILE"];
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    if (prevProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = prevProfile;
  }
}

function makeCfg(over: Partial<Config> = {}): Config {
  const cwd = over.cwd ?? tempDir("neo-73-cfg-");
  return {
    providerName: "test",
    providerType: "openai",
    apiKey: "sk-test",
    baseUrl: "http://127.0.0.1:9/v1",
    modelTier: "default",
    model: "m-default",
    providers: [],
    routes: {},
    classifierModel: "m-fast",
    classifierProvider: "test",
    legacyFormat: false,
    maxTokensWarnings: [],
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 200_000,
    contextWindowSource: "models_api",
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 200_000 },
    compactThreshold: 0.8,
    maxToolIterations: 80,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    cwd,
    settingsPath: over.settingsPath ?? null,
    skillsStore: join(cwd, "skills"),
    memory: { enabled: false },
    hooks: { hooks: {} },
    systemPrompt: undefined,
    outputStyle: "Default",
    outputStyleWarnings: [],
    env: { prompt: false },
    ...over,
  } as unknown as Config;
}

function silentIO(): AgentIO {
  return {
    line(): void {},
    blank(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    toolHeader(): void {},
    toolResult(): void {},
    indent(body: string, prefix = "│ "): string {
      return body
        .split("\n")
        .map((l) => prefix + l)
        .join("\n");
    },
    startSpinner(): void {},
    updateSpinner(): void {},
    stopSpinner(): void {},
    beginStream(): void {},
    writeStream(): void {},
    endStream(): void {},
    ensureStreamClosed(): void {},
    async confirm(): Promise<boolean> {
      return true;
    },
    width: 100,
  };
}

function makeAgent(cfg: Config, pm?: PromptManager): Agent {
  const prompt = pm ?? new PromptManager({ mailbox: false, askUser: false, sessionName: "neo", nonInteractive: true });
  return new Agent({
    cfg,
    console: silentIO(),
    mode: "ask",
    systemPrompt: prompt.render(cfg).text,
    renderSystemPrompt: () => prompt.render(cfg).text,
  });
}

function makeCmdCtx(
  agent: Agent,
  ui: ReturnType<typeof captureConsole>["ui"],
  cfg: Config,
  promptManager?: PromptManager,
): CommandContext {
  return {
    agent,
    ui,
    cfg,
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: { id: "s1", model: "m-default", cwd: cfg.cwd } as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
    promptManager,
  };
}

wireCommands();

const snap = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  version: "0.4.54",
  model: "deepseek-flash",
  tier: "balanced",
  mode: "ask",
  branch: "main",
  ctxUsage: 0.42,
  elapsedMs: 42_000,
  active: true,
  tokensTotal: 12_300,
  width: 120,
  ...over,
});

describe("登记与帮助", () => {
  test("COMMANDS 与 knownSlashCommand 登记 /output-style", () => {
    expect(COMMANDS.some((c) => c.name === "output-style")).toBe(true);
    expect(knownSlashCommand("/output-style Concise")).toBe("output-style");
    expect(knownSlashCommand("  /output-style")).toBe("output-style");
  });

  test("/help 含 /output-style 一行，且不做 /config 子菜单", () => {
    const text = helpText();
    expect(text).toContain("/output-style");
    expect(text).not.toMatch(/\/config[^\n]*output-style/);
  });

  test("内置专名是 PascalCase：Default / Proactive / Concise / Explanatory / Learning", () => {
    expect([...BUILTIN_OUTPUT_STYLES]).toEqual([
      "Default",
      "Proactive",
      "Concise",
      "Explanatory",
      "Learning",
    ]);
  });
});

describe("内置名规范化与匹配", () => {
  test("读取内置名大小写不敏感并规范成 PascalCase", () => {
    expect(normalizeBuiltinOutputStyle("concise")).toBe("Concise");
    expect(normalizeBuiltinOutputStyle("LEARNING")).toBe("Learning");
    expect(normalizeBuiltinOutputStyle("Default")).toBe("Default");
    expect(normalizeBuiltinOutputStyle("default")).toBe("Default");
    expect(normalizeBuiltinOutputStyle("nope")).toBeNull();
  });

  test("命令匹配：精确优先于大小写不敏感", () => {
    const styles = [
      ...["Default", "Proactive", "Concise", "Explanatory", "Learning"].map((name) => ({
        name,
        description: "",
        kind: "builtin" as const,
        body: name === "Default" ? "" : "x",
      })),
      { name: "concise", description: "custom", kind: "custom" as const, body: "CUSTOM-CI" },
    ];
    expect(matchOutputStyle("Concise", styles)?.kind).toBe("builtin");
    expect(matchOutputStyle("Concise", styles)?.name).toBe("Concise");
    expect(matchOutputStyle("concise", styles)?.kind).toBe("custom");
    expect(matchOutputStyle("concise", styles)?.body).toBe("CUSTOM-CI");
    expect(matchOutputStyle("LEARNING", styles)?.name).toBe("Learning");
    expect(matchOutputStyle("missing", styles)).toBeNull();
  });
});

describe("发现路径", () => {
  test("扫用户目录与从 cwd 走到 git toplevel 的项目目录，不读 .claude/output-styles", () => {
    const repo = tempDir("neo-73-disc-");
    const home = join(repo, "home");
    const sub = join(repo, "pkg", "app");
    mkdirSync(sub, { recursive: true });
    initRepo(repo);
    write(join(home, ".neo", "output-styles", "user-voice.md"), "---\nname: UserVoice\ndescription: 用户级\n---\nUSER-BODY\n");
    write(join(repo, ".neo", "output-styles", "root-voice.md"), "---\nname: RootVoice\n---\nROOT-BODY\n");
    write(join(sub, ".neo", "output-styles", "near-voice.md"), "---\nname: NearVoice\n---\nNEAR-BODY\n");
    write(join(sub, ".claude", "output-styles", "claude-only.md"), "---\nname: ClaudeOnly\n---\nSHOULD-NOT-LOAD\n");

    const found = discoverOutputStyles({ cwd: sub, home });
    const names = found.styles.map((s) => s.name);
    expect(names).toContain("UserVoice");
    expect(names).toContain("RootVoice");
    expect(names).toContain("NearVoice");
    expect(names).not.toContain("ClaudeOnly");
    expect(found.styles.find((s) => s.name === "UserVoice")?.body).toContain("USER-BODY");
    expect(found.styles.some((s) => s.body.includes("SHOULD-NOT-LOAD"))).toBe(false);
  });

  test("不在 git 仓库里只扫 cwd/.neo/output-styles 加用户目录", () => {
    const root = tempDir("neo-73-nongit-");
    const home = join(root, "home");
    const cwd = join(root, "proj");
    const outside = join(root, "outside");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(outside, { recursive: true });
    write(join(home, ".neo", "output-styles", "from-user.md"), "---\nname: FromUser\n---\nU\n");
    write(join(cwd, ".neo", "output-styles", "from-cwd.md"), "---\nname: FromCwd\n---\nC\n");
    write(join(outside, ".neo", "output-styles", "from-out.md"), "---\nname: FromOut\n---\nNO\n");
    const found = discoverOutputStyles({ cwd, home });
    const names = found.styles.map((s) => s.name);
    expect(names).toContain("FromUser");
    expect(names).toContain("FromCwd");
    expect(names).not.toContain("FromOut");
  });

  test("同名：更靠近 cwd 的项目文件赢，项目优于用户", () => {
    const repo = tempDir("neo-73-prec-");
    const home = join(repo, "home");
    const sub = join(repo, "pkg");
    mkdirSync(sub, { recursive: true });
    initRepo(repo);
    write(join(home, ".neo", "output-styles", "voice.md"), "---\nname: Voice\n---\nUSER\n");
    write(join(repo, ".neo", "output-styles", "voice.md"), "---\nname: Voice\n---\nROOT\n");
    write(join(sub, ".neo", "output-styles", "voice.md"), "---\nname: Voice\n---\nNEAR\n");
    const near = discoverOutputStyles({ cwd: sub, home }).styles.find((s) => s.name === "Voice");
    expect(near?.body).toContain("NEAR");
    const atRoot = discoverOutputStyles({ cwd: repo, home }).styles.find((s) => s.name === "Voice");
    expect(atRoot?.body).toContain("ROOT");
  });

  test("自定义名与内置冲突则跳过并打诊断，不覆盖内置", () => {
    const root = tempDir("neo-73-conflict-");
    const home = join(root, "home");
    const cwd = join(root, "proj");
    mkdirSync(cwd, { recursive: true });
    write(join(cwd, ".neo", "output-styles", "concise.md"), "---\nname: Concise\n---\nSHOULD-SKIP\n");
    const found = discoverOutputStyles({ cwd, home });
    const concise = found.styles.filter((s) => s.name === "Concise");
    expect(concise).toHaveLength(1);
    expect(concise[0]?.kind).toBe("builtin");
    expect(concise[0]?.body).not.toContain("SHOULD-SKIP");
    expect(found.diagnostics.some((d) => /Concise/.test(d))).toBe(true);
  });

  test("frontmatter 解析失败用文件名、空字段，正文仍加载；未知字段与 force-for-plugin 忽略", () => {
    const root = tempDir("neo-73-fm-");
    const home = join(root, "home");
    const cwd = join(root, "proj");
    write(
      join(cwd, ".neo", "output-styles", "broken-style.md"),
      "---\nname: Broken\nthis block never closes\nBODY-STILL-HERE\n",
    );
    write(
      join(cwd, ".neo", "output-styles", "extra-fields.md"),
      "---\nname: ExtraFields\ndescription: 有未知字段\nforce-for-plugin: true\nunknown-key: nope\nkeep-coding-instructions: false\n---\nEXTRA-BODY\n",
    );
    const found = discoverOutputStyles({ cwd, home });
    const broken = found.styles.find((s) => s.name === "broken-style" || s.name === "Broken");
    expect(broken).toBeDefined();
    expect(broken?.name).toBe("broken-style");
    expect(broken?.description ?? "").toBe("");
    expect(broken?.body).toContain("BODY-STILL-HERE");
    const extra = found.styles.find((s) => s.name === "ExtraFields");
    expect(extra?.description).toBe("有未知字段");
    expect(extra?.body).toContain("EXTRA-BODY");
    expect(extra?.keepCodingInstructions).toBe(false);
  });
});

describe("配置读写", () => {
  test("启动时读入已有 outputStyle，并规范成 PascalCase", () => {
    const proj = tempDir("neo-73-load-");
    const home = join(proj, "home");
    mkdirSync(home, { recursive: true });
    writeSettings(proj, { outputStyle: "concise" });
    const cfg = withHome(home, () => loadConfig({}, { settingsDir: proj }));
    expect(cfg.outputStyle).toBe("Concise");
    expect(cfg.outputStyleWarnings ?? []).toEqual([]);
  });

  test("配置里未知 outputStyle：告警并回退 Default", () => {
    const proj = tempDir("neo-73-unknown-cfg-");
    const home = join(proj, "home");
    mkdirSync(home, { recursive: true });
    writeSettings(proj, { outputStyle: "NotAStyle" });
    const cfg = withHome(home, () => loadConfig({}, { settingsDir: proj }));
    expect(cfg.outputStyle).toBe("Default");
    expect((cfg.outputStyleWarnings ?? []).some((w) => /NotAStyle/.test(w))).toBe(true);
  });

  test("resolveOutputStyleConfig 对缺失字段回退 Default", () => {
    const proj = tempDir("neo-73-resolve-");
    const got = resolveOutputStyleConfig({}, { cwd: proj, home: join(proj, "home") });
    expect(got.outputStyle).toBe("Default");
    expect(got.outputStyleWarnings).toEqual([]);
  });
});

describe("命令交互", () => {
  test("无参数、非 TTY：列出并标记当前项；Proactive hint 写明不改变权限模式", async () => {
    const options = buildOutputStyleOptions(
      discoverOutputStyles({ cwd: tempDir("neo-73-opt-"), home: tempDir("neo-73-opt-home-") }).styles,
      "Default",
    );
    expect(options.map((o) => o.label)).toEqual([
      "Default",
      "Proactive",
      "Concise",
      "Explanatory",
      "Learning",
    ]);
    expect(options.find((o) => o.label === "Proactive")?.hint).toContain("不改变权限模式");
    expect(options.find((o) => o.label === "Default")?.hint).toMatch(/当前/);

    const cfg = makeCfg();
    const cap = captureConsole({ stdinIsTTY: false, stdoutIsTTY: false });
    const agent = makeAgent(cfg);
    await dispatchCommand("/output-style", makeCmdCtx(agent, cap.ui, cfg));
    const out = cap.out();
    expect(out).toContain("Default");
    expect(out).toContain("Proactive");
    expect(out).toContain("Concise");
    expect(out).toMatch(/●|当前/);
    expect(out).toContain("不改变权限模式");
  });

  test("/output-style Concise 切换本会话，确认口径对齐 /mode，并给出 muted 持久化提示", async () => {
    const proj = tempDir("neo-73-cmd-");
    const home = join(proj, "home");
    mkdirSync(home, { recursive: true });
    const settings = writeSettings(proj);
    const before = readFileSync(settings, "utf8");
    const cfg = makeCfg({ cwd: proj, settingsPath: settings });
    const cap = captureConsole({ stdinIsTTY: false });
    const pm = new PromptManager({ mailbox: false, askUser: false, sessionName: "neo", nonInteractive: true });
    const agent = makeAgent(cfg, pm);
    await dispatchCommand("/output-style Concise", makeCmdCtx(agent, cap.ui, cfg, pm));
    const out = cap.out();
    expect(cfg.outputStyle).toBe("Concise");
    expect(out).toContain("输出风格 → Concise");
    expect(out).toContain("第一份存在的候选文件全赢");
    expect(out).toContain("settingsPath.ts");
    expect(out).toContain("loadConfig");
    expect(out).toMatch(/不是字段级/);
    expect(out).toContain("不要为这个字段新建一份工作区 settings.json");
    expect(out).toContain("outputStyle");
    expect(readFileSync(settings, "utf8")).toBe(before);
    expect(existsSync(join(home, ".neo", "settings.json"))).toBe(false);
  });

  test("切到 Default 的确认写「不加 style 段」；大小写不敏感", async () => {
    const cfg = makeCfg({ outputStyle: "Concise" });
    const cap = captureConsole({ stdinIsTTY: false });
    const pm = new PromptManager({ mailbox: false, askUser: false, sessionName: "neo", nonInteractive: true });
    const agent = makeAgent(cfg, pm);
    await dispatchCommand("/output-style default", makeCmdCtx(agent, cap.ui, cfg, pm));
    expect(cfg.outputStyle).toBe("Default");
    expect(cap.out()).toContain("输出风格 → Default（不加 style 段）");
  });

  test("未知名称报错并列可用风格，不悄悄回退", async () => {
    const cfg = makeCfg({ outputStyle: "Learning" });
    const cap = captureConsole({ stdinIsTTY: false });
    const agent = makeAgent(cfg);
    await dispatchCommand("/output-style NotAStyle", makeCmdCtx(agent, cap.ui, cfg));
    const out = cap.out();
    expect(cfg.outputStyle).toBe("Learning");
    expect(out).toMatch(/未知|没有|不存在|找不到/);
    expect(out).toContain("Default");
    expect(out).toContain("Concise");
    expect(out).toContain("Learning");
    expect(out).not.toContain("输出风格 → Default");
  });

  test("Proactive 确认不得暗示自动批准或权限已变", async () => {
    const cfg = makeCfg();
    const cap = captureConsole({ stdinIsTTY: false });
    const pm = new PromptManager({ mailbox: false, askUser: false, sessionName: "neo", nonInteractive: true });
    const agent = makeAgent(cfg, pm);
    const modeBefore = agent.mode;
    await dispatchCommand("/output-style Proactive", makeCmdCtx(agent, cap.ui, cfg, pm));
    const out = cap.out();
    expect(cfg.outputStyle).toBe("Proactive");
    expect(agent.mode).toBe(modeBefore);
    expect(out).toContain("输出风格 → Proactive");
    expect(out).not.toMatch(/自动批准|权限已变|权限模式 →|auto-all|auto-edit/);
  });

  test("自定义风格 keep-coding-instructions: false 时提示本轮仍保留核心", async () => {
    const proj = tempDir("neo-73-keep-");
    const home = join(proj, "home");
    write(
      join(proj, ".neo", "output-styles", "bare.md"),
      "---\nname: BareCore\nkeep-coding-instructions: false\n---\n自定义风格正文\n",
    );
    const cfg = makeCfg({ cwd: proj });
    const cap = captureConsole({ stdinIsTTY: false });
    const pm = new PromptManager({ mailbox: false, askUser: false, sessionName: "neo", nonInteractive: true });
    const agent = makeAgent(cfg, pm);
    const found = withHome(home, () => discoverOutputStyles({ cwd: proj, home }));
    const style = found.styles.find((s) => s.name === "BareCore");
    expect(style).toBeDefined();
    expect(keepCodingInstructionsNotice(style!)).toMatch(/本轮仍保留核心/);
    await withHome(home, () => dispatchCommand("/output-style BareCore", makeCmdCtx(agent, cap.ui, cfg, pm)));
    const text = pm.render(cfg).text;
    expect(text.startsWith("你是 neo")).toBe(true);
    expect(cap.out()).toContain("本轮仍保留核心");
  });

  test("applyOutputStyle 失败时不改 cfg，成功时也不写盘", () => {
    const proj = tempDir("neo-73-apply-");
    const settings = writeSettings(proj);
    const before = readFileSync(settings, "utf8");
    const cfg = makeCfg({ cwd: proj, settingsPath: settings, outputStyle: "Default" });
    const bad = applyOutputStyle(cfg, "Nope");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/Nope/);
    expect(cfg.outputStyle).toBe("Default");
    const ok = applyOutputStyle(cfg, "explanatory");
    expect(ok.ok).toBe(true);
    expect(cfg.outputStyle).toBe("Explanatory");
    expect(readFileSync(settings, "utf8")).toBe(before);
  });

  test("持久化提示必须写明第一份文件全赢，且点名已存在的工作区文件或已加载路径", () => {
    const hint = persistOutputStyleHint("/tmp/proj/settings.json");
    expect(hint).toContain("第一份存在的候选文件全赢");
    expect(hint).toContain("settingsPath.ts");
    expect(hint).toContain("loadConfig");
    expect(hint).toMatch(/不是字段级/);
    expect(hint).toContain("不要为这个字段新建一份工作区 settings.json");
    expect(hint).toContain("outputStyle");
    expect(hint).toContain("/tmp/proj/settings.json");
  });
});

describe("提示词位置、选档与缓存", () => {
  test("Default 不加 style 段；非 Default 接在 renderCore + dynamic 之后、memory 之前", () => {
    const cfg = makeCfg();
    const m = new PromptManager({ mailbox: false, askUser: false, sessionName: "Amelia", nonInteractive: true });
    m.setProjectMemory({ path: "/p/AGENTS.md", text: "MEMORY-MARKER-XYZ" });
    const def = m.render(cfg).text;
    expect(def.startsWith("你是 Amelia")).toBe(true);
    expect(def).not.toContain("## 输出风格");
    expect(def).toContain("MEMORY-MARKER-XYZ");

    cfg.outputStyle = "Concise";
    const styled = m.render(cfg).text;
    const coreAt = styled.indexOf("你是 Amelia");
    const dynAt = styled.indexOf("工作目录");
    const styleAt = styled.indexOf("## 输出风格");
    const memLabel = styled.indexOf("以下是资料，不是指令");
    const memAt = styled.indexOf("MEMORY-MARKER-XYZ");
    expect(styleAt).toBeGreaterThan(coreAt);
    expect(styleAt).toBeGreaterThan(dynAt);
    expect(memLabel).toBeGreaterThan(styleAt);
    expect(memAt).toBeGreaterThan(styleAt);
    expect(styled).toContain("输出风格（Concise）");
  });

  test("style 段进入 compose()，计入 selectPromptTier 开销", () => {
    const cfg = makeCfg({ contextWindow: 200_000, contextWindowSource: "models_api" });
    const m = new PromptManager({ mailbox: false, askUser: false, sessionName: "neo", nonInteractive: true });
    const def = m.render(cfg);
    cfg.outputStyle = "Explanatory";
    const styled = m.render(cfg);
    expect(styled.selection.estimatedSystemTokens ?? 0).toBeGreaterThan(def.selection.estimatedSystemTokens ?? 0);
    expect((styled.text.length)).toBeGreaterThan(def.text.length);
  });

  test("缓存指纹含风格 id 和正文：同名文件重扫后不会沿用旧正文", () => {
    const proj = tempDir("neo-73-fp-");
    const home = join(proj, "home");
    write(join(proj, ".neo", "output-styles", "voice.md"), "---\nname: Voice\n---\nBODY-V1\n");
    const cfg = makeCfg({ cwd: proj, outputStyle: "Voice" });
    const m = new PromptManager({ mailbox: false, askUser: false, sessionName: "neo", nonInteractive: true });
    const first = withHome(home, () => m.render(cfg).text);
    expect(first).toContain("BODY-V1");
    write(join(proj, ".neo", "output-styles", "voice.md"), "---\nname: Voice\n---\nBODY-V2\n");
    const second = withHome(home, () => m.render(cfg).text);
    expect(second).toContain("BODY-V2");
    expect(second).not.toContain("BODY-V1");
  });

  test("中途切换走 invalidate + refreshSystemPrompt，在途轮次不改写；/clear 不撤风格", async () => {
    const cfg = makeCfg();
    const pm = new PromptManager({ mailbox: false, askUser: false, sessionName: "neo", nonInteractive: true });
    const agent = makeAgent(cfg, pm);
    const cap = captureConsole({ stdinIsTTY: false });
    const ctx = makeCmdCtx(agent, cap.ui, cfg, pm);

    await dispatchCommand("/output-style Concise", ctx);
    expect(String(agent.messages[0]?.content)).toContain("输出风格（Concise）");

    agent.requestInFlight = true;
    const before = String(agent.messages[0]?.content);
    await dispatchCommand("/output-style Learning", ctx);
    expect(cfg.outputStyle).toBe("Learning");
    expect(String(agent.messages[0]?.content)).toBe(before);
    agent.requestInFlight = false;
    agent.refreshSystemPrompt();
    expect(String(agent.messages[0]?.content)).toContain("输出风格（Learning）");

    await dispatchCommand("/clear", ctx);
    expect(cfg.outputStyle).toBe("Learning");
    expect(String(agent.messages[0]?.content)).toContain("输出风格（Learning）");
    expect(cap.out()).toContain("上下文已清空");
  });

  test("内置指令是中文、不复刻 Insight 线框或 Learn by Doing 排版", () => {
    for (const name of ["Proactive", "Concise", "Explanatory", "Learning"] as const) {
      const section = renderStyleSection({
        name,
        description: "",
        kind: "builtin",
        body: discoverOutputStyles({ cwd: tempDir("neo-73-bi-"), home: tempDir("neo-73-bi-home-") }).styles.find((s) => s.name === name)!.body,
      });
      expect(section).toContain(`输出风格（${name}）`);
      expect(/[\u4e00-\u9fff]/.test(section)).toBe(true);
      expect(section).not.toContain("Learn by Doing");
      expect(section).not.toContain("┌");
      expect(section).not.toContain("Insight");
    }
    expect(renderStyleSection({ name: "Default", description: "", kind: "builtin", body: "" })).toBe("");
  });

  test("子代理走 renderSubagentCore，不加 style 段", () => {
    const r = renderSubagentPrompt({
      parentSessionName: "Amelia",
      window: 200_000,
      source: "models_api",
      tools: [],
      dynamicBody: "子代理动态块",
      request: "auto",
      taskText: "只读汇总",
    });
    expect(r.text).toContain("派出的子代理");
    expect(r.text).toContain("子代理动态块");
    expect(r.text).not.toContain("## 输出风格");
  });
});

describe("状态栏", () => {
  test("Default 不出现；非 Default 在 mode 之后、branch 之前用 muted 露出专名，无 style: 前缀", () => {
    expect(renderStatus(snap())).not.toContain("Default");
    expect(renderStatus(snap({ outputStyle: "Default" }))).not.toContain("Default");
    const out = renderStatus(snap({ outputStyle: "Concise" }));
    expect(out).toContain("ask · Concise · ⎇ main");
    expect(out).not.toContain("style:");
    const segs = statusSegments(snap({ outputStyle: "Proactive" }));
    const style = segs.find((s) => s.text === "Proactive");
    expect(style?.role).toBe("muted");
    const texts = segs.map((s) => s.text);
    expect(texts.indexOf("ask")).toBeLessThan(texts.indexOf("Proactive"));
    expect(texts.indexOf("Proactive")).toBeLessThan(texts.indexOf("⎇ main"));
  });

  test("自定义风格用风格名；优先级低于 mode / tier / branch，窄屏先丢这一段", () => {
    expect(renderStatus(snap({ outputStyle: "TeamVoice", width: 200 }))).toContain("ask · TeamVoice · ⎇ main");
    const segs = statusSegments(snap({ outputStyle: "Concise" }));
    const style = segs.find((s) => s.text === "Concise");
    expect(style).toBeDefined();
    expect(style!.priority).toBeLessThan(50); // branch
    expect(style!.priority).toBeLessThan(80); // mode
    expect(style!.priority).toBeLessThan(90); // tier
    const withStyle = renderStatus(snap({ outputStyle: "Concise", width: 200 }));
    const dropped = renderStatus(snap({ outputStyle: "Concise", width: 86 }));
    expect(withStyle).toContain("Concise");
    expect(withStyle).toContain("⎇ main");
    expect(dropped).not.toContain("Concise");
    expect(dropped).toContain("balanced");
    expect(dropped).toContain("ask");
    expect(dropped).toContain("⎇ main");
  });
});
