/**
 * v0.4.8：恢复会话时图片附件占位编号必须与用户看到的 chip 编号一致。
 *
 * 落盘时图片按 part 下标命名（img-<i>.png），用户看到的 chip 是 `[Image #<i+1>]`。
 * 附件文件丢失时占位文本写的是「[Image #N 已丢失]」—— N 若按「第几个丢失」计数，
 * 一旦前面有图还在，编号就整体前移，模型会对着错误的编号回复。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hydrateMessages } from "../src/session.ts";
import type { Message } from "../src/llm.ts";

const SANDBOX = join(tmpdir(), `neo-hydrate-test-${Date.now()}`);
const SID = "s-hydrate";

beforeAll(() => {
  process.env["NEO_SESSIONS_DIR"] = SANDBOX;
  mkdirSync(join(SANDBOX, "attachments", SID), { recursive: true });
  // 只写 img-0：img-1 / img-2 视为丢失
  writeFileSync(join(SANDBOX, "attachments", SID, "img-0.png"), Buffer.from("png"));
});

afterAll(() => {
  delete process.env["NEO_SESSIONS_DIR"];
  rmSync(SANDBOX, { recursive: true, force: true });
});

function ref(name: string): { type: "image_ref"; ref: string } {
  return { type: "image_ref", ref: `attachments/${SID}/${name}` };
}

function userMsg(parts: unknown[]): Message {
  return { role: "user", content: parts as Message["content"] };
}

describe("hydrateMessages 图片占位编号", () => {
  test("前面有图还在时，丢失占位仍按原 chip 编号", () => {
    // 用户原始输入：[Image #1]（img-0，还在）[Image #2]（img-1，丢）[Image #3]（img-2，丢）
    const out = hydrateMessages([
      userMsg([ref("img-0.png"), ref("img-1.png"), { type: "text", text: "看图" }, ref("img-2.png")]),
    ]);
    const parts = out[0]?.content as Array<{ type: string; text?: string }>;
    expect(parts[0]?.type).toBe("image_url");
    expect(parts[1]).toEqual({ type: "text", text: "[Image #2 已丢失]" });
    expect(parts[3]).toEqual({ type: "text", text: "[Image #3 已丢失]" });
  });

  test("全部丢失时编号从 1 起，与 chip 一致", () => {
    const out = hydrateMessages([userMsg([ref("img-0.png"), ref("img-1.png")])]);
    const parts = out[0]?.content as Array<{ type: string; text?: string }>;
    // img-0 存在 → 第 2 个（img-1）丢失，编号应为 #2
    expect(parts[1]).toEqual({ type: "text", text: "[Image #2 已丢失]" });
  });

  test("编号跨消息连续（同一会话内 chip 计数不重置）", () => {
    const out = hydrateMessages([
      userMsg([ref("img-0.png"), ref("img-1.png")]),
      userMsg([ref("img-2.png")]),
    ]);
    const first = out[0]?.content as Array<{ type: string; text?: string }>;
    const second = out[1]?.content as Array<{ type: string; text?: string }>;
    expect(first[1]).toEqual({ type: "text", text: "[Image #2 已丢失]" });
    expect(second[0]).toEqual({ type: "text", text: "[Image #3 已丢失]" });
  });

  test("非图片消息原样返回，不产生占位", () => {
    const out = hydrateMessages([
      { role: "user", content: "纯文本" },
      { role: "assistant", content: [{ type: "text", text: "回复" }] },
    ]);
    expect(out[0]?.content).toBe("纯文本");
    expect(out[1]?.content).toEqual([{ type: "text", text: "回复" }]);
  });
});
