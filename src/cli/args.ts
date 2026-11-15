import type { PermissionMode } from "../agent.ts";
import { helpText } from "./help.ts";
import { JsonlWriter } from "../streamJson.ts";
import { c } from "../ui/theme.ts";

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

export interface Args {
  print: string | null;
  model: string | null;
  provider: string | null;
  tier: string | null;
  auto: string | null;
  cwd: string | null;
  mode: PermissionMode;
  resume: string | null;
  name: string | null;
  listSessions: boolean;
  noReasoning: boolean;
  continueLast: boolean;
  help: boolean;
  version: boolean;
  /** -p 输出格式：text（默认）| json（P0-6，stdout 单行）| stream-json（#37，stdout JSONL）。 */
  outputFormat: "text" | "json" | "stream-json";
  /** #59：CLI 有序备用链（可重复 --fallback）；出现即完整替换 settings 链。 */
  fallbackArgs: string[];
  /** #59：本次运行禁用备用链（与 --fallback 互斥）。 */
  noFallback: boolean;
  /** --worktree <name>：在托管 worktree 里开会话（issue #9）。 */
  worktree: string | null;
  /** 参数值非法（如 --output-format bogus）：main 直接返回 2。 */
  badArgs: boolean;
  rest: string[];
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    print: null,
    model: null,
    provider: null,
    tier: null,
    auto: null,
    cwd: null,
    mode: "ask",
    resume: null,
    name: null,
    listSessions: false,
    noReasoning: false,
    continueLast: false,
    help: false,
    version: false,
    outputFormat: "text",
    fallbackArgs: [],
    noFallback: false,
    worktree: null,
    badArgs: false,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] ?? "";
    // #59：--fallback=<provider>:<model> 与空格形式等价，可重复，出现顺序即优先级。
    if (v.startsWith("--fallback=")) {
      a.fallbackArgs.push(v.slice("--fallback=".length).trim());
      continue;
    }
    // 等号形式（--output-format=json）也要认，否则编排器写 `--flag=value` 会被静默忽略。
    if (v.startsWith("--output-format=")) {
      const val = v.slice("--output-format=".length).trim();
      if (val !== "text" && val !== "json" && val !== "stream-json") {
        console.error(`✖ --output-format 只支持 text | json | stream-json（收到 "${val}"）`);
        a.badArgs = true;
      } else {
        a.outputFormat = val;
      }
      continue;
    }
    switch (v) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-v":
      case "--version":
        a.version = true;
        break;
      case "-p":
      case "--print":
        a.print = argv[++i] ?? "";
        break;
      case "-m":
      case "--model":
        a.model = argv[++i] ?? null;
        break;
      case "-P":
      case "--provider":
        a.provider = argv[++i] ?? null;
        break;
      case "-t":
      case "--tier":
        a.tier = argv[++i] ?? null;
        break;
      case "--auto":
        a.auto = argv[++i] ?? null;
        break;
      case "-C":
      case "--cwd":
        a.cwd = argv[++i] ?? null;
        break;
      // issue #9：整会话进托管 worktree。-w 在 neo 里没有别的主人（-y/-c/-p/-m/-P/-t/-C 都占了）。
      case "-w":
      case "--worktree":
        a.worktree = argv[++i] ?? "";
        break;
      case "-y":
      case "--yes":
        a.mode = "auto-all";
        break;
      case "--edit":
        a.mode = "auto-edit";
        break;
      case "--plan":
        a.mode = "plan";
        break;
      case "--resume": {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-") && next.trim() !== "") {
          a.resume = next;
          i += 1;
        } else {
          a.resume = "last"; // --resume 后面直接跟 flag/结束 → 取最近可恢复
        }
        break;
      }
      case "--name":
        a.name = argv[++i] ?? "";
        break;
      case "-c":
      case "--continue":
        a.continueLast = true;
        break;
      case "--sessions":
        a.listSessions = true;
        break;
      case "--no-reasoning":
        a.noReasoning = true;
        break;
      case "--output-format": {
        const v = (argv[++i] ?? "").trim();
        if (v !== "text" && v !== "json" && v !== "stream-json") {
          console.error(`✖ --output-format 只支持 text | json | stream-json（收到 "${v}"）`);
          a.badArgs = true;
        } else {
          a.outputFormat = v;
        }
        break;
      }
      case "--fallback": {
        a.fallbackArgs.push((argv[++i] ?? "").trim());
        break;
      }
      case "--no-fallback":
        a.noFallback = true;
        break;
      default:
        a.rest.push(v);
    }
  }
  return a;
}

export const HELP = helpText();

/**
 * #37：已明确识别为 stream-json 的用法错误也遵守 JSONL。
 *
 * 会话创建前就收口：stdout 为一条 error + 恰好一条 result，session_id=null；
 * stderr 保留一条可读诊断。退出码固定 2，不引入任何退出码判断逻辑
 * （#52 的 driveExitCode() 只服务正常路径的 result，属 #17b 接线）。
 */
export async function streamJsonUsageError(message: string): Promise<number> {
  const writer = new JsonlWriter({ sessionId: null });
  writer.emitError({
    code: "usage_error",
    message,
    provider: null,
    model: null,
  });
  writer.emitResult({
    status: "usage_error",
    exit_code: 2,
    provider: null,
    model: null,
    usage: { prompt: 0, completion: 0, reasoning: 0, by_model: [] },
    drive: null,
    error: message,
  });
  console.error(c.err(`✖ ${message}`));
  await writer.flush();
  writer.dispose();
  return 2;
}

