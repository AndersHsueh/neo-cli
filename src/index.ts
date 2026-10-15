#!/usr/bin/env bun
/**
 * neo —— Matrix 风格的终端编程助手。
 *
 * 交互模式：直接输入自然语言或 /命令；! 开头的行直接走 shell。
 * 单次模式：-p "问题" 执行一轮后退出，适合脚本化。
 */
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

import {
  loadConfig,
  maskKey,
  switchProvider,
  switchTier,
  applyTier,
  describeRoute,
  isImplemented,
  IMPLEMENTED_PROVIDER_TYPES,
  ConfigError,
  isModelTier,
  MODEL_TIERS,
  type Config,
} from "./config.ts";
import { Classifier, CLASSIFIER_NAMES, isClassifierName, type ClassifierName } from "./classifier/index.ts";
import { Agent, type PermissionMode } from "./agent.ts";
import { Console } from "./ui/console.ts";
import { banner, c, rule } from "./ui/theme.ts";
import { renderMarkdown } from "./ui/render.ts";
import { buildMemoryFile, buildSystemPrompt } from "./system-prompt.ts";
import { listModels, type Message } from "./llm.ts";
import { toolNames } from "./tools/index.ts";
import { discoverSkills, isValidSkillName, formatSkillLine, normalizeDescription } from "./skills.ts";
import { createSession, listSessions, loadSession, saveSession, type SessionMeta } from "./session.ts";

const VERSION = "0.0.3";

/** /auto 列表里各实现的说明。 */
const DESC: Record<string, string> = {
  off: "关闭自动分类，始终用手动选的档位",
  rule: "规则分类器，零延迟零成本（默认）",
  llm: "用 classifier_model_name 判定，多一次调用",
};

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

interface Args {
  print: string | null;
  model: string | null;
  provider: string | null;
  tier: string | null;
  auto: string | null;
  cwd: string | null;
  mode: PermissionMode;
  resume: string | null;
  listSessions: boolean;
  noReasoning: boolean;
  continueLast: boolean;
  help: boolean;
  version: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    print: null,
    model: null,
    provider: null,
    tier: null,
    auto: null,
    cwd: null,
    mode: "ask",
    resume: null,
    listSessions: false,
    noReasoning: false,
    continueLast: false,
    help: false,
    version: false,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] ?? "";
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
      case "--resume":
        a.resume = argv[++i] ?? "last";
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
      default:
        a.rest.push(v);
    }
  }
  return a;
}

const HELP = `
${c.accent("neo")} ${c.dim(`v${VERSION}`)} — Matrix 风格的终端编程助手

${c.bold("用法")}
  bun run src/index.ts                 进入交互模式
  bun run src/index.ts -p "问题"        单次执行一轮后退出
  bun run src/index.ts -P <provider>   指定 provider
  bun run src/index.ts -t <tier>       指定模型档位
  bun run src/index.ts -C <dir>        指定工作目录
  bun run src/index.ts --resume        恢复上一次会话
  bun run src/index.ts --sessions      列出会话

${c.bold("选项")}
  -p, --print <text>    单次模式
  -m, --model <id>      直接指定模型 ID（绕过档位）
  -P, --provider <name> 切换 provider
  -t, --tier <name>     模型档位：${MODEL_TIERS.join(" / ")}
  -C, --cwd <dir>       切换工作目录
  -y, --yes             自动批准所有操作（慎用）
      --edit            自动批准文件写入，shell 仍需批准
      --plan            只读模式，禁止一切写操作
  -c, --continue        继续上一次会话
      --resume [id]     恢复会话（默认 last）
      --sessions        列出历史会话
      --no-reasoning    不显示思维链
  -h, --help            显示帮助
  -v, --version         显示版本

${c.bold("交互命令")}
  /help            帮助            /clear       清空上下文
  /compact         压缩上下文      /cost        token 统计
  /provider        切换 provider   /model       查看/切模型
  /tools           工具列表        /mode        权限模式
  /skills          列出可用技能    /skills <名>  查看技能详情
  /init            生成 AGENTS.md  /history     历史统计
  /save [path]     导出会话        /sessions    历史会话
  /tier [name]     查看/切档位      /auto [name] 切换分类器（off/rule/llm）
  /fast /balanced /deep            档位快捷方式（等价 /tier）
  /why             上次分类判定与理由
  /exit            退出
  !<cmd>           直接执行 shell（受权限模式约束）

${c.bold("环境变量")}
  NEO_PROVIDER / NEO_TIER / NEO_MODEL / NEO_BASE_URL / NEO_API_KEY  覆盖 settings.json
  NEO_CLASSIFIER_PROVIDER / NEO_CLASSIFIER_MODEL                    指定分类器用的 provider 与模型
`;

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // 参数合法性先于 --help/--version 校验。
  // 否则 `--auto bogus --version` 会打印版本后返回 0，
  // 把一个拼写错误静默放过 —— 下次真正跑起来才报错，更难查。
  if (args.auto && !isClassifierName(args.auto)) {
    console.error(c.err(`✖ 未知分类器 "${args.auto}"。可选：${CLASSIFIER_NAMES.join(", ")}`));
    return 2;
  }
  if (args.tier && !isModelTier(args.tier)) {
    console.error(c.err(`✖ 未知档位 "${args.tier}"。可选：${MODEL_TIERS.join(", ")}`));
    return 2;
  }

  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.version) {
    console.log(c.accent(`neo v${VERSION}`));
    return 0;
  }

  const overrides: Partial<Config> = {};
  if (args.model) overrides.model = args.model;
  if (args.cwd) overrides.cwd = args.cwd;
  if (args.noReasoning) overrides.showReasoning = false;

  // provider 与档位要在配置载入后处理：它们决定 model 的解析方式
  let cfg: Config;
  try {
    cfg = loadConfig(overrides);

    if (args.tier && isModelTier(args.tier)) {
      const r = applyTier(cfg, args.tier);
      if (!r.ok) {
        console.error(c.err(`✖ ${r.error}`));
        return 2;
      }
    }
    if (args.provider) {
      const r = switchProvider(cfg, args.provider);
      if (!r.ok) {
        console.error(c.err(`✖ ${r.error}`));
        return 2;
      }
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(c.err(`✖ 配置错误：${e.message}`));
      return 2;
    }
    throw e;
  }

  if (!cfg.apiKey) {
    console.error(
      c.err(`✖ provider "${cfg.providerName}" 没有配置 api_key。`) +
        c.dim("\n  请在 settings.json 的 providers 中填写，或设置环境变量 NEO_API_KEY。"),
    );
    return 2;
  }

  const ui = new Console(cfg.theme === "matrix");

  // default_provider 指向未接入的协议时，必须在启动就拦下。
  // 放过的话会一路走到 fetch，得到的错误跟配置问题无关，排查方向完全被带偏。
  if (!isImplemented(cfg.providerType)) {
    const pending = cfg.providers.filter((p) => !isImplemented(p.type)).map((p) => p.name);
    console.error(
      c.err(`✖ default_provider "${cfg.providerName}" 使用 ${cfg.providerType} 协议，请求层尚未接入。`) +
        c.dim(`\n  已实现的协议：${IMPLEMENTED_PROVIDER_TYPES.join(", ")}。`) +
        c.dim("\n  可用 -P 指定其他 provider，或改 settings.json 的 default_provider。") +
        c.dim(`\n  已配置但未接入：${pending.join(", ") || "无"}`),
    );
    return 2;
  }

  if (cfg.legacyFormat) {
    ui.warn("检测到旧版扁平配置（api-key / OpenAI / model_name），已自动折算为 provider \"legacy\"。");
    ui.line(c.dim("  新格式见 settings.example.json。"));
  }

  if (args.listSessions) {
    printSessions(ui);
    return 0;
  }

  // ---- 恢复会话 ----
  let restored: Message[] | null = null;
  let meta: SessionMeta | null = null;
  if (args.resume !== null || args.continueLast) {
    const target = args.resume ?? "last";
    if (target === "last") {
      const last = listSessions(1)[0];
      if (!last) {
        ui.warn("没有可恢复的历史会话。");
      } else {
        const full = loadSession(last.id);
        restored = full?.messages ?? null;
        meta = full?.meta ?? last;
      }
    } else {
      const full = loadSession(target);
      if (!full) ui.warn(`未找到会话 ${target}`);
      else {
        restored = full.messages;
        meta = full.meta;
      }
    }
  }

  // 分类器。默认规则版；用 --auto 可换成 off 或 llm。
  const classifier = new Classifier(cfg, (args.auto ?? "rule") as ClassifierName);
  const agent = new Agent({
    cfg,
    console: ui,
    mode: args.mode,
    systemPrompt: buildSystemPrompt(cfg),
    classifier,
  });

  if (restored && restored.length > 0) {
    const sys = agent.messages[0];
    agent.messages = [sys as Message, ...restored.filter((m) => m.role !== "system")];
    ui.info(`已恢复会话 ${meta?.id ?? ""}（${restored.length} 条消息）`);
  }

  const sess = createSession(cfg.model, cfg.cwd);

  // 覆盖系统提示：注入项目记忆文件（若存在）
  const memoryFile = ["AGENTS.md", "NEO.md", ".neo.md"]
    .map((f) => join(cfg.cwd, f))
    .find((p) => existsSync(p));
  if (memoryFile) {
    const extra = readFileSync(memoryFile, "utf8");
    const sysMsg = agent.messages[0];
    if (sysMsg) sysMsg.content = `${sysMsg.content}\n\n## 项目记忆（来自 ${memoryFile}）\n\n${extra}`;
    ui.info(`已加载项目记忆 ${memoryFile}`);
  }

  // ---- 单次模式 ----
  if (args.print !== null) {
    const prompt = args.print || args.rest.join(" ");
    if (!prompt.trim()) {
      console.error(c.err("✖ -p 需要提供内容"));
      return 2;
    }
    const stats = await agent.send(prompt);
    persist(agent.messages, sess.meta);
    if (!stats.aborted) {
      ui.blank();
      if (stats.tierSwitch) {
        const ts = stats.tierSwitch;
        ui.line(
          `${c.accent("⇅")} 档位 ${c.dim(ts.from)} → ${c.accent(ts.to)} ` +
            `${c.dim(`(${cfg.providerName}/${cfg.model})`)}`,
        );
        ui.line(`  ${c.dim("理由:")} ${c.muted(ts.reason)}`);
        if (ts.degraded) ui.line(`  ${c.warn("降级:")} ${c.warn(ts.degraded)}`);
        ui.blank();
      }
    }
    return stats.aborted ? 130 : 0;
  }

  // 也允许 `neo 你的问题` 直接作为首轮输入（非交互）
  if (args.rest.length > 0 && !process.stdin.isTTY) {
    await agent.send(args.rest.join(" "));
    persist(agent.messages, sess.meta);
    return 0;
  }

  // ---- 交互模式 ----
  if (process.stdin.isTTY) {
    ui.line(banner(cfg.model, cfg.baseUrl, cfg.providerName, cfg.modelTier));
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.accent("❯")} `,
    historySize: 200,
  });
  const prompt = (): void => {
    rl.prompt();
  };

  /**
   * 审批问句统一走 readline.question。
   * 关键：不要另开 raw-mode stdin 监听，否则 readline 会重复回显输入。
   * question 会自动挂起/恢复 line 事件，因此外层队列不会被问句污染。
   */
  ui.setAsker((q: string) => new Promise<string>((resolve) => rl.question(q, (a) => resolve(a))));

  const shutdown = (): void => {
    persist(agent.messages, sess.meta);
    ui.blank();
    ui.line(c.dim("再见。"));
    rl.close();
    process.exit(0);
  };

  const onSigint = (): void => {
    if (queue.length > 0 || draining) {
      agent.cancel();
      ui.line(c.warn("^C 已中断当前请求"));
      return;
    }
    shutdown();
  };
  process.on("SIGINT", onSigint);

  // 输入串行化：粘贴多行或快速回车时，readline 的 line 事件会并发触发。
  // 用队列 + 单 worker 保证处理顺序与输出不交错。
  const queue: string[] = [];
  let draining = false;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const line = queue.shift() ?? "";
      if (!line) continue;

      if (line.startsWith("!")) {
        await runShell(line.slice(1), cfg, ui, agent.mode);
        continue;
      }

      if (line.startsWith("/")) {
        await handleCommand(line, agent, ui, cfg, classifier, sess.meta, shutdown);
        continue;
      }

      ui.blank();
      try {
        const stats = await agent.send(line);
        ui.blank();
          ui.blank();
      // 档位切换必须显式告知 —— 静默换模型会让人困惑「为什么这轮答得不一样」
      if (stats.tierSwitch) {
        const ts = stats.tierSwitch;
        ui.line(
          `${c.accent("⇅")} 档位 ${c.dim(ts.from)} → ${c.accent(ts.to)} ` +
            `${c.dim(`(${cfg.providerName}/${cfg.model})`)}`,
        );
        ui.line(`  ${c.dim("理由:")} ${c.muted(ts.reason)}`);
        if (ts.degraded) ui.line(`  ${c.warn("降级:")} ${c.warn(ts.degraded)}`);
        ui.blank();
      }
      showStats(ui, agent, cfg, stats);
      } catch (e) {
        ui.error(`未捕获异常: ${(e as Error).message}`);
        if (process.env["NEO_DEBUG"]) console.error(e);
      }
      persist(agent.messages, sess.meta);
    }
    draining = false;
    prompt();
  };

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    queue.push(line);
    void drain();
  });

  rl.on("close", () => {
    process.off("SIGINT", onSigint);
  });

  prompt();

  await new Promise<void>((resolve) => rl.on("close", () => resolve()));
  return 0;
}

function persist(messages: Message[], meta: SessionMeta): void {
  try {
    const copy = messages.filter((m) => m.role !== "system");
    meta.turns = copy.filter((m) => m.role === "user").length;
    saveSession(copy, meta);
  } catch {
    // 落盘失败不打断交互
  }
}

/* ------------------------------------------------------------------ */
/* 统计栏                                                              */
/* ------------------------------------------------------------------ */

function showStats(ui: Console, agent: Agent, cfg: Config, stats: {
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  finishReason: string | null;
  aborted: boolean;
  tierSwitch: { from: string; to: string; reason: string; degraded?: string } | null;
}): void {
  const cum = agent.cumulative;
  const usage = agent.contextUsage();
  ui.statusBar([
    ["model", `${cfg.providerName}/${cfg.model}`],
    ["tier", cfg.modelTier],
    ["stop", String(stats.finishReason ?? "stop")],
    ["tok", `${stats.promptTokens}↑ ${stats.completionTokens}↓`],
    ["think", String(stats.reasoningTokens)],
    ["tools", String(stats.toolCalls)],
    ["ctx", `${(usage * 100).toFixed(1)}%`],
    ["msgs", String(agent.historyLength)],
    ["$", (stats.durationMs / 1000).toFixed(2) + "s"],
    ["total", `${cum.prompt}↑ ${cum.completion}↓`],
  ]);
}

/* ------------------------------------------------------------------ */
/* 斜杠命令                                                            */
/* ------------------------------------------------------------------ */

async function handleCommand(
  line: string,
  agent: Agent,
  ui: Console,
  cfg: Config,
  classifier: Classifier,
  meta: SessionMeta,
  shutdown: () => void,
): Promise<void> {
  const [cmdRaw, ...rest] = line.slice(1).split(/\s+/);
  const cmd = (cmdRaw ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
    case "?":
      ui.line(HELP);
      break;

    case "clear":
      agent.reset();
      ui.success("上下文已清空。");
      break;

    case "compact": {
      ui.line("压缩上下文中…");
      const ok = await agent.compact();
      if (ok) ui.success(`压缩完成。上下文使用率 ${(agent.contextUsage() * 100).toFixed(1)}%`);
      else ui.warn("对话太短或压缩失败，未做处理。");
      break;
    }

    case "cost": {
      const cum = agent.cumulative;
      ui.blank();
      ui.kv("provider", `${c.accent(cfg.providerName)} ${c.dim(`(${cfg.providerType})`)}`);
      ui.kv("tier", c.muted(cfg.modelTier));
      ui.kv("model", c.accent(cfg.model));
      ui.kv("endpoint", c.muted(cfg.baseUrl));
      ui.kv("api key", c.muted(maskKey(cfg.apiKey)));
      ui.kv("max_tokens", String(cfg.maxTokens));
      ui.kv("temperature", String(cfg.temperature));
      ui.kv("prompt", `${cum.prompt} tokens`);
      ui.kv("completion", `${cum.completion} tokens`);
      ui.kv("thinking", `${cum.reasoning} tokens`);
      ui.kv("context", `${(agent.contextUsage() * 100).toFixed(1)}% of ${cfg.contextWindow}`);
      ui.kv("messages", String(agent.messages.length));
      ui.blank();
      break;
    }

    case "provider": {
      const p = cfg.providers.find((x) => x.name === cfg.providerName);
      if (!arg) {
        ui.blank();
        ui.kv("当前", `${c.accent(cfg.providerName)} ${c.dim(`(${cfg.providerType})`)}`);
        ui.blank();
        for (const x of cfg.providers) {
          const on = x.name === cfg.providerName;
          const usable = isImplemented(x.type);
          const tag = usable ? "" : c.warn(" [未接入]");
          ui.line(
            `${on ? c.accent("●") : c.dim("○")} ${on ? c.bright(x.name) : c.muted(x.name)} ` +
              `${c.dim(x.type)} ${c.dim("→")} ${c.muted(x.baseUrl)}${tag}`,
          );
          if (on) {
            for (const tier of MODEL_TIERS) {
              const mark = tier === cfg.modelTier ? c.accent("▸") : " ";
              ui.line(`    ${mark} ${c.dim(tier.padEnd(15))} ${c.muted(x.models[tier])}`);
            }
          }
        }
        ui.line(c.dim("  用 /provider <name> 切换"));
        ui.blank();
        break;
      }
      const r = switchProvider(cfg, arg);
      if (!r.ok) {
        ui.warn(r.error);
        break;
      }
      agent.noteModelChange(cfg);
      ui.success(`provider → ${cfg.providerName}（${cfg.providerType}）`);
      ui.kv("model", `${cfg.model} ${c.dim(`[${cfg.modelTier}]`)}`);
      ui.kv("endpoint", cfg.baseUrl);
      break;
    }

    case "tier":
    // 档位快捷方式。存在的理由：规则分类器的 override 规则（/deep、/fast…）
    // 匹配的是用户输入，若没有对应分支，输入会在到达分类器之前
    // 就被 handleCommand 当成未知命令吃掉 —— 规则永远等不到它的输入。
    case "fast":
    case "balanced":
    case "deep":
    case "deep_reasoning":
    case "default": {
      // /deep 等价于 /tier deep_reasoning；带参数时（如 `/deep 分析这段代码`）
      // 前半段是档位指令，其余作为普通输入继续走 agent。
      const target = cmd === "deep" ? "deep_reasoning" : cmd;
      // /tier 不带参数时是查询操作：列出全部档位的生效路由。
      if (cmd === "tier" && rest.length === 0) {
        ui.blank();
        ui.kv("当前档位", c.accent(cfg.modelTier));
        ui.kv("生效路由", `${c.accent(describeRoute(cfg, cfg.modelTier))}`);
        ui.blank();
        for (const tier of MODEL_TIERS) {
          const on = tier === cfg.modelTier;
          ui.line(
            `${on ? c.accent("●") : c.dim("○")} ${on ? c.bright(tier.padEnd(15)) : c.muted(tier.padEnd(15))} ` +
              `${c.dim("→")} ${c.muted(describeRoute(cfg, tier))}`,
          );
        }
        ui.line(c.dim("  用 /tier <name> 切换"));
        ui.blank();
        break;
      }
      if (!isModelTier(target)) {
        ui.warn(`未知档位 "${target}"。可选：${MODEL_TIERS.join(", ")}`);
        break;
      }
      const r = applyTier(cfg, target);
      if (!r.ok) {
        ui.warn(r.error);
        break;
      }
      agent.noteModelChange(cfg);
      if (r.degraded && r.note) ui.warn(r.note);
      ui.success(`档位 → ${cfg.modelTier}（${cfg.providerName} / ${cfg.model}）`);
      // 剩余文本当作下一轮用户输入，不丢内容。
      if (rest.length > 0) await agent.send(rest.join(" "));
      break;
    }

    case "auto": {
      if (!arg) {
        ui.blank();
        ui.kv("自动分类", `${c.accent(classifier.name)}`);
        ui.kv("分类器模型", `${c.muted(cfg.classifierProvider)} / ${c.muted(cfg.classifierModel)}`);
        ui.kv("连续工具失败", String(agent.toolFailureStreak));
        ui.blank();
        for (const n of CLASSIFIER_NAMES) {
          ui.line(
            `${n === classifier.name ? c.accent("●") : c.dim("○")} ` +
              `${n === classifier.name ? c.bright(n) : c.muted(n)} ${c.dim(DESC[n] ?? "")}`,
          );
        }
        ui.line(c.dim("  用 /auto <off|rule|llm> 切换"));
        ui.blank();
        break;
      }
      if (!isClassifierName(arg)) {
        ui.warn(`未知分类器 "${arg}"。可选：${CLASSIFIER_NAMES.join(", ")}`);
        break;
      }
      try {
        classifier.use(arg, cfg);
        ui.success(`自动分类 → ${arg}`);
      } catch (e) {
        ui.warn((e as Error).message);
      }
      break;
    }

    case "why": {
      ui.blank();
      ui.kv("分类器", c.accent(classifier.name));
      const last = classifier.lastResult;
      if (!last) {
        ui.info("还没有产生过判定。发一条消息后用 /why 查看。");
      } else {
        ui.kv("判定档位", c.accent(last.tier));
        ui.kv("来源", c.muted(last.source));
        ui.kv("理由", c.text(last.reason));
      }
      const fail = classifier.lastFailure;
      if (fail) ui.kv("上次失败", c.err(fail));
      ui.kv("当前生效", `${cfg.modelTier} → ${cfg.providerName} / ${cfg.model}`);
      ui.blank();
      break;
    }

    case "model": {
      if (!arg) {
        ui.blank();
        ui.kv("当前模型", `${c.accent(cfg.model)} ${c.dim(`(${cfg.modelTier})`)}`);
        ui.line(c.dim("  用 /model <id> 直接指定模型，或 /tier <档位> 切换档位"));
        ui.line(c.dim("  服务端可用模型："));
        try {
          const models = await listModels(cfg);
          for (const m of models) {
            ui.line(m === cfg.model ? `  ${c.accent("●")} ${c.bright(m)}` : `  ${c.dim("○")} ${c.muted(m)}`);
          }
        } catch (e) {
          ui.error(`获取模型列表失败: ${(e as Error).message}`);
        }
        ui.blank();
        break;
      }
      cfg.model = arg;
      agent.noteModelChange(cfg);
      ui.success(`模型已切到 ${arg}（本次会话内生效，已绕过档位）。`);
      break;
    }

    case "tools":
      ui.blank();
      ui.kv("可用工具", String(toolNames().length));
      for (const t of toolNames()) ui.line(`  ${c.tool("⚡")} ${c.text(t)}`);
      ui.blank();
      break;

    case "skills": {
      const skills = discoverSkills(cfg);
      if (arg) {
        // 约束 16：这是给**人**看的只读诊断入口 —— 不加载全文，也不建软链。
        // 软链只由 use_skill 创建（那是模型行为，且会在输出里告知）。
        // 所以这里只从已发现的索引里查，不能走 resolveSkill —— 它会建软链，
        // 让一条纯查看命令悄悄改动了用户的项目目录。
        //
        // 但名称白名单仍要先过：arg 来自用户输入，`../etc` 这类必须报「非法」而非
        // 混入下面的 find() 变成一句语义错误的「不存在」—— 否则路径穿越的形态被掩盖了。
        if (!isValidSkillName(arg)) {
          ui.error(`技能名非法: ${arg}`);
          if (skills.length > 0) ui.info(`可用技能：${skills.map((s) => s.name).join(", ")}`);
          break;
        }
        const hit = skills.find((s) => s.name === arg);
        if (!hit) {
          ui.error(`技能不存在: ${arg}`);
          if (skills.length > 0) ui.info(`可用技能：${skills.map((s) => s.name).join(", ")}`);
          break;
        }
        ui.blank();
        ui.kv("名称", hit.name);
        // 用与索引/list 完全相同的规范化函数，保证三处 description 逐字一致
        ui.kv("说明", normalizeDescription(hit.description, hit.name));
        ui.kv("来源", hit.source === "project" ? "项目" : "全局");
        ui.kv("路径", hit.absPath);
        let first = "";
        try {
          first = (readFileSync(join(hit.absPath, "SKILL.md"), "utf8").split("\n") ?? [])
            .find((l) => l.trim().startsWith("# "))
            ?.trim() ?? "";
        } catch {
          /* ignore */
        }
        if (first) ui.kv("标题", first);
        ui.blank();
        ui.info("完整正文请让模型调用 use_skill。");
        break;
      }

      ui.blank();
      if (skills.length === 0) {
        ui.info(`没有可用技能。把技能目录放到 ${join(cfg.cwd, "skills")} 或全局技能库。`);
        ui.blank();
        break;
      }
      ui.kv("可用技能", String(skills.length));
      for (const s of skills) {
        const dot = c.tool("●");
        // 形态与 system prompt 索引一致（formatSkillLine 保证 description 截断口径统一），
        // 但**保留来源与软链标注** —— 它们是 name/description 之外的信息，
        // 去掉会让用户看不出某技能是项目私有还是全局、是否为软链产物。
        // 统一的是「技能行里name:description 的写法」，不是「只能有这两项」。
        const origin = `${s.source === "project" ? "项目" : "全局"}${s.linked ? " · 软链" : ""}`;
        ui.line(`  ${dot} ${formatSkillLine(s.name, s.description)}${origin ? `　[${origin}]` : ""}`);
      }
      ui.blank();
      ui.info("用 /skills <名称> 查看详情，或让模型按需 use_skill。");
      ui.blank();
      break;
    }

    case "mode": {
      const modes: Array<[string, string]> = [
        ["1", "ask — 写文件/执行命令都需批准"],
        ["2", "auto-edit — 自动批准写文件，命令仍需批准"],
        ["3", "auto-all — 全部自动批准（慎用）"],
        ["4", "plan — 只读，禁止一切写操作"],
      ];
      if (!arg) {
        ui.blank();
        ui.kv("当前模式", c.accent(agent.mode));
        for (const [k, d] of modes) ui.line(`  ${c.accent(k)}) ${d}`);
        ui.line(c.dim("  用 /mode <1-4> 切换"));
        ui.blank();
        break;
      }
      const map: Record<string, PermissionMode> = {
        "1": "ask", ask: "ask", "2": "auto-edit", "3": "auto-all", "4": "plan", plan: "plan",
      };
      const m = map[arg];
      if (!m) {
        ui.warn(`未知模式 ${arg}`);
        break;
      }
      agent.mode = m;
      ui.success(`权限模式 → ${m}`);
      break;
    }

    case "init": {
      const target = join(cfg.cwd, arg || "AGENTS.md");
      if (existsSync(target)) {
        const ok = await ui.confirm(`${target} 已存在，覆盖？`);
        if (!ok) {
          ui.info("已取消。");
          break;
        }
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buildMemoryFile(cfg), "utf8");
      ui.success(`已生成 ${target}`);
      break;
    }

    case "history": {
      const msgs = agent.messages;
      ui.blank();
      ui.kv("消息总数", String(msgs.length));
      ui.kv("用户消息", String(msgs.filter((m) => m.role === "user").length));
      ui.kv("助手消息", String(msgs.filter((m) => m.role === "assistant").length));
      ui.kv("工具结果", String(msgs.filter((m) => m.role === "tool").length));
      ui.kv("工具调用", String(msgs.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0)));
      ui.blank();
      break;
    }

    case "save": {
      const target = arg ? resolve(cfg.cwd, arg) : join(cfg.cwd, "neo-session.json");
      writeFileSync(target, JSON.stringify({ meta, messages: agent.messages }, null, 2), "utf8");
      ui.success(`会话已保存到 ${target}`);
      break;
    }

    case "sessions":
      printSessions(ui);
      break;

    case "exit":
    case "quit":
      shutdown();
      break;

    default:
      ui.warn(`未知命令 /${cmd}。用 /help 查看全部命令。`);
  }
}

/* ------------------------------------------------------------------ */
/* shell 直通                                                          */
/* ------------------------------------------------------------------ */

/**
 * `!cmd` 直通 shell。
 *
 * 权限必须与工具层的 approve 保持一致 —— 否则 `--plan` 只读模式下
 * `!rm -rf` 照样执行，「只读模式」就名存实亡了。
 * 规则：plan 一律拒；auto-all 直接放行；auto-edit 与 ask 都要审批。
 */
async function runShell(
  cmdline: string,
  cfg: Config,
  ui: Console,
  mode: PermissionMode,
): Promise<void> {
  const cmd = cmdline.trim();
  if (!cmd) return;

  if (mode === "plan") {
    ui.warn(`plan 模式禁止执行 shell：${cmd}`);
    return;
  }
  if (mode !== "auto-all") {
    const ok = await ui.confirm(`shell — 执行: ${cmd}`);
    if (!ok) {
      ui.info("已拒绝。");
      return;
    }
  }

  ui.blank();
  ui.line(`${c.dim("$")} ${c.text(cmd)}`);
  try {
    const proc = Bun.spawn(["/bin/zsh", "-lc", cmd], {
      cwd: cfg.cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) ui.line(c.dim(`exit ${code}`));
  } catch (e) {
    ui.error(`执行失败: ${(e as Error).message}`);
  }
  ui.blank();
}

function printSessions(ui: Console): void {
  const list = listSessions(15);
  ui.blank();
  if (list.length === 0) {
    ui.info("还没有历史会话。");
    ui.blank();
    return;
  }
  ui.kv("历史会话", String(list.length));
  for (const s of list) {
    ui.line(
      `  ${c.accent(s.id)} ${c.dim(s.updatedAt.slice(0, 16).replace("T", " "))} ` +
        `${c.muted(`${s.turns} 轮`)} ${c.dim(s.model)}`,
    );
  }
  ui.line(c.dim("  用 neo --resume <id> 恢复"));
  ui.blank();
}

/* ------------------------------------------------------------------ */

const code = await main();
void homedir;
void rule;
process.exit(code);
