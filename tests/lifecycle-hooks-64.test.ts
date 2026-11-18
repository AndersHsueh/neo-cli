/** #64 lifecycle hooks: user-boundary validation, bounded Stop, non-destructive compact.
 * New integration coverage is added separately for CLI/ACP/PTY entry points.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentIO } from "../src/agent.ts";
import { parseHooksConfig } from "../src/hooks/index.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult } from "../src/llm.ts";
const SANDBOX = mkdtempSync(join(import.meta.dir, ".tmp-hooks64-"));
afterAll(() => rmSync(SANDBOX, {recursive:true, force:true}));
function makeCfg(over: Partial<Config> = {}): Config {
  // providers 必须带齐四个档位的 models：runSubagent 会 applyTier 到子档位，
  // 缺档会以「未知档位」报错（子代理用例踩过这个坑）。
  const provider = {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: {
      default: "m-default",
      deep_reasoning: "m-deep",
      balanced: "m-bal",
      fast: "m-fast",
    },
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
  };
  const route = { provider: "p1", model: null, fallbackAllowed: true };
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [provider],
    routes: {
      default: route,
      deep_reasoning: route,
      balanced: route,
      fast: route,
    },
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
    cwd: SANDBOX,
    settingsPath: null,
    skillsStore: join(SANDBOX, "skills"),
    hooks: parseHooksConfig(undefined),
    memory: {
      enabled: false,
      userLevelDir: join(SANDBOX, "mem"),
      userWikiDir: join(SANDBOX, "wiki"),
      journalDir: join(SANDBOX, "journal"),
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
    ...over,
  } as unknown as Config;
}

interface SpyIO extends AgentIO {
  warns: string[];
  infos: string[];
  confirms: string[];
}

function spyIO(confirmAnswer = true): SpyIO {
  const warns: string[] = [];
  const infos: string[] = [];
  const confirms: string[] = [];
  const base: AgentIO = {
    line(): void {},
    blank(): void {},
    info(m: string): void {
      infos.push(m);
    },
    warn(m: string): void {
      warns.push(m);
    },
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
    async confirm(q: string): Promise<boolean> {
      confirms.push(q);
      return confirmAnswer;
    },
    width: 100,
  };
  return Object.assign(base, { warns, infos, confirms }) as SpyIO;
}


let serial = 0;
function setup(raw: Record<string, unknown>, overrides: Partial<Config> = {}) {
  const io = spyIO();
  const seen: Message[][] = [];
  const hooks = parseHooksConfig({enabled:true, ...raw});
  const agent = new Agent({cfg:makeCfg(overrides), console:io, mode:"auto-all", hooks,
    systemPrompt:"sys", chatStream:async (...args: unknown[]) => {
      seen.push(JSON.parse(JSON.stringify(args[1])) as Message[]);
      return {content:"normal reply", reasoning:"", toolCalls:[], finishReason:"stop", usage:null, raw:null} as StreamResult;
    }});
  return {agent, io, seen};
}
function hook(output: string, code=0) {
  const path = join(SANDBOX, `h${serial++}.sh`);
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${output.replaceAll("'", "'\\''")}'\nexit ${code}\n`, {mode:0o755});
  return {command:path};
}
function history(agent: Agent) {
  for(let i=0; i<16; i++) agent.messages.push({role:i%2 ? "assistant":"user", content:`old ${i} `+"history ".repeat(30)});
}

test("#64 configuration accepts all four lifecycle event classes", () => {
  const raw = Object.fromEntries(["SessionStart","UserPromptSubmit","Stop","PreCompact"].map(e=>[e,[{command:"true"}]]));
  const cfg = parseHooksConfig({enabled:true, ...raw});
  expect(cfg.warnings).toEqual([]);
  for(const event of Object.keys(raw)) expect((cfg.hooks as unknown as Record<string, unknown[]>)[event]?.length).toBe(1);
});

test("#64 UserPromptSubmit exit2 blocks before history and zero model requests", async () => {
  const {agent, io, seen} = setup({UserPromptSubmit:[hook("do not send",2)]});
  const before = JSON.stringify(agent.messages);
  await agent.send("secret input");
  expect(seen.length).toBe(0);
  expect(JSON.stringify(agent.messages)).toBe(before);
  expect([...io.warns,...io.infos].join("\n")).toContain("do not send");
});

test("#64 UserPromptSubmit plain stdout is additional model context", async () => {
  const {agent, seen} = setup({UserPromptSubmit:[hook("plain lifecycle context")]});
  await agent.send("hello");
  expect(JSON.stringify(seen)).toContain("plain lifecycle context");
});

test("#64 JSON additionalContext is injected once without raw JSON wrapper", async () => {
  const {agent, seen} = setup({UserPromptSubmit:[hook(JSON.stringify({additionalContext:"unique lifecycle marker"}))]});
  await agent.send("hello");
  const request = JSON.stringify(seen);
  expect(request.split("unique lifecycle marker").length-1).toBe(1);
  expect(request).not.toContain("additionalContext");
});

test("#64 Stop block plus reason continues once only and final hooks once", async () => {
  const mark = join(SANDBOX, `final-${serial++}`);
  const {agent, seen} = setup({Stop:[hook(JSON.stringify({decision:"block",reason:"please verify result"}))],
    TurnEnd:[{command:`echo end >> '${mark}'`}], Notification:[{command:`echo notice >> '${mark}'`,matcher:"turn_end"}]});
  await agent.send("hello");
  expect(seen.length).toBe(2);
  expect(JSON.stringify(seen[1])).toContain("please verify result");
  expect(readFileSync(mark,"utf8").trim().split("\n").sort()).toEqual(["end","notice"]);
});

test("#64 ordinary Stop stdout and block without reason do not continue", async () => {
  for(const output of ["please continue", '{"decision":"block"}', '{broken json']) {
    const {agent, seen}=setup({Stop:[hook(output)]});
    await agent.send("hello");
    expect(seen.length).toBe(1);
  }
});

test("#64 Stop continuation shares original iteration maximum", async () => {
  const {agent, seen}=setup({Stop:[hook('{"decision":"block","reason":"more"}')]},{maxToolIterations:1});
  await agent.send("hello");
  expect(seen.length).toBe(1);
});

test("#64 manual PreCompact exit2 preserves exact history and lastCompact", async () => {
  const {agent, seen}=setup({PreCompact:[hook("keep history",2)]});
  history(agent);
  const before=JSON.stringify(agent.messages);
  const snapshot=JSON.stringify(agent.lastCompact);
  expect(await agent.compact()).toBe(false);
  expect(seen.length).toBe(0);
  expect(JSON.stringify(agent.messages)).toBe(before);
  expect(JSON.stringify(agent.lastCompact)).toBe(snapshot);
});

test("#64 PreCompact additional context reaches summarizer but never history", async () => {
  const {agent, seen}=setup({PreCompact:[hook('{"additionalContext":"summarizer only marker"}')]});
  history(agent);
  expect(await agent.compact()).toBe(true);
  expect(JSON.stringify(seen)).toContain("summarizer only marker");
  expect(JSON.stringify(agent.messages)).not.toContain("summarizer only marker");
});

test("#64 automatic PreCompact rejection stops without any model request or retry", async () => {
  const mark=join(SANDBOX,`auto-${serial++}`);
  const {agent, seen}=setup({PreCompact:[{command:`echo attempt >> '${mark}'; echo no-auto; exit 2`}]},
    {contextWindow:1000, compactThreshold:0.01});
  history(agent);
  const old=JSON.stringify(agent.messages);
  const snapshot=JSON.stringify(agent.lastCompact);
  await agent.send("trigger compact");
  expect(seen.length).toBe(0);
  expect(readFileSync(mark,"utf8").trim().split("\n")).toEqual(["attempt"]);
  expect(JSON.stringify(agent.messages.slice(0,-1))).toBe(old);
  expect(JSON.stringify(agent.lastCompact)).toBe(snapshot);
});
