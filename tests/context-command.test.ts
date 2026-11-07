/**
 * P2：`/context` 与 `/env` 展示当前模型的五项能力。
 *
 * 运行：bun test tests/context-command.test.ts
 *
 * ============================================================================
 * 【为什么用子进程】
 * ============================================================================
 * 同 skills-command.test.ts：src/index.ts 顶层自执行 main() 并 process.exit，
 * handleCommand 未导出。只有交互模式读到以 `/` 开头的行才走命令分支。
 *
 * ============================================================================
 * 【env 快照怎么注入】
 * ============================================================================
 * modelWindows 的事实源是 ~/.neo/env/<machineKey>.json（envHome() = homedir()，
 * 可用 NEO_ENV_HOME 覆盖）。测试把 HOME 与 NEO_ENV_HOME 都指向沙箱假 home，
 * 预先写好一份 models 记录，让 /context 读到「探测值」。
 * 快照里只放 models 字段 —— 旧快照兼容也顺带被覆盖（缺字段不炸）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { machineKeyOf, snapshotFile } from "../src/env/probe.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "src", "index.ts");
const made: string[] = [];

const PROVIDER = "test";
const MODEL = "m-caps";

/**
 * 建沙箱：settings.json 里 provider 手写 vision=false / reasoning=true（tools 留空），
 * env 快照里同一模型探测到 vision=true / tools=true / reasoning=false + 输出上限。
 * 于是「手写优先」与「探测补空缺」两条路径都能在同一份输出里验到。
 *
 * handwritten="no-window"：不写 context_window —— 启动时窗口是「未证实的兜底
 * 200K」（来源 default），档位只能 mini；等 /env refresh 探测到真实窗口后才升档。
 */
function makeProject(
  opts: {
    snapshot?: "full" | "legacy" | "none" | "thin";
    handwritten?: "default" | "window-only" | "no-window";
    baseUrl?: string;
  } = {},
): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "neo-ctx-cmd-")));
  const home = join(cwd, "fakehome");
  mkdirSync(home, { recursive: true });

  const provider: Record<string, unknown> = {
    provider_name: PROVIDER,
    provider_type: "openai",
    base_url: opts.baseUrl ?? "http://127.0.0.1:9/v1",
    api_key: "sk-test",
    default_model_name: MODEL,
    max_tokens: 8_192,
  };
  if (opts.handwritten !== "no-window") {
    provider["context_window"] = 100_000;
  }
  if (opts.handwritten !== "window-only") {
    provider["vision"] = false;
    provider["reasoning"] = true;
  }
  writeFileSync(
    join(cwd, "settings.json"),
    JSON.stringify({ providers: [provider] }),
    "utf8",
  );

  const kind = opts.snapshot ?? "full";
  if (kind !== "none") {
    const key = machineKeyOf(hostname(), platform(), arch());
    const file = snapshotFile(home, key, {});
    mkdirSync(dirname(file), { recursive: true });
    const models =
      kind === "full"
        ? {
            [`${PROVIDER}|${MODEL}`]: {
              contextWindow: 131_072,
              maxOutputTokens: 32_768,
              vision: true,
              tools: true,
              reasoning: false,
              source: "models_api",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : kind === "thin"
          ? {
              // ipsa-thor 一类瘦网关：探测跑过，但卡片上没有能力字段。
              [`${PROVIDER}|${MODEL}`]: {
                contextWindow: null,
                maxOutputTokens: null,
                vision: "unknown",
                tools: "unknown",
                reasoning: "unknown",
                source: "models_api",
                updatedAt: "2026-01-01T00:00:00.000Z",
                evidence: "http://thin.example/v1/models",
              },
            }
          : {
              // v0.4.1 时期的旧记录：只有窗口字段。
              [`${PROVIDER}|${MODEL}`]: {
                contextWindow: 131_072,
                source: "overflow_error",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            };
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        // 必须是「新鲜」时间戳：过期的快照会被 loadEnv 重新探测并重写。
        collectedAt: new Date().toISOString(),
        machineKey: key,
        // readSnapshot 会校验 shell 是否存在；缺了它整份快照被判为损坏（返回 null），
        // models 也随之丢失 —— 所以这里必须给一个最小 shell 结构。
        // /env 还会渲染 os/memory 等字段，一并给齐，避免 formatEnvForCli 读到 undefined。
        shell: { path: "/bin/bash", kind: "bash", login: false, source: "env", version: null },
        hostname: hostname(),
        os: { platform: platform(), arch: arch(), release: "test", kernelVersion: "test", pretty: "Test OS" },
        cpu: { cores: 1, model: "test-cpu" },
        memoryTotalBytes: 1,
        tools: {},
        container: { docker: false, wsl: false, ssh: false },
        terminal: { term: null, program: null, colorterm: null },
        locale: { lang: null, timezone: null },
        privileges: { uid: null, root: false, sudo: false },
        gui: false,
        runtime: { bun: "test", node: null, parentPath: null },
        models,
      }),
      "utf8",
    );
  }

  made.push(cwd);
  return cwd;
}

function runCommands(cwd: string, cmds: string[]): string {
  return execFileSync(process.execPath, [ENTRY], {
    cwd,
    input: `${cmds.join("\n")}\n/exit\n`,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: join(cwd, "fakehome"),
      USERPROFILE: join(cwd, "fakehome"),
      NEO_ENV_HOME: join(cwd, "fakehome"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * 分片喂命令：写一条 → 等它的输出落地 → 再写下一条。
 *
 * 为什么不能一次写完：execFileSync 把输入写完就关 stdin，子进程读到 EOF 会
 * 立刻关停 —— 正在 await 的命令（比如 /env refresh 的探测）会被腰斩，输出只剩半截。
 * 分片后 stdin 一直开着，命令按队列顺序一个个跑完。
 */
async function runCommandsSeq(
  cwd: string,
  steps: { cmd: string; until: string[] }[],
): Promise<string> {
  const child = spawn(process.execPath, [ENTRY], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: join(cwd, "fakehome"),
      USERPROFILE: join(cwd, "fakehome"),
      NEO_ENV_HOME: join(cwd, "fakehome"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => { out += d; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => { out += d; });
  const exited = new Promise<void>((res) => child.on("close", () => res()));

  for (const step of steps) {
    child.stdin.write(`${step.cmd}\n`);
    await waitUntil(
      () => step.until.some((m) => out.includes(m)),
      30_000,
      `等待命令「${step.cmd}」的输出超时`,
    );
  }
  child.stdin.write("/exit\n");
  await exited;
  return out;
}

async function waitUntil(pred: () => boolean, timeoutMs: number, msg: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(msg);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 取含某标签的行（kv 输出形如 `context    131,072 tokens`）。 */
function lineWith(out: string, label: string): string {
  return out.split("\n").find((l) => l.trimStart().startsWith(label)) ?? "";
}

/** 取最后一个含某标签的行：/context 是最后一条命令，避免撞上前面命令的输出。 */
function lastLineWith(out: string, label: string): string {
  const hits = out.split("\n").filter((l) => l.trimStart().startsWith(`${label} `));
  return hits[hits.length - 1] ?? "";
}

/** 起一个只回 /models 的假网关（窗口元数据从这里来）。 */
function serveModels(entry: Record<string, unknown>): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [entry] });
      }
      return new Response("nope", { status: 404 });
    },
  });
  return { port: Number(server.port), stop: () => server.stop(true) };
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("P2 /context 展示五项能力", () => {
  test("五项 kv 都在，手写 settings 优先、探测补空缺", () => {
    const out = runCommands(makeProject(), ["/context"]);

    expect(lineWith(out, "context")).toContain("131,072 tokens");
    expect(lineWith(out, "max_output")).toContain("32,768 tokens");
    // 手写 false 压过探测 true
    expect(lineWith(out, "vision")).toContain("否");
    // 手写未填 → 用探测值
    expect(lineWith(out, "tools")).toContain("是");
    // 手写 true 压过探测 false
    expect(lineWith(out, "reasoning")).toContain("是");
  });

  test("旧快照缺字段：不炸，未探测项显示「未知」", () => {
    const out = runCommands(makeProject({ snapshot: "legacy" }), ["/context"]);
    expect(out).toContain("context");
    expect(lineWith(out, "max_output")).toContain("未知");
    // 手写值仍在（旧快照不影响 settings 手写）
    expect(lineWith(out, "vision")).toContain("否");
    expect(lineWith(out, "reasoning")).toContain("是");
    // tools 既没手写也没探测 → 未知
    expect(lineWith(out, "tools")).toContain("未知");
  });

  test("完全没有 env 快照：五项不炸，能力回落「未知」", () => {
    const out = runCommands(makeProject({ snapshot: "none" }), ["/context"]);
    expect(lineWith(out, "max_output")).toContain("未知");
    expect(lineWith(out, "tools")).toContain("未知");
    // 窗口回落到 settings 的 context_window
    expect(lineWith(out, "context")).toContain("100,000 tokens");
  });
});

describe("瘦网关：输出上限未探测到", () => {
  test("/context 与 /env 区分请求预算和能力上限，并提示手写", () => {
    const out = runCommands(makeProject({ snapshot: "thin", handwritten: "window-only" }), ["/context", "/env"]);
    expect(out).toContain("未探测到");
    expect(out).toContain("max_output_tokens");
    expect(out).toContain("请求预算");
    expect(out).toContain("能力上限");
    const outputLine = lineWith(out, "max_output");
    expect(outputLine).toContain("未知");
    expect(outputLine).toContain("能力上限");
    expect(outputLine).not.toContain("8,192");
    const budgetLine = lineWith(out, "max_tokens");
    expect(budgetLine).toContain("8,192");
    expect(budgetLine).toContain("请求预算");
    // 窗口是手写的，不能被瘦网关的 null 探测值抹掉。
    expect(lineWith(out, "context")).toContain("100,000 tokens");
  });
});

describe("P2 /env 模型能力行", () => {
  test("标题改为「模型能力」，行内含五项", () => {
    const out = runCommands(makeProject(), ["/env"]);
    expect(out).toContain("模型能力");
    const line = out.split("\n").find((l) => l.includes(`${PROVIDER}|${MODEL}`)) ?? "";
    expect(line).toContain("131,072 tokens");
    expect(line).toContain("能力上限 max_output_tokens 32,768 tokens");
    expect(line).toContain("请求预算 max_tokens 8,192");
    expect(line).toContain("vision 否");
    expect(line).toContain("tools 是");
    expect(line).toContain("reasoning 是");
  });
});

/**
 * 档位行与窗口行必须自洽（issue #20 收尾）。
 *
 * 窗口变了（探测到手写值之外的真实窗口），档位行必须跟着变 —— 否则一行说
 * 「131,072 tokens」、另一行还说「窗口未证实 → mini / 超预算」，用户看到的是
 * 自相矛盾的两行。
 *
 * /env refresh 会探测 /models 并把窗口事实写回 env 快照，随即 resolveAndApplyModelWindow
 * 更新 cfg —— 但**不**重渲染系统提示词（提示词何时生效由请求边界决定）。
 * 于是这里正是「cfg 已变、lastSelection 还是旧值」的窗口。
 */
describe("档位行与窗口行自洽", () => {
  test("/env refresh 探测到窗口后，档位行不再报「未证实 → mini / 超预算」", async () => {
    const s = serveModels({ id: MODEL, context_length: 131_072, max_output_tokens: 32_768 });
    try {
      const cwd = makeProject({
        snapshot: "none",
        handwritten: "no-window",
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
      });
      const out = await runCommandsSeq(cwd, [
        { cmd: "/env refresh", until: ["已探测", "未能从 /models"] },
        // threshold 行在 prompt 行之后：等它出现即说明档位行已经打印
        { cmd: "/context", until: ["threshold"] },
      ]);

      // 窗口行读的是 cfg：探测后已是新值（这一行一直是对的）
      expect(lineWith(out, "window")).toContain("131,072");
      expect(lineWith(out, "window")).toContain("models_api");

      // 档位行必须与它自洽：不再是「窗口未证实 → mini / 超预算」
      const promptLine = lastLineWith(out, "prompt");
      expect(promptLine).not.toContain("mini");
      expect(promptLine).not.toContain("超预算");
      expect(promptLine).toContain("预算内");
    } finally {
      s.stop();
    }
  });
});

/**
 * 「可见工具」dry-run 行（issue #20 收尾，第 1 步）。
 *
 * 走真实 CLI：组合根 → PromptManager.currentVisibility → /context。
 * 断言只到「形状」为止 —— 具体的数字随环境（技能数、目录大小、注册的 MCP 工具）变，
 * 这正是「按实测开销现算、不写死阈值表」的意义。
 */
describe("可见工具 dry-run 行（真实 CLI）", () => {
  test("/context 多一行「可见工具」，标明未启用、当前仍是全量", () => {
    const out = runCommands(makeProject(), ["/context"]);
    const line = out.split("\n").find((l) => l.trimStart().startsWith("可见工具")) ?? "";
    expect(line).toMatch(/\d+\/\d+ 个/);
    expect(line).toContain("未启用");
    expect(out).toContain("收窄尚未启用");
    // 运行时行为不变由「请求体逐字节对比」保证（见 v0.4.72 的验收记录），
    // 这里只断言 /context 多出来的那一行是 dry-run。
    expect(out).toContain("dry-run");
  });
});
