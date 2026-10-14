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

import { loadConfig, maskKey, type Config } from "./config.ts";
import { Agent, type PermissionMode } from "./agent.ts";
import { Console } from "./ui/console.ts";
import { banner, c, rule } from "./ui/theme.ts";
import { renderMarkdown } from "./ui/render.ts";
import { buildMemoryFile, buildSystemPrompt } from "./system-prompt.ts";
import { listModels, type Message } from "./llm.ts";
import { toolNames } from "./tools/index.ts";
import { createSession, listSessions, loadSession, saveSession, type SessionMeta } from "./session.ts";

const VERSION = "0.1.0";

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

interface Args {
  print: string | null;
  model: string | null;
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
  bun run src/index.ts -m <model>      指定模型
  bun run src/index.ts -C <dir>        指定工作目录
  bun run src/index.ts --resume        恢复上一次会话
  bun run src/index.ts --sessions      列出会话

${c.bold("选项")}
  -p, --print <text>    单次模式
  -m, --model <id>      覆盖模型
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
  /model [id]      查看/切模型     /tools       工具列表
  /mode [m]        权限模式        /init        生成 AGENTS.md
  /history         历史统计        /save [path] 导出会话
  /sessions        历史会话        /exit        退出
  !<cmd>           直接执行 shell

${c.bold("环境变量")}
  NEO_API_KEY / NEO_BASE_URL / NEO_MODEL  覆盖 settings.json
`;

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

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

  const cfg = loadConfig(overrides);

  if (!cfg.apiKey) {
    console.error(c.err("✖ 未找到 API key。请设置 NEO_API_KEY 或在 settings.json 中填写 api-key。"));
    return 2;
  }

  const ui = new Console(cfg.theme === "matrix");

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

  const agent = new Agent({
    cfg,
    console: ui,
    mode: args.mode,
    systemPrompt: buildSystemPrompt(cfg),
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
    if (!stats.aborted) ui.blank();
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
    ui.line(banner(cfg.model, cfg.baseUrl));
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
        await runShell(line.slice(1), cfg, ui);
        continue;
      }

      if (line.startsWith("/")) {
        await handleCommand(line, agent, ui, cfg, sess.meta, shutdown);
        continue;
      }

      ui.blank();
      try {
        const stats = await agent.send(line);
        ui.blank();
        showStats(ui, agent, stats);
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

function showStats(ui: Console, agent: Agent, stats: {
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  finishReason: string | null;
  aborted: boolean;
}): void {
  const cum = agent.cumulative;
  const usage = agent.contextUsage();
  ui.statusBar([
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
      ui.kv("model", c.accent(cfg.model));
      ui.kv("endpoint", c.muted(cfg.baseUrl));
      ui.kv("api key", c.muted(maskKey(cfg.apiKey)));
      ui.kv("prompt", `${cum.prompt} tokens`);
      ui.kv("completion", `${cum.completion} tokens`);
      ui.kv("thinking", `${cum.reasoning} tokens`);
      ui.kv("context", `${(agent.contextUsage() * 100).toFixed(1)}% of ${cfg.contextWindow}`);
      ui.kv("messages", String(agent.messages.length));
      ui.blank();
      break;
    }

    case "model": {
      if (!arg) {
        ui.blank();
        ui.kv("当前模型", c.accent(cfg.model));
        ui.line(c.dim("  用 /model <id> 切换，或 neo -m <id>"));
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
      ui.success(`模型已切到 ${arg}（本次会话内生效）。`);
      break;
    }

    case "tools":
      ui.blank();
      ui.kv("可用工具", String(toolNames().length));
      for (const t of toolNames()) ui.line(`  ${c.tool("⚡")} ${c.text(t)}`);
      ui.blank();
      break;

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

async function runShell(cmdline: string, cfg: Config, ui: Console): Promise<void> {
  const cmd = cmdline.trim();
  if (!cmd) return;
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
