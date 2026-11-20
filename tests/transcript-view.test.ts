/**
 * transcript-view.test.ts — issue #90 交互式 transcript 视图（Ctrl+O）。
 *
 * 纯逻辑 + composer 接线：快照、搜索、展开、Esc 分层、busy 时 Ctrl+C
 * 不武装退出、与 rewind/choose 互斥。TTY 开/关/搜索见 scripts/pty-e2e.ts。
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Composer, type ComposerDeps, type ComposerStatus } from "../src/tui/composer.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { HELP_LINES } from "../src/tui/composerHelp.ts";
import { helpText } from "../src/cli/help.ts";
import type { Message } from "../src/llm.ts";
import { transcriptLines } from "../src/ui/transcript.ts";
import {
  EMPTY_TRANSCRIPT_HINT,
  TRANSCRIPT_FOOTER_BUSY,
  TRANSCRIPT_FOOTER_SEARCH,
  snapshotMessages,
  type TranscriptViewState,
} from "../src/tui/transcriptView.ts";

const ROOT = join(import.meta.dir, "..");

const msg = (partial: Partial<Message> & Pick<Message, "role">): Message =>
  ({ content: "", ...partial }) as Message;

const CONVO: Message[] = [
  msg({ role: "system", content: "你是 neo" }),
  msg({ role: "user", content: "请读取 alpha 文件" }),
  msg({
    role: "assistant",
    content: "先看一下。",
    tool_calls: [
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"alpha.txt"}' } },
    ],
  }),
  msg({ role: "tool", tool_call_id: "c1", content: "ALPHA_SECRET_BODY\nsecond line" }),
  msg({ role: "assistant", content: "文件里写着重点结论。" }),
  msg({ role: "user", content: "再问 beta" }),
  msg({ role: "assistant", content: "beta 的答复" }),
];

interface Harness {
  composer: Composer;
  submitted: Array<{ text: string; attachments: unknown[] }>;
  exits: number;
  cancels: number;
  messages: Message[];
  setNow: (t: number) => void;
}

function makeHarness(overrides: Partial<ComposerDeps> = {}): Harness {
  const chunks: string[] = [];
  let now = 1_000_000;
  const submitted: Array<{ text: string; attachments: unknown[] }> = [];
  let exits = 0;
  let cancels = 0;
  const messages: Message[] = [];
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream & {
    setRawMode: (v: boolean) => void;
    isRaw: boolean;
    isTTY: boolean;
  };
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
  (stdin as unknown as { isRaw: boolean }).isRaw = false;
  const status: ComposerStatus = {
    version: "0.4.98",
    model: "deepseek-flash",
    tier: "balanced",
    mode: "ask",
    branch: "main",
    ctxUsage: 0.42,
    elapsedMs: 42_000,
    active: true,
    tokensTotal: 12_300,
  };
  const deps: ComposerDeps = {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: { write: (s: string) => chunks.push(s), columns: 100, rows: 24 },
    columns: () => 100,
    rows: () => 24,
    getStatus: () => status,
    getTitle: () => "neo · test",
    commands: COMMANDS,
    files: () => ["a.txt"],
    onSubmit: (text, attachments) => submitted.push({ text, attachments }),
    onExit: () => {
      exits += 1;
    },
    onCancelTurn: () => {
      cancels += 1;
    },
    getMessages: () => messages,
    now: () => now,
    ...overrides,
  };
  const composer = new Composer(deps);
  composer.start();
  return {
    composer,
    submitted,
    get exits() {
      return exits;
    },
    get cancels() {
      return cancels;
    },
    messages,
    setNow: (t: number) => {
      now = t;
    },
  };
}

function special(
  h: Harness,
  key: { name?: string; ch?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string },
): void {
  h.composer.handleKey(key.ch, key);
}

function typeText(h: Harness, text: string): void {
  for (const ch of text) h.composer.handleKey(ch, { ch, name: ch });
}

function visible(h: Harness): string {
  return h.composer.compose().rows.join("\n");
}

function openView(h: Harness): void {
  special(h, { ch: "\x0f", name: "o", ctrl: true });
}

function viewOf(h: Harness): TranscriptViewState | null {
  return h.composer.transcriptView;
}

describe("#90 快照构造（不破坏 resume 回放）", () => {
  test("#90 验收：snapshot 含用户/助手正文与已完成工具，跳过 system 与进行中工具调用", () => {
    const pending: Message[] = [
      ...CONVO,
      msg({
        role: "assistant",
        content: "还在跑",
        tool_calls: [
          { id: "c-pending", type: "function", function: { name: "shell", arguments: '{"cmd":"sleep"}' } },
        ],
      }),
    ];
    const records = snapshotMessages(pending);
    const kinds = records.map((r) => r.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    expect(kinds).toContain("tool");
    expect(records.some((r) => r.kind === "tool" && r.name === "read_file")).toBe(true);
    expect(records.some((r) => r.kind === "tool" && r.name === "shell")).toBe(false);
    expect(records.some((r) => r.kind === "user" && r.text.includes("alpha"))).toBe(true);
    expect(JSON.stringify(records)).not.toContain("你是 neo");
    const tool = records.find((r) => r.kind === "tool" && r.name === "read_file");
    expect(tool?.kind === "tool" ? tool.output : "").toContain("ALPHA_SECRET_BODY");
  });

  test("#90 不破坏 transcriptLines 的 --resume 回放语义", () => {
    const lines = transcriptLines(CONVO, { width: 80 });
    const text = lines.join("\n");
    expect(text).toContain("❯ 请读取 alpha 文件");
    expect(text).toContain("● 文件里写着重点结论。");
    expect(text).not.toContain("ALPHA_SECRET_BODY");
    expect(text).not.toContain("你是 neo");
  });
});

describe("#90 打开 / 关闭 / 空会话", () => {
  test("#90 验收1：Ctrl+O 打开视图，不再提示将在 v0.3.1 提供；空会话给 muted 提示；输入框仍在", () => {
    const h = makeHarness();
    openView(h);
    const text = visible(h);
    expect(viewOf(h)).not.toBeNull();
    expect(text).toContain(EMPTY_TRANSCRIPT_HINT);
    expect(text).not.toContain("将在 v0.3.1 提供");
    expect(text).not.toContain("transcript 视图将在");
    expect(text).toContain(TRANSCRIPT_FOOTER_SEARCH);
    expect(text).toContain("❯");
    expect(text).toContain("deepseek-flash");
    h.composer.stop();
  });

  test("#90 验收1：有记录时用户行 ❯、助手行 ●，打开滚到最新", () => {
    const h = makeHarness();
    h.messages.push(...CONVO);
    openView(h);
    const text = visible(h);
    expect(text).toContain("❯");
    expect(text).toContain("请读取 alpha 文件");
    expect(text).toContain("●");
    expect(text).toContain("beta 的答复");
    expect(text).toContain("read_file");
    const view = viewOf(h)!;
    expect(view.cursor).toBe(view.records.length - 1);
    h.composer.stop();
  });

  test("#90 第二次 Ctrl+O 关闭（开关）；Esc 也能关并回到输入框，草稿保留", () => {
    const h = makeHarness();
    typeText(h, "草稿还在");
    openView(h);
    expect(viewOf(h)).not.toBeNull();
    expect(h.composer.text).toBe("草稿还在");
    openView(h);
    expect(viewOf(h)).toBeNull();
    expect(h.composer.text).toBe("草稿还在");
    expect(h.submitted).toEqual([]);

    openView(h);
    special(h, { name: "escape" });
    expect(viewOf(h)).toBeNull();
    expect(h.composer.text).toBe("草稿还在");
    expect(h.cancels).toBe(0);
    h.composer.stop();
  });

  test("#90 视图开着时按键不穿透到输入框（提交/历史/Ctrl+R/普通插入）", () => {
    const h = makeHarness();
    typeText(h, "keep");
    h.messages.push(...CONVO);
    openView(h);
    typeText(h, "xyz");
    special(h, { sequence: "\r", name: "return" });
    special(h, { name: "r", ctrl: true });
    special(h, { name: "up" });
    expect(h.composer.text).toBe("keep");
    expect(h.submitted).toEqual([]);
    expect(h.composer.search).toBeNull();
    expect(viewOf(h)).not.toBeNull();
    h.composer.stop();
  });
});

describe("#90 检索", () => {
  test("#90 验收2：/ 与 Ctrl+F 进入搜索，大小写不敏感，命中用户/助手/工具输出并可跳转", () => {
    const h = makeHarness();
    h.messages.push(...CONVO);
    openView(h);
    special(h, { ch: "/", name: "/" });
    expect(viewOf(h)?.searching).toBe(true);
    typeText(h, "ALPHA_secret");
    expect(viewOf(h)?.query).toBe("ALPHA_secret");
    const afterQuery = viewOf(h)!;
    expect(afterQuery.hits.length).toBeGreaterThan(0);
    special(h, { sequence: "\r", name: "return" });
    expect(viewOf(h)?.searching).toBe(true);
    const tool = viewOf(h)!.records[viewOf(h)!.cursor];
    expect(tool?.kind === "tool" && tool.output.includes("ALPHA_SECRET_BODY")).toBe(true);
    expect(viewOf(h)?.expanded.has(tool!.id)).toBe(true);

    special(h, { name: "escape" });
    expect(viewOf(h)?.searching).toBe(false);
    expect(viewOf(h)).not.toBeNull();

    special(h, { ch: "\x06", name: "f", ctrl: true });
    expect(viewOf(h)?.searching).toBe(true);
    h.composer.stop();
  });

  test("#90 搜索态 Enter 跳下一条、不切换展开；Space 进查询；退出后 n/N 仍跳转；关视图后清掉", () => {
    const h = makeHarness();
    h.messages.push(...CONVO);
    openView(h);
    special(h, { ch: "/", name: "/" });
    typeText(h, "请读取");
    expect(viewOf(h)?.hits.length).toBeGreaterThan(0);
    const expandedBefore = [...viewOf(h)!.expanded].sort();
    special(h, { sequence: "\r", name: "return" });
    expect(viewOf(h)?.searching).toBe(true);
    // 命中在用户正文：Enter 只跳转，不得把工具行展开/折叠当作搜索确认。
    expect([...viewOf(h)!.expanded].sort()).toEqual(expandedBefore);
    special(h, { ch: " ", name: " " });
    expect(viewOf(h)?.query).toBe("请读取 ");
    special(h, { name: "escape" });
    // 换一条有多处命中的查询，供退出搜索后的 n/N 使用。
    special(h, { ch: "/", name: "/" });
    typeText(h, "文件");
    expect((viewOf(h)?.hits.length ?? 0) >= 2).toBe(true);
    special(h, { name: "escape" });
    expect(viewOf(h)?.lastQuery).toBe("文件");
    const cursor0 = viewOf(h)!.cursor;
    typeText(h, "n");
    expect(h.composer.text).toBe("");
    expect(viewOf(h)?.searching).toBe(false);
    expect(viewOf(h)?.cursor).not.toBe(cursor0);
    typeText(h, "N");
    expect(viewOf(h)?.cursor).toBe(cursor0);
    special(h, { name: "escape" });
    expect(viewOf(h)).toBeNull();
    openView(h);
    expect(viewOf(h)?.query).toBe("");
    expect(viewOf(h)?.lastQuery).toBe("");
    expect(viewOf(h)?.searching).toBe(false);
    h.composer.stop();
  });

  test("#90 搜索态 Home/End 走查询行，不是跳转记录", () => {
    const h = makeHarness();
    h.messages.push(...CONVO);
    openView(h);
    special(h, { ch: "/", name: "/" });
    typeText(h, "beta");
    const cursor = viewOf(h)!.cursor;
    const qLen = viewOf(h)!.query.length;
    expect(viewOf(h)?.queryCursor).toBe(qLen);
    special(h, { name: "home" });
    expect(viewOf(h)?.queryCursor).toBe(0);
    expect(viewOf(h)?.cursor).toBe(cursor);
    special(h, { name: "end" });
    expect(viewOf(h)?.queryCursor).toBe(qLen);
    expect(viewOf(h)?.cursor).toBe(cursor);
    h.composer.stop();
  });

  test("#90 退出搜索后 Enter/Space 展开或折叠工具行", () => {
    const h = makeHarness();
    h.messages.push(...CONVO);
    openView(h);
    const recs = viewOf(h)!.records;
    const toolIndex = recs.findIndex((r) => r.kind === "tool");
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    const id = recs[toolIndex]!.id;
    // 把光标移到工具行：非搜索态 Home 到首条再 ↓ 到工具
    special(h, { name: "home" });
    for (let i = 0; i < toolIndex; i++) special(h, { name: "down" });
    expect(viewOf(h)?.cursor).toBe(toolIndex);
    expect(viewOf(h)?.expanded.has(id)).toBe(false);
    special(h, { sequence: "\r", name: "return" });
    expect(viewOf(h)?.expanded.has(id)).toBe(true);
    expect(visible(h)).toContain("ALPHA_SECRET_BODY");
    special(h, { ch: " ", name: " " });
    expect(viewOf(h)?.expanded.has(id)).toBe(false);
    h.composer.stop();
  });
});

describe("#90 Esc / Ctrl+C / busy / 互斥", () => {
  test("#90 Esc 先退出搜索再关视图；绝不取消本轮、不清空草稿、不打开 rewind", () => {
    const h = makeHarness({
      rewind: {
        list: () => [{ index: 1, at: "2026-11-20T12:00:00.000Z", prompt: "x", checkpointSeqs: [], compacted: false }],
        apply: () => {
          throw new Error("rewind 不应被调用");
        },
      },
    });
    typeText(h, "draft");
    h.messages.push(...CONVO);
    h.composer.busy = true;
    openView(h);
    special(h, { ch: "/", name: "/" });
    typeText(h, "beta");
    special(h, { name: "escape" });
    expect(viewOf(h)?.searching).toBe(false);
    expect(viewOf(h)).not.toBeNull();
    expect(h.cancels).toBe(0);
    expect(h.composer.text).toBe("draft");
    special(h, { name: "escape" });
    expect(viewOf(h)).toBeNull();
    expect(h.cancels).toBe(0);
    expect(h.composer.text).toBe("draft");
    expect(h.composer.rewindMenuOpen).toBe(false);
    h.composer.stop();
  });

  test("#90 视图开着时 Ctrl+C 只关视图；busy 时同时请求取消，且不武装再按退出", () => {
    const h = makeHarness();
    typeText(h, "draft");
    h.messages.push(...CONVO);
    h.composer.busy = true;
    openView(h);
    expect(visible(h)).toContain(TRANSCRIPT_FOOTER_BUSY);
    special(h, { name: "c", ctrl: true });
    expect(viewOf(h)).toBeNull();
    expect(h.cancels).toBe(1);
    expect(h.composer.armedExit).toBe(false);
    expect(h.exits).toBe(0);
    expect(h.composer.text).toBe("draft");
    expect(visible(h)).not.toContain("再按 Ctrl+C 退出");
    h.composer.stop();
  });

  test("#90 busy 时允许只读打开已落盘快照，不把进行中工具装成已完成行", () => {
    const h = makeHarness();
    h.messages.push(
      msg({ role: "user", content: "已完成的问题" }),
      msg({ role: "assistant", content: "已完成的回答" }),
      msg({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "live", type: "function", function: { name: "shell", arguments: "{}" } }],
      }),
    );
    h.composer.busy = true;
    openView(h);
    const recs = viewOf(h)!.records;
    expect(recs.some((r) => r.kind === "user" && r.text.includes("已完成的问题"))).toBe(true);
    expect(recs.some((r) => r.kind === "tool" && r.name === "shell")).toBe(false);
    expect(visible(h)).toContain(TRANSCRIPT_FOOTER_BUSY);
    h.composer.stop();
  });

  test("#90 rewind 菜单或权限/choose 对话打开时 Ctrl+O 不抢焦点、不打开视图", () => {
    const h = makeHarness();
    h.composer.rewindMenuOpen = true;
    openView(h);
    expect(viewOf(h)).toBeNull();
    expect(visible(h)).not.toContain(EMPTY_TRANSCRIPT_HINT);
    h.composer.rewindMenuOpen = false;

    h.composer.mode = "select";
    h.composer.select = {
      question: "选一个",
      options: [{ label: "A", value: 1 }],
      state: { cursor: 0, scroll: 0 },
      viewport: 5,
      resolve: () => {},
    };
    openView(h);
    expect(viewOf(h)).toBeNull();
    h.composer.mode = "normal";
    h.composer.select = null;

    h.composer.mode = "ask_user";
    openView(h);
    expect(viewOf(h)).toBeNull();
    h.composer.stop();
  });

  test("#90 打开时关掉帮助面板和 / 命令菜单；草稿保留；关闭后若仍以 / 开头再同步菜单", () => {
    const h = makeHarness();
    special(h, { ch: "?", name: "?" });
    expect(h.composer.helpOpen).toBe(true);
    openView(h);
    expect(h.composer.helpOpen).toBe(false);
    expect(viewOf(h)).not.toBeNull();
    special(h, { name: "escape" });

    typeText(h, "/he");
    expect(h.composer.menu).not.toBeNull();
    openView(h);
    expect(h.composer.menu).toBeNull();
    expect(h.composer.text).toBe("/he");
    expect(viewOf(h)).not.toBeNull();
    special(h, { name: "escape" });
    expect(viewOf(h)).toBeNull();
    expect(h.composer.text).toBe("/he");
    expect(h.composer.menu).not.toBeNull();
    h.composer.stop();
  });

  test("#90 未打开视图时 Ctrl+F 不产生新的输入框语义", () => {
    const h = makeHarness();
    typeText(h, "ab");
    special(h, { ch: "\x06", name: "f", ctrl: true });
    expect(h.composer.text).toBe("ab");
    expect(viewOf(h)).toBeNull();
    expect(h.composer.search).toBeNull();
    expect(h.submitted).toEqual([]);
    h.composer.stop();
  });
});

describe("#90 文档与非 TTY", () => {
  test("#90 /help、? 帮助不再写 v0.3.1 占位，并补上 Ctrl+O 与 / 搜索", () => {
    const help = helpText();
    expect(help).toContain("Ctrl+O");
    expect(help).toMatch(/transcript 视图/);
    expect(help).toContain("/ 搜索");
    expect(help).not.toContain("v0.3.1 提供");
    const panel = HELP_LINES.join("\n");
    expect(panel).toContain("Ctrl+O");
    expect(panel).toMatch(/\/ 搜索/);
    expect(panel).not.toContain("v0.3.1");
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).not.toContain("Ctrl+O` transcript 视图与轮次 diff 留 v0.3.2 / v0.3.3");
    expect(readme).toContain("Ctrl+O");
  });

  test("#90 验收4：-p / oneshot 路径不构造 Composer，因而不会进入该视图", () => {
    const src = readFileSync(join(ROOT, "src/cli/oneshot.ts"), "utf8");
    expect(src).not.toMatch(/new Composer/);
    expect(src).not.toMatch(/transcriptView/);
  });
});
