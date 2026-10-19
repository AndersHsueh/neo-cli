/**
 * 粘贴增强 M1 测试（PRD docs/paste-enhancement-prd.md §9 测试 1/2 的 M1 范围）。
 *
 * 覆盖：折叠判定边界值、PasteCollector 生命周期、assemblePaste 组装、
 * chip 生成/绑定/还原（含「手打同款字样不误还原」）。
 * 纯逻辑测试，不碰 readline / 真实终端。
 */
import { describe, expect, test } from "bun:test";
import { PasteCollector, shouldFold, assemblePaste } from "../src/paste.ts";
import { makeTextAttachment, makeTextChip, bindAttachments, resolveLine } from "../src/attachments.ts";

const T = { foldLines: 3, foldChars: 300 };

describe("shouldFold 折叠判定", () => {
  test("含换行必折叠（M1 结构性约束：readline 行缓冲装不下 \\n）", () => {
    expect(shouldFold("a\nb", T)).toBe(true);
    expect(shouldFold("a\n", T)).toBe(true); // 尾随换行也折叠
  });

  test("单行 299 字符不折叠 / 300 字符折叠（fold_chars 边界）", () => {
    expect(shouldFold("x".repeat(299), T)).toBe(false);
    expect(shouldFold("x".repeat(300), T)).toBe(true);
  });

  test("空串与短行不折叠", () => {
    expect(shouldFold("", T)).toBe(false);
    expect(shouldFold("hello", T)).toBe(false);
  });
});

describe("PasteCollector 生命周期", () => {
  test("非活跃时 consume 返回 false（正常行照常入队）", () => {
    const c = new PasteCollector();
    expect(c.active).toBe(false);
    expect(c.consume("hello")).toBe(false);
  });

  test("start → consume 收集 → end 交出", () => {
    const c = new PasteCollector();
    c.start();
    expect(c.active).toBe(true);
    expect(c.consume("line1")).toBe(true);
    expect(c.consume("line2")).toBe(true);
    expect(c.count).toBe(2);
    const r = c.end("tail");
    expect(r).toEqual({ lines: ["line1", "line2"], tail: "tail" });
    expect(c.active).toBe(false);
  });

  test("end 后收集器复位：可再次 start", () => {
    const c = new PasteCollector();
    c.start();
    c.consume("a");
    c.end("");
    c.start();
    expect(c.count).toBe(0);
    expect(c.consume("b")).toBe(true);
    expect(c.end("")?.lines).toEqual(["b"]);
  });

  test("纯空粘贴 end 返回 null（缓冲未被拦截，调用方无需动作）", () => {
    const c = new PasteCollector();
    c.start();
    expect(c.end("")).toBe(null);
  });

  test("只有缓冲内容（单行粘贴）也能组装", () => {
    const c = new PasteCollector();
    c.start();
    expect(c.end("just one line")).toEqual({ lines: [], tail: "just one line" });
  });
});

describe("assemblePaste 组装", () => {
  test("lines 与 tail 用 \\n 连接", () => {
    expect(assemblePaste(["a", "b"], "c")).toBe("a\nb\nc");
  });

  test("tail 为空串时保留尾随换行结构", () => {
    expect(assemblePaste(["a", "b"], "")).toBe("a\nb\n");
  });

  test("纯缓冲粘贴（lines 空）", () => {
    expect(assemblePaste([], "only")).toBe("only");
  });
});

describe("chip 生成与还原", () => {
  test("chip 格式：[Pasted text #N +X lines]", () => {
    expect(makeTextChip(1, 3)).toBe("[Pasted text #1 +3 lines]");
    const a = makeTextAttachment(2, "a\nb\nc\nd");
    expect(a.chip).toBe("[Pasted text #2 +4 lines]");
    expect(a.lines).toBe(4);
    expect(a.kind).toBe("text");
  });

  test("resolveLine：chip 在行内 → 还原原文", () => {
    const att = makeTextAttachment(1, "line1\nline2\nline3");
    expect(resolveLine(`看这个 ${att.chip} 谢谢`, [att])).toBe("看这个 line1\nline2\nline3 谢谢");
  });

  test("resolveLine：chip 被用户删除 → 静默丢弃，不还原", () => {
    const att = makeTextAttachment(1, "secret content");
    expect(resolveLine("chip 已经删了", [att])).toBe("chip 已经删了");
  });

  test("resolveLine：手打同款字样（不在 pending 里）不被误还原（PRD 测试 2）", () => {
    expect(resolveLine("我就是要打 [Pasted text #1 +3 lines] 这几个字", [])).toBe(
      "我就是要打 [Pasted text #1 +3 lines] 这几个字",
    );
  });

  test("resolveLine：多个附件混合还原", () => {
    const a1 = makeTextAttachment(1, "AAA");
    const a2 = makeTextAttachment(2, "BBB");
    expect(resolveLine(`${a1.chip} 中间 ${a2.chip}`, [a1, a2])).toBe("AAA 中间 BBB");
  });

  test("bindAttachments：只绑定 chip 仍在本行内的附件", () => {
    const a1 = makeTextAttachment(1, "AAA");
    const a2 = makeTextAttachment(2, "BBB");
    const line = `前缀 ${a2.chip}`;
    expect(bindAttachments(line, [a1, a2])).toEqual([a2]);
    expect(bindAttachments("没有 chip", [a1, a2])).toEqual([]);
  });
});
