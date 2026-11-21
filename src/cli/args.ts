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
  /** #65: fork restored history into a new session. */
  fork: boolean;
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
  /**
   * #77：`--json-schema` 的原始取值（inline JSON 或 `@path` / 路径），未 trim。
   * null = 没给这个旗标；空串 = 给了旗标但缺值（用法错误 2）。
   * 读取与编译在 bootstrap 里做，因为路径要相对 `args.cwd` 解析。
   */
  jsonSchema: string | null;
  /** 参数值非法（如 --output-format bogus）：main 直接返回 2。 */
  badArgs: boolean;
  /**
   * #70：`--safe-mode` 以干净配置启动，排查自定义项故障。
   * 环境变量 `NEO_SAFE_MODE` 在 bootstrap 里合并；解析层只记录旗标。
   */
  safeMode: boolean;
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
    fork: false,
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
    jsonSchema: null,
    badArgs: false,
    safeMode: false,
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
    if (v.startsWith("--json-schema=")) {
      a.jsonSchema = v.slice("--json-schema=".length);
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
      case "--fork":
        a.fork = true;
        break;
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
      // #77：结构化输出。等号形式（--json-schema=<inline|path>）与空格形式等价；
      // 取值是否合法（缺值 / 读不到 / 不是可编译的 schema）由 bootstrap 判定。
      case "--json-schema":
        a.jsonSchema = argv[++i] ?? "";
        break;
      // #70：排障用干净配置。无取值；环境变量在 bootstrap 合并。
      case "--safe-mode":
        a.safeMode = true;
        break;
      default:
        a.rest.push(v);
    }
  }
  if (a.fork && a.resume === null && !a.continueLast) {
    console.error("✖ --fork 必须搭配 --resume 或 --continue");
    a.badArgs = true;
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

