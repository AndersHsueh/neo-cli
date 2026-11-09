/**
 * issue #23：LSP 客户端（编辑后诊断 + 只读符号导航）。
 *
 * 用 tests/fixtures/fake-lsp.ts 作为假语言服务器（真实 stdio + Content-Length 帧），
 * 覆盖：连接/状态、编辑后诊断注入、definition/references/hover、零配置、启动失败可读。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import { encodeLspMessage, LspFramer, normalizeDiagnostics } from "../src/lsp/client.ts";
import { formatNavigation, lspServers, resetLspServers } from "../src/lsp/index.ts";
import { TOOLS } from "../src/tools/index.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-lsp.ts");
const BUN = Bun.which("bun") ?? "bun";
const dirs: string[] = [];

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "neo-lsp-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  resetLspServers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cfgFor(cwd: string, over: Partial<Config["lsp"]> = {}): Pick<Config, "cwd" | "lsp"> {
  return {
    cwd,
    lsp: {
      enabled: true,
      diagnosticsTimeoutMs: 2_000,
      servers: [{ name: "fake", command: BUN, args: [FIXTURE], extensions: [".ts"] }],
      ...over,
    },
  };
}

function lspTool() {
  const impl = TOOLS.find((t) => t.spec.function.name === "lsp");
  if (!impl) throw new Error("lsp 工具未注册");
  return impl;
}

function ctx(cwd: string) {
  return {
    cfg: { cwd, toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => true,
  };
}

describe("issue #23 LSP", () => {
  test("帧编解码与诊断归一化（纯函数）", () => {
    const enc = encodeLspMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const framer = new LspFramer();
    const msgs = framer.push(enc);
    expect(msgs).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
    // 拆成两段喂也要能解出来
    const framer2 = new LspFramer();
    expect(framer2.push(enc.subarray(0, 5))).toEqual([]);
    expect(framer2.push(enc.subarray(5))).toHaveLength(1);
    expect(normalizeDiagnostics([{ range: { start: { line: 2, character: 3 } }, severity: 1, message: "boom" }])).toEqual(
      [{ line: 2, character: 3, severity: "error", message: "boom", source: undefined, code: undefined }],
    );
  });

  test("configure：启动假 server，状态 connected", async () => {
    const cwd = sandbox();
    const problems = await lspServers.configure(cfgFor(cwd));
    expect(problems).toEqual([]);
    expect(lspServers.configured).toBe(true);
    expect(lspServers.states()[0]).toMatchObject({ name: "fake", status: "connected" });
  });

  test("启动失败 → error 状态 + 可读消息，不抛", async () => {
    const cwd = sandbox();
    const problems = await lspServers.configure({
      cwd,
      lsp: { enabled: true, diagnosticsTimeoutMs: 1_000, servers: [{ name: "bad", command: "/nonexistent-lsp-xyz", args: [], extensions: [".ts"] }] },
    });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("无法启动 LSP server");
    expect(lspServers.states()[0]?.status).toBe("error");
    expect(lspServers.configured).toBe(false);
  });

  test("编辑后诊断：文件含 BROKEN → 注入 error 摘要；干净文件 → 空串", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    const bad = join(cwd, "bad.ts");
    writeFileSync(bad, "const x: string = BROKEN;\n", "utf8");
    const note = await lspServers.afterEdit(bad);
    expect(note).toContain("[LSP 诊断]");
    expect(note).toContain("1 error");
    expect(note).toContain("fake type error");
    expect(note).toContain("bad.ts:1:1");

    const good = join(cwd, "good.ts");
    writeFileSync(good, "const ok = 1;\n", "utf8");
    expect(await lspServers.afterEdit(good)).toBe("");
  });

  test("lsp 工具：definition / references / hover；未配置时明确报错", async () => {
    const cwd = sandbox();
    // 未配置：可读错误
    await expect(
      lspTool().execute({ operation: "definition", file: "a.ts", line: 1 }, ctx(cwd)),
    ).rejects.toThrow(/没有可用的语言服务器/);

    await lspServers.configure(cfgFor(cwd));
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");

    const def = String(await lspTool().execute({ operation: "definition", file: "a.ts", line: 2, character: 3 }, ctx(cwd)));
    expect(def).toContain("[definition]");
    expect(def).toContain("a.ts:2:3");

    const refs = String(await lspTool().execute({ operation: "references", file: "a.ts", line: 1 }, ctx(cwd)));
    expect(refs).toContain("[references] 2 处");
    expect(refs).toContain("a.ts:4:1");

    const hover = String(await lspTool().execute({ operation: "hover", file: "a.ts", line: 1 }, ctx(cwd)));
    expect(hover).toContain("fake type");

    // 参数校验
    await expect(lspTool().execute({ operation: "definition", file: "a.ts", line: 0 }, ctx(cwd))).rejects.toThrow(/line/);
    await expect(lspTool().execute({ operation: "bogus", file: "a.ts", line: 1 }, ctx(cwd))).rejects.toThrow(/operation/);
    // 没有 server 处理的后缀（文件先建出来，否则会先报「文件不存在」）
    writeFileSync(join(cwd, "x.py"), "x = 1\n", "utf8");
    await expect(lspTool().execute({ operation: "definition", file: "x.py", line: 1 }, ctx(cwd))).rejects.toThrow(/没有语言服务器处理/);
  });

  test("formatNavigation：LocationLink 的 targetUri/targetRange 也认", () => {
    const out = formatNavigation(
      "definition",
      [{ targetUri: "file:///repo/src/a.ts", targetRange: { start: { line: 9, character: 0 } } }],
      "/repo",
    );
    expect(out).toContain("src/a.ts:10:1");
    expect(formatNavigation("definition", null, "/repo")).toContain("没有找到定义");
    expect(formatNavigation("hover", { contents: "**T**" }, "/repo")).toContain("**T**");
  });
});
