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

import { DEFAULT_LSP, resolveLspConfig, type Config } from "../src/config.ts";
import { encodeLspMessage, LspFramer, normalizeDiagnostics } from "../src/lsp/client.ts";
import { formatNavigation, lspServers, resetLspServers } from "../src/lsp/index.ts";
import { mainToolNames, TOOLS, toolSpecs } from "../src/tools/index.ts";

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
  test("52-A/B 默认关闭且 schema/名称不可见；显式 true 保留，false 关闭", () => {
    expect(DEFAULT_LSP.enabled).toBe(false);
    expect(resolveLspConfig(undefined).config.enabled).toBe(false);
    expect(resolveLspConfig({ enabled: true }).config.enabled).toBe(true);
    expect(resolveLspConfig({ enabled: false }).config.enabled).toBe(false);
    const base = cfgFor(sandbox(), { servers: [] }) as Config;
    for (const enabled of [false, true]) {
      base.lsp = { ...base.lsp, enabled };
      expect(mainToolNames(base).includes("lsp")).toBe(enabled);
      expect(toolSpecs(base).some((s) => s.function.name === "lsp")).toBe(enabled);
    }
    expect(TOOLS.some((t) => t.spec.function.name === "lsp")).toBe(true);
  });

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
    expect(refs).toContain("[references] 2 条");
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

/* ------------------------------------------------------------------ */
/* issue #43：LSP 后续三件套（workspaceSymbol / callHierarchy / completion） */
/* ------------------------------------------------------------------ */

describe("issue #43 LSP 扩展", () => {
  test("E1 server→client 请求必须应答（workspace/configuration），否则真实 server 挂住", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    // 假 server 在 initialize 后主动发 workspace/configuration；客户端应答后
    // 后续请求才能正常往返 —— 这里用一次 definition 证明链路没被挂住。
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");
    const def = String(await lspTool().execute({ operation: "definition", file: "a.ts", line: 1 }, ctx(cwd)));
    expect(def).toContain("[definition]");
  });

  test("E2 workspaceSymbol：不需要 line，query 透传，结果按位置列出", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");
    // 先让 server 知道 lastUri（workspace/symbol 的 location 用它）
    await lspTool().execute({ operation: "definition", file: "a.ts", line: 1 }, ctx(cwd));

    const out = String(await lspTool().execute({ operation: "workspaceSymbol", query: "foo" }, ctx(cwd)));
    expect(out).toContain("[workspaceSymbol]");
    expect(out).toContain("foo0");
    expect(out).toContain("a.ts:1:1");
  });

  test("E3 workspaceSymbol：结果超上限时截断并标注总数", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");
    await lspTool().execute({ operation: "definition", file: "a.ts", line: 1 }, ctx(cwd));

    // 空 query = 假 server 返回 25 条；上限 20 → 必须截断并说明总数
    const out = String(await lspTool().execute({ operation: "workspaceSymbol", query: "" }, ctx(cwd)));
    expect(out).toContain("sym0");
    expect(out).toContain("25");
    expect(out).toContain("截断");
  });

  test("E4 callHierarchy：两段式（prepare + incomingCalls），item 原样回传", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");

    const out = String(
      await lspTool().execute({ operation: "callHierarchy", file: "a.ts", line: 1, direction: "incoming" }, ctx(cwd)),
    );
    // 假 server 在 item.data 丢失时会报 -32602；能拿到结果即证明原样回传
    expect(out).toContain("[callHierarchy]");
    expect(out).toContain("caller0");
    // fromRanges 是「调用发生在我这一侧」的位置（第 11 行第 3 列）
    expect(out).toContain("@11:3");
  });

  test("E5 callHierarchy：direction=outgoing 走 outgoingCalls", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");

    const out = String(
      await lspTool().execute({ operation: "callHierarchy", file: "a.ts", line: 1, direction: "outgoing" }, ctx(cwd)),
    );
    expect(out).toContain("callee0");
  });

  test("E6 callHierarchy：direction 缺省 = incoming；非法值报可读错误", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");

    const out = String(await lspTool().execute({ operation: "callHierarchy", file: "a.ts", line: 1 }, ctx(cwd)));
    expect(out).toContain("caller0");
    await expect(
      lspTool().execute({ operation: "callHierarchy", file: "a.ts", line: 1, direction: "sideways" }, ctx(cwd)),
    ).rejects.toThrow(/direction/);
  });

  test("E7 completion：返回候选并截断到上限，标注总数与 isIncomplete", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");

    const out = String(await lspTool().execute({ operation: "completion", file: "a.ts", line: 1, character: 1 }, ctx(cwd)));
    expect(out).toContain("[completion]");
    expect(out).toContain("cand0");
    expect(out).toContain("25");
    expect(out).toContain("截断");
  });

  test("E8 line 改可选：workspaceSymbol 不需要 line；其余 operation 缺 line 仍报错", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");

    // 缺 line 的 workspaceSymbol 可跑
    const ok = String(await lspTool().execute({ operation: "workspaceSymbol", query: "foo" }, ctx(cwd)));
    expect(ok).toContain("[workspaceSymbol]");

    for (const op of ["definition", "references", "hover", "completion", "callHierarchy"]) {
      await expect(lspTool().execute({ operation: op, file: "a.ts" }, ctx(cwd))).rejects.toThrow(/line/);
    }
  });

  test("E9 未知 operation 的报错列出全部可用值", async () => {
    const cwd = sandbox();
    await lspServers.configure(cfgFor(cwd));
    writeFileSync(join(cwd, "a.ts"), "export function f() {}\n", "utf8");
    await expect(lspTool().execute({ operation: "bogus", file: "a.ts", line: 1 }, ctx(cwd))).rejects.toThrow(
      /workspaceSymbol/,
    );
  });

  test("E10 工具 schema：operation enum 含新值，line 不在 required 里", () => {
    const params = lspTool().spec.function.parameters as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(params.properties["operation"]?.enum).toEqual([
      "definition",
      "references",
      "hover",
      "workspaceSymbol",
      "callHierarchy",
      "completion",
    ]);
    expect(params.required).not.toContain("line");
    expect(params.required).toContain("operation");
  });

  test("E11 formatNavigation：workspaceSymbol / callHierarchy / completion 各自格式化", () => {
    const sym = formatNavigation(
      "workspaceSymbol",
      [{ name: "foo", kind: 12, location: { uri: "file:///repo/src/a.ts", range: { start: { line: 4, character: 2 } } } }],
      "/repo",
    );
    expect(sym).toContain("foo");
    expect(sym).toContain("src/a.ts:5:3");

    const calls = formatNavigation(
      "callHierarchy",
      [{ from: { name: "caller", uri: "file:///repo/src/b.ts", range: { start: { line: 0, character: 0 } } }, fromRanges: [] }],
      "/repo",
    );
    expect(calls).toContain("caller");
    expect(calls).toContain("src/b.ts:1:1");

    const comp = formatNavigation(
      "completion",
      { isIncomplete: false, items: [{ label: "alpha", kind: 3, detail: "d" }] },
      "/repo",
    );
    expect(comp).toContain("alpha");
    expect(comp).toContain("d");
  });
});
