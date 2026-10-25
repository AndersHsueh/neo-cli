/**
 * --resume 真续接的会话文件层：adoptSession 沿用 id/path，不产生 fork 文件。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptSession,
  createSession,
  listSessions,
  loadSession,
  saveSession,
} from "../src/session.ts";
import type { Message } from "../src/llm.ts";

const dirs: string[] = [];
function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "neo-adopt-"));
  dirs.push(d);
  process.env["NEO_SESSIONS_DIR"] = d;
  return d;
}
const msg = (role: "user" | "assistant", content: string): Message => ({ role, content });

afterEach(() => {
  delete process.env["NEO_SESSIONS_DIR"];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("R1 --resume 会话文件真续接", () => {
  test("R1a adoptSession 沿用 id / path / createdAt，只更新 model", () => {
    sandbox();
    const a = createSession("model-a", "/tmp/a");
    saveSession([msg("user", "q1")], a.meta);
    const full = loadSession(a.meta.id)!;
    const adopted = adoptSession(full.meta, "model-b");
    expect(adopted.meta.id).toBe(a.meta.id);
    expect(adopted.meta.path).toBe(a.meta.path);
    expect(adopted.meta.createdAt).toBe(a.meta.createdAt);
    expect(adopted.meta.model).toBe("model-b");
    expect(adopted.meta.cwd).toBe("/tmp/a"); // 保留原目录记录（运行目录由 cfg.cwd 决定）
  });

  test("R1b 续写回同一文件：不产生新会话文件，内容追加而非分叉", () => {
    sandbox();
    const a = createSession("m", "/tmp/a");
    saveSession([msg("user", "q1"), msg("assistant", "a1")], a.meta);
    const before = readdirSync(process.env["NEO_SESSIONS_DIR"]!).length;
    const full = loadSession(a.meta.id)!;
    const adopted = adoptSession(full.meta, "m2");
    saveSession([...full.messages, msg("user", "q2")], adopted.meta);
    const after = readdirSync(process.env["NEO_SESSIONS_DIR"]!).length;
    expect(after).toBe(before);
    const reread = loadSession(a.meta.id)!;
    expect(reread.messages.length).toBe(3);
    expect(reread.messages[2]?.content).toBe("q2");
    expect(listSessions(10).length).toBe(1);
  });

  test("R1c 不存在的 id 不会被 adopt 伪造出会话", () => {
    sandbox();
    expect(loadSession("no-such-session")).toBeNull();
  });
});
