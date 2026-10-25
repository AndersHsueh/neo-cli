/**
 * tools/shellMarks.ts — `shell` 工具输出里标记行的唯一定义（v0.2.3）。
 *
 * 为什么单独成文件：`src/tools/index.ts` 负责生产这些标记，
 * `src/ui/toolLog.ts` 负责消费（失败摘要 / `/last`）。两边各自写字符串字面量时
 * tsc 抓不到漂移；放在这个零依赖模块里，生产与消费共享同一份定义，
 * 又不让 UI 层反向依赖整个工具注册表（避免循环依赖）。
 */

/** shell 输出中的标记行。 */
export const shellMarks = {
  /** 命令行首行：`$ <command>`。 */
  cmdPrefix: "$ ",
  cmd: (command: string): string => `$ ${command}`,
  /** stderr 段落前缀。 */
  stderr: "[stderr] ",
  stderrPrefix: "[stderr]",
  /** 退出码末行：`[exit N]`。 */
  exit: (code: number): string => `[exit ${code}]`,
  exitRe: /^\[exit (-?\d+)\]$/,
} as const;
