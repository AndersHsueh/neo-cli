/**
 * issue #60 ACP 服务端验收 —— 覆盖 PRD（docs/acp-prd.md）§3 的 A1 / A2 / A3 与 B1 / B2 / B3 / C1 / C2。
 *
 * 覆盖范围（如实声明）：
 *  - A1 `neo acp` 入口存在且与 -p 互斥（含与 --output-format json 互斥）；
 *  - A2 `initialize` 协商 protocolVersion=1，返回 agentCapabilities / agentInfo / 空 authMethods，
 *       请求版本非 1 时仍回 1；
 *  - A3 握手期间 stdout 只有协议 NDJSON（无非 JSON 行、无 ANSI），诊断走 stderr；
 *  - B1 `session/new` 以绝对 cwd 建会话并返回 sessionId；相对路径 / 未知 session 的 prompt 有明确错误；
 *  - B2 同一进程第二次 `session/new` 被拒绝（单 session，PRD §2.6）；
 *  - B3 缺模型凭证时 `session/new` 返回 JSON-RPC 错误且不伪造 sessionId（PRD §2.5）；
 *  - C1 `session/prompt` 先发 agent_message_chunk 通知，再以 stopReason=end_turn 结束（PRD §2.8/§2.9）；
 *  - C2 ACP 会话是交互记忆（用户级+项目级），不是 -p 的仅项目级（PRD §2.12）。
 * 本文件**不覆盖** D1–E1（工具事件、diff、权限、cancel、help/README），那些由后续红态/绿态补齐。
 *
 * C2 的观察点（文件系统副作用，不 import 尚未存在的实现模块）：
 *  交互模式启动时会给用户级记忆建骨架（`ensureScopeLayout("user", …)`，src/memory/layout.ts:75）
 *  并写用户级环境快照（src/cli/sessionStart.ts:520-537）；`-p` 的 oneshot 口径先把
 *  `cfg.memory.scopeMode` 降成 "project"（src/cli/bootstrap.ts:550），这条路径根本不走。
 *  因此：把用户级库根指到沙箱（`memory.user_wiki_dir` + `NEO_USER_WIKI_DIR`）后，
 *  断言 `session/new` 成功 **且** 用户级目录被准备 = ACP 走的是交互记忆（both），不是仅项目级。
 *  不观察 stderr 里的提示词正文：stdout 归协议、stderr 归诊断，都不该为测试泄漏模型上下文。
 *
 * 形态：管道级假客户端 —— 真起 `bun src/index.ts acp` 子进程，stdin 写 NDJSON、
 * stdout 读 NDJSON，**不依赖真 Zed**、不触网、不读真实 settings.json / ~/.neo。
 * 范式沿用 tests/cli-json.test.ts / tests/cli-stream-json.test.ts
 * （mkdtempSync 沙箱 + writeSettings 最小假 settings + Bun.spawn）。
 * 禁止 mock.module（bun test 单进程共享模块表）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
 * base_url 默认指向 127.0.0.1:9（discard 端口，必然连不上）：A1–A3 只做入口与握手，
 * 任何一次真实模型请求都说明实现走错了路，应当失败而不是悄悄触网。
 * C1 例外：传入本地假 SSE 端点的 baseUrl（Bun.serve port 0，仍不出本机）。
 * `apiKey` 传 "" 模拟缺凭证（B3），不读真实配置。
 */
function writeSettings(dir: string, baseUrl = "http://127.0.0.1:9/v1", apiKey = "test"): void {
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
            base_url: baseUrl,
            api_key: apiKey,
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
function project(baseUrl?: string, apiKey?: string): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir, baseUrl, apiKey);
  return dir;
}

/**
 * 子进程环境：注入沙箱目录，并**显式删掉**真实 NEO_API_KEY 等覆盖项。
 * 否则开发机上的 NEO_API_KEY / NEO_BASE_URL 会盖掉沙箱 settings，测试就不再隔离。
 */
function childEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEO_SESSIONS_DIR: sessionsDir,
    NEO_MAILBOX_DIR: join(SANDBOX, "mailbox"),
    NEO_MEMORY_DIR: join(SANDBOX, "memory"),
    NEO_USER_WIKI_DIR: join(SANDBOX, "wiki"),
    NEO_MEMORY_JOURNAL_DIR: join(SANDBOX, "journal"),
    NEO_MEMORY_DISABLE: "1",
    ...overrides,
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
  envOverrides?: Record<string, string | undefined>,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(envOverrides),
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

    // acp --help / -h：元请求，打印既有帮助文本后退出 0，绝不启动服务端。
    // 判据是「没有 [acp] 服务端已就绪」—— 那行只在 runAcpServer() 里打，
    // 出现即说明 bootstrap 又抢在 --help 之前进了服务端。
    for (const flag of ["--help", "-h"]) {
      const help = await runUsage(dir, ["acp", flag]);
      expect(help.timedOut).toBe(false);
      expect(help.code).toBe(0);
      expect(help.out.includes("用法") || help.out.includes("neo v")).toBe(true);
      expect(help.err.includes("[acp] 服务端已就绪")).toBe(false);
      // stdout 是帮助文本，不是协议流：不得出现 NDJSON 响应。
      expect(help.out.trimStart().startsWith("{")).toBe(false);
    }

    // acp --version / -v：同样早退，打印版本行退出 0。
    for (const flag of ["--version", "-v"]) {
      const ver = await runUsage(dir, ["acp", flag]);
      expect(ver.timedOut).toBe(false);
      expect(ver.code).toBe(0);
      expect(ver.out).toContain("neo v");
      expect(ver.err.includes("[acp] 服务端已就绪")).toBe(false);
    }
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

/* ------------------------------------------------------------------ *
 * B/C 步共用的会话夹具
 * ------------------------------------------------------------------ */

/** ACP v1 `session/new` 请求（cwd 必填；mcpServers 按 schema 给空数组）。 */
function newSessionRequest(id: number, cwd: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "session/new", params: { cwd, mcpServers: [] } }) + "\n";
}

/** ACP v1 `session/prompt` 请求（prompt 为 text ContentBlock 数组）。 */
function promptRequest(id: number, sessionId: string, text: string): string {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text }] },
    }) + "\n"
  );
}

/** 取 JSON-RPC 错误的数值码（结构不对时返回 NaN，让断言直接失败而不是抛 TypeError）。 */
function errorCode(resp: JsonRpcMessage | undefined): number {
  const err = resp?.error as { code?: unknown } | undefined;
  return typeof err?.code === "number" ? err.code : Number.NaN;
}

/** 取 JSON-RPC 错误的人类可读 message。 */
function errorMessage(resp: JsonRpcMessage | undefined): string {
  const err = resp?.error as { message?: unknown } | undefined;
  return typeof err?.message === "string" ? err.message : "";
}

/** 取 `session/new` 成功结果里的 sessionId；没有就返回 null（红态下实现可能回 -32601）。 */
function sessionIdOf(resp: JsonRpcMessage | undefined): string | null {
  const result = resp?.result as { sessionId?: unknown } | undefined;
  return typeof result?.sessionId === "string" && result.sessionId !== "" ? result.sessionId : null;
}

/** 沙箱内的绝对工作目录（session/new 的 cwd 必须是已存在的绝对路径）。 */
function workspace(): string {
  const dir = join(SANDBOX, `ws${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ *
 * B1 session/new 以 cwd 为工作区
 * ------------------------------------------------------------------ */

describe("B1 session/new 以 cwd 为工作区", () => {
  test("B1 session/new 以 cwd 为工作区", async () => {
    const dir = project();
    const ws = workspace();
    const r = await runAcp(
      dir,
      ["acp"],
      initializeRequest(1, 1) + newSessionRequest(2, ws) + newSessionRequest(3, "relative/dir"),
    );
    expect(r.timedOut).toBe(false);

    const messages = parseNdjson(r.out);
    expect(findResponse(messages, 1)).toBeDefined();

    // 绝对路径 cwd → 成功，返回非空 sessionId 字符串（PRD §2.5）。
    const ok = findResponse(messages, 2);
    expect(ok).toBeDefined();
    expect(ok?.error).toBeUndefined();
    const sessionId = sessionIdOf(ok);
    expect(typeof sessionId).toBe("string");
    expect((sessionId ?? "").length).toBeGreaterThan(0);

    // 相对路径 cwd → 参数非法（-32602），不得返回 sessionId。
    const rel = findResponse(messages, 3);
    expect(rel).toBeDefined();
    expect(rel?.result).toBeUndefined();
    expect(errorCode(rel)).toBe(-32602);
    expect(errorMessage(rel).length).toBeGreaterThan(0);

    // 未知 sessionId 的 session/prompt → 资源不存在（-32002），data.sessionId 回带请求里的 id。
    const unknown = await runAcp(
      dir,
      ["acp"],
      initializeRequest(1, 1) + promptRequest(2, "no-such-session", "hi"),
    );
    expect(unknown.timedOut).toBe(false);
    const unknownMessages = parseNdjson(unknown.out);
    const missing = findResponse(unknownMessages, 2);
    expect(missing).toBeDefined();
    expect(missing?.result).toBeUndefined();
    expect(errorCode(missing)).toBe(-32002);
    const data = (missing?.error as { data?: unknown } | undefined)?.data as
      | { sessionId?: unknown }
      | undefined;
    expect(data?.sessionId).toBe("no-such-session");
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * B2 单 session
 * ------------------------------------------------------------------ */

describe("B2 第二个 session/new 被拒绝", () => {
  test("B2 第二个 session/new 被拒绝", async () => {
    const dir = project();
    const first = workspace();
    const second = workspace();
    const r = await runAcp(
      dir,
      ["acp"],
      initializeRequest(1, 1) + newSessionRequest(2, first) + newSessionRequest(3, second),
    );
    expect(r.timedOut).toBe(false);

    const messages = parseNdjson(r.out);
    const firstResp = findResponse(messages, 2);
    expect(firstResp).toBeDefined();
    expect(firstResp?.error).toBeUndefined();
    const firstId = sessionIdOf(firstResp);
    expect(typeof firstId).toBe("string");

    // 第二次必须明确报错（PRD §2.6）：不静默复用、不新建第二个会话。
    const secondResp = findResponse(messages, 3);
    expect(secondResp).toBeDefined();
    expect(secondResp?.result).toBeUndefined();
    expect(Number.isFinite(errorCode(secondResp))).toBe(true);
    const msg = errorMessage(secondResp);
    expect(msg).toMatch(/只支持一个 session|only one session|one session per process/i);
    // 不得返回与第一次相同的成功 sessionId。
    expect(sessionIdOf(secondResp)).not.toBe(firstId);
    expect(sessionIdOf(secondResp)).toBeNull();
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * B3 缺凭证
 * ------------------------------------------------------------------ */

describe("B3 缺凭证返回清楚错误", () => {
  test("B3 缺凭证返回清楚错误", async () => {
    // api_key 为空字符串：不读真实 settings，也不依赖开发机上的 NEO_API_KEY（childEnv 已删）。
    const dir = project(undefined, "");
    const ws = workspace();
    const r = await runAcp(dir, ["acp"], initializeRequest(1, 1) + newSessionRequest(2, ws));
    expect(r.timedOut).toBe(false);

    const messages = parseNdjson(r.out);
    const resp = findResponse(messages, 2);
    expect(resp).toBeDefined();
    // 必须是 JSON-RPC error，且不得伪造 sessionId（不静默降级）。
    expect(resp?.result).toBeUndefined();
    expect(Number.isFinite(errorCode(resp))).toBe(true);
    expect(sessionIdOf(resp)).toBeNull();
    const msg = errorMessage(resp);
    expect(msg).toMatch(/api_key/i);
    expect(msg).toMatch(/settings\.json/);
    expect(msg).toMatch(/环境变量|NEO_API_KEY/);
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * C1 prompt 文本流与 end_turn
 * ------------------------------------------------------------------ */

/**
 * 交互式跑一次 ACP 会话：先握手 + 建会话拿到 sessionId，再发 prompt。
 *
 * 与 runAcp 的区别：prompt 的 sessionId 只有跑起来才知道，所以不能一次性喂完 stdin。
 * 这里按行读 stdout，等到 session/new 的响应后补发 prompt，最后关 stdin 等退出。
 * 超时一律杀进程（killSpawnedBun），红态下不会挂死。
 */
async function runSessionThenPrompt(
  cwd: string,
  promptText: string,
  timeoutMs = 15_000,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", INDEX, "acp"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });
  const decoder = new TextDecoder();
  let out = "";
  let err = "";
  let sentPrompt = false;
  let timedOut = false;

  const errReader = (async () => {
    for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
      err += decoder.decode(chunk, { stream: true });
    }
  })();

  const timer = setTimeout(() => {
    timedOut = true;
    killSpawnedBun(proc);
  }, timeoutMs);

  try {
    proc.stdin.write(initializeRequest(1, 1));
    proc.stdin.write(newSessionRequest(2, cwd));
    proc.stdin.flush();
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      out += decoder.decode(chunk, { stream: true });
      if (sentPrompt) continue;
      // 逐行找 session/new 的响应（stdout 只归协议，解析失败就继续等）。
      for (const line of out.split("\n")) {
        if (!line.startsWith("{")) continue;
        let parsed: JsonRpcMessage;
        try {
          parsed = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        const sessionId = parsed.id === 2 ? sessionIdOf(parsed) : null;
        if (sessionId !== null) {
          sentPrompt = true;
          proc.stdin.write(promptRequest(3, sessionId, promptText));
          await proc.stdin.end();
        }
      }
    }
    await errReader;
    const code = await proc.exited;
    return { out, err, code, timedOut };
  } finally {
    clearTimeout(timer);
    if (!sentPrompt) {
      try {
        await proc.stdin.end();
      } catch {
        /* 已退出 */
      }
    }
  }
}

describe("C1 prompt 文本流与 end_turn", () => {
  test("C1 prompt 文本流与 end_turn", async () => {
    // 本地假 OpenAI SSE 端点（照 tests/cli-json.test.ts）：只回一小段文本，不出本机。
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
      "data: [DONE]\n\n";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/models")) {
          return Response.json({ object: "list", data: [{ id: "fake-model" }] });
        }
        if (url.pathname.endsWith("/chat/completions")) {
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const dir = project(`http://127.0.0.1:${server.port}/v1`);
      const r = await runSessionThenPrompt(dir, "hi");
      expect(r.timedOut).toBe(false);

      const messages = parseNdjson(r.out);
      expect(sessionIdOf(findResponse(messages, 2))).not.toBeNull();

      // 先有 agent_message_chunk 通知，内容含假端点那段文本（PRD §2.9）。
      const chunk = messages.find(
        (m) =>
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update?.sessionUpdate ===
            "agent_message_chunk",
      );
      expect(chunk).toBeDefined();
      const update = (chunk?.params as { update?: { content?: { type?: unknown; text?: unknown } } }).update;
      expect(update?.content?.type).toBe("text");
      expect(String(update?.content?.text ?? "")).toContain("hi");

      // 再以 stopReason=end_turn 结束（PRD §2.8），且响应在通知之后。
      const promptResp = findResponse(messages, 3);
      expect(promptResp).toBeDefined();
      expect(promptResp?.error).toBeUndefined();
      expect((promptResp?.result as { stopReason?: unknown } | undefined)?.stopReason).toBe("end_turn");
      expect(messages.indexOf(chunk as JsonRpcMessage)).toBeLessThan(messages.indexOf(promptResp as JsonRpcMessage));
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * C2 记忆 scopeMode 为 both
 * ------------------------------------------------------------------ */

/**
 * 只给 C2 用的 settings：memory.enabled=true，且把**用户级 wiki 目录**显式指到沙箱。
 *
 * 配置键沿用 src/config.ts:723 `resolveMemoryConfig` 的既有口径：
 *  - `memory.enabled`（settings.json）；
 *  - `memory.user_wiki_dir`（settings.json，被 NEO_USER_WIKI_DIR 覆盖）。
 * 本用例**同时**写 settings 与 env（childEnv 已设 NEO_USER_WIKI_DIR），
 * 这样即使实现改了 env 优先级，观察点仍然落在同一个沙箱路径上。
 * 不写 `memory.scopeMode`：那是运行时由组合根按交互/单次模式决定的，不该由测试替它拍板。
 */
function writeMemorySettings(dir: string, userWikiDir: string): void {
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
        memory: { enabled: true, user_wiki_dir: userWikiDir },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("C2 记忆 scopeMode 为 both", () => {
  test("C2 记忆 scopeMode 为 both", async () => {
    // ---- 沙箱布局（全部在 SANDBOX 内，绝不写仓库里的 .neo/wiki）----
    // 用户级库根：<SANDBOX>/c2-user-wiki，主题页目录是它下面的 wiki/（src/wiki/paths.ts:69）。
    const userWikiRoot = join(SANDBOX, "c2-user-wiki");
    const userPagesDir = join(userWikiRoot, "wiki");
    // 项目级库根：<cwd>/.neo/wiki（src/memory/layout.ts:25 projectWikiRoot）。
    const dir = join(SANDBOX, `c2p${seq++}`);
    mkdirSync(dir, { recursive: true });
    writeMemorySettings(dir, userWikiRoot);
    const projectPagesDir = join(dir, ".neo", "wiki", "wiki");
    mkdirSync(projectPagesDir, { recursive: true });
    writeFileSync(
      join(projectPagesDir, "INDEX.md"),
      "# 项目记忆 — 索引\n\n## 主题\n\n- [[C2-项目锚点]]\n",
      "utf8",
    );
    // 用户级库**故意先不建**：它是否被创建/写入，正是本用例要观察的副作用。

    const ws = workspace();
    const r = await runAcp(dir, ["acp"], initializeRequest(1, 1) + newSessionRequest(2, ws), {
      // 其它用例默认关掉记忆以免写盘；本用例要观察用户级 layout，必须打开。
      NEO_MEMORY_DISABLE: undefined,
      NEO_USER_WIKI_DIR: userWikiRoot,
    });
    expect(r.timedOut).toBe(false);
    const messages = parseNdjson(r.out);
    expect(findResponse(messages, 1)).toBeDefined();

    // ---- 观察点 1：session 真的建起来了 ----
    // 红态下这里就是第一个失败点（当前 src/acp/server.ts 对 session/* 回 -32601）。
    expect(sessionIdOf(findResponse(messages, 2))).not.toBeNull();

    // ---- 观察点 2：用户级记忆目录被准备/写入 ----
    // 交互模式启动时会 ensureScopeLayout("user", …) 建骨架（src/memory/layout.ts:75：
    // wiki/ + raw/ + outputs/ + INDEX.md + log.md + AGENTS.md），并写用户级环境快照
    // （src/cli/sessionStart.ts:520-537 → syncEnvPage，页名 src/env/wiki.ts:30）。
    // -p 的 oneshot 口径把 scopeMode 降成 "project"（src/cli/bootstrap.ts:550），
    // 这条路径根本不会走到，用户级目录保持不存在。
    expect(existsSync(userPagesDir)).toBe(true);
    expect(existsSync(join(userPagesDir, "INDEX.md"))).toBe(true);
    expect(existsSync(join(userPagesDir, "log.md"))).toBe(true);

    // ---- 观察点 3：项目级记忆也在（both，而不是只剩用户级）----
    expect(existsSync(join(projectPagesDir, "INDEX.md"))).toBe(true);

    // ---- 明确不要求的事 ----
    // 不要求 stderr 含系统提示词正文或 wiki 索引：「用户记忆」「C2-用户锚点」这类内容
    // 属于模型上下文，不该为了测试泄漏到诊断通道（stdout 归协议，stderr 是诊断）。
    // 若 scopeMode 被误设成 "project"，上面的 existsSync(userPagesDir) 会失败；
    // 若会话根本没建起来，第一个断言（sessionId）会失败 —— 两种失败都指向真实缺陷。
  }, 30_000);
});
