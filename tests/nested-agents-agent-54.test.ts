/**
 * issue #54：嵌套指令文件的轮内注入（Agent 集成）。
 *
 * 触达子目录后，下一请求带临时 system 消息；轮末从历史摘除，不留正文残片。
 * 不触网、不碰真实 ~/.neo。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult, ToolCall } from "../src/llm.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../src/mailbox/types.ts";
import {
  collectNestedInstructionFiles,
  formatNestedAgentsBlock,
} from "../src/cli/nestedAgents.ts";
import { extractTouchedPaths } from "../src/rules/index.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-54-agent-")));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function makeCfg(cwd: string): Config {
  const provider = {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" },
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
  };
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m",
    providers: [provider],
    routes: {
      default: { provider: "p1", model: null, fallbackAllowed: true },
      deep_reasoning: { provider: "p1", model: null, fallbackAllowed: true },
      balanced: { provider: "p1", model: null, fallbackAllowed: true },
      fast: { provider: "p1", model: null, fallbackAllowed: true },
    },
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 4,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    paste: { foldLines: 3, foldChars: 300, imageMaxBytes: 8_388_608 },
    mailbox: DEFAULT_MAILBOX_CONFIG,
    crossSessionInbound: "auto",
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
        mode: "off",
        modelTier: "fast",
        maxOpsPerTurn: 2,
        maxPagesPerSession: 8,
        minConfidence: 0.65,
        minInferredConfidence: 0.75,
        journalRetentionDays: 7,
        flushTimeoutMs: 3000,
        quiet: true,
      },
      quiet: true,
    },
  } as unknown as Config;
}

function silentConsole(): AgentIO {
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

function result(over: Partial<StreamResult>): StreamResult {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
    raw: null,
    ...over,
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function textOf(m: Message): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

function attachNested(cwd: string) {
  return {
    toolPathsOf: (name: string, args: string) => extractTouchedPaths(name, args, cwd),
    nestedAgentsPrompt: (touched: string[]) => {
      const files = collectNestedInstructionFiles({ roots: [cwd], touched });
      const text = formatNestedAgentsBlock(files);
      return text === "" ? null : { text, files };
    },
  };
}

describe("issue #54 轮内注入", () => {
  test("启动不预载嵌套正文；read 触达后注入，轮末摘除", async () => {
    const cwd = join(SANDBOX, "read-turn");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "AGENTS.md", "CWD-PERM-SHOULD-NOT-BE-IN-TEMP");
    writeFile(cwd, "packages/foo/AGENTS.md", "FOO-ON-DEMAND-MARKER");
    writeFile(cwd, "packages/foo/a.ts", "export const a = 1;\n");

    const seen: Message[][] = [];
    let call = 0;
    const agent = new Agent({
      cfg: makeCfg(cwd),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "sys",
      chatStream: async (_cfg, messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        call += 1;
        if (call === 1) {
          return result({
            toolCalls: [toolCall("c1", "read_file", { path: "packages/foo/a.ts" })],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "done" });
      },
      ...attachNested(cwd),
    });

    await agent.send("看看 packages/foo 的实现");

    expect(seen[0]!.some((m) => textOf(m).includes("FOO-ON-DEMAND-MARKER"))).toBe(false);

    const second = seen[1]!;
    const injected = second.filter((m) => m.role === "system" && textOf(m).includes("FOO-ON-DEMAND-MARKER"));
    expect(injected.length).toBe(1);
    expect(textOf(injected[0]!)).toContain("嵌套");
    expect(textOf(injected[0]!)).not.toContain("CWD-PERM-SHOULD-NOT-BE-IN-TEMP");

    expect(agent.messages.some((m) => textOf(m).includes("FOO-ON-DEMAND-MARKER"))).toBe(false);
    expect(agent.activeNestedAgents.length).toBe(1);
    expect(agent.activeNestedAgents[0]!.text).toContain("FOO-ON-DEMAND-MARKER");
  });

  test("write_file / edit_file 触达同样注入；@ 引用路径也算触达", async () => {
    const cwd = join(SANDBOX, "write-at");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "packages/foo/AGENTS.md", "WRITE-NESTED-MARKER");
    writeFile(cwd, "packages/bar/CLAUDE.md", "AT-NESTED-MARKER");

    const seenWrite: Message[][] = [];
    let writeCall = 0;
    const writeAgent = new Agent({
      cfg: makeCfg(cwd),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "sys",
      chatStream: async (_cfg, messages) => {
        seenWrite.push(messages.map((m) => ({ ...m })));
        writeCall += 1;
        if (writeCall === 1) {
          return result({
            toolCalls: [toolCall("w1", "write_file", { path: "packages/foo/new.ts", content: "x" })],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "wrote" });
      },
      ...attachNested(cwd),
    });
    await writeAgent.send("写一个新文件");
    expect(seenWrite[1]!.some((m) => textOf(m).includes("WRITE-NESTED-MARKER"))).toBe(true);
    expect(writeAgent.messages.some((m) => textOf(m).includes("WRITE-NESTED-MARKER"))).toBe(false);

    const seenEdit: Message[][] = [];
    let editCall = 0;
    const editAgent = new Agent({
      cfg: makeCfg(cwd),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "sys",
      chatStream: async (_cfg, messages) => {
        seenEdit.push(messages.map((m) => ({ ...m })));
        editCall += 1;
        if (editCall === 1) {
          return result({
            toolCalls: [
              toolCall("e1", "edit_file", { path: "packages/foo/new.ts", old_string: "x", new_string: "y" }),
            ],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "edited" });
      },
      ...attachNested(cwd),
    });
    await editAgent.send("改一下");
    expect(seenEdit[1]!.some((m) => textOf(m).includes("WRITE-NESTED-MARKER"))).toBe(true);

    const seenAt: Message[][] = [];
    const atAgent = new Agent({
      cfg: makeCfg(cwd),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "sys",
      chatStream: async (_cfg, messages) => {
        seenAt.push(messages.map((m) => ({ ...m })));
        return result({ content: "ok" });
      },
      ...attachNested(cwd),
    });
    atAgent.noteTouchedPaths(["packages/bar/readme.md"]);
    await atAgent.send("看这个引用");
    expect(seenAt[0]!.some((m) => textOf(m).includes("AT-NESTED-MARKER"))).toBe(true);
    expect(atAgent.messages.some((m) => textOf(m).includes("AT-NESTED-MARKER"))).toBe(false);
  });

  test("未触达子目录则不注入，也不留残片", async () => {
    const cwd = join(SANDBOX, "no-touch");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "packages/foo/AGENTS.md", "SHOULD-NOT-APPEAR");
    const seen: Message[][] = [];
    const agent = new Agent({
      cfg: makeCfg(cwd),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "sys",
      chatStream: async (_cfg, messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        return result({ content: "ok" });
      },
      ...attachNested(cwd),
    });
    await agent.send("闲聊");
    expect(seen[0]!.some((m) => textOf(m).includes("SHOULD-NOT-APPEAR"))).toBe(false);
    expect(agent.activeNestedAgents).toEqual([]);
    expect(agent.messages.some((m) => textOf(m).includes("SHOULD-NOT-APPEAR"))).toBe(false);
  });
});
