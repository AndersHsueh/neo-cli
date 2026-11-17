/**
 * issue #60 ACP 服务端验收 —— 只覆盖 PRD（docs/acp-prd.md）§3 的 A1 / A2 / A3。
 *
 * 覆盖范围（如实声明）：
 *  - A1 `neo acp` 入口存在且与 -p 互斥（含与 --output-format json 互斥）；
 *  - A2 `initialize` 协商 protocolVersion=1，返回 agentCapabilities / agentInfo / 空 authMethods，
 *       请求版本非 1 时仍回 1；
 *  - A3 握手期间 stdout 只有协议 NDJSON（无非 JSON 行、无 ANSI），诊断走 stderr。
 * 本文件**不覆盖** B1–E1（session/new、单 session、缺凭证、prompt 流、记忆作用域、
 * 工具事件、diff、权限、cancel、help/README），那些由后续红态/绿态补齐。
 *
 * 形态：管道级假客户端 —— 真起 `bun src/index.ts acp` 子进程，stdin 写 NDJSON、
 * stdout 读 NDJSON，**不依赖真 Zed**、不触网、不读真实 settings.json / ~/.neo。
 * 范式沿用 tests/cli-json.test.ts / tests/cli-stream-json.test.ts
 * （mkdtempSync 沙箱 + writeSettings 最小假 settings + Bun.spawn）。
 * 禁止 mock.module（bun test 单进程共享模块表）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-acp-protocol-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;

/** 每个 spawn 的硬超时：红态下（没有 acp 入口）不能让测试挂死。 */
const SPAWN_TIMEOUT_MS = 8_000;

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/**
 * 写入最小 settings.json（不读用户真实配置）。
 *
 * base_url 指向 127.0.0.1:9（discard 端口，必然连不上）：A1–A3 只做入口与握手，
 * 任何一次真实模型请求都说明实现走错了路，应当失败而不是悄悄触网。
 */
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
            base_url: "http://127.0.0.1:9/v1",
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
        retry: {
          max_attempts: 1,
          base_delay_ms: 1,
          connect_timeout_ms: 1_000,
          stream_idle_timeout_ms: 1_000,
        },
        memory: { enabled: false },
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** 每个用例一个独立工作目录（settings.json 只从 cwd 读，不碰真实 home）。 */
function project(): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir);
  return dir;
}

/**
 * 子进程环境：注入沙箱目录，并**显式删掉**真实 NEO_API_KEY 等覆盖项。
 * 否则开发机上的 NEO_API_KEY / NEO_BASE_URL 会盖掉沙箱 settings，测试就不再隔离。
 */
function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEO_SESSIONS_DIR: sessionsDir,
    NEO_MAILBOX_DIR: join(SANDBOX, "mailbox"),
    NEO_MEMORY_DIR: join(SANDBOX, "memory"),
    NEO_USER_WIKI_DIR: join(SANDBOX, "wiki"),
    NEO_MEMORY_JOURNAL_DIR: join(SANDBOX, "journal"),
    NEO_MEMORY_DISABLE: "1",
  };
  for (const key of ["NEO_API_KEY", "NEO_BASE_URL", "NEO_PROVIDER", "NEO_MODEL", "NEO_TIER"]) {
    delete env[key];
  }
  return env;
}

/**
 * Bun.spawn(["bun", script]) 返回的 pid 是启动器，不是跑脚本的那个进程。
 * 超时清理必须同时打到启动器与它的直接子进程，否则真脚本会活下来拖住测试进程
 * （先例：tests/cli-json.test.ts 的 signalSpawnedBun）。
 */
function killSpawnedBun(proc: Bun.Subprocess): void {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  const text = new TextDecoder().decode(out.stdout);
  const kids: number[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (Number.isFinite(pid) && ppid === proc.pid) kids.push(pid);
  }
  for (const pid of [...kids, proc.pid]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}

interface RunResult {
  out: string;
  err: string;
  code: number;
  /** 超时被杀（不是自己退出的）—— 断言里要能区分「红」与「挂死」。 */
  timedOut: boolean;
}

/** 起一个 acp 子进程，喂完 stdin 后等它退出；超时则杀进程并标记 timedOut。 */
async function runAcp(
  cwd: string,
  args: string[],
  stdinText: string,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });
  try {
    proc.stdin.write(stdinText);
    await proc.stdin.end();
  } catch {
    /* 子进程可能已退出（红态：acp 不是合法入口时立刻 exit 2） */
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killSpawnedBun(proc);
  }, SPAWN_TIMEOUT_MS);

  try {
    const [out, err, code] = (await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])) as [string, string, number];
    return { out, err, code, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** 不带 stdin 的用法错误用例：stdin 直接 ignore，避免子进程等输入。 */
async function runUsage(cwd: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killSpawnedBun(proc);
  }, SPAWN_TIMEOUT_MS);
  try {
    const [out, err, code] = (await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])) as [string, string, number];
    return { out, err, code, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * JSON-RPC 夹具
 * ------------------------------------------------------------------ */

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

/** ACP v1 `initialize` 请求（字段名以官方 schema 为准，不发明字段）。 */
function initializeRequest(id: number, protocolVersion: number): string {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "neo-acp-test-client", title: "neo acp test client", version: "0.0.0" },
      },
    }) + "\n"
  );
}

/**
 * 逐行解析 stdout：每一行都必须是 JSON-RPC 对象，不允许空行/垃圾行/ANSI。
 * 返回解析后的消息（空 stdout 返回空数组，由调用方断言数量）。
 */
function parseNdjson(out: string): JsonRpcMessage[] {
  expect(out.includes("\x1b")).toBe(false);
  const lines = out.split("\n").filter((line) => line !== "");
  return lines.map((line) => {
    expect(line.trim()).toBe(line);
    expect(line.startsWith("{")).toBe(true);
    expect(line.endsWith("}")).toBe(true);
    const parsed = JSON.parse(line) as unknown;
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
    return parsed as JsonRpcMessage;
  });
}

/** 找到对应 id 的 JSON-RPC 响应。 */
function findResponse(messages: JsonRpcMessage[], id: number): JsonRpcMessage | undefined {
  return messages.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
}

/* ------------------------------------------------------------------ *
 * A1 入口与互斥
 * ------------------------------------------------------------------ */

describe("A1 neo acp 入口存在且与 -p 互斥", () => {
  test("A1 neo acp 入口存在且与 -p 互斥", async () => {
    const dir = project();

    // acp + -p：用法错误，退出码 2，诊断在 stderr，stdout 不得有模型输出。
    const withPrint = await runUsage(dir, ["acp", "-p", "hello", "-y"]);
    expect(withPrint.timedOut).toBe(false);
    expect(withPrint.code).toBe(2);
    expect(withPrint.err.trim().length).toBeGreaterThan(0);
    expect(withPrint.out).toBe("");

    // acp + --output-format json：同样是用法错误（stdout 只归协议，不归 -p 的 JSON）。
    const withJson = await runUsage(dir, ["acp", "--output-format", "json"]);
    expect(withJson.timedOut).toBe(false);
    expect(withJson.code).toBe(2);
    expect(withJson.err.trim().length).toBeGreaterThan(0);
    expect(withJson.out).toBe("");
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * A2 initialize 协商
 * ------------------------------------------------------------------ */

describe("A2 initialize 协商 v1 与能力", () => {
  test("A2 initialize 协商 v1 与能力", async () => {
    const dir = project();
    const r = await runAcp(dir, ["acp"], initializeRequest(1, 1));
    expect(r.timedOut).toBe(false);

    const messages = parseNdjson(r.out);
    const resp = findResponse(messages, 1);
    expect(resp).toBeDefined();
    expect(resp?.jsonrpc).toBe("2.0");
    expect(resp?.error).toBeUndefined();

    const result = resp?.result as Record<string, unknown>;
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();

    // 协议版本：请求 1 → 回 1。
    expect(result["protocolVersion"]).toBe(1);

    // agentCapabilities：首期只广告真做的能力，loadSession 必须为 false。
    const caps = result["agentCapabilities"] as Record<string, unknown>;
    expect(typeof caps).toBe("object");
    expect(caps).not.toBeNull();
    expect(caps["loadSession"]).toBe(false);

    // agentInfo：name 为 neo（title/version 由实现按 src/cli/version.ts 填）。
    const info = result["agentInfo"] as Record<string, unknown>;
    expect(typeof info).toBe("object");
    expect(info).not.toBeNull();
    expect(info["name"]).toBe("neo");

    // authMethods：首期空数组（鉴权沿用 settings.json，不新做登录流）。
    expect(Array.isArray(result["authMethods"])).toBe(true);
    expect(result["authMethods"]).toEqual([]);
  }, 30_000);

  test("A2 请求版本非 1 时仍回 1（不报错，由客户端决定是否断开）", async () => {
    const dir = project();
    const r = await runAcp(dir, ["acp"], initializeRequest(2, 2));
    expect(r.timedOut).toBe(false);

    const messages = parseNdjson(r.out);
    const resp = findResponse(messages, 2);
    expect(resp).toBeDefined();
    expect(resp?.error).toBeUndefined();
    const result = resp?.result as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe(1);
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * A3 stdout 只归协议
 * ------------------------------------------------------------------ */

describe("A3 stdout 只有协议 NDJSON", () => {
  test("A3 stdout 只有协议 NDJSON", async () => {
    const dir = project();
    const r = await runAcp(dir, ["acp"], initializeRequest(7, 1));
    expect(r.timedOut).toBe(false);

    // 每一行都必须是可解析的 JSON-RPC 对象（parseNdjson 内部逐行断言无 ANSI / 无垃圾行）。
    const messages = parseNdjson(r.out);
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) {
      expect(m.jsonrpc).toBe("2.0");
      // 握手期间只允许「响应」或「服务端通知」（method 存在且无 id）。
      const isResponse = m.id !== undefined && (m.result !== undefined || m.error !== undefined);
      const isNotification = m.method !== undefined && m.id === undefined;
      expect(isResponse || isNotification).toBe(true);
    }

    // 握手响应必须在 stdout 里出现（协议通道真的通着，不是空 stdout 蒙混过关）。
    expect(findResponse(messages, 7)).toBeDefined();

    // 诊断/日志若有，只能出现在 stderr —— stdout 里不允许出现 banner 或提示文本。
    expect(r.out.includes("neo v")).toBe(false);
    expect(r.out.includes("✖")).toBe(false);
  }, 30_000);
});
