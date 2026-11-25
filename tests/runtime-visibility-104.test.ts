/**
 * 运行时可见集收窄（issue #104）。
 *
 * 只在选档 fits=false 时，把已经算好的优先级前缀和三项成组裁接到真正发出的
 * 系统提示词与工具 schema。fits=true 不收窄。dry-run 的空集不得变成「四个工具也不发」。
 * 目录树成组裁包含「工作根目录结构」，且不得把后面的仓库地图一起裁掉。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import { handleCommand, type CommandContext } from "../src/cli/commands.ts";
import type { Config } from "../src/config.ts";
import { makeOverBudgetReporter } from "../src/bootDiagnostics.ts";
import { PromptManager } from "../src/prompt/manager.ts";
import { DEFAULT_SELECTION_CONFIG, type PromptSelection } from "../src/prompt/select.ts";
import {
  measureVisibilityCost,
  visibilityPriority,
  type ToolVisibility,
} from "../src/prompt/visibility.ts";
import { makeAskUserTool } from "../src/tools/askUser.ts";
import { mainToolNames, registerTool } from "../src/tools/index.ts";
import { makeListPeersTool, makeSendMessageTool } from "../src/tools/mailbox.ts";
import { makeRememberTool } from "../src/tools/memory.ts";
import { makeTaskTool } from "../src/tools/task.ts";
import { makeTodoWriteTool } from "../src/tools/todo.ts";
import { registerWikiTools } from "../src/tools/wiki.ts";
import { captureConsole } from "./helpers.ts";

const FLOOR = ["read_file", "edit_file", "shell", "shell_output"] as const;
const dirs: string[] = [];
const unregister: Array<() => void> = [];

afterAll(() => {
  for (const u of unregister.splice(0)) u();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function registerSessionTools(): void {
  unregister.push(
    registerTool(makeTaskTool({ run: async () => "ok" })),
    registerWikiTools(registerTool),
    registerTool(makeRememberTool({ remember: async () => "ok" })),
    registerTool(makeTodoWriteTool({ get: () => [], set: () => {} })),
    registerTool(makeSendMessageTool({ mailbox: {} as never, onSent: () => {} })),
    registerTool(makeListPeersTool({ mailbox: {} as never })),
    registerTool(makeAskUserTool({ ask: async () => ({ status: "canceled" }) })),
  );
}

/** 交互会话口径：信箱、提问、运行时工具都在，环境探测关掉以便数字稳定。 */
function manager(): PromptManager {
  return new PromptManager({
    mailbox: true,
    askUser: true,
    nonInteractive: false,
    sessionName: "neo",
  });
}

function world(over: Partial<Config> = {}): Config {
  const cwd = mkdtempSync(join(tmpdir(), "neo-104-"));
  const extra = mkdtempSync(join(tmpdir(), "neo-104-extra-"));
  const skillsStore = mkdtempSync(join(tmpdir(), "neo-104-skills-"));
  dirs.push(cwd, extra, skillsStore);

  mkdirSync(join(cwd, "skills", "demo"), { recursive: true });
  writeFileSync(
    join(cwd, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: 演示技能，用来占住技能索引这一成组裁的一块。\n---\n\n正文。\n",
  );
  const topics = Array.from({ length: 40 }, (_, i) => {
    const name = `主题${String(i).padStart(2, "0")}${"占位".repeat(40)}`;
    return `- [[${name}]]`;
  });
  mkdirSync(join(cwd, ".neo", "wiki", "wiki"), { recursive: true });
  writeFileSync(join(cwd, ".neo", "wiki", "wiki", "INDEX.md"), `# 索引\n\n${topics.join("\n")}\n`);
  mkdirSync(join(cwd, "src"), { recursive: true });
  for (let i = 0; i < 60; i++) {
    writeFileSync(join(cwd, "src", `mod${i}.ts`), `export function mod${i}(n: number) { return n + ${i}; }\n`);
  }
  mkdirSync(join(extra, "lib"), { recursive: true });
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(extra, "lib", `extra${i}.ts`), `export function extra${i}() { return ${i}; }\n`);
  }

  return {
    cwd,
    skillsStore,
    providerName: "magpie",
    providerType: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    model: "trae-cn/glm-5.3-flash",
    modelTier: "balanced",
    maxTokens: 8_192,
    temperature: 0.6,
    compactThreshold: 0.75,
    maxToolIterations: 10,
    toolOutputLimit: 30_000,
    parallelToolCalls: "readonly",
    contextWindow: 116_000,
    contextWindowSource: "models_api",
    configuredContextWindow: 116_000,
    configuredContextWindowExplicit: true,
    env: { prompt: false, dir: skillsStore },
    additionalDirs: [extra],
    repoMap: { enabled: true, budgetTokens: 800, maxFiles: 1_200 },
    providers: [],
    ...over,
  } as unknown as Config;
}

function listedTools(text: string): string[] {
  const line = text.split("\n").find((l) => l.startsWith("可用工具："));
  if (!line) return [];
  return line
    .slice("可用工具：".length)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function captureTrimmed(systemText: string, trimDynamic: boolean): string {
  let captured = "";
  measureVisibilityCost({
    systemText,
    specs: [],
    visible: new Set(["read_file"]),
    allToolNames: ["read_file", "edit_file", "shell"],
    trimDynamic,
    count: (t) => {
      captured = t;
      return 0;
    },
  });
  return captured;
}

function silent(): AgentIO {
  return {
    line() {},
    blank() {},
    info() {},
    warn() {},
    error() {},
    toolHeader() {},
    toolResult() {},
    indent: (body: string) => body,
    startSpinner() {},
    updateSpinner() {},
    stopSpinner() {},
    beginStream() {},
    writeStream() {},
    endStream() {},
    ensureStreamClosed() {},
    confirm: async () => true,
  } as unknown as AgentIO;
}

describe("#104 目录树成组裁不得吃掉仓库地图", () => {
  test("#104 多根「工作根目录结构」被裁掉，同节内的仓库地图与额外工作根留下", () => {
    const system = [
      "HEAD",
      "",
      "## 环境",
      "",
      "- 工作目录：/tmp/main",
      "- 额外工作根（/add-dir，本会话）：/tmp/extra（默认 glob/grep 覆盖）",
      "- 模型：magpie/trae-cn/glm-5.3-flash",
      "工作根目录结构（最多两层；预算 120 条在 2 个工作根之间共享）：",
      "[主根] /tmp/main",
      "  TREE_ONLY_FILE.ts",
      "[额外根] /tmp/extra",
      "  OTHER_TREE_ONLY.ts",
      "仓库地图（关键符号，预算内）",
      "以下为源码文件的主要导出/定义；需要细节再用 read_file/grep。",
      "src/mod.ts: MAP_ONLY_SYMBOL",
      "",
    ].join("\n");
    const out = captureTrimmed(system, true);
    expect(out).not.toContain("工作根目录结构");
    expect(out).not.toContain("TREE_ONLY_FILE.ts");
    expect(out).not.toContain("OTHER_TREE_ONLY.ts");
    expect(out).toContain("额外工作根");
    expect(out).toContain("仓库地图（关键符号，预算内）");
    expect(out).toContain("MAP_ONLY_SYMBOL");
    expect(out).toContain("- 工作目录：/tmp/main");
  });

  test("#104 单根「工作目录结构」仍按原标记裁掉", () => {
    const system = ["HEAD", "", "## 环境", "", "- 工作目录：/tmp/main", "工作目录结构（最多两层）：", "  ONLY_TREE.ts", ""].join("\n");
    const out = captureTrimmed(system, true);
    expect(out).not.toContain("工作目录结构");
    expect(out).not.toContain("ONLY_TREE.ts");
    expect(out).toContain("- 工作目录：/tmp/main");
  });
});

describe("#104 运行时只在 fits=false 时收窄", () => {
  beforeAll(() => {
    registerSessionTools();
  });

  test("#104 fits=true 不收窄：提示词与 schema 仍是全量", () => {
    const cfg = world({ contextWindow: 2_000_000 });
    const pm = manager();
    const text = pm.render(cfg).text;
    expect(pm.render(cfg).selection.fits).toBe(true);
    const listed = listedTools(text);
    // fits=true 时「可用工具」行保持注册表顺序，不按优先级重排。
    expect(listed).toEqual(mainToolNames(cfg));
    expect(text).toContain("## 技能");
    expect(text).toContain("## 记忆库");
    expect(text).toContain("工作根目录结构");
    expect(text).toContain("仓库地图");
    const agent = new Agent({
      cfg,
      console: silent(),
      mode: "auto-all",
      systemPrompt: text,
      visibleToolNames: () => pm.runtimeToolNames(cfg),
    } as never);
    const plain = new Agent({
      cfg,
      console: silent(),
      mode: "auto-all",
      systemPrompt: text,
    } as never);
    expect(agent.toolSpecsFor().map((s) => s.function.name)).toEqual(
      plain.toolSpecsFor().map((s) => s.function.name),
    );
  });

  test("#104 预算连 0 个工具都放不下时，请求仍含四个最小闭环，且说明行与 schema 同构", () => {
    const cfg = world({ contextWindow: 1_000, contextWindowSource: "models_api" });
    const pm = manager();
    const rendered = pm.render(cfg);
    expect(rendered.selection.budget).toBe(125);
    expect(rendered.selection.fits).toBe(false);
    const text = rendered.text;
    const listed = listedTools(text);
    const priority = visibilityPriority(mainToolNames(cfg));
    expect(listed).toEqual(priority.slice(0, listed.length));
    for (const n of FLOOR) expect(listed).toContain(n);
    expect(listed.length).toBeGreaterThanOrEqual(FLOOR.length);
    expect(text).not.toContain("- web_search：");
    expect(text).not.toContain("list_dir / glob / grep");
    expect(text).toContain("规划态（用户用 /plan 进入）");
    const blocks = [
      text.includes("## 技能"),
      text.includes("## 记忆库"),
      text.includes("工作根目录结构") || text.includes("工作目录结构"),
    ];
    expect(new Set(blocks).size).toBe(1);
    expect(blocks[0]).toBe(false);
    expect(text).toContain("仓库地图");
    expect(text).toContain("额外工作根");
    expect(text).not.toContain("工作根目录结构");
    expect(text).toContain("## 交付物与提问");
    expect(text).toContain("## 跨会话消息");

    const agent = new Agent({
      cfg,
      console: silent(),
      mode: "auto-all",
      systemPrompt: text,
      visibleToolNames: () => pm.runtimeToolNames(cfg),
    } as never);
    const sent = agent.toolSpecsFor().map((s) => s.function.name);
    expect(new Set(sent)).toEqual(new Set(listed));
    for (const n of FLOOR) expect(sent).toContain(n);
  });

  test("#104 触发场景：窗口 116000（models_api）预算 14500，记录收窄后开销并按收窄后的结果警告", () => {
    const base = world();
    const wideCfg = {
      ...base,
      contextWindow: 2_000_000,
      systemPrompt: { ...DEFAULT_SELECTION_CONFIG, maxTier: "mini" as const },
    } as Config;
    const preSel = manager().render(wideCfg).selection;
    expect(preSel.tier).toBe("mini");
    expect(preSel.fits).toBe(true);
    const pre = preSel.estimatedSystemTokens ?? 0;
    expect(pre).toBeGreaterThan(14_500);

    const warns: string[] = [];
    const reporter = makeOverBudgetReporter({
      interactive: true,
      current: () => ({ provider: base.providerName, model: base.model }),
      log: () => {},
      warn: (m) => warns.push(m),
      bootBlockPrinted: () => true,
    });
    const pm = new PromptManager({
      mailbox: true,
      askUser: true,
      nonInteractive: false,
      sessionName: "neo",
      onSelection: (sel) => reporter.report(sel),
    });
    const tight = pm.render(base);
    expect(tight.selection.tier).toBe("mini");
    expect(tight.selection.budget).toBe(14_500);
    expect(tight.selection.window).toBe(116_000);
    expect(tight.selection.source).toBe("models_api");
    const post = tight.selection.estimatedSystemTokens ?? 0;
    const vis = pm.visibilityForContext(base);
    const listed = listedTools(tight.text);
    // 验收记录：收窄后前缀、三项是否被裁、估计开销。失败信息里带上实测数字。
    const record = `pre=${pre} post=${post} trimmed=${vis.trimmed} fits=${tight.selection.fits} prefix=${listed.join(",")}`;
    expect(post, record).toBeLessThan(pre);
    expect(post, record).toBe(vis.cost);
    expect(vis.applied, record).toBe(true);
    expect(listed, record).toEqual(vis.names);
    const skill = tight.text.includes("## 技能");
    const wiki = tight.text.includes("## 记忆库");
    const tree = tight.text.includes("工作根目录结构") || tight.text.includes("工作目录结构");
    expect(skill, record).toBe(wiki);
    expect(wiki, record).toBe(tree);
    expect(tree, record).toBe(!vis.trimmed);
    if (vis.trimmed) {
      expect(tight.text, record).toContain("仓库地图");
      expect(tight.text, record).toContain("额外工作根");
      expect(tight.text, record).not.toContain("工作根目录结构");
    }
    for (const n of FLOOR) expect(listed, record).toContain(n);

    const agent = new Agent({
      cfg: base,
      console: silent(),
      mode: "auto-all",
      systemPrompt: tight.text,
      visibleToolNames: () => pm.runtimeToolNames(base),
    } as never);
    expect(new Set(agent.toolSpecsFor().map((s) => s.function.name)), record).toEqual(new Set(listed));

    if (post <= 14_500) {
      expect(tight.selection.fits, record).toBe(true);
      expect(warns, record).toEqual([]);
      expect(warns.join("\n"), record).not.toContain("15,893");
      expect(warns.join("\n"), record).not.toContain("放不下预算");
    } else {
      expect(tight.selection.fits, record).toBe(false);
      expect(warns.length, record).toBe(1);
      expect(warns[0], record).toContain(post.toLocaleString());
      expect(warns[0], record).not.toContain("手写 context_window");
      expect(warns[0], record).not.toContain("context_window");
      if (pre.toLocaleString() !== post.toLocaleString()) {
        expect(warns[0], record).not.toContain(pre.toLocaleString());
      }
    }
  });
});

describe("#104 规划态", () => {
  test("#104 收窄时规划控制工具仍在，名单外的只读工具不进 schema", () => {
    const cfg = world({ contextWindow: 2_000_000 });
    const agent = new Agent({
      cfg,
      console: silent(),
      mode: "auto-all",
      systemPrompt: "s",
      planBaseMode: "auto-all",
      visibleToolNames: () => ["read_file"],
    } as never);
    const names = agent.toolSpecsFor().map((s) => s.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("submit_plan");
    expect(names).toContain("exit_plan_mode");
    expect(names).not.toContain("grep");
    expect(names).not.toContain("shell");
  });
});

describe("#104 /context 与运行时可见集不矛盾", () => {
  test("#104 已收窄时不再写「dry-run 未启用 / 收窄尚未启用」", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-104-ctx-"));
    dirs.push(dir);
    const cfg = {
      cwd: dir,
      providerName: "p1",
      providerType: "openai",
      apiKey: "k",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m1",
      modelTier: "balanced",
      maxTokens: 8_192,
      temperature: 0.6,
      compactThreshold: 0.75,
      maxToolIterations: 10,
      toolOutputLimit: 30_000,
      parallelToolCalls: "readonly",
      contextWindow: 116_000,
      contextWindowSource: "models_api",
      env: { prompt: false, dir },
      providers: [],
    } as unknown as Config;
    const vis = {
      names: ["read_file", "edit_file", "shell", "shell_output"],
      hidden: ["web_search"],
      total: 5,
      trimmed: true,
      fits: true,
      cost: 12_040,
      budget: 14_500,
      applied: true,
    } as ToolVisibility;
    const { ui, out } = captureConsole({ stdoutIsTTY: false });
    const agent = new Agent({ cfg, console: ui, mode: "auto", systemPrompt: "s" } as never);
    await handleCommand("/context", {
      agent,
      ui,
      cfg,
      toolVisibility: () => vis,
      promptSelection: () =>
        ({
          tier: "mini",
          fits: true,
          reason: "已收窄工具可见集，估计 12040 tokens，落入预算 14500。",
          window: 116_000,
          windowTrusted: true,
          source: "models_api",
          budget: 14_500,
          estimatedSystemTokens: 12_040,
        }) satisfies PromptSelection,
    } as unknown as CommandContext);
    const text = out().replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("已收窄");
    expect(text).toContain("4/5");
    expect(text).toContain("12040/14500");
    expect(text).not.toContain("尚未启用");
    expect(text).not.toContain("dry-run");
    expect(text).not.toContain("当前仍暴露全部");
  });
});
