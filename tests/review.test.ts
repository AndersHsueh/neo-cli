/**
 * review.test.ts — `/review` 一等公民代码审查（issue #12）。
 *
 * 覆盖：
 *  a. 声明：COMMANDS 含 review；helpText 含 /review。
 *  b. 采集层（collectReviewDiff）：干净仓库 / 已跟踪文件改动 / 相对基线 / 非 git 目录 /
 *     不存在的 ref / 截断。
 *  c. 命令层（dispatchCommand）：干净时不 send；有改动时 send 且文本含文件名与 diff 片段；
 *     /review main 走基线；错误友好不抛。
 *  d. 禁写：send 期间 agent.mode === "plan"，结束后恢复；不进规划态（planning 保持 false）。
 *
 * 夹具用真临时 git 仓库（init + config user + 提交），不 mock git。
 * 运行：bun test tests/review.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent } from "../src/agent.ts";
import type { AgentIO } from "../src/agent.ts";
import { dispatchCommand, wireCommands } from "../src/cli/commands.ts";
import type { CommandContext } from "../src/cli/commands.ts";
import { helpText } from "../src/cli/help.ts";
import type { Config } from "../src/config.ts";
import { COMMANDS } from "../src/input/commands.ts";
import {
  buildReviewPrompt,
  collectReviewDiff,
  REVIEW_DIFF_LIMIT,
  summarizePatch,
} from "../src/review.ts";
import { captureConsole } from "./helpers.ts";

const ROOT = join(tmpdir(), `neo-review-test-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${p.stderr.toString()}`);
  }
  return p.stdout.toString();
}

/** 建一个临时仓库，返回其路径。name 需唯一（同一测试文件里可能建多个）。 */
function makeRepo(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function commitAll(dir: string, msg: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
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

function makeCfg(cwd: string): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [],
    routes: {},
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 80,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    cwd,
    settingsPath: null,
    skillsStore: join(cwd, "skills"),
    memory: {
      enabled: false,
      userLevelDir: join(cwd, "mem"),
      userWikiDir: join(cwd, "wiki"),
      journalDir: join(cwd, "journal"),
      autoRecall: { enabled: false, maxTokens: 900, projectPages: 2, userPages: 1 },
      autoCapture: {
        enabled: false,
        mode: "off" as const,
        modelTier: "fast",
        maxOpsPerTurn: 2,
        maxPagesPerSession: 8,
        minConfidence: 0.65,
        minInferredConfidence: 0.75,
        journalRetentionDays: 7,
        flushTimeoutMs: 3000,
      },
      quiet: true,
    },
  } as unknown as Config;
}

function makeAgent(cwd: string, mode: "ask" | "auto-all" = "ask"): Agent {
  return new Agent({ cfg: makeCfg(cwd), console: silentIO(), mode, systemPrompt: "sys" });
}

function makeCmdCtx(agent: Agent, ui: ReturnType<typeof captureConsole>["ui"], cwd: string): CommandContext {
  return {
    agent,
    ui,
    cfg: makeCfg(cwd),
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: { id: "s1", model: "m-default", cwd } as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
  };
}

/** 把 agent.send 换成记录桩；返回记录数组。 */
function stubSend(agent: Agent): Array<{ text: string; modeAtSend: string; planningAtSend: boolean }> {
  const calls: Array<{ text: string; modeAtSend: string; planningAtSend: boolean }> = [];
  (agent as unknown as { send: (t: string) => Promise<unknown> }).send = async (t: string) => {
    calls.push({ text: t, modeAtSend: agent.mode, planningAtSend: agent.planning });
    return {} as never;
  };
  return calls;
}

wireCommands();

/* ------------------------------------------------------------------ */
/* a. 声明                                                             */
/* ------------------------------------------------------------------ */

describe("a. 命令声明与帮助", () => {
  test("COMMANDS 含 review，说明写的是只读审查而非 Plan", () => {
    const entry = COMMANDS.find((c) => c.name === "review");
    expect(entry).toBeDefined();
    expect(entry!.description).toContain("只读审查");
    expect(entry!.description).toContain("git");
    expect(entry!.description.toLowerCase()).not.toContain("plan");
  });

  test("helpText 含 /review 与基线用法", () => {
    const text = helpText();
    expect(text).toContain("/review");
    expect(text).toContain("/review [基线]");
    expect(text).toContain("默认不改文件");
  });
});

/* ------------------------------------------------------------------ */
/* b. 采集层                                                           */
/* ------------------------------------------------------------------ */

describe("b. collectReviewDiff", () => {
  test("干净仓库：hasChanges=false，patch 为空", () => {
    const dir = makeRepo("clean");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");

    const r = collectReviewDiff(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hasChanges).toBe(false);
    expect(r.patch.trim()).toBe("");
    expect(r.untracked).toEqual([]);
    expect(r.label).toBe("未提交改动");
  });

  test("修改已跟踪文件：patch 含改动内容", () => {
    const dir = makeRepo("modified");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

    const r = collectReviewDiff(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hasChanges).toBe(true);
    expect(r.patch).toContain("a.ts");
    expect(r.patch).toContain("+export const a = 2;");
    expect(r.patch).toContain("-export const a = 1;");
  });

  test("未跟踪文件进名单（diff 里没有，名单里有）", () => {
    const dir = makeRepo("untracked");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");

    const r = collectReviewDiff(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hasChanges).toBe(true);
    expect(r.untracked).toContain("new.ts");
    expect(r.patch).not.toContain("new.ts");
  });

  test("相对基线：/review main 采集到相对 main 的差异", () => {
    const dir = makeRepo("baseline");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "b.ts"), "export const b = 42;\n");
    commitAll(dir, "feat");

    const r = collectReviewDiff(dir, "main");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBe("相对 main");
    expect(r.hasChanges).toBe(true);
    expect(r.patch).toContain("b.ts");
    expect(r.patch).toContain("+export const b = 42;");
  });

  test("非 git 目录：友好失败，不抛", () => {
    const dir = join(ROOT, "not-a-repo");
    mkdirSync(dir, { recursive: true });
    const r = collectReviewDiff(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("不是 git 仓库");
  });

  test("不存在的 ref：友好失败，不抛", () => {
    const dir = makeRepo("bad-ref");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");

    const r = collectReviewDiff(dir, "no-such-branch");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("找不到基线");
    expect(r.message).toContain("no-such-branch");
  });

  test("diff 超过上限时截断并注明", () => {
    const dir = makeRepo("huge");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");
    // 每行 100 字符 × 2000 行 ≈ 200KB，超过 80KB 上限
    const big = Array.from({ length: 2000 }, (_, i) => `export const v${i} = "${"x".repeat(80)}";`).join("\n");
    writeFileSync(join(dir, "a.ts"), `${big}\n`);

    const r = collectReviewDiff(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.patchLength).toBeGreaterThan(REVIEW_DIFF_LIMIT);
    expect(r.patch).toContain("已截断");
    expect(r.patch.length).toBeLessThan(REVIEW_DIFF_LIMIT + 200);
  });
});

/* ------------------------------------------------------------------ */
/* c. 命令层                                                           */
/* ------------------------------------------------------------------ */

describe("c. /review 命令", () => {
  test("干净仓库：打印「工作区干净」，不调用 agent.send", async () => {
    const dir = makeRepo("cmd-clean");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");

    const agent = makeAgent(dir);
    // 会 throw 的桩：走到 send 就红
    (agent as unknown as { send: () => Promise<unknown> }).send = async () => {
      throw new Error("干净仓库不该调用 agent.send");
    };
    const cap = captureConsole();
    await dispatchCommand("/review", makeCmdCtx(agent, cap.ui, dir));
    expect(cap.out()).toContain("工作区干净");
  });

  test("有改动：调用 agent.send，文本含文件名与 diff 片段", async () => {
    const dir = makeRepo("cmd-dirty");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

    const agent = makeAgent(dir);
    const calls = stubSend(agent);
    const cap = captureConsole();
    await dispatchCommand("/review", makeCmdCtx(agent, cap.ui, dir));

    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toContain("a.ts");
    expect(calls[0]!.text).toContain("+export const a = 2;");
    expect(calls[0]!.text).toContain("只审查");
    expect(calls[0]!.text).toContain("critical");
    expect(cap.out()).toContain("未提交改动");
  });

  test("/review main：走基线，提示里写明「相对 main」", async () => {
    const dir = makeRepo("cmd-baseline");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "b.ts"), "export const b = 42;\n");
    commitAll(dir, "feat");

    const agent = makeAgent(dir);
    const calls = stubSend(agent);
    const cap = captureConsole();
    await dispatchCommand("/review main", makeCmdCtx(agent, cap.ui, dir));

    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toContain("相对 main");
    expect(calls[0]!.text).toContain("b.ts");
    expect(cap.out()).toContain("相对 main");
  });

  test("非 git 目录：友好错误，不 send、不抛", async () => {
    const dir = join(ROOT, "cmd-not-repo");
    mkdirSync(dir, { recursive: true });
    const agent = makeAgent(dir);
    const calls = stubSend(agent);
    const cap = captureConsole();
    await dispatchCommand("/review", makeCmdCtx(agent, cap.ui, dir));
    expect(calls.length).toBe(0);
    expect(cap.out()).toContain("不是 git 仓库");
  });

  test("不存在的 ref：友好错误，不 send、不抛", async () => {
    const dir = makeRepo("cmd-bad-ref");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");
    const agent = makeAgent(dir);
    const calls = stubSend(agent);
    const cap = captureConsole();
    await dispatchCommand("/review nope", makeCmdCtx(agent, cap.ui, dir));
    expect(calls.length).toBe(0);
    expect(cap.out()).toContain("找不到基线");
  });
});

/* ------------------------------------------------------------------ */
/* d. 本轮禁写                                                         */
/* ------------------------------------------------------------------ */

describe("d. 审查期间借用只读闸门", () => {
  test("send 期间 mode=plan，结束后恢复原模式；不进规划态", async () => {
    const dir = makeRepo("readonly");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

    const agent = makeAgent(dir, "auto-all");
    const calls = stubSend(agent);
    const cap = captureConsole();
    await dispatchCommand("/review", makeCmdCtx(agent, cap.ui, dir));

    expect(calls.length).toBe(1);
    expect(calls[0]!.modeAtSend).toBe("plan");
    expect(calls[0]!.planningAtSend).toBe(false);
    // 结束后恢复
    expect(agent.mode).toBe("auto-all");
    // 全程没进交互规划态
    expect(agent.planning).toBe(false);
    expect(agent.plan).toBeNull();
  });

  test("send 抛错也要恢复原模式（finally）", async () => {
    const dir = makeRepo("readonly-throw");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    commitAll(dir, "init");
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

    const agent = makeAgent(dir, "ask");
    (agent as unknown as { send: () => Promise<unknown> }).send = async () => {
      throw new Error("boom");
    };
    const cap = captureConsole();
    await expect(dispatchCommand("/review", makeCmdCtx(agent, cap.ui, dir))).rejects.toThrow("boom");
    expect(agent.mode).toBe("ask");
  });
});

/* ------------------------------------------------------------------ */
/* e. 提示与摘要纯函数                                                 */
/* ------------------------------------------------------------------ */

describe("e. 提示与摘要", () => {
  test("summarizePatch 统计文件数与增删行", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "+more",
    ].join("\n");
    expect(summarizePatch(patch)).toEqual({ files: 1, added: 2, removed: 1 });
  });

  test("buildReviewPrompt 带上未跟踪名单与截断提示", () => {
    const text = buildReviewPrompt({
      ok: true,
      scope: { kind: "worktree" },
      label: "未提交改动",
      patch: "diff --git a/x.ts b/x.ts\n+new\n",
      truncated: true,
      patchLength: 999_999,
      untracked: ["new.ts"],
      untrackedTruncated: false,
      hasChanges: true,
    });
    expect(text).toContain("只审查");
    expect(text).toContain("未发现明显问题");
    expect(text).toContain("已截断");
    expect(text).toContain("- new.ts");
  });
});
