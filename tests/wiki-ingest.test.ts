/**
 * ingest 计划与状态测试（src/wiki/ingest.ts）。
 *
 * 覆盖：模式判定矩阵（显式参数 / 无参按 log 时间 / 快照缺失回落）、
 * 差集计算（新增/删除）、状态快照读写、提示词组装。
 *
 * 运行：bun test tests/wiki-ingest.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  planIngest,
  readIngestState,
  writeIngestState,
  clearIngestState,
  listRawFiles,
  isStale,
  buildIngestPrompt,
  loadIngestTemplate,
  finishIngest,
} from "../src/wiki/ingest.ts";
import { resolveWikiLayout } from "../src/wiki/paths.ts";
import { appendLog } from "../src/wiki/write.ts";
import type { WikiLayout } from "../src/wiki/paths.ts";

const ROOT = join(tmpdir(), `neo-wiki-ingest-${Date.now()}`);
const CWD = join(ROOT, "proj");
mkdirSync(join(CWD, ".neo", "wiki", "wiki"), { recursive: true });
mkdirSync(join(CWD, ".neo", "wiki", "raw", "sub"), { recursive: true });

const LAYOUT = resolveWikiLayout(CWD)! as WikiLayout;

function raw(rel: string, content = "素材"): void {
  const p = join(LAYOUT.rawDir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}
function delRaw(rel: string): void {
  const p = join(LAYOUT.rawDir, rel);
  if (existsSync(p)) rmSync(p);
}

function daysAgoLog(n: number): void {
  const d = new Date(Date.now() - n * 24 * 3600 * 1000);
  const p = (x: number, w = 2): string => String(x).padStart(w, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  // 直接写 log（appendLog 用当天日期，这里需要控制日期）
  const { appendFileSync } = require("node:fs") as typeof import("node:fs");
  appendFileSync(join(LAYOUT.pagesDir, "log.md"), `## [${stamp}] ingest | 历史条目\n`, "utf8");
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* listRawFiles / isStale                                              */
/* ------------------------------------------------------------------ */

describe("listRawFiles 与 isStale", () => {
  test("递归列出 raw 文件（相对路径、排序、忽略点文件）", () => {
    raw("a.md");
    raw("sub/b.md");
    raw(".hidden.md");
    expect(listRawFiles(LAYOUT)).toEqual(["a.md", "sub/b.md"]);
  });

  test("isStale：无 log → true；8 天前 → true；3 天前 → false", () => {
    delRaw("a.md");
    delRaw("sub/b.md");
    rmSync(join(LAYOUT.pagesDir, "log.md"), { force: true });
    expect(isStale(LAYOUT)).toBe(true);

    daysAgoLog(8);
    expect(isStale(LAYOUT)).toBe(true);

    daysAgoLog(3);
    expect(isStale(LAYOUT)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* planIngest 判定矩阵                                                 */
/* ------------------------------------------------------------------ */

describe("planIngest 模式判定", () => {
  test("显式 full → 全量；显式 incremental 无快照 → 回落全量并要求告知", () => {
    const p1 = planIngest(LAYOUT, "full");
    expect(p1.mode).toBe("full");
    expect(p1.reason).toContain("用户指定");

    const p2 = planIngest(LAYOUT, "incremental");
    expect(p2.mode).toBe("full");
    expect(p2.reason).toContain("无上次 ingest 快照");
    expect(p2.needsAnnounce).toBe(true);
  });

  test("无参 + 3 天前 ingest + 有快照 → 增量，差集正确", () => {
    clearIngestState(LAYOUT);
    raw("a.md");
    raw("b.md");
    writeIngestState(LAYOUT, ["a.md", "b.md"]); // 上次快照：a、b
    raw("c.md"); // 新增
    delRaw("b.md"); // 删除

    const p = planIngest(LAYOUT, "");
    expect(p.mode).toBe("incremental");
    expect(p.needsAnnounce).toBe(false);
    expect(p.files).toEqual(["c.md"]);
    expect(p.removed).toEqual(["b.md"]);
  });

  test("无参 + 8 天前 ingest → 自动全量并要求告知", () => {
    clearIngestState(LAYOUT);
    rmSync(join(LAYOUT.pagesDir, "log.md"), { force: true });
    daysAgoLog(8);
    raw("x.md");
    const p = planIngest(LAYOUT, "");
    expect(p.mode).toBe("full");
    expect(p.needsAnnounce).toBe(true);
    expect(p.reason).toContain("超过 1 周");
    expect(p.files).toContain("x.md");
  });

  test("无参 + 从未 ingest → 全量但无需宣告（第一次本来就是全量）", () => {
    clearIngestState(LAYOUT);
    rmSync(join(LAYOUT.pagesDir, "log.md"), { force: true });
    const p = planIngest(LAYOUT, "");
    expect(p.mode).toBe("full");
    expect(p.needsAnnounce).toBe(false);
    expect(p.reason).toContain("首次");
  });

  test("非法参数抛错", () => {
    expect(() => planIngest(LAYOUT, "turbo")).toThrow(/未知参数/);
  });
});

/* ------------------------------------------------------------------ */
/* 状态与收尾                                                          */
/* ------------------------------------------------------------------ */

describe("状态快照", () => {
  test("write → read 往返；损坏状态回落 null；finishIngest 刷成当前全集", () => {
    clearIngestState(LAYOUT);
    expect(readIngestState(LAYOUT)).toBeNull();

    writeIngestState(LAYOUT, ["a.md"]);
    expect(readIngestState(LAYOUT)?.lastRawFiles).toEqual(["a.md"]);

    // 损坏文件 → null
    const statePath = join(LAYOUT.pagesDir, "..", "ingest-state.json");
    writeFileSync(statePath, "{broken", "utf8");
    expect(readIngestState(LAYOUT)).toBeNull();

    raw("z.md");
    finishIngest(LAYOUT);
    const s = readIngestState(LAYOUT)!;
    expect(s.lastRawFiles).toContain("a.md");
    expect(s.lastRawFiles).toContain("z.md");
  });
});

/* ------------------------------------------------------------------ */
/* 提示词组装                                                          */
/* ------------------------------------------------------------------ */

describe("buildIngestPrompt", () => {
  test("全量与增量的任务描述含目录与清单", () => {
    const tpl = loadIngestTemplate();
    expect(tpl).toContain("wiki 编译子代理");
    expect(tpl).toContain("不修改 raw 文件");

    const full = planIngest(LAYOUT, "full");
    const p1 = buildIngestPrompt(LAYOUT, full, tpl);
    expect(p1).toContain("全量模式");
    expect(p1).toContain("z.md");
    expect(p1).toContain(LAYOUT.pagesDir);

    clearIngestState(LAYOUT);
    writeIngestState(LAYOUT, ["z.md"]);
    raw("new.md");
    const inc = planIngest(LAYOUT, "incremental");
    const p2 = buildIngestPrompt(LAYOUT, inc, tpl);
    expect(p2).toContain("增量模式");
    expect(p2).toContain("new.md");
    expect(p2).toContain("已过时");
  });
});
