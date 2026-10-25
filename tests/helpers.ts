/**
 * tests/helpers.ts — 共享测试脚手架（不参与 bun test 发现：文件名不带 .test）。
 *
 * 项目约定禁 `mock.module` 全局污染（bun test 单进程共享模块表），
 * 因此 TTY 行为一律走构造注入。这个文件集中 Console 的注入样板，
 * 避免 4 个测试文件各抄一遍（v0.2.3 simplify 审查的 reuse 项）。
 */
import { Console } from "../src/ui/console.ts";

export interface CaptureConsole {
  ui: Console;
  /** 已写入的全部字符（按调用顺序拼接）。 */
  out: () => string;
  /** 清空已捕获输出（不断开后续捕获）。 */
  clear: () => void;
}

export function captureConsole(
  opts: {
    stdoutIsTTY?: boolean;
    stdinIsTTY?: boolean;
    columns?: number;
    /** true = 紧凑工具行（toolcall_info_details=false）。默认 false（详情模式）。 */
    compact?: boolean;
  } = {},
): CaptureConsole {
  const chunks: string[] = [];
  const ui = new Console(false, !(opts.compact ?? false), {
    stdoutIsTTY: opts.stdoutIsTTY ?? true,
    stdinIsTTY: opts.stdinIsTTY ?? false,
    columns: () => opts.columns ?? 100,
    write: (s) => chunks.push(s),
  });
  return {
    ui,
    out: () => chunks.join(""),
    clear: () => {
      chunks.length = 0;
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
