/**
 * issue #63：--add-dir 启动用法错误的端到端（子进程，非 TTY）。
 *
 * 退出码 2、不启会话；stream-json 下按 #37 输出 usage_error JSONL；
 * 非 TTY 下位置参数仍当一次性提示词（不因 --add-dir 报位置参数错）。
 * 交互 TTY 的位置参数规则见 scripts/pty-e2e.ts S42。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "../src/index.ts");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function box(): { work: string; home: string; sessions: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "neo-63-cli-")));
  made.push(root);
  const work = join(root, "work");
  const home = join(root, "home");
  const sessions = join(root, "sessions");
  for (const d of [work, home, sessions, join(work, "lib")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(work, "file.txt"), "x", "utf8");
  return { work, home, sessions };
}

function runNeo(args: string[], b = box()): { code: number; stdout: string; stderr: string; sessions: string[] } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("NEO_")) env[k] = v;
  env["HOME"] = b.home;
  env["NEO_SESSIONS_DIR"] = b.sessions;
  env["NEO_MAILBOX_DIR"] = join(b.home, "mailbox");
  env["NEO_MEMORY_DISABLE"] = "1";
  const r = Bun.spawnSync(["bun", "run", ENTRY, ...args], { cwd: b.work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    code: r.exitCode ?? -1,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    sessions: readdirSync(b.sessions),
  };
}

describe("--add-dir 用法错误：退出码 2，不启会话", () => {
  const cases: Array<[string, string[]]> = [
    ["缺值", ["-p", "q", "--add-dir"]],
    ["空值", ["-p", "q", "--add-dir", ""]],
    ["= 空值", ["-p", "q", "--add-dir="]],
    ["下一个参数以 - 开头", ["-p", "q", "--add-dir", "-x"]],
    ["路径不存在", ["-p", "q", "--add-dir", "nope"]],
    ["不是目录", ["-p", "q", "--add-dir", "file.txt"]],
    ["文件系统根", ["-p", "q", "--add-dir", "/"]],
  ];
  for (const [name, args] of cases) {
    test(name, () => {
      const r = runNeo(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--add-dir");
      expect(r.sessions).toEqual([]);
    });
  }

  test("stream-json 下按 #37 输出 usage_error JSONL", () => {
    const r = runNeo(["-p", "q", "--output-format", "stream-json", "--add-dir", "nope"]);
    expect(r.code).toBe(2);
    const events = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e["type"] === "error" && (e["error"] as Record<string, unknown>)?.["code"] === "usage_error" || e["code"] === "usage_error")).toBe(true);
    const result = events.find((e) => e["type"] === "result") as Record<string, unknown> | undefined;
    expect(result?.["status"]).toBe("usage_error");
    expect(result?.["exit_code"]).toBe(2);
  });

  test("neo acp 带 --add-dir：报冲突退出 2", () => {
    const r = runNeo(["acp", "--add-dir", "lib"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--add-dir");
  });

  test("非 TTY：--add-dir 加位置参数不报位置参数错（位置参数照旧当一次性提示词）", () => {
    const r = runNeo(["--add-dir", "lib", "解释一下"]);
    expect(r.stderr).not.toContain("每个目录各写一次 --add-dir");
  });

  test("--help 写明 --add-dir", () => {
    const r = runNeo(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--add-dir <路径>");
  });
});
