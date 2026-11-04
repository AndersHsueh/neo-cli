/**
 * v0.4.8：恢复会话时图片附件占位编号必须与用户看到的 chip 编号一致。
 * v0.4.12：落盘编号口径同步修正 —— 按**会话内第几张图**命名（img-<seq>.png），
 * 不再按 part 下标（每轮都从 1 起，会让后一轮的图覆盖前一轮）。
 *
 * 附件文件丢失时占位文本写的是「[Image #N 已丢失]」—— N 若按「第几个丢失」计数，
 * 一旦前面有图还在，编号就整体前移，模型会对着错误的编号回复。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hydrateMessages, loadSession, saveSession, type SessionMeta } from "../src/session.ts";
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

describe("saveSession 附件命名（v0.4.12）", () => {
  const SID2 = "s-save";
  const META: SessionMeta = {
    id: SID2,
    path: join(SANDBOX, `${SID2}.json`),
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
    model: "m",
    cwd: "/tmp",
    turns: 2,
  };

  function dataUrl(bytes: string): string {
    return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  }

  function imgMsg(text: string, bytes: string): Message {
    return {
      role: "user",
      content: [
        { type: "text", text },
        { type: "image_url", image_url: { url: dataUrl(bytes) } },
      ],
    };
  }

  test("每轮图片各自落盘，后一轮不覆盖前一轮", () => {
    // 旧实现按 part 下标命名：两条用户消息的图都叫 img-1.png，第二轮直接覆盖第一轮。
    saveSession([imgMsg("第一轮", "AAA"), { role: "assistant", content: "ok" }, imgMsg("第二轮", "BBB")], META);
    const files = readdirSync(join(SANDBOX, "attachments", SID2)).sort();
    expect(files).toEqual(["img-0.png", "img-1.png"]);

    const loaded = loadSession(SID2);
    expect(loaded).not.toBeNull();
    const first = loaded?.messages[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
    const second = loaded?.messages[2]?.content as Array<{ type: string; image_url?: { url: string } }>;
    const b64 = (u?: string): string => Buffer.from(u?.split(",")[1] ?? "", "base64").toString();
    expect(b64(first[1]?.image_url?.url)).toBe("AAA");
    expect(b64(second[1]?.image_url?.url)).toBe("BBB");
  });

  test("文件名序号与 hydrate 占位编号同一口径（img-<seq>.png ↔ [Image #<seq+1>]）", () => {
    saveSession([imgMsg("一", "AAA"), imgMsg("二", "BBB")], META);
    // 删掉第 2 张（img-1.png）后恢复：占位应为 [Image #2]，不是 #1
    rmSync(join(SANDBOX, "attachments", SID2, "img-1.png"));
    const loaded = loadSession(SID2);
    const second = loaded?.messages[1]?.content as Array<{ type: string; text?: string }>;
    expect(second[1]).toEqual({ type: "text", text: "[Image #2 已丢失]" });
  });
});
