/**
 * v0.4.1 B4 / D4：会话导出 Markdown。
 */
import { describe, expect, test } from "bun:test";

import { renderSessionMarkdown } from "../src/sessionExport.ts";
import type { SessionMeta } from "../src/session.ts";
import type { Message } from "../src/llm.ts";

const meta: SessionMeta = {
  id: "20261026-143606-ldr92c",
  path: "/tmp/x.json",
  createdAt: "2026-10-26T06:36:06.000Z",
  updatedAt: "2026-10-26T09:14:18.000Z",
  model: "glm-5.3-flash",
  cwd: "/work/proj",
  turns: 3,
  lastTurn: {
    at: "2026-10-26T09:10:38.000Z",
    outcome: "error",
    finishReason: null,
    errorMessage: "模型连续两轮未产出正文",
  },
};

const messages: Message[] = [
  { role: "system", content: "sys prompt 不应导出" },
  { role: "user", content: "分析一下售前资料" },
  {
    role: "assistant",
    content: "先读文件。",
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.txt"}' },
      },
    ],
  },
  { role: "tool", content: "文件内容\n第二行", tool_call_id: "c1", name: "read_file" },
  { role: "assistant", content: "结论：OK" },
];

describe("renderSessionMarkdown", () => {
  test("头部元信息 + 用户/助手/工具 + 最后一轮状态", () => {
    const md = renderSessionMarkdown(meta, messages);
    expect(md).toContain("# neo 会话导出 · 20261026-143606-ldr92c");
    expect(md).toContain("- 模型：glm-5.3-flash");
    expect(md).toContain("- 最后一轮：error（模型连续两轮未产出正文）");
    expect(md).toContain("## 用户\n\n分析一下售前资料");
    expect(md).toContain("## 助手");
    expect(md).toContain("read_file");
    expect(md).toContain("### 工具结果 · read_file");
    expect(md).toContain("文件内容");
    expect(md).toContain("结论：OK");
    // system 不进导出
    expect(md).not.toContain("sys prompt 不应导出");
  });

  test("空会话有占位", () => {
    const md = renderSessionMarkdown(meta, [{ role: "system", content: "x" }]);
    expect(md).toContain("（空会话）");
  });

  test("只有无正文的 assistant 也算空会话（占位不能漏）", () => {
    // 计数只算写进正文的段：空 assistant 被跳过，不能把它算作「有内容」。
    const md = renderSessionMarkdown(meta, [
      { role: "system", content: "x" },
      { role: "assistant", content: "" },
      { role: "assistant", content: null },
    ]);
    expect(md).toContain("（空会话）");
    expect(md).not.toContain("## 助手");
  });

  test("有正文时不出占位", () => {
    const md = renderSessionMarkdown(meta, [
      { role: "assistant", content: "" },
      { role: "user", content: "hi" },
    ]);
    expect(md).not.toContain("（空会话）");
    expect(md).toContain("## 用户\n\nhi");
  });
});
