/**
 * source-size.test.ts — 源文件体积守卫。
 *
 * docs/maintenance.md 未给出数字阈值。本测试采用 1000 行作为 src 目录内所有 TypeScript 文件
 * 的工作上限，依据是仓库自身的规模分布：大量模块自然落在 500–650 行；
 * `src/streamJson.ts`（940 行）是单一协议模块，不为一拆而拆；超过 1000 行
 * 的都是混合职责的历史堆叠文件（入口、斜杠命令、配置、循环、TUI、工具、LLM）。
 *
 * 规格：拆分过大源文件，使 src 下单个 TypeScript 文件不超过工作上限。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "../src");
/** src 下单个 TypeScript 源文件的工作上限（行）。 */
export const SRC_MAX_LINES = 1000;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function lineCount(path: string): number {
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  // 与 wc -l 对齐：文件以换行结尾时不把末尾空行计进去。
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

describe("源文件行数上限", () => {
  test("S1 src 下单个 TypeScript 源文件不超过 1000 行", () => {
    const files = listTsFiles(SRC_ROOT).sort();
    expect(files.length).toBeGreaterThan(10);
    const oversized = files
      .map((path) => ({
        path: relative(join(SRC_ROOT, ".."), path).replaceAll("\\", "/"),
        lines: lineCount(path),
      }))
      .filter((f) => f.lines > SRC_MAX_LINES)
      .sort((a, b) => b.lines - a.lines);
    expect(oversized).toEqual([]);
  });
});
