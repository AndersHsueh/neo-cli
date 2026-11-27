/**
 * issue #94：write_file 整文件覆盖前检测中间改动。
 *
 * 锁定已签切面（Jim 已签交互）：只拦 write_file；仅本会话完整读取或完整
 * 写入后才启用检查；拒绝发生在路径解析之后、gateTool 之前；给模型 / 给用户
 * 的文案与路径口径（abs）字面一致。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Agent, type AgentIO, type PermissionMode } from "../src/agent.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import type { Config } from "../src/config.ts";
import { MAX_READ } from "../src/tools/fsPaths.ts";
import { dispatch } from "../src/tools/index.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const ROOT = mkdtempSync(join(tmpdir(), "neo-94-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let seq = 0;

function staleModelReason(path: string): string {
  return `write_file 已拒绝：文件 ${path} 在上次完整读取或写入之后已被修改，未改动磁盘。请先用 read_file 完整读取该文件，再基于最新内容重试。`;
}

function staleTooLargeReason(path: string): string {
  return `write_file 已拒绝：文件 ${path} 在上次完整读取或写入之后已被修改，未改动磁盘。该文件超过读取上限，无法完整读取。`;
}

function staleUserNotice(path: string): string {
  return `已拒绝覆盖 ${path}：该文件在 agent 读过或写过之后又被改过，磁盘未改动。请让它先重读再写。`;
}

function silentIO(notices: string[]): AgentIO {
  return {
    line(): void {},
    blank(): void {},
    info(msg: string): void {
      notices.push(msg);
    },
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

interface Harness {
  cwd: string;
  agent: Agent;
  ctx: ToolCtx;
  notices: string[];
  approvals: number;
  beforeWrites: number;
  postCalls: number;
  store: CheckpointStore;
  abs(rel: string): string;
}

function harness(
  mode: PermissionMode = "ask",
  over: { isSubagent?: boolean } = {},
): Harness {
  const cwd = join(ROOT, `s${seq++}`);
  mkdirSync(cwd, { recursive: true });
  const notices: string[] = [];
  const store = new CheckpointStore({ cwd, sessionId: `sess-${seq}` });
  const agent = new Agent({
    cfg: { cwd, toolOutputLimit: 30_000 } as Config,
    console: silentIO(notices),
    mode,
    systemPrompt: "sys",
    checkpoint: store,
    approve: async () => true,
    ...(over.isSubagent ? { isSubagent: true } : {}),
  });
  const raw = agent.makeCtx(new AbortController().signal);
  const h: Harness = {
    cwd,
    agent,
    notices,
    approvals: 0,
    beforeWrites: 0,
    postCalls: 0,
    store,
    abs: (rel) => resolve(cwd, rel),
    ctx: raw,
  };
  h.ctx = {
    ...raw,
    approve: async (tool, detail, signal) => {
      h.approvals += 1;
      return raw.approve(tool, detail, signal);
    },
    checkpoint: {
      beforeWrite(path, op) {
        h.beforeWrites += 1;
        return store.beforeWrite(path, op);
      },
    },
    postToolUse: async (tool, args, result) => {
      h.postCalls += 1;
      return raw.postToolUse ? raw.postToolUse(tool, args, result) : null;
    },
  };
  return h;
}

async function readPath(
  h: Harness,
  rel: string,
  args: { offset?: number; limit?: number } = {},
) {
  return dispatch(
    "read_file",
    JSON.stringify({ path: rel, ...args }),
    h.ctx,
  );
}

async function writePath(h: Harness, rel: string, content: string) {
  return dispatch("write_file", JSON.stringify({ path: rel, content }), h.ctx);
}

function expectRejected(
  r: { ok: boolean; output: string; executed?: boolean },
  h: Harness,
  path: string,
  kind: "retry" | "too-large",
  userContent: string,
): void {
  const reason = kind === "too-large" ? staleTooLargeReason(path) : staleModelReason(path);
  expect(r.ok).toBe(false);
  expect(r.executed).toBe(false);
  expect(r.output).toBe(`错误: ${reason}`);
  if (kind === "too-large") {
    expect(r.output).not.toContain("请先完整读取再重试");
    expect(r.output).not.toContain("请先用 read_file 完整读取该文件，再基于最新内容重试");
  }
  expect(h.notices).toEqual([staleUserNotice(path)]);
  expect(h.approvals).toBe(0);
  expect(h.beforeWrites).toBe(0);
  expect(h.postCalls).toBe(0);
  expect(h.store.list()).toHaveLength(0);
  expect(readFileSync(path, "utf8")).toBe(userContent);
}

describe("#94 write_file 中间改动检测", () => {
  test("完整读取后磁盘被改：write_file 被拒绝，磁盘仍是用户版本，不产生成功写入检查点", async () => {
    const h = harness();
    const rel = "a.txt";
    const path = h.abs(rel);
    writeFileSync(path, "agent-view\n", "utf8");
    const read = await readPath(h, rel);
    expect(read.ok).toBe(true);
    expect(read.output).not.toContain("还有");
    writeFileSync(path, "user-edit\n", "utf8");
    const r = await writePath(h, rel, "stale-overwrite\n");
    expectRejected(r, h, path, "retry", "user-edit\n");
  });

  test("完整读取后磁盘未改：write_file 成功，内容为新全文", async () => {
    const h = harness();
    const rel = "b.txt";
    const path = h.abs(rel);
    writeFileSync(path, "same\n", "utf8");
    expect((await readPath(h, rel)).ok).toBe(true);
    const r = await writePath(h, rel, "new-full\n");
    expect(r.ok).toBe(true);
    expect(r.executed).not.toBe(false);
    expect(readFileSync(path, "utf8")).toBe("new-full\n");
    expect(h.approvals).toBe(1);
    expect(h.beforeWrites).toBe(1);
    expect(h.store.list()).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });

  test("只做部分读取（offset=1, limit 小于总行数）后即使用户改盘，write_file 仍成功", async () => {
    const h = harness();
    const rel = "partial-limit.txt";
    const path = h.abs(rel);
    writeFileSync(path, "l1\nl2\nl3\nl4\n", "utf8");
    const read = await readPath(h, rel, { offset: 1, limit: 2 });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("还有");
    writeFileSync(path, "user-changed\n", "utf8");
    const r = await writePath(h, rel, "agent-full\n");
    expect(r.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("agent-full\n");
    expect(h.notices).toEqual([]);
  });

  test("只做部分读取（offset>1）后即使用户改盘，write_file 仍成功", async () => {
    const h = harness();
    const rel = "partial-offset.txt";
    const path = h.abs(rel);
    writeFileSync(path, "l1\nl2\nl3\n", "utf8");
    const read = await readPath(h, rel, { offset: 2, limit: 10 });
    expect(read.ok).toBe(true);
    writeFileSync(path, "user-changed\n", "utf8");
    const r = await writePath(h, rel, "agent-full\n");
    expect(r.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("agent-full\n");
    expect(h.notices).toEqual([]);
  });

  test("默认 limit=2000 读取超过 2000 行的文件，不视为完整读", async () => {
    const h = harness();
    const rel = "long.txt";
    const path = h.abs(rel);
    const lines = Array.from({ length: 2001 }, (_, i) => `L${i + 1}`);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const read = await readPath(h, rel);
    expect(read.ok).toBe(true);
    expect(read.output).toContain("还有");
    writeFileSync(path, "user-after-default-read\n", "utf8");
    const r = await writePath(h, rel, "overwrite\n");
    expect(r.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("overwrite\n");
    expect(h.notices).toEqual([]);
  });

  test("完整写入成功后用户再改盘，下一次 write_file 被拒绝", async () => {
    const h = harness();
    const rel = "created.txt";
    const path = h.abs(rel);
    const first = await writePath(h, rel, "written-by-agent\n");
    expect(first.ok).toBe(true);
    expect(h.store.list()).toHaveLength(1);
    const approvalsAfterWrite = h.approvals;
    const beforesAfterWrite = h.beforeWrites;
    writeFileSync(path, "user-after-write\n", "utf8");
    const r = await writePath(h, rel, "second-stale\n");
    expect(r.ok).toBe(false);
    expect(r.executed).toBe(false);
    expect(r.output).toBe(`错误: ${staleModelReason(path)}`);
    expect(h.notices).toEqual([staleUserNotice(path)]);
    expect(h.approvals).toBe(approvalsAfterWrite);
    expect(h.beforeWrites).toBe(beforesAfterWrite);
    expect(h.store.list()).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("user-after-write\n");
  });

  test("拒绝发生在审批之前：approve 与 beforeWrite 都不被调用", async () => {
    const h = harness("ask");
    const rel = "before-gate.txt";
    const path = h.abs(rel);
    writeFileSync(path, "v1\n", "utf8");
    expect((await readPath(h, rel)).ok).toBe(true);
    writeFileSync(path, "v2\n", "utf8");
    const r = await writePath(h, rel, "v3\n");
    expectRejected(r, h, path, "retry", "v2\n");
  });

  test("auto-edit 下过期文件仍然被拒绝", async () => {
    const h = harness("auto-edit");
    const rel = "auto-edit.txt";
    const path = h.abs(rel);
    writeFileSync(path, "orig\n", "utf8");
    expect((await readPath(h, rel)).ok).toBe(true);
    writeFileSync(path, "changed\n", "utf8");
    const r = await writePath(h, rel, "stale\n");
    expectRejected(r, h, path, "retry", "changed\n");
  });

  test("auto-all 下过期文件仍然被拒绝", async () => {
    const h = harness("auto-all");
    const rel = "auto-all.txt";
    const path = h.abs(rel);
    writeFileSync(path, "orig\n", "utf8");
    expect((await readPath(h, rel)).ok).toBe(true);
    writeFileSync(path, "changed\n", "utf8");
    const r = await writePath(h, rel, "stale\n");
    expectRejected(r, h, path, "retry", "changed\n");
  });

  test("部分读取不会清除或刷新已启用的指纹", async () => {
    const h = harness();
    const rel = "keep-fingerprint.txt";
    const path = h.abs(rel);
    writeFileSync(path, "l1\nl2\nl3\nl4\n", "utf8");
    expect((await readPath(h, rel)).ok).toBe(true);
    const mid = await readPath(h, rel, { offset: 2, limit: 1 });
    expect(mid.ok).toBe(true);
    expect(mid.output).toContain("l2");
    writeFileSync(path, "changed-after-partial\n", "utf8");
    const r = await writePath(h, rel, "stale\n");
    expectRejected(r, h, path, "retry", "changed-after-partial\n");
  });

  test("完整读取后部分读不刷新指纹，磁盘未改时写入仍成功", async () => {
    const h = harness();
    const rel = "partial-no-refresh.txt";
    const path = h.abs(rel);
    writeFileSync(path, "l1\nl2\nl3\n", "utf8");
    expect((await readPath(h, rel)).ok).toBe(true);
    expect((await readPath(h, rel, { offset: 1, limit: 1 })).ok).toBe(true);
    const r = await writePath(h, rel, "still-fresh\n");
    expect(r.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("still-fresh\n");
    expect(h.notices).toEqual([]);
  });

  test("完整写入后文件超过 MAX_READ 且哈希不同：用上限文案，不再要求完整重读", async () => {
    const h = harness();
    const rel = "huge.txt";
    const path = h.abs(rel);
    const first = await writePath(h, rel, "small\n");
    expect(first.ok).toBe(true);
    h.notices.length = 0;
    const approvalsAfterWrite = h.approvals;
    const beforesAfterWrite = h.beforeWrites;
    writeFileSync(path, "H".repeat(MAX_READ + 1), "utf8");
    const r = await writePath(h, rel, "try-overwrite\n");
    expect(r.ok).toBe(false);
    expect(r.executed).toBe(false);
    expect(r.output).toBe(`错误: ${staleTooLargeReason(path)}`);
    expect(r.output).not.toContain("请先完整读取再重试");
    expect(r.output).not.toContain("请先用 read_file 完整读取该文件，再基于最新内容重试");
    expect(h.notices).toEqual([staleUserNotice(path)]);
    expect(h.approvals).toBe(approvalsAfterWrite);
    expect(h.beforeWrites).toBe(beforesAfterWrite);
    expect(h.store.list()).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("H".repeat(MAX_READ + 1));
  });

  test("把 limit/offset 覆盖到全文的超长文件视为完整读，改盘后写入被拒绝", async () => {
    const h = harness();
    const rel = "full-long.txt";
    const path = h.abs(rel);
    const lines = Array.from({ length: 2001 }, (_, i) => `L${i + 1}`);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const read = await readPath(h, rel, { offset: 1, limit: 3000 });
    expect(read.ok).toBe(true);
    expect(read.output).not.toContain("还有");
    writeFileSync(path, "user-on-full-long\n", "utf8");
    const r = await writePath(h, rel, "stale\n");
    expectRejected(r, h, path, "retry", "user-on-full-long\n");
  });

  test("恰好 2000 行用默认 limit 是完整读，改盘后写入被拒绝", async () => {
    const h = harness();
    const rel = "exact-2000.txt";
    const path = h.abs(rel);
    const lines = Array.from({ length: 2000 }, (_, i) => `L${i + 1}`);
    writeFileSync(path, lines.join("\n"), "utf8");
    const read = await readPath(h, rel);
    expect(read.ok).toBe(true);
    expect(read.output).not.toContain("还有");
    writeFileSync(path, "user-2000\n", "utf8");
    const r = await writePath(h, rel, "stale\n");
    expectRejected(r, h, path, "retry", "user-2000\n");
  });

  test("相对路径与绝对路径走同一 abs 口径，拒绝文案里是绝对路径", async () => {
    const h = harness();
    const rel = "rel.txt";
    const path = h.abs(rel);
    writeFileSync(path, "v1\n", "utf8");
    expect((await readPath(h, rel)).ok).toBe(true);
    writeFileSync(path, "v2\n", "utf8");
    const r = await dispatch(
      "write_file",
      JSON.stringify({ path, content: "v3\n" }),
      h.ctx,
    );
    expectRejected(r, h, path, "retry", "v2\n");
  });

  test("子代理是独立 Agent，不继承父会话指纹", async () => {
    const parent = harness();
    const child = harness("ask", { isSubagent: true });
    const rel = "shared.txt";
    const parentPath = parent.abs(rel);
    const childPath = child.abs(rel);
    writeFileSync(parentPath, "orig\n", "utf8");
    writeFileSync(childPath, "orig\n", "utf8");
    expect((await readPath(parent, rel)).ok).toBe(true);
    writeFileSync(parentPath, "changed\n", "utf8");
    writeFileSync(childPath, "changed\n", "utf8");
    const childWrite = await writePath(child, rel, "child-overwrite\n");
    expect(childWrite.ok).toBe(true);
    expect(readFileSync(childPath, "utf8")).toBe("child-overwrite\n");
    const parentWrite = await writePath(parent, rel, "parent-stale\n");
    expectRejected(parentWrite, parent, parentPath, "retry", "changed\n");
  });

  test("未读未写过的文件即使用户改过，检查未启用，write_file 成功", async () => {
    const h = harness();
    const rel = "untouched.txt";
    const path = h.abs(rel);
    writeFileSync(path, "user\n", "utf8");
    const r = await writePath(h, rel, "agent\n");
    expect(r.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("agent\n");
    expect(h.notices).toEqual([]);
  });

  test("edit_file 不被本单拦截", async () => {
    const h = harness();
    const rel = "edit.txt";
    const path = h.abs(rel);
    writeFileSync(path, "alpha\n", "utf8");
    expect((await readPath(h, rel)).ok).toBe(true);
    writeFileSync(path, "alpha-user\n", "utf8");
    const r = await dispatch(
      "edit_file",
      JSON.stringify({ path: rel, old_string: "alpha-user", new_string: "beta" }),
      h.ctx,
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("beta\n");
  });

  test("makeCtx 为当前 Agent 注入 fileFreshness，不同 Agent 各用各的表", () => {
    const a = harness();
    const b = harness();
    const fa = (a.ctx as ToolCtx & { fileFreshness?: object }).fileFreshness;
    const fb = (b.ctx as ToolCtx & { fileFreshness?: object }).fileFreshness;
    expect(fa).toBeDefined();
    expect(fb).toBeDefined();
    expect(fa).not.toBe(fb);
    const again = a.agent.makeCtx(new AbortController().signal);
    expect((again as ToolCtx & { fileFreshness?: object }).fileFreshness).toBe(fa);
  });
});
