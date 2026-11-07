/**
 * issue #18：启动 TUI 降噪 + 输出顺序 + 占位样式。
 *
 * 覆盖点（与 issue 验收一一对应）：
 *  1. 前置能力探测提示（「首次使用 … 将探测模型能力…」/「仍有未声明能力…」）只写日志，不进 TUI；
 *  2. 「未探测到：…」能力缺口诊断只写日志，不进 TUI（异步探测结束后也不回流）；
 *  3. 输出顺序：banner → shell 行 → 项目记忆提示，记忆提示紧邻 shell 行下方且只一次；
 *  4. 输入框占位更暗（SGR 2），正文/光标样式与快捷键行为不变。
 *
 * 为什么把「发往 TUI 的文案」和「写日志」拆开测：探测本身有副作用（写 settings.json），
 * 单测里用假网关 + 临时 settings 太重；这里直接断言两个通道的**分流函数**，
 * 再用 Console 录制证明 TUI 通道里没有这些文案。真终端顺序由 scripts/pty-e2e.ts S22 兜底。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootLines,
  bootLogFile,
  bootLogRoot,
  formatGapLogLine,
  formatOverBudgetNotice,
  formatProbeIntent,
  formatWindowNotice,
  formatWritebackNotice,
  logBootDiagnostic,
} from "../src/bootDiagnostics.ts";
import { formatCapabilityGapHint } from "../src/env/modelWindows.ts";
import { undeclaredCapabilityFields } from "../src/env/modelCaps.ts";
import type { Config } from "../src/config.ts";
import { captureConsole } from "./helpers.ts";
import { stripAnsi } from "../src/tui/ansi.ts";
import { Composer } from "../src/tui/composer.ts";
import { COMMANDS } from "../src/input/commands.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-boot-noise-"));
afterEach(() => {
  /* 每个用例各自建子目录，最后统一删 */
});
process.on("exit", () => {
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

function makeCfg(over: Partial<Config> = {}): Config {
  return {
    providerName: "ipsa",
    model: "m1",
    contextWindow: 100_000,
    maxTokens: 8_192,
    providers: [
      {
        name: "ipsa",
        type: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        models: { default: "m1" },
        contextWindow: null,
        maxOutputTokens: null,
        vision: undefined,
        tools: undefined,
        reasoning: undefined,
      },
    ],
    env: {},
    cwd: SANDBOX,
    settingsPath: null,
    ...over,
  } as unknown as Config;
}

describe("issue #18-1/3 诊断只写日志", () => {
  test("前置探测提示文案：五项全空说「首次使用」，部分空缺点名缺口", () => {
    const all = formatProbeIntent("ipsa", "m1", [
      "context_window",
      "max_output_tokens",
      "vision",
      "tools",
      "reasoning",
    ]);
    expect(all).toContain("首次使用 ipsa/m1");
    expect(all).toContain("将探测模型能力");

    const partial = formatProbeIntent("ipsa", "m1", ["max_output_tokens", "vision", "tools", "reasoning"]);
    expect(partial).toContain("仍有未声明能力");
    expect(partial).toContain("max_output_tokens");
    // 保护规则必须写在文案里：手写值（含 false）不被覆盖
    expect(partial).toContain("含 false");
    expect(partial).toContain("不会被覆盖");
  });

  test("logBootDiagnostic 落盘到 boot/<day>.jsonl，一行一条 JSON（不含 ANSI）", () => {
    const root = join(SANDBOX, "log-1");
    const now = new Date("2026-11-20T10:00:00Z");
    const file = logBootDiagnostic(
      { kind: "probe-intent", message: formatProbeIntent("ipsa", "m1", ["vision"]) },
      { now, root },
    );
    expect(file).toBe(bootLogFile(now, root));
    const lines = readFileSync(file!, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!) as { kind: string; message: string; ts: string };
    expect(entry.kind).toBe("probe-intent");
    expect(entry.message).toContain("仍有未声明能力");
    expect(entry.message).not.toContain("\x1b");
  });

  test("能力缺口诊断：日志里保留五项缺失与 max_output_tokens/max_tokens 的区别", () => {
    const cfg = makeCfg();
    const hint = formatCapabilityGapHint(cfg);
    expect(hint).not.toBeNull();
    const logged = formatGapLogLine(hint!);
    expect(logged).toContain("未探测到");
    expect(logged).toContain("max_output_tokens");
    expect(logged).toContain("能力上限");
    expect(logged).toContain("请求预算");
    expect(logged).toContain("max_tokens");
    // 五项能力定义不变：缺口来自 undeclaredCapabilityFields 的同一份字段表
    expect(undeclaredCapabilityFields(cfg).length).toBe(5);
  });

  test("写回/窗口提示是「结果」不是诊断：文案保持原文", () => {
    expect(formatWritebackNotice(["vision", "tools"])).toBe(
      "已补进 settings.json：vision、tools（手写值不会被覆盖）",
    );
    expect(formatWindowNotice(131_072, "models_api")).toBe(
      "模型上下文窗口：131,072 tokens（models_api）",
    );
  });

  test("TUI 通道不含前置探测提示与「未探测到」（只有日志通道有）", () => {
    const cap = captureConsole({ stdoutIsTTY: true });
    // 模拟 index.ts 的分流：诊断 → 日志；结果 → TUI
    const root = join(SANDBOX, "log-2");
    logBootDiagnostic(
      { kind: "probe-intent", message: formatProbeIntent("ipsa", "m1", ["vision", "tools"]) },
      { root },
    );
    logBootDiagnostic({ kind: "capability-gap", message: formatGapLogLine(formatCapabilityGapHint(makeCfg())!) }, { root });
    cap.ui.info(formatWritebackNotice(["vision"]));

    const tui = stripAnsi(cap.out());
    expect(tui).not.toContain("首次使用");
    expect(tui).not.toContain("将探测");
    expect(tui).not.toContain("未探测到");
    expect(tui).toContain("已补进 settings.json");

    const logged = readFileSync(join(root, "boot", `${bootLogFile(new Date(), root).split("/").pop()}`), "utf8");
    expect(logged).toContain("将探测");
    expect(logged).toContain("未探测到");
  });

  test("bootLogRoot 跟随 NEO_LOG_DIR（与轮次日志同根）", () => {
    const old = process.env["NEO_LOG_DIR"];
    process.env["NEO_LOG_DIR"] = "/tmp/neo-boot-root-probe";
    try {
      expect(bootLogRoot()).toBe("/tmp/neo-boot-root-probe");
    } finally {
      if (old === undefined) delete process.env["NEO_LOG_DIR"];
      else process.env["NEO_LOG_DIR"] = old;
    }
  });

  test("日志写失败不抛（诊断是增强项）", () => {
    // 用一个「父路径是文件」的根，mkdir 必然失败
    const badRoot = join(SANDBOX, "not-a-dir");
    require("node:fs").writeFileSync(badRoot, "x");
    expect(logBootDiagnostic({ kind: "capability-gap", message: "x" }, { root: join(badRoot, "sub") })).toBeNull();
  });

  test("异步探测结束不回流 TUI：写回/窗口是结果，缺口只进日志且同 key 只说一次", () => {
    // 模拟 index.ts 的异步回调：探测 resolve 之后先打写回（结果），再报缺口（诊断）。
    const cap = captureConsole({ stdoutIsTTY: true });
    const root = join(SANDBOX, "log-3");
    const announced = new Set<string>();
    const announceGap = (): void => {
      const key = "ipsa|m1";
      if (announced.has(key)) return;
      const hint = formatCapabilityGapHint(makeCfg());
      if (!hint) return;
      announced.add(key);
      logBootDiagnostic({ kind: "capability-gap", message: formatGapLogLine(hint) }, { root });
    };
    // 两次回调（首轮探测 + 撞墙重试）都不该把诊断写进 TUI，也不该重复写日志。
    for (let i = 0; i < 2; i++) {
      cap.ui.info(formatWritebackNotice(["vision"]));
      announceGap();
    }
    const tui = stripAnsi(cap.out());
    expect(tui).not.toContain("未探测到");
    expect(tui).not.toContain("网关未提供");
    expect(tui).not.toContain("能力上限");
    // 结果提示可以重复出现在 TUI（每次确实改了东西），诊断日志只一条。
    const file = bootLogFile(new Date(), root);
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).kind).toBe("capability-gap");
  });
});

/* ------------------------------------------------------------------ */
/* issue #18-3：启动输出顺序（shell 行 → 记忆提示紧邻 → 告警）           */
/* ------------------------------------------------------------------ */

describe("issue #18-3 启动顺序：记忆提示紧邻真实 shell 行，告警可见但不打断紧邻", () => {
  const SHELL = "  shell /bin/bash（bash，登录 shell）";
  const MEM = "已加载项目记忆 /tmp/x/AGENTS.md";
  const WARN = "指定的 shell 不可执行：/nonexistent/x（config），已回退到其它候选";

  /** 按 index.ts 的方式把 bootLines 渲染到 Console，返回纯文本行。 */
  function render(b: Parameters<typeof bootLines>[0]): string[] {
    const cap = captureConsole({ stdoutIsTTY: true });
    for (const row of bootLines(b)) {
      if (row.kind === "shell") cap.ui.line(row.text);
      else if (row.kind === "memory") cap.ui.info(row.text);
      else cap.ui.warn(row.text);
    }
    return stripAnsi(cap.out()).split("\n").map((l) => l.replace(/\s+$/, ""));
  }

  test("无 shell 告警：shell 行 → 记忆提示（下一非空行）", () => {
    const lines = render({ shell: SHELL, memory: MEM, warnings: [] });
    const shellIdx = lines.findIndex((l) => l.includes("shell /bin/bash"));
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    const next = lines.slice(shellIdx + 1).find((l) => l.trim() !== "") ?? "";
    expect(next).toContain("已加载项目记忆");
    expect(lines.some((l) => l.includes("指定的 shell 不可执行"))).toBe(false);
  });

  test("有 shell 告警：记忆提示仍紧邻 shell 行，告警排在记忆之后且可见", () => {
    const lines = render({ shell: SHELL, memory: MEM, warnings: [WARN] });
    const shellIdx = lines.findIndex((l) => l.includes("shell /bin/bash"));
    const next = lines.slice(shellIdx + 1).find((l) => l.trim() !== "") ?? "";
    expect(next).toContain("已加载项目记忆");
    const memIdx = lines.findIndex((l) => l.includes("已加载项目记忆"));
    const warnIdx = lines.findIndex((l) => l.includes("指定的 shell 不可执行"));
    expect(warnIdx).toBeGreaterThan(memIdx);
    // 告警行不能被误当成 shell 状态行（S22 假阳性的根因）
    expect(/^ {2}shell \/[^（]*（/.test(lines[warnIdx]!.trimStart())).toBe(false);
  });

  test("多条告警按原顺序全部输出，且都排在记忆之后", () => {
    const w2 = "Windows shell 执行尚未实机验证";
    const lines = render({ shell: SHELL, memory: MEM, warnings: [WARN, w2] });
    const memIdx = lines.findIndex((l) => l.includes("已加载项目记忆"));
    const i1 = lines.findIndex((l) => l.includes("指定的 shell 不可执行"));
    const i2 = lines.findIndex((l) => l.includes(w2));
    expect(i1).toBeGreaterThan(memIdx);
    expect(i2).toBeGreaterThan(i1);
  });

  test("没有项目记忆文件：shell 行之后直接是告警（不输出空提示）", () => {
    const lines = render({ shell: SHELL, memory: null, warnings: [WARN] });
    expect(lines.some((l) => l.includes("已加载项目记忆"))).toBe(false);
    const shellIdx = lines.findIndex((l) => l.includes("shell /bin/bash"));
    const next = lines.slice(shellIdx + 1).find((l) => l.trim() !== "") ?? "";
    expect(next).toContain("指定的 shell 不可执行");
  });
});

/* ------------------------------------------------------------------ */
/* issue #18-4：输入框占位更暗                                          */
/* ------------------------------------------------------------------ */

describe("issue #18-4 占位样式更暗但仍可读", () => {
  const PLACEHOLDER = "输入消息 · @ 文件 · / 命令 · Ctrl+J 换行";

  function withColor<T>(fn: () => T): T {
    const prevNo = process.env["NO_COLOR"];
    const prevForce = process.env["FORCE_COLOR"];
    delete process.env["NO_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    try {
      return fn();
    } finally {
      if (prevNo === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = prevNo;
      if (prevForce === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = prevForce;
    }
  }

  function makeComposer(): { composer: Composer; out: () => string; stop: () => void } {
    const chunks: string[] = [];
    const stdin = new EventEmitter() as unknown as NodeJS.ReadStream & {
      setRawMode: (v: boolean) => void;
      isRaw: boolean;
      isTTY: boolean;
    };
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
    (stdin as unknown as { isRaw: boolean }).isRaw = false;
    const composer = new Composer({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: { write: (s: string) => chunks.push(s), columns: 100, rows: 24 },
      columns: () => 100,
      rows: () => 24,
      getStatus: () => ({
        version: "0.4.64",
        model: "deepseek-flash",
        tier: "balanced",
        mode: "ask",
        branch: "main",
        ctxUsage: 0.1,
        elapsedMs: 1_000,
        active: true,
        tokensTotal: 100,
      }),
      getTitle: () => "neo · test",
      commands: COMMANDS,
      files: () => [],
      onSubmit: () => {},
      onExit: () => {},
    });
    composer.start();
    return { composer, out: () => chunks.join(""), stop: () => composer.stop() };
  }

  test("占位文案不变，颜色是 grey + SGR 2（比正文暗）", () => {
    withColor(() => {
      const h = makeComposer();
      try {
        const row = h.composer.compose().rows.find((r) => r.includes("输入消息")) ?? "";
        expect(stripAnsi(row)).toContain(PLACEHOLDER);
        // grey = 130;165;140，叠 SGR 2（faint）
        expect(row).toContain("\x1b[38;2;130;165;140m\x1b[2m");
        // 不再是旧的 dimGreen（正文同族绿），否则「暗」得看不出来
        expect(row).not.toContain("\x1b[38;2;0;143;17m");
      } finally {
        h.stop();
      }
    });
  });

  test("正文与光标样式不受影响：仍是 c.text + 反显", () => {
    withColor(() => {
      const h = makeComposer();
      try {
        h.composer.handleKey("a", { ch: "a", name: "a" });
        const row = h.composer.compose().rows.find((r) => r.includes("❯")) ?? "";
        expect(row).toContain("\x1b[38;2;230;255;235m"); // c.text(white)
        expect(row).toContain("\x1b[7m"); // 光标反显
        expect(row).not.toContain("\x1b[2m"); // 正文不带 faint
      } finally {
        h.stop();
      }
    });
  });

  test("无色环境（NO_COLOR）下占位就是纯文本，不残留转义", () => {
    const prevNo = process.env["NO_COLOR"];
    process.env["NO_COLOR"] = "1";
    try {
      const h = makeComposer();
      try {
        const row = h.composer.compose().rows.find((r) => r.includes("输入消息")) ?? "";
        expect(row).toBe(`❯  ${PLACEHOLDER}`);
      } finally {
        h.stop();
      }
    } finally {
      if (prevNo === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = prevNo;
    }
  });
});

/**
 * issue #20 收尾：「系统提示词放不下预算」的提示文案。
 *
 * 归类与 issue #18 的诊断不同：#18 的诊断是「网关缺了什么字段」（无当下动作），
 * 这条是**当前配置的直接后果**且**当下就能补救**（换窗口更大的模型 / 手写
 * context_window）—— 所以它进 TUI（仅交互模式）+ 写日志。
 */
describe("issue #20 收尾：超预算提示文案", () => {
  test("文案含窗口、估计开销、预算与两条补救建议", () => {
    const msg = formatOverBudgetNotice({
      window: 16_384,
      source: "config",
      estimatedSystemTokens: 7_918,
      budget: 2_048,
    });
    expect(msg).toContain("16,384");
    expect(msg).toContain("config");
    expect(msg).toContain("7,918");
    expect(msg).toContain("2,048");
    expect(msg).toContain("换用窗口更大的模型");
    expect(msg).toContain("context_window");
    // 日志要能 grep：不带 ANSI
    expect(msg).not.toContain("\x1b");
  });

  test("窗口未知时也不崩，文案仍然可读", () => {
    const msg = formatOverBudgetNotice({
      window: null,
      source: undefined,
      estimatedSystemTokens: null,
      budget: 2_048,
    });
    expect(msg).toContain("窗口未知");
    expect(msg).toContain("2,048");
  });

  test("日志 kind 为 prompt-budget（新增的稳定枚举）", () => {
    const root = join(SANDBOX, "log-budget");
    const now = new Date("2026-11-20T10:00:00Z");
    const file = logBootDiagnostic(
      {
        kind: "prompt-budget",
        message: formatOverBudgetNotice({
          window: 8_192,
          source: "default",
          estimatedSystemTokens: 8_055,
          budget: 1_024,
        }),
      },
      { now, root },
    );
    const entry = JSON.parse(readFileSync(file!, "utf8").trim()) as { kind: string; message: string };
    expect(entry.kind).toBe("prompt-budget");
    expect(entry.message).toContain("放不下预算");
  });
});
