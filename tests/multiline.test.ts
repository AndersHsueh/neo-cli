/**
 * multiline.test.ts — v0.2.4 C4：continuation 状态机（纯逻辑）。
 *
 * 规格：docs/v0.2.4-input-prd[done].md §2 C4。
 * 具体触发键（Ctrl+J / 行尾反斜杠）由 M0 探针定；本状态机与触发方式解耦。
 */
import { describe, expect, test } from "bun:test";

import {
  appendContinuation,
  newlineKindFromBytes,
  newlineKindsFromBytes,
  continuationPrompt,
  emptyContinuation,
  finishContinuation,
  isActiveContinuation,
  stripContinuationMarker,
} from "../src/input/multiline.ts";

describe("C4a continuation 状态机", () => {
  test("空状态不活跃，提示符是普通 ❯", () => {
    const c = emptyContinuation();
    expect(isActiveContinuation(c)).toBe(false);
    expect(continuationPrompt(c)).toContain("❯");
  });

  test("append 后活跃，提示符变 …", () => {
    const c = appendContinuation(emptyContinuation(), "第一行");
    expect(isActiveContinuation(c)).toBe(true);
    expect(continuationPrompt(c)).toContain("…");
  });

  test("不可变：append 不修改原状态", () => {
    const a = emptyContinuation();
    const b = appendContinuation(a, "x");
    expect(a.lines).toEqual([]);
    expect(b.lines).toEqual(["x"]);
  });

  test("finish 用 \\n 拼接暂存行与当前行", () => {
    const c = appendContinuation(appendContinuation(emptyContinuation(), "a"), "b");
    expect(finishContinuation(c, "c")).toBe("a\nb\nc");
  });

  test("finish 空暂存时就是当前行", () => {
    expect(finishContinuation(emptyContinuation(), "only")).toBe("only");
  });

  test("finish 空首行允许（换行开头）", () => {
    expect(finishContinuation(appendContinuation(emptyContinuation(), ""), "x")).toBe("\nx");
  });
});

describe("C4b 行尾反斜杠模式（探针不可用时的回退触发）", () => {
  test("行尾 \\ 表示续行，并剥掉反斜杠", () => {
    expect(stripContinuationMarker("echo \\")).toEqual({ text: "echo ", cont: true });
    expect(stripContinuationMarker("linux\\")).toEqual({ text: "linux", cont: true });
  });

  test("普通行不变", () => {
    expect(stripContinuationMarker("普通")).toEqual({ text: "普通", cont: false });
    expect(stripContinuationMarker("a\\b")).toEqual({ text: "a\\b", cont: false });
  });

  test("双反斜杠不是续行（转义）", () => {
    expect(stripContinuationMarker("a\\\\")).toEqual({ text: "a\\\\", cont: false });
  });

  test("奇数个行尾反斜杠 = 转义对 + 续行符（≥3 也要续行）", () => {
    // 3 个：最后一对是转义、剩下那个是续行标记 → 续行并剥掉一个
    expect(stripContinuationMarker("a\\\\\\")).toEqual({ text: "a\\\\", cont: true });
    expect(stripContinuationMarker("a\\\\\\\\\\")).toEqual({ text: "a\\\\\\\\", cont: true });
    // 4 个：两对转义 → 不续行
    expect(stripContinuationMarker("a\\\\\\\\")).toEqual({ text: "a\\\\\\\\", cont: false });
  });
});

describe("C4c 提交字节判定（Ctrl+J=0x0A / Enter=0x0D）", () => {
  test("纯 LF → lf（Ctrl+J）", () => {
    expect(newlineKindFromBytes(new Uint8Array([0x0a]))).toBe("lf");
    expect(newlineKindFromBytes(new TextEncoder().encode("abc\n"))).toBe("lf");
  });

  test("纯 CR → cr（Enter）", () => {
    expect(newlineKindFromBytes(new Uint8Array([0x0d]))).toBe("cr");
    expect(newlineKindFromBytes(new TextEncoder().encode("abc\r"))).toBe("cr");
  });

  test("CRLF 只算一个 Enter（粘贴 CRLF 文本不会变成续行）", () => {
    expect(newlineKindsFromBytes(new Uint8Array([0x0d, 0x0a]))).toEqual(["cr"]);
    expect(newlineKindFromBytes(new Uint8Array([0x0d, 0x0a]))).toBe("cr");
  });

  test("一个数据块里的多个换行入队，按顺序消费", () => {
    expect(newlineKindsFromBytes(new TextEncoder().encode("a\nb\rc\r\nd"))).toEqual(["lf", "cr", "cr"]);
  });

  test("没有换行（方向键/普通字符）→ null", () => {
    expect(newlineKindFromBytes(new TextEncoder().encode("abc"))).toBeNull();
    expect(newlineKindFromBytes(new Uint8Array([0x1b, 0x5b, 0x41]))).toBeNull();
    expect(newlineKindFromBytes(new Uint8Array())).toBeNull();
  });
});
