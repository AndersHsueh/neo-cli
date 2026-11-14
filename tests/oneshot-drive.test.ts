/**
 * oneshot-drive.test.ts — `-p` 无人值守长跑（issue #51，来源 #24 非目标）。
 *
 * 覆盖 issue #51 的验收：
 *  A 参数解析：`--drive` / `--judge` / `--max` / `--max-minutes` 的组合、缺省、非法值、缺 `-y`
 *  B 退出码映射：达成 0（verified / model 分别标来源）/ 未达成 1 / 用法错误 2
 *  C max-minutes 墙钟停止
 *  D 集成（fake-llm + 真 CLI）：两轮场景第 1 轮检查失败 → 第 2 轮通过 exit 0；
 *    轮次耗尽 exit 1；缺 -y exit 2
 *
 * 口径见 docs/oneshot-drive-prd.md（§0 硬口径：不新增 max-turns，三层上限不同轴）。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseDriveArgs,
  driveExitCode,
  formatDriveSummary,
  DEFAULT_MAX_MINUTES,
  MAX_MAX_MINUTES,
  type DriveRunResult,
} from "../src/oneshotDrive.ts";

/* ------------------------------------------------------------------ */
/* A. 参数解析                                                          */
/* ------------------------------------------------------------------ */

describe("A 参数解析（issue #51）", () => {
  test("A1 完整组合：--drive / --judge / --max / --max-minutes / -y", () => {
    const r = parseDriveArgs([
      "-p", "修到绿", "--drive", "bun test", "--judge", "测试全绿", "--max", "3", "--max-minutes", "10", "-y",
    ]);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
    if (!r!.ok) return;
    expect(r!.spec.check).toBe("bun test");
    expect(r!.spec.judge?.criteria).toBe("测试全绿");
    expect(r!.spec.maxRounds).toBe(3);
    expect(r!.spec.maxMinutes).toBe(10);
    expect(r!.autoApprove).toBe(true);
  });

  test("A2 缺省：--max 默认 5、--max-minutes 默认 30", () => {
    const r = parseDriveArgs(["-p", "x", "--drive", "true", "-y"]);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
    if (!r!.ok) return;
    expect(r!.spec.maxRounds).toBe(5);
    expect(r!.spec.maxMinutes).toBe(DEFAULT_MAX_MINUTES);
  });

  test("A3 夹紧：--max 超范围夹到 1–20；--max-minutes 夹到 1–240", () => {
    const hi = parseDriveArgs(["-p", "x", "--drive", "true", "--max", "999", "--max-minutes", "9999", "-y"]);
    expect(hi!.ok).toBe(true);
    if (hi!.ok) {
      expect(hi!.spec.maxRounds).toBe(20);
      expect(hi!.spec.maxMinutes).toBe(MAX_MAX_MINUTES);
    }
    const lo = parseDriveArgs(["-p", "x", "--drive", "true", "--max", "0", "--max-minutes", "0", "-y"]);
    expect(lo!.ok).toBe(true);
    if (lo!.ok) {
      expect(lo!.spec.maxRounds).toBe(1);
      expect(lo!.spec.maxMinutes).toBe(1);
    }
  });

  test("A4 缺 -y → 用法错误（无人值守没有人类点确认）", () => {
    const r = parseDriveArgs(["-p", "x", "--drive", "true"]);
    expect(r!.ok).toBe(false);
    if (r!.ok) return;
    expect(r!.error).toContain("-y");
  });

  test("A5 --drive 与 --judge 都缺 → 用法错误", () => {
    // 注意：`--drive` 后面紧跟 `-y`（另一个 flag）→ check 为空；又没有 --judge → 无完成条件。
    const r = parseDriveArgs(["-p", "x", "--drive", "-y"]);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    if (r!.ok) return;
    expect(r!.error).toContain("完成条件");
  });

  test("A6 非法数值 → 用法错误（不是静默用默认值）", () => {
    for (const bad of [["--max", "abc"], ["--max-minutes", "x"], ["--max", "-3"]]) {
      const r = parseDriveArgs(["-p", "x", "--drive", "true", "-y", ...bad]);
      expect(r!.ok).toBe(false);
    }
  });

  test("A7 没有 --drive 时不启用（返回 null，普通 -p 行为不变）", () => {
    expect(parseDriveArgs(["-p", "x", "-y"])).toBeNull();
    expect(parseDriveArgs(["-p", "x"])).toBeNull();
  });

  test("A8 只有 --judge 没有 --drive 命令：允许（模型判断单独作完成条件）", () => {
    const r = parseDriveArgs(["-p", "x", "--judge", "标准", "-y"]);
    expect(r!.ok).toBe(true);
    if (!r!.ok) return;
    expect(r!.spec.check).toBe("");
    expect(r!.spec.judge?.criteria).toBe("标准");
  });
});

/* ------------------------------------------------------------------ */
/* B. 退出码与摘要                                                       */
/* ------------------------------------------------------------------ */

describe("B 退出码与摘要（issue #51）", () => {
  function res(over: Partial<DriveRunResult>): DriveRunResult {
    return {
      status: "done",
      source: "verified",
      rounds: 2,
      elapsedMs: 184_000,
      reason: null,
      ...over,
    };
  }

  test("52-C/D/E verified done=0；model done=3；无来源 done 防御性=1", () => {
    expect(driveExitCode(res({ status: "done", source: "verified" }))).toBe(0);
    expect(driveExitCode(res({ status: "done", source: "model" }))).toBe(3);
    expect(driveExitCode(res({ status: "done", source: null }))).toBe(1);
  });

  test("B2 未达成（exhausted / idle-stop / timeout）→ 1", () => {
    expect(driveExitCode(res({ status: "exhausted", source: null }))).toBe(1);
    expect(driveExitCode(res({ status: "idle-stop", source: null }))).toBe(1);
    expect(driveExitCode(res({ status: "timeout", source: null }))).toBe(1);
  });

  test("B3 摘要一行，含 status / source / rounds / elapsed", () => {
    const line = formatDriveSummary(res({ status: "done", source: "verified", rounds: 2, elapsedMs: 184_000 }));
    expect(line).toBe("[drive] status=done source=verified rounds=2 elapsed=184s");
  });

  test("B4 未达成时 source 写 none（不冒充 verified）", () => {
    const line = formatDriveSummary(res({ status: "exhausted", source: null, rounds: 5, elapsedMs: 60_000 }));
    expect(line).toBe("[drive] status=exhausted source=none rounds=5 elapsed=60s");
  });
});

/* ------------------------------------------------------------------ */
/* C. max-minutes 墙钟停止                                              */
/* ------------------------------------------------------------------ */

describe("C max-minutes（issue #51）", () => {
  test("C1 墙钟到点 → timeout（在轮间检查，不硬杀单轮）", async () => {
    const { DriveManager } = await import("../src/drive.ts");
    let now = 0;
    const dm = new DriveManager({
      runCheck: async () => ({ ok: false, code: 1, output: "fail" }),
      enqueue: () => true,
      now: () => now,
    });
    dm.start({ check: "true", prompt: "p", maxRounds: 5 });
    // 第一轮结束：未到墙钟 → continue
    now = 1_000;
    const first = await dm.onTurnEnd({ toolCalls: 1 });
    expect(first.action).toBe("continue");
    // 墙钟到点（超过 maxMinutes）→ 由调用方（-p 循环）判定 timeout
    now = 31 * 60_000;
    expect(dm.expired(30 * 60_000)).toBe(true);
    expect(dm.expired(60 * 60_000)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* D. 集成：真 CLI + fake-llm                                           */
/* ------------------------------------------------------------------ */

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-oneshot-drive-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;

/** 第几次 chat/completions 请求（决定 fake-llm 回什么）。 */
let hits = 0;
/** 打开后每轮都先回一次工具调用（给「轮次耗尽」用例：否则会先撞 idle-stop）。 */
let forceToolCall = false;
/** #52：judge 判 done，用于验证 model done 绝不能冒充检查成功。 */
let judgeDone = false;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "fake-model" }] });
    if (url.pathname.endsWith("/chat/completions")) {
      hits += 1;
      const body = (await req.json()) as { messages?: Array<{ role: string; content: unknown }> };
      const text = JSON.stringify(body.messages ?? []);
      // judge 请求（system 里带「完成条件判定器」）→ 一律判未达成，避免干扰轮次场景。
      if (text.includes("完成条件判定器")) {
        return sse(judgeDone ? '{"done": true, "reason": "模型认为完成"}' : '{"done": false, "reason": "还没好"}');
      }
      // 「轮次耗尽」用例：每轮先来个无害工具调用（shell true），保证 toolCalls>0。
      const last = body.messages?.[body.messages.length - 1];
      if (forceToolCall && last?.role !== "tool") return sseToolCall();
      // 普通轮次：回一句可见正文。
      return sse(`第 ${hits} 轮回答`);
    }
    return new Response("not found", { status: 404 });
  },
});

/** 工具调用帧（OpenAI 流式 tool_calls）：带一次 `shell true`，本回合 toolCalls>0。 */
function sseToolCall(): Response {
  const args = JSON.stringify({ command: "true" });
  const frames =
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_fake_shell", type: "function", function: { name: "shell", arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }],
    })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(frames, { headers: { "content-type": "text/event-stream" } });
}

function sse(content: string): Response {
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
    "data: [DONE]\n\n";
  return new Response(payload, { headers: { "content-type": "text/event-stream" } });
}

const BASE = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => {
  server.stop(true);
  rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  hits = 0;
  judgeDone = false;
});

function project(): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(
      {
        default_provider: "fake",
        default_model_tier: "default",
        providers: [
          {
            provider_name: "fake",
            api_type: "openai",
            base_url: BASE,
            api_key: "k",
            default_model_name: "fake-model",
            models: { default: "fake-model", fast: "fake-model", balanced: "fake-model", deep_reasoning: "fake-model" },
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
  return dir;
}

async function run(dir: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd: dir,
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

describe("D 集成（issue #51）", () => {
  test("D1 缺 -y → exit 2，一次模型请求都不发", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "做点事", "--drive", "true"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("-y");
    expect(hits).toBe(0);
  }, 30_000);

  test("D2 两轮场景：第 1 轮检查失败 → 第 2 轮通过 → exit 0，摘要 source=verified", async () => {
    const dir = project();
    // 检查命令：文件存在即达成。第 1 轮不存在 → 失败；第 2 轮由 fake 模型创建。
    // 这里用「计数器文件」模拟：每跑一次检查就自增，第 2 次起 exit 0。
    const counter = join(dir, "check-count");
    const checkCmd = `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; [ "$n" -ge 2 ]`;
    const r = await run(dir, ["-p", "修到绿", "--drive", checkCmd, "--max", "5", "-y"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("[drive] status=done");
    expect(r.err).toContain("source=verified");
    expect(r.err).toContain("rounds=1");
  }, 60_000);

  test("D3 轮次耗尽 → exit 1，摘要 status=exhausted source=none", async () => {
    const dir = project();
    // 每轮都有工具调用 → 不会先撞 idle-stop，跑满 --max 2 轮后 exhausted。
    forceToolCall = true;
    try {
      const r = await run(dir, ["-p", "永远不达成", "--drive", "false", "--max", "2", "-y"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("[drive] status=exhausted");
      expect(r.err).toContain("source=none");
    } finally {
      forceToolCall = false;
    }
  }, 60_000);

  test("D3b 连续空转 → idle-stop 也停（exit 1，不折算成 exhausted）", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "不调工具也不达成", "--drive", "false", "--max", "5", "-y"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("[drive] status=idle-stop");
  }, 60_000);

  test("D4 启动时 stderr 警告「无人值守」", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "x", "--drive", "true", "-y"]);
    expect(r.err).toContain("无人值守");
  }, 30_000);

  test("52-D 无检查命令、judge 判 done → exit 3，摘要 source=model", async () => {
    const dir = project();
    judgeDone = true;
    const r = await run(dir, ["-p", "看起来完成了", "--judge", "模型说了算", "--max", "1", "-y"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("[drive] status=done source=model");
  }, 60_000);

  test("52-E 检查失败但 judge 判 done → 仍 exit 3，绝不返回 0", async () => {
    const dir = project();
    judgeDone = true;
    const r = await run(dir, ["-p", "检查仍失败", "--drive", "false", "--judge", "模型说了算", "--max", "1", "-y"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("[drive] status=done source=model");
    expect(r.err).not.toContain("source=verified");
  }, 60_000);

  test("D5 不带 --drive 的普通 -p 行为不变（无 [drive] 摘要）", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "普通任务", "-y"]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("[drive]");
  }, 30_000);
});
