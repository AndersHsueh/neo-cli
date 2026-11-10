/**
 * issue #40：一次性模式（`-p` / `args.rest` 非 TTY）的资源回收。
 *
 * 覆盖：
 *  A `cleanupEphemeral` 单测：清理顺序、逐项容错、可选依赖缺失不炸
 *  B 集成：假 LLM 让模型发起 `shell background:true` 跑长命令；**两段式**断言
 *    （运行期间确认进程确实起来了 → 退出后确认已消失），避免「从未起来」的假阳性
 *  C 回归：`-p` 正常路径仍输出答案、退出码不变
 *
 * 集成用例用真实 CLI 子进程（与 cli-json.test.ts 同款写法），不触网：
 * 假端点直接在本进程 Bun.serve 上起，按 messages 里是否已有 tool 消息决定这一轮。
 *
 * 子进程识别不用 pid 文件（登录 shell 的 PATH preamble 下 `echo $$ > f` 实测不落盘），
 * 改用**命令唯一标记**：标记必须作为**子进程 argv** 出现（`# 注释` 会被 shell 吃掉、
 * ps 里看不到），所以用 `sh -c "sleep 300; :" <marker>` 把标记带进子进程命令行。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupEphemeral, type EphemeralDeps } from "../src/cleanup.ts";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-oneshot-cleanup-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;

/* ------------------------------------------------------------------ */
/* A. cleanupEphemeral 单测                                             */
/* ------------------------------------------------------------------ */

/** 记录调用顺序的可观测假依赖。 */
function recorder(): { deps: EphemeralDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      loop: { dispose: () => calls.push("loop") },
      drive: { stop: () => calls.push("drive") },
      tasks: { cancelAll: () => calls.push("tasks") },
      shells: { killAll: () => calls.push("shells") },
      lsp: { closeAll: () => calls.push("lsp") },
      mcp: { closeAll: () => calls.push("mcp") },
      closeMailbox: () => calls.push("mailbox"),
    },
  };
}

describe("A cleanupEphemeral", () => {
  test("A1 按序清理：驱动 → 子进程（子代理/后台 shell/LSP）→ MCP → 信箱", () => {
    const r = recorder();
    cleanupEphemeral(r.deps);
    expect(r.calls).toEqual(["loop", "drive", "tasks", "shells", "lsp", "mcp", "mailbox"]);
  });

  test("A2 某一项抛错不阻止后续清理（孤儿进程比清理干净更要紧）", () => {
    const calls: string[] = [];
    cleanupEphemeral({
      loop: { dispose: () => calls.push("loop") },
      drive: {
        stop: () => {
          throw new Error("drive boom");
        },
      },
      tasks: { cancelAll: () => calls.push("tasks") },
      shells: {
        killAll: () => {
          throw new Error("shells boom");
        },
      },
      lsp: { closeAll: () => calls.push("lsp") },
      mcp: { closeAll: () => calls.push("mcp") },
      closeMailbox: () => calls.push("mailbox"),
    });
    expect(calls).toEqual(["loop", "tasks", "lsp", "mcp", "mailbox"]);
  });

  test("A3 可选依赖缺失（null / undefined）不炸，也不漏掉其余项", () => {
    const calls: string[] = [];
    cleanupEphemeral({
      loop: null,
      drive: undefined,
      tasks: null,
      shells: { killAll: () => calls.push("shells") },
      lsp: null,
      mcp: { closeAll: () => calls.push("mcp") },
      closeMailbox: null,
    });
    expect(calls).toEqual(["shells", "mcp"]);
  });

  test("A4 空依赖：不抛错（-p 在连 MCP 之前就失败时也会走到这里）", () => {
    expect(() => cleanupEphemeral({})).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* B/C. 集成：真 CLI 子进程                                            */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();

/** 第 1 轮：调 shell(background:true) 起长命令；第 2 轮：给最终答案。 */
function shellBackgroundFrames(command: string): string[] {
  const args = JSON.stringify({ command, background: true });
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "起后台任务。" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_fake_bg", type: "function", function: { name: "shell", arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

const ANSWER_FRAMES =
  'data: {"choices":[{"delta":{"content":"已启动。"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
  "data: [DONE]\n\n";

let bgCommand = "";
/** 当前用例的标记命令是否走「第一轮就调工具」；C1 设为 false（纯答案路径）。 */
let firstRoundTool = true;
/** 清理用：只按本用例唯一的标记杀残留，别用 `true` 这种会匹配到别的进程的字符串。 */
let bgMarker = "";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "fake-model" }] });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      return (async () => {
        let messages: Array<{ role?: string }> = [];
        try {
          const body = (await req.json()) as { messages?: Array<{ role?: string }> };
          if (Array.isArray(body.messages)) messages = body.messages;
        } catch {
          /* 非法请求体也照常回 stop 帧 */
        }
        const toolRounds = messages.reduce((n, m) => (m.role === "tool" ? n + 1 : n), 0);
        const frames = firstRoundTool && toolRounds === 0 ? shellBackgroundFrames(bgCommand) : [ANSWER_FRAMES];
        // 工具轮之后延迟回答案：给测试一个稳定的「后台进程仍在」观测窗口（B1/B2 的两段式断言依赖它）。
        if (toolRounds > 0) await Bun.sleep(800);
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const f of frames) {
              controller.enqueue(enc.encode(f));
              await Bun.sleep(2);
            }
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      })();
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => {
  server.stop(true);
  rmSync(SANDBOX, { recursive: true, force: true });
});

function writeSettings(dir: string): void {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(
      {
        default_provider: "fake",
        default_model_tier: "default",
        classifier_provider: "fake",
        classifier_model_name: "fake-model",
        providers: [
          {
            provider_name: "fake",
            provider_type: "openai",
            base_url: BASE,
            api_key: "test",
            default_model_name: "fake-model",
            deep_reasoning_model_name: "fake-model",
            balanced_model_name: "fake-model",
            fast_model_name: "fake-model",
            max_tokens: 64,
            temperature: 0,
            context_window: 100_000,
          },
        ],
        retry: { max_attempts: 1, base_delay_ms: 1, connect_timeout_ms: 2_000, stream_idle_timeout_ms: 2_000 },
        memory: { enabled: false },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function project(): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir);
  return dir;
}

/** 按命令行里出现 `marker` 找进程（排除自己这条 ps）。 */
function pidsWithMarker(marker: string): number[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" });
  const text = new TextDecoder().decode(out.stdout);
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(marker)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function waitPidsGone(marker: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidsWithMarker(marker).length === 0) return true;
    await Bun.sleep(50);
  }
  return pidsWithMarker(marker).length === 0;
}

/**
 * 运行期间等标记进程出现：先证明后台命令确实执行了，否则「退出后没有」是假阳性。
 *
 * 窗口放宽到 45s / 轮询 100ms：全量 `bun test`（多个测试文件 + 真子进程）下，
 * `neo -p` 从启动到执行工具调用偶发被拖慢，20s 会假红（issue #40 合入后实测）。
 */
async function waitPidsAppear(marker: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidsWithMarker(marker).length > 0) return true;
    await Bun.sleep(100);
  }
  return pidsWithMarker(marker).length > 0;
}

/** 长命令带上唯一标记（标记要留在子进程 argv 里；`# 注释` 会被 shell 吃掉）。 */
function markedCommand(marker: string): string {
  return `sh -c "sleep 300; :" ${marker}`;
}

async function run(cwd: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NEO_SESSIONS_DIR: sessionsDir, NEO_MEMORY_DISABLE: "1" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

afterEach(() => {
  // 兜底：用例失败时别把 sleep 留在机器上（只按本用例唯一标记找，避免误杀）
  if (bgMarker) {
    for (const pid of pidsWithMarker(bgMarker)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  }
  bgMarker = "";
  firstRoundTool = true;
});

describe("B -p 退出后不留孤儿（issue #40）", () => {
  test("B1 模型发起 shell background:true → -p 退出后子进程已死", async () => {
    const dir = project();
    const marker = `NEO_BG_MARK_${Date.now()}_${seq}`;
    bgCommand = markedCommand(marker);
    bgMarker = marker;

    const proc = Bun.spawn(["bun", INDEX, "-p", "起一个后台任务", "-y"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NEO_SESSIONS_DIR: sessionsDir, NEO_MEMORY_DISABLE: "1" },
    });
    const outP = new Response(proc.stdout).text();
    // 两段式：①运行期间后台命令确实起来了（否则「退出后没有进程」是假阳性）②退出后消失
    expect(await waitPidsAppear(marker)).toBe(true);
    expect(await proc.exited).toBe(0);
    expect(await outP).toContain("已启动");
    expect(await waitPidsGone(marker)).toBe(true);
  }, 60_000);

  test("B2 非交互 args.rest 路径同样回收（不是只有 -p 走清理）", async () => {
    const dir = project();
    const marker = `NEO_BG_MARK_${Date.now()}_${seq}`;
    bgCommand = markedCommand(marker);
    bgMarker = marker;

    // 非 TTY：stdin 是 pipe，走 args.rest 分支
    const proc = Bun.spawn(["bun", INDEX, "-y", "起一个后台任务"], {
      cwd: dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NEO_SESSIONS_DIR: sessionsDir, NEO_MEMORY_DISABLE: "1" },
    });
    const outP = new Response(proc.stdout).text();
    expect(await waitPidsAppear(marker)).toBe(true);
    expect(await proc.exited).toBe(0);
    await outP; // 消费输出,避免管道背压
    expect(await waitPidsGone(marker)).toBe(true);
  }, 60_000);
});

describe("C 回归：-p 正常路径不变", () => {
  test("C1 不调工具时答案与退出码不变", async () => {
    const dir = project();
    firstRoundTool = false; // 纯答案路径：假端点第一轮直接回正文，不派工具
    const r = await run(dir, ["-p", "你好", "-y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("已启动。");
    expect(r.out).not.toContain("⚡ shell"); // 没有工具调用，不该出现 shell 工具行
  }, 30_000);
});
