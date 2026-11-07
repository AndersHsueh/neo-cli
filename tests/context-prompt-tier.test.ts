/**
 * /context 的档位行（issue #20 收尾）。
 *
 * 两件事：
 *  1. 档位行展示宿主给的诊断值，并与 window 行自洽 —— 宿主给的是「当前 cfg 下会选
 *     哪一档」（探针回写窗口后到下一轮边界之间，lastSelection 还是旧档）；
 *  2. 诊断取不到或抛错时，/context 照常输出其余各行 —— 诊断是增强项，不是命令的依赖项。
 *
 * env 快照目录指向沙箱（cfg.env.dir），绝不读真实的 ~/.neo。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent.ts";
import { handleCommand, type CommandContext } from "../src/cli/commands.ts";
import type { Config, ProviderConfig } from "../src/config.ts";
import type { PromptSelection } from "../src/prompt/select.ts";
import { captureConsole } from "./helpers.ts";

/** 去掉 ANSI 转义：TTY 与否都会带上色，断言不能依赖终端环境。 */
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** kv 输出的行首是标签（padEnd(10) + 空格 + 值）。 */
function lineWith(text: string, label: string): string {
  return text.split("\n").find((l) => l.trimStart().startsWith(`${label} `)) ?? "";
}

function prov(): ProviderConfig {
  return {
    name: "p1",
    type: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    models: { default: "m1", deep_reasoning: "m1", balanced: "m1", fast: "m1" },
    maxTokens: 8_192,
    temperature: null,
    contextWindow: null,
    maxOutputTokens: null,
  };
}

function makeCfg(): { cfg: Config; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "neo-ctx-tier-"));
  return {
    dir,
    cfg: {
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
      contextWindow: 200_000,
      contextWindowSource: "config",
      configuredContextWindow: 200_000,
      configuredContextWindowExplicit: true,
      // env 快照落在沙箱里：/context 会重新解析窗口，绝不能读到真实的 ~/.neo
      env: { prompt: false, dir },
      providers: [prov()],
    } as unknown as Config,
  };
}

function selection(over: Partial<PromptSelection> = {}): PromptSelection {
  return {
    tier: "standard",
    fits: true,
    reason: "budget-first，窗口200000（config）；standard 开销 9000 ≤ 预算 25000",
    window: 200_000,
    windowTrusted: true,
    source: "config",
    budget: 25_000,
    estimatedSystemTokens: 9_000,
    ...over,
  };
}

describe("/context 档位行", () => {
  test("展示宿主给的诊断值，并与 window 行同源", async () => {
    const { cfg, dir } = makeCfg();
    try {
      const { ui, out } = captureConsole({ stdoutIsTTY: false });
      const agent = new Agent({ cfg, console: ui, mode: "auto", systemPrompt: "s" } as never);
      await handleCommand("/context", {
        agent,
        ui,
        cfg,
        promptSelection: () => selection(),
      } as unknown as CommandContext);

      const text = plain(out());
      const promptLine = lineWith(text, "prompt");
      expect(promptLine).toContain("standard");
      expect(promptLine).toContain("预算内");
      // 原因行：档位为什么这么选
      expect(text).toContain("standard 开销 9000 ≤ 预算 25000");
      // 其余各行照常
      expect(lineWith(text, "window")).toContain("200,000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("诊断回调抛错：/context 不崩，省略档位行，其余各行照常", async () => {
    const { cfg, dir } = makeCfg();
    try {
      const { ui, out } = captureConsole({ stdoutIsTTY: false });
      const agent = new Agent({ cfg, console: ui, mode: "auto", systemPrompt: "s" } as never);
      await handleCommand("/context", {
        agent,
        ui,
        cfg,
        promptSelection: () => {
          throw new Error("档位诊断炸了");
        },
      } as unknown as CommandContext);

      const text = plain(out());
      // 档位行被省略 —— 不是报错，更不是整条命令失败
      expect(lineWith(text, "prompt")).toBe("");
      expect(text).not.toContain("档位诊断炸了");
      // 其余各行照常
      expect(lineWith(text, "window")).toContain("200,000");
      expect(lineWith(text, "model")).toContain("p1/m1");
      expect(lineWith(text, "threshold")).toContain("75%");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("诊断取不到（null）：/context 照常输出", async () => {
    const { cfg, dir } = makeCfg();
    try {
      const { ui, out } = captureConsole({ stdoutIsTTY: false });
      const agent = new Agent({ cfg, console: ui, mode: "auto", systemPrompt: "s" } as never);
      await handleCommand("/context", {
        agent,
        ui,
        cfg,
        promptSelection: () => null,
      } as unknown as CommandContext);

      const text = plain(out());
      expect(lineWith(text, "prompt")).toBe("");
      expect(lineWith(text, "window")).toContain("200,000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
