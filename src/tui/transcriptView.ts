/**
 * tui/transcriptView.ts — 交互式 transcript 视图的纯逻辑（issue #90）。
 *
 * 与 composer 的分工：快照、搜索、展开/折叠、Esc 分层和面板排版都在这里，
 * bun test 可直测；按键接线与「画在输入框上方」留在 composerTranscript。
 *
 * 不替代 /rewind、/export、/last、Ctrl+R；本刀不做轮次 diff、[ 回灌、实时追加。
 */
import { contentText, type Message } from "../llm.ts";
import { c, truncate } from "../ui/theme.ts";
import { truncateAnsi, wrapAnsi } from "./ansi.ts";
import type { KeyAction } from "./keys.ts";

export const TRANSCRIPT_TITLE = "会话记录";
export const EMPTY_TRANSCRIPT_HINT = "本会话还没有记录";
export const TRANSCRIPT_FOOTER_SEARCH = "/ 搜索";
export const TRANSCRIPT_FOOTER_BUSY = "关闭后再 Esc 才能取消本轮";

export type TranscriptRecord =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "tool"; name: string; args: string; output: string };

export interface TranscriptViewState {
  records: TranscriptRecord[];
  /** 当前记录下标（空会话为 0）。 */
  cursor: number;
  /** 正文区第一条可见行（在 flatten 后的行数组里）。 */
  scroll: number;
  expanded: Set<string>;
  searching: boolean;
  query: string;
  queryCursor: number;
  /** 退出搜索后仍用于 n/N；关视图后由调用方丢弃整个 state。 */
  lastQuery: string;
  hits: number[];
  hitIndex: number;
}

export type TranscriptViewEffect = "none" | "close" | "close-and-cancel";

/** 只收录已落盘且已完成的记录；没有 tool 结果的 tool_calls 视为进行中，不入快照。 */
export function snapshotMessages(messages: readonly Message[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  let seq = 0;
  const nextId = (): string => `t${seq++}`;
  const pending = new Map<string, { name: string; args: string }>();

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const text = (contentText(m.content) ?? "").trim();
      if (text) records.push({ id: nextId(), kind: "user", text });
      continue;
    }
    if (m.role === "assistant") {
      const text = (contentText(m.content) ?? "").trim();
      if (text) records.push({ id: nextId(), kind: "assistant", text });
      for (const tc of m.tool_calls ?? []) {
        pending.set(tc.id, { name: tc.function.name, args: tc.function.arguments ?? "" });
      }
      continue;
    }
    if (m.role !== "tool") continue;
    const callId = m.tool_call_id;
    if (!callId) continue;
    const call = pending.get(callId);
    if (!call) continue;
    pending.delete(callId);
    records.push({
      id: nextId(),
      kind: "tool",
      name: call.name,
      args: call.args,
      output: contentText(m.content) ?? "",
    });
  }
  return records;
}

export function openTranscriptView(messages: readonly Message[]): TranscriptViewState {
  const records = snapshotMessages(messages);
  const state: TranscriptViewState = {
    records,
    cursor: Math.max(0, records.length - 1),
    scroll: 0,
    expanded: new Set(),
    searching: false,
    query: "",
    queryCursor: 0,
    lastQuery: "",
    hits: [],
    hitIndex: -1,
  };
  return state;
}

function cloneState(state: TranscriptViewState): TranscriptViewState {
  return { ...state, expanded: new Set(state.expanded), hits: state.hits.slice() };
}

function recordSearchText(rec: TranscriptRecord): string {
  if (rec.kind === "user" || rec.kind === "assistant") return rec.text;
  return `${rec.name} ${rec.args}\n${rec.output}`;
}

function needleOf(state: TranscriptViewState): string {
  const raw = state.searching ? state.query : state.lastQuery;
  return raw.trim().toLowerCase();
}

export function computeHits(state: TranscriptViewState): number[] {
  const needle = needleOf(state);
  if (!needle) return [];
  const hits: number[] = [];
  for (let i = 0; i < state.records.length; i++) {
    if (recordSearchText(state.records[i]!).toLowerCase().includes(needle)) hits.push(i);
  }
  return hits;
}

function syncHits(state: TranscriptViewState, jump: "keep" | "first" | "next" | "prev"): void {
  state.hits = computeHits(state);
  if (state.hits.length === 0) {
    state.hitIndex = -1;
    return;
  }
  if (jump === "first") {
    const after = state.hits.findIndex((i) => i >= state.cursor);
    state.hitIndex = after >= 0 ? after : 0;
  } else if (jump === "next") {
    const start = state.hitIndex < 0 ? -1 : state.hitIndex;
    state.hitIndex = (start + 1) % state.hits.length;
  } else if (jump === "prev") {
    const start = state.hitIndex < 0 ? 0 : state.hitIndex;
    state.hitIndex = (start - 1 + state.hits.length) % state.hits.length;
  } else {
    const at = state.hits.indexOf(state.cursor);
    if (at >= 0) state.hitIndex = at;
    else if (state.hitIndex < 0 || state.hitIndex >= state.hits.length) state.hitIndex = 0;
  }
  const target = state.hits[state.hitIndex];
  if (target !== undefined) {
    state.cursor = target;
    maybeExpandHit(state, target);
  }
}

function maybeExpandHit(state: TranscriptViewState, index: number): void {
  const rec = state.records[index];
  const needle = needleOf(state);
  if (!rec || rec.kind !== "tool" || !needle) return;
  const summary = `${rec.name} ${rec.args}`.toLowerCase();
  if (!summary.includes(needle) && rec.output.toLowerCase().includes(needle)) {
    state.expanded.add(rec.id);
  }
}

function setQuery(state: TranscriptViewState, query: string, cursor: number): void {
  state.query = query;
  state.queryCursor = Math.max(0, Math.min(Array.from(query).length, cursor));
  state.lastQuery = query;
  syncHits(state, "first");
}

function insertQuery(state: TranscriptViewState, text: string): void {
  const chars = Array.from(state.query);
  const i = Math.max(0, Math.min(chars.length, state.queryCursor));
  chars.splice(i, 0, ...Array.from(text));
  setQuery(state, chars.join(""), i + Array.from(text).length);
}

function deleteQueryLeft(state: TranscriptViewState): void {
  const chars = Array.from(state.query);
  if (state.queryCursor <= 0) return;
  chars.splice(state.queryCursor - 1, 1);
  setQuery(state, chars.join(""), state.queryCursor - 1);
}

function deleteQueryRight(state: TranscriptViewState): void {
  const chars = Array.from(state.query);
  if (state.queryCursor >= chars.length) return;
  chars.splice(state.queryCursor, 1);
  setQuery(state, chars.join(""), state.queryCursor);
}

function exitSearch(state: TranscriptViewState): void {
  state.searching = false;
  state.lastQuery = state.query;
  state.query = "";
  state.queryCursor = 0;
  syncHits(state, "keep");
}

function enterSearch(state: TranscriptViewState): void {
  state.searching = true;
  state.query = "";
  state.queryCursor = 0;
  state.hits = [];
  state.hitIndex = -1;
}

function moveCursor(state: TranscriptViewState, next: number): void {
  if (state.records.length === 0) {
    state.cursor = 0;
    return;
  }
  state.cursor = Math.max(0, Math.min(state.records.length - 1, next));
}

function toggleExpand(state: TranscriptViewState): void {
  const rec = state.records[state.cursor];
  if (!rec || rec.kind !== "tool") return;
  if (state.expanded.has(rec.id)) state.expanded.delete(rec.id);
  else state.expanded.add(rec.id);
}

/**
 * 视图打开时的按键分发。返回 null state 表示关闭视图。
 * Ctrl+C 的「不武装退出」由调用方保证，这里只给出 close / close-and-cancel。
 */
export function handleTranscriptAction(
  state: TranscriptViewState,
  action: KeyAction,
  opts: { busy: boolean } = { busy: false },
): { state: TranscriptViewState | null; effect: TranscriptViewEffect } {
  if (action.type === "ctrl-o") {
    return { state: null, effect: "close" };
  }
  if (action.type === "ctrl-c") {
    return { state: null, effect: opts.busy ? "close-and-cancel" : "close" };
  }
  // 终端常把连按 Esc 合并成 escape-escape：视图开着时一律关视图，
  // 绝不落到 rewind。单 Esc 仍是先退出搜索、再关视图。
  if (action.type === "escape-escape") {
    return { state: null, effect: "close" };
  }
  if (action.type === "escape") {
    const next = cloneState(state);
    if (next.searching) {
      exitSearch(next);
      return { state: next, effect: "none" };
    }
    return { state: null, effect: "close" };
  }

  const next = cloneState(state);

  if (next.searching) {
    if (action.type === "ctrl-f" || (action.type === "insert" && action.text === "/")) {
      enterSearch(next);
      return { state: next, effect: "none" };
    }
    if (action.type === "submit") {
      syncHits(next, "next");
      return { state: next, effect: "none" };
    }
    if (action.type === "insert") {
      insertQuery(next, action.text);
      return { state: next, effect: "none" };
    }
    if (action.type === "newline") {
      insertQuery(next, "\n");
      return { state: next, effect: "none" };
    }
    if (action.type === "backspace") {
      deleteQueryLeft(next);
      return { state: next, effect: "none" };
    }
    if (action.type === "delete") {
      deleteQueryRight(next);
      return { state: next, effect: "none" };
    }
    if (action.type === "left") {
      next.queryCursor = Math.max(0, next.queryCursor - 1);
      return { state: next, effect: "none" };
    }
    if (action.type === "right") {
      next.queryCursor = Math.min(Array.from(next.query).length, next.queryCursor + 1);
      return { state: next, effect: "none" };
    }
    if (action.type === "home") {
      next.queryCursor = 0;
      return { state: next, effect: "none" };
    }
    if (action.type === "end") {
      next.queryCursor = Array.from(next.query).length;
      return { state: next, effect: "none" };
    }
    if (action.type === "up") {
      moveCursor(next, next.cursor - 1);
      return { state: next, effect: "none" };
    }
    if (action.type === "down") {
      moveCursor(next, next.cursor + 1);
      return { state: next, effect: "none" };
    }
    if (action.type === "page-up") {
      moveCursor(next, next.cursor - 8);
      return { state: next, effect: "none" };
    }
    if (action.type === "page-down") {
      moveCursor(next, next.cursor + 8);
      return { state: next, effect: "none" };
    }
    return { state: next, effect: "none" };
  }

  if (action.type === "ctrl-f" || (action.type === "insert" && action.text === "/")) {
    enterSearch(next);
    return { state: next, effect: "none" };
  }
  if (action.type === "insert" && (action.text === "n" || action.text === "N")) {
    syncHits(next, action.text === "n" ? "next" : "prev");
    return { state: next, effect: "none" };
  }
  if (action.type === "submit" || (action.type === "insert" && action.text === " ")) {
    toggleExpand(next);
    return { state: next, effect: "none" };
  }
  if (action.type === "up") {
    moveCursor(next, next.cursor - 1);
    return { state: next, effect: "none" };
  }
  if (action.type === "down") {
    moveCursor(next, next.cursor + 1);
    return { state: next, effect: "none" };
  }
  if (action.type === "page-up") {
    moveCursor(next, next.cursor - 8);
    return { state: next, effect: "none" };
  }
  if (action.type === "page-down") {
    moveCursor(next, next.cursor + 8);
    return { state: next, effect: "none" };
  }
  if (action.type === "home") {
    moveCursor(next, 0);
    return { state: next, effect: "none" };
  }
  if (action.type === "end") {
    moveCursor(next, next.records.length - 1);
    return { state: next, effect: "none" };
  }
  // 其它键吞掉，不落到输入框。
  return { state: next, effect: "none" };
}

function toolSummary(rec: Extract<TranscriptRecord, { kind: "tool" }>): string {
  const args = rec.args.replace(/\s+/g, " ").trim();
  return args ? `⚡ ${rec.name} ${args}` : `⚡ ${rec.name}`;
}

function recordLines(rec: TranscriptRecord, width: number, expanded: boolean): string[] {
  const inner = Math.max(8, width - 2);
  if (rec.kind === "user" || rec.kind === "assistant") {
    const mark = rec.kind === "user" ? c.accent("❯") : c.accent("●");
    const wrapped = wrapAnsi(rec.text, inner);
    if (wrapped.length === 0) return [`${mark} `];
    return wrapped.map((line, i) => (i === 0 ? `${mark} ${line}` : `  ${line}`));
  }
  const head = truncate(`  ${toolSummary(rec)}`, width);
  if (!expanded) return [head];
  const body = rec.output.length === 0 ? [c.dim("  （无输出）")] : wrapAnsi(rec.output, inner).map((l) => `  ${l}`);
  return [head, ...body];
}

export interface TranscriptPanelOpts {
  width: number;
  height: number;
  busy: boolean;
}

export interface TranscriptPanel {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

function footerLines(state: TranscriptViewState, width: number, busy: boolean): string[] {
  const parts = [TRANSCRIPT_FOOTER_SEARCH, "↑↓ 滚动", "Esc 关闭"];
  if (!state.searching) parts.splice(1, 0, "Enter/Space 展开");
  const out = [truncateAnsi(c.dim(parts.join(" · ")), width)];
  if (state.searching) {
    const q = `/${state.query}`;
    out.push(truncateAnsi(q, width));
  }
  if (busy) out.push(truncateAnsi(c.dim(TRANSCRIPT_FOOTER_BUSY), width));
  return out;
}

function flatten(state: TranscriptViewState, width: number): { lines: string[]; startAt: number[] } {
  const lines: string[] = [];
  const startAt: number[] = [];
  if (state.records.length === 0) {
    lines.push(c.muted(EMPTY_TRANSCRIPT_HINT));
    startAt.push(0);
    return { lines, startAt };
  }
  for (let i = 0; i < state.records.length; i++) {
    const rec = state.records[i]!;
    startAt.push(lines.length);
    const block = recordLines(rec, width, state.expanded.has(rec.id));
    lines.push(...block);
  }
  return { lines, startAt };
}

/** 让当前 cursor 对应的记录出现在正文窗口内；打开时默认滚到最新。 */
export function syncTranscriptScroll(state: TranscriptViewState, width: number, bodyHeight: number): void {
  const h = Math.max(1, bodyHeight);
  const { lines, startAt } = flatten(state, width);
  const start = startAt[state.cursor] ?? 0;
  const nextStart = startAt[state.cursor + 1] ?? lines.length;
  if (nextStart - 1 >= state.scroll + h) {
    state.scroll = Math.max(0, nextStart - h);
  }
  if (start < state.scroll) {
    state.scroll = start;
  }
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, lines.length - h)));
}

export function renderTranscriptPanel(state: TranscriptViewState, opts: TranscriptPanelOpts): TranscriptPanel {
  const width = Math.max(20, opts.width);
  const height = Math.max(3, opts.height);
  const footer = footerLines(state, width, opts.busy);
  const header = [truncateAnsi(c.bold(TRANSCRIPT_TITLE), width), c.dim("─".repeat(Math.min(width, 40)))];
  const reserved = header.length + footer.length;
  const bodyHeight = Math.max(1, height - reserved);
  syncTranscriptScroll(state, width, bodyHeight);
  const { lines, startAt } = flatten(state, width);
  const slice = lines.slice(state.scroll, state.scroll + bodyHeight);
  while (slice.length < bodyHeight) slice.push("");

  const out = [...header, ...slice, ...footer];
  while (out.length < height) out.push("");
  if (out.length > height) out.length = height;

  let cursorRow = header.length;
  let cursorCol = 0;
  if (state.searching) {
    const qRow = header.length + bodyHeight + 1; // after the hint footer, on the /query line
    cursorRow = Math.min(height - 1, Math.max(0, qRow));
    cursorCol = Math.min(width - 1, 1 + state.queryCursor);
  } else {
    const start = startAt[state.cursor] ?? 0;
    cursorRow = Math.max(0, Math.min(height - 1, header.length + (start - state.scroll)));
    cursorCol = 0;
  }
  return { lines: out.slice(0, height).map((l) => truncateAnsi(l, width)), cursorRow, cursorCol };
}
