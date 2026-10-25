/**
 * transcript.test.ts — v0.2.3 D4：会话恢复回放。
 *
 * 规格：docs/v0.2.3-tui-patch-prd[done].md D4。
 * 纯函数：只做「从 messages 切出最近 N 轮 → 着色行数组」，IO 由调用方负责。
 */
import { describe, expect, test } from "bun:test";

import { transcriptLines } from "../src/ui/transcript.ts";
import type { Message } from "../src/llm.ts";

const msg = (role: Message["role"], content: string): Message => ({ role, content }) as Message;

const CONVO: Message[] = [
  msg("system", "你是 neo"),
  msg("user", "问题一"),
  msg("assistant", "答案一"),
  msg("tool", "工具原始输出不该出现"),
  msg("user", "问题二"),
  msg("assistant", "答案二"),
];

describe("D4 会话回放", () => {
  test("默认取最近 3 轮，用户/助手各自带前缀", () => {
    const lines = transcriptLines(CONVO, { width: 80 });
    const text = lines.join("\n");
    expect(text).toContain("❯ 问题一");
    expect(text).toContain("● 答案一");
    expect(text).toContain("❯ 问题二");
    expect(text).toContain("● 答案二");
    expect(text).not.toContain("你是 neo");
    expect(text).not.toContain("工具原始输出不该出现");
  });

  test("turns=1 只回放最后一轮", () => {
    const text = transcriptLines(CONVO, { width: 80, turns: 1 }).join("\n");
    expect(text).toContain("问题二");
    expect(text).not.toContain("问题一");
  });

  test("空正文的 assistant（纯工具调用轮）被跳过", () => {
    const convo: Message[] = [
      msg("user", "q"),
      msg("assistant", ""),
      msg("assistant", "最终答案"),
    ];
    const lines = transcriptLines(convo, { width: 80 });
    expect(lines.filter((l) => l.startsWith("●")).length).toBe(1);
    expect(lines.join("\n")).toContain("最终答案");
  });

  test("maxLines 截断时给出「更早未显示」提示", () => {
    const convo: Message[] = [];
    for (let i = 0; i < 5; i++) {
      convo.push(msg("user", `q${i}`));
      convo.push(msg("assistant", `a${i}`));
    }
    const lines = transcriptLines(convo, { width: 80, maxLines: 4 });
    expect(lines.length).toBeLessThanOrEqual(5); // 4 行 + 可能的提示行
    expect(lines[0]).toContain("未显示");
    expect(lines.join("\n")).toContain("a4"); // 最新的必须在
  });

  test("多行用户输入：首行带 ❯，续行缩进对齐", () => {
    const lines = transcriptLines([msg("user", "第一行\n第二行")], { width: 80 });
    expect(lines[0]!.startsWith("❯")).toBe(true);
    expect(lines[1]!.startsWith("  ")).toBe(true);
    expect(lines[1]).toContain("第二行");
  });

  test("markdown 粗体被渲染掉（复用 renderMarkdown）", () => {
    const text = transcriptLines([msg("assistant", "这是**重点**")], { width: 80 }).join("\n");
    expect(text).not.toContain("**");
    expect(text).toContain("重点");
  });

  test("空会话返回空数组", () => {
    expect(transcriptLines([])).toEqual([]);
    expect(transcriptLines([msg("system", "s")])).toEqual([]);
  });
});

describe("D4b 单段超长内容也受 maxLines 约束", () => {
  test("300 行长回答被压进 20 行并提示本段截断", () => {
    const convo: Message[] = [
      msg("user", "q"),
      msg("assistant", Array.from({ length: 300 }, (_, i) => `line${i}`).join("\n")),
    ];
    const lines = transcriptLines(convo, { width: 80, maxLines: 20 });
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.join("\n")).toContain("本段还有");
  });

  test("默认 maxLines=120 时不会因单条长回答刷屏", () => {
    const convo: Message[] = [msg("assistant", Array.from({ length: 300 }, (_, i) => `line${i}`).join("\n"))];
    expect(transcriptLines(convo, { width: 80 }).length).toBeLessThanOrEqual(120);
  });

  test("截断提示不承诺 /last（resume 后工具历史并不存在）", () => {
    const convo: Message[] = [];
    for (let i = 0; i < 5; i++) {
      convo.push(msg("user", `q${i}`));
      convo.push(msg("assistant", `a${i}`));
    }
    const text = transcriptLines(convo, { width: 80, maxLines: 4 }).join("\n");
    expect(text).toContain("未显示");
    expect(text).not.toContain("/last");
  });
});
