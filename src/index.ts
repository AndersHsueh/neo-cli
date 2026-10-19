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
import { HotkeyRouter, doubleStrike } from "./hotkeys.ts";
import { PasteCollector, shouldFold, assemblePaste } from "./paste.ts";
import { makeTextAttachment, makeImageAttachment, bindAttachments, resolveLine, type Attachment, type QueuedLine } from "./attachments.ts";
import { readClipboardImage } from "./clipboard.ts";
import { select, type SelectDeps } from "./ui/select.ts";
import { Console } from "./ui/console.ts";
import { banner, c, rule, truncate } from "./ui/theme.ts";
import { renderMarkdown } from "./ui/render.ts";
import { buildMemoryFile, buildSystemPrompt } from "./system-prompt.ts";
import { ensureProfile as initEnsureProfile, reInjectProfile as initReInjectProfile, recordIndex as initRecordIndex, initProjectLevel as initProjectLevelImpl } from "./memory/index.ts";
import { listModels, contentText, type Message } from "./llm.ts";
import { toolNames, registerTool } from "./tools/index.ts";
import { makeTaskTool, runSubagent } from "./tools/task.ts";
import { registerWikiTools } from "./tools/wiki.ts";
import { lintWiki, formatLintReport, resolveWikiDir } from "./wiki/lint.ts";
import {
  planIngest,
  buildIngestPrompt,
  loadIngestTemplate,
  finishIngest,
  listRawFiles,
} from "./wiki/ingest.ts";
import { resolveWikiLayout } from "./wiki/paths.ts";
import { appendLog } from "./wiki/write.ts";
import { discoverSkills, isValidSkillName, formatSkillLine, normalizeDescription } from "./skills.ts";
import { applyRestored, createSession, listSessions, loadSession, saveSession, type SessionMeta } from "./session.ts";

const VERSION = "0.1.9";

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
  /wiki-lint       wiki 体检：断链/orphan/摘要/日期戳/链接密度
  /ingest [f|i]    编译 raw → wiki（无参按 log 判定：超 1 周全量并告知，否则增量）
  /init            生成 AGENTS.md  /history     历史统计
  /memory ...      记忆索引子命令（status/list/forward/reindex/redact）
  /save [path]     导出会话        /sessions    历史会话
  /resume [id]     恢复会话（无参进入选择；last = 最近一次）
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

  // task 工具：派生子代理。必须在首次 send 前注册 —— toolSpecs() 每轮现取，注册后即刻生效。
  registerTool(
    makeTaskTool({
      run: (prompt, tier, ctx) => runSubagent(agent, prompt, tier, ctx),
    }),
  );

  // wiki 工具：检索 + 回填唯一路径（raw 不可改拦截在 write_file/edit_file 内）。
  registerWikiTools(registerTool);

  if (restored && restored.length > 0) {
    agent.messages = applyRestored(agent.messages[0], restored);
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

  // PRD §6.2 / 约束 26 / 约束 27：profile 注入到 messages[1]（不追加到 messages[0]）。
  // ensureProfile 失败 / profile.md 不存在 → no-op，不阻塞主流程。
  try {
    const slice = await initEnsureProfile(cfg);
    if (slice) {
      agent.messages = await initReInjectProfile(cfg, agent.messages);
      ui.info(`已注入用户画像（${slice.estimatedTokens} tokens）`);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`profile 注入失败 ${reason}（session 不阻塞）`);
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
   * questionPending 供粘贴热键 C1 判定：问句中 rl.write(chip) 会污染问句缓冲。
   */
  let questionPending = false;
  ui.setAsker((q: string) => new Promise<string>((resolve) => {
    questionPending = true;
    rl.question(q, (a) => {
      questionPending = false;
      resolve(a);
    });
  }));

  const shutdown = (): void => {
    persist(agent.messages, sess.meta);
    ui.blank();
    ui.line(c.dim("再见。"));
    rl.close();
    process.exit(0);
  };

  // Ctrl+C 双击退出（模仿 Claude Code）：第一次按下闪现橙色提示，
  // 2 秒内再按才真正退出。挂在 SIGINT 路径而非 keypress ——
  // 否则运行中一次 Ctrl+C 会同时触发信号与 keypress 两路，提示错乱。
  // 职责划分：Ctrl+C = 信号语义，其余按键 = HotkeyRouter（keypress 语义）。
  const exitStrike = doubleStrike(
    () => shutdown(),
    {
      windowMs: 2000,
      notice: "Press Ctrl+C again to exit",
      flash: (t, ms) => ui.flashNotice(t, ms),
    },
  );

  const onSigint = (): void => {
    // C9：select 存续期间 Ctrl+C = 取消选择，不武装双击退出
    if (selectActive && selectCancel) {
      selectCancel();
      return;
    }
    if (queue.length > 0 || draining) {
      agent.cancel();
      // 中断不回滚：跑了几十轮工具的进展不该被一次误按丢掉。
      // 回滚是 ESC 的语义（输入错了重来）。
      exitStrike();
      return;
    }
    exitStrike();
  };
  process.on("SIGINT", onSigint);

  // 输入串行化：粘贴多行或快速回车时，readline 的 line 事件会并发触发。
  // 用队列 + 单 worker 保证处理顺序与输出不交错。
  // M1 粘贴增强（PRD §5.4）：queue 元素升级为 QueuedLine（行文本 + 绑定附件）。
  const queue: QueuedLine[] = [];
  let draining = false;

  // ---- 粘贴拦截（PRD §5.3 + §7 探针结论）----
  // readline 不自带 bracketed paste：启用 \x1b[?2004h 后终端才会在粘贴前后
  // 包裹 200~/201~ 标记，readline 才会发 paste-start/paste-end keypress。
  // 不支持的终端无标记，行为退化为现状（逐行提交），非回归。
  if (process.stdin.isTTY) process.stdout.write("\x1b[?2004h");
  const pasteCollector = new PasteCollector();
  let pasteTextCounter = 0; // chip 编号会话内递增（PRD §3），图片/文本各自独立
  let pasteImageCounter = 0;
  /** 待绑定附件：chip 已写入缓冲、随下一次 line 提交绑定入队（PRD §5.4）。 */
  let pendingAttachments: Attachment[] = [];

  // 粘贴期间的 line 一律收集不提交（C11 同款模式）。
  // 收集态由 paste-end 的 collector.end() 撤销（探针 §7.2：此刻最后一段仍在缓冲，
  // 由 paste-end 处理器取出组装，之后无 flush）。
  const origLineHandler = (raw: string): void => {
    if (selectActive) return; // C11：select 存续期间的 line 一律丢弃（残留提交）
    if (pasteCollector.consume(raw)) return; // 粘贴期间：收集，不入队
    const line = raw.trim();
    if (!line) return;
    const bound = bindAttachments(line, pendingAttachments);
    // 绑定即消费：chip 只对本次提交生效，防止后续消息引用同款字样被二次还原
    if (bound.length > 0) pendingAttachments = pendingAttachments.filter((a) => !bound.includes(a));
    queue.push({ text: line, attachments: bound });
    void drain();
  };
  rl.on("line", origLineHandler);

  // ESC 等按键走 keypress 语义。仅运行中响应：取消当前轮并回滚历史。
  const hotkeys = new HotkeyRouter();
  hotkeys.attach(rl, process.stdin);
  hotkeys.on("escape", () => {
    if (draining) agent.cancel();
    // 空闲时无操作，留给将来的热键语义
  });

  // ---- 粘贴边界接线（PRD §5.3 + §7 探针结论）----
  // paste-start：进入收集态。用户先打到一半的字随首行 line 提交天然带上，无需特殊处理。
  hotkeys.on("paste-start", () => pasteCollector.start());

  // ---- 图片粘贴热键（PRD §5.1 D1 + §5.2 D2）----
  // C1：仅在输入空闲时响应——readline 问句中 rl.write 会污染问句缓冲（console.ts 同源结论）。
  // C3：Ctrl+V（macOS 主键位）与 Alt+V（Win/WSL）同时绑定。
  // C4：异步读取，等待期间输入框可用；结果到达后 chip 追加到当前缓冲尾部。
  // C5：无图 → info 一行，不报错（用户可能只是想贴文本）。C6：8MB 上限。
  const onPasteImage = (): void => {
    if (draining || queue.length > 0 || selectActive || questionPending) return; // C1
    void (async (): Promise<void> => {
      let img: Awaited<ReturnType<typeof readClipboardImage>> = null;
      let err: string | null = null;
      try {
        img = await readClipboardImage();
      } catch (e) {
        err = (e as Error).message;
      }
      if (err) {
        ui.warn(err); // C9 关联：读取失败一行说明原因
        return;
      }
      if (!img) {
        ui.line(c.dim("· 剪贴板里没有图片")); // C5
        return;
      }
      if (img.data.length > cfg.paste.imageMaxBytes) {
        ui.warn(`图片超过 ${(cfg.paste.imageMaxBytes / 1024 / 1024).toFixed(0)}MB 上限（${(img.data.length / 1024 / 1024).toFixed(1)}MB），已放弃`); // C6
        return;
      }
      pasteImageCounter += 1;
      const att = makeImageAttachment(pasteImageCounter, img.data);
      pendingAttachments.push(att);
      (rl as unknown as { write(b: string): void }).write(att.chip); // C2：只走 rl.write
      ui.line(c.dim(`· 已附加 ${att.chip} (${(att.bytes / 1024).toFixed(0)}KB)`));
    })();
  };
  hotkeys.on("paste-image", onPasteImage);

  // paste-end：组装全文。此刻最后一段仍在 rl.line 缓冲（探针 §7.2），取出参与组装；
  // 取走后立即清空重绘，防止用户随后的回车把残留再提交一次。
  hotkeys.on("paste-end", () => {
    const rlAny = rl as unknown as { line: string; _refreshLine?: () => void; history: string[] };
    const buf = rlAny.line;
    rlAny.line = "";
    rlAny._refreshLine?.();
    const r = pasteCollector.end(buf);
    if (!r) return; // 纯空粘贴，缓冲未被拦截过，无需动作
    const full = assemblePaste(r.lines, r.tail);
    // history 定向回滚：粘贴期间提交的行已进 rl.history（探针 §7.5，新条目在 index 0）
    if (r.lines.length > 0 && Array.isArray(rlAny.history)) rlAny.history.splice(0, r.lines.length);
    // 折叠判定：含 \n 必折叠（readline 行缓冲装不下换行，写回会再次逐行提交）；
    // 单行超长按 fold_chars 折叠。不折叠 → 原样回填缓冲，用户无感。
    if (!shouldFold(full, { foldLines: cfg.paste.foldLines, foldChars: cfg.paste.foldChars })) {
      rlAny.line = full;
      rlAny._refreshLine?.();
      return;
    }
    pasteTextCounter += 1;
    const att = makeTextAttachment(pasteTextCounter, full);
    pendingAttachments.push(att);
    // chip 走 readline 自己的行缓冲与回显（PRD C2：绝不另开 raw-mode 监听）
    rlAny.line = att.chip;
    rlAny._refreshLine?.();
  });

  // select 组件的依赖（PRD D1 注入惯例）。clearLine 是 M0 §2 手段B：
  // select 结束时清掉行缓冲残留（↑ 历史召回 / 误触数字），防止污染下一提示符。
  // C11（M0 §3 实证）：select 存续期间 readline 仍会发 line 事件——
  // 回车提交的是当时缓冲里的残留（↑ 历史召回 / 误触字符），可能非空。
  // 置标志让 line 处理器丢弃这些事件，防止残留被当成命令/聊天消息入队。
  let selectActive = false;
  let selectCancel: (() => void) | undefined;
  const selectDeps: SelectDeps = {
    router: hotkeys,
    asker: (q: string): Promise<string> =>
      new Promise<string>((resolve) => rl.question(q, (a) => resolve(a))),
    clearLine: (): void => {
      (rl as unknown as { line: string }).line = "";
      (rl as unknown as { _refreshLine?: () => void })._refreshLine?.();
    },
    onActiveChange: (active, cancel): void => {
      selectActive = active;
      selectCancel = cancel; // C9：select 期间 Ctrl+C 路由为取消选择
    },
  };

  // PRD §6.2 / 约束 22：首次用户输入触发 recordIndex（不写 daily memory 快照，
// 只把首条输入前 200 字符落 ~/.neo/memorys/raw/）。
  let firstUserInputCaptured = false;
  const onFirstUserInput = (line: string): void => {
    if (firstUserInputCaptured) return;
    firstUserInputCaptured = true;
    initRecordIndex(cfg, cfg.cwd, { firstUserInput: line })
      .catch((e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`首次输入 recordIndex 失败 ${reason}（session 不阻塞）`);
      });
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const q = queue.shift();
      if (!q) continue;
      const line = q.text;
      if (!line) continue;

      if (line.startsWith("!")) {
        await runShell(line.slice(1), cfg, ui, agent.mode);
        continue;
      }

      if (line.startsWith("/")) {
        await handleCommand(line, agent, ui, cfg, classifier, sess.meta, shutdown, selectDeps);
        continue;
      }

      // M1/M2 粘贴增强（PRD §5.4）：chip 还原后才发给模型——文本 chip 还原原文，
      // 图片 chip 收集为 data URL 列表交给 agent.send 组装多模态 content。
      const resolved = resolveLine(line, q.attachments);
      if (resolved.images.length > 0) {
        // PRD §5.8：用户对「发出去了什么」有知情权（图片可能含敏感信息）
        ui.line(c.dim(`· 已发送图片 ×${resolved.images.length}`));
      }
      onFirstUserInput(resolved.text);
      ui.blank();
      try {
        // ESC 中止路径开启回滚：本轮（含 user 消息）整体作废，用户直接重输
        const stats = await agent.send(
          resolved.images.length > 0 ? { text: resolved.text, images: resolved.images } : resolved.text,
          { rollbackOnAbort: true },
        );
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
        // C9：本轮带图且请求失败 → 追加一行软提示（无法可靠区分「服务端拒绝图片」
        // 与其他 4xx，用软提示近似 PRD 要求，不误导为确定结论）
        if (resolved.images.length > 0) ui.line(c.dim("  当前 provider 可能不支持图片输入"));
        if (process.env["NEO_DEBUG"]) console.error(e);
      }
      persist(agent.messages, sess.meta);
    }
    draining = false;
    prompt();
  };

  rl.on("close", () => {
    process.off("SIGINT", onSigint);
    if (process.stdin.isTTY) process.stdout.write("\x1b[?2004l"); // 退出还原终端 bracketed paste 模式
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
  selectDeps: SelectDeps,
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
        // TTY：选择器接入（与 /model 同款）。含全部 provider——未接入的标注在 hint，
        // 选中后由 switchProvider 给出与显式 /provider <name> 相同的错误，不另设禁用态
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const options = cfg.providers.map((x) => ({
            label: x.name,
            hint:
              x.name === cfg.providerName
                ? `当前 · ${x.type}`
                : isImplemented(x.type)
                  ? x.type
                  : `${x.type} · 未接入`,
            value: x.name,
          }));
          const picked = await select("切换到哪个 provider？", options, {
            ...selectDeps,
            initial: Math.max(0, cfg.providers.findIndex((x) => x.name === cfg.providerName)),
          });
          if (!picked) {
            ui.info("已取消。");
            break;
          }
          const r = switchProvider(cfg, picked);
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
        // 非 TTY：维持纯列表（C8）
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
      // /tier 的档位名来自**参数**（rest[0]），不是命令名 —— 旧代码永远取 cmd，
      // 导致 `/tier default` 被解析成档位 "tier"，任何参数都报「未知档位」。
      // 快捷命令（/fast /balanced /deep…）没有参数概念，档位名就是命令名本身。
      const target = cmd === "tier" ? (rest[0] ?? "") : cmd === "deep" ? "deep_reasoning" : cmd;
      // /tier 不带参数时是查询操作：列出全部档位的生效路由。
      // 用 target === "" 判断而非 rest.length === 0："/tier "（尾随空格）
      // split 后 rest = [""]，length 为 1，但语义上仍是查询。
      if (cmd === "tier" && target === "") {
        ui.blank();
        ui.kv("当前档位", c.accent(cfg.modelTier));
        ui.kv("生效路由", `${c.accent(describeRoute(cfg, cfg.modelTier))}`);
        ui.blank();
        // TTY：选择器接入（与 /model 同款）；hint = 该档位生效路由，initial 定位当前档位
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const options = MODEL_TIERS.map((t) => ({
            label: t,
            hint: t === cfg.modelTier ? `当前 · ${describeRoute(cfg, t)}` : describeRoute(cfg, t),
            value: t,
          }));
          const picked = await select("切换到哪个档位？", options, {
            ...selectDeps,
            initial: Math.max(0, MODEL_TIERS.indexOf(cfg.modelTier)),
          });
          if (picked) {
            const r = applyTier(cfg, picked);
            if (r.ok) {
              agent.noteModelChange(cfg);
              if (r.degraded && r.note) ui.warn(r.note);
              ui.success(`档位 → ${cfg.modelTier}（${cfg.providerName} / ${cfg.model}）`);
            } else {
              ui.warn(r.error);
            }
          } else {
            ui.info("已取消。");
          }
          break;
        }
        // 非 TTY：维持纯列表（C8）
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
      // /tier 的 rest[0] 是档位名，已消费掉；快捷命令的 rest 全是剩余文本。
      const leftover = cmd === "tier" ? rest.slice(1) : rest;
      if (leftover.length > 0) await agent.send(leftover.join(" "));
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
        // D8：先取列表——失败维持现有错误输出，不进选择器
        let models: string[] | null = null;
        try {
          models = await listModels(cfg);
        } catch (e) {
          ui.error(`获取模型列表失败: ${(e as Error).message}`);
        }
        if (models && models.length > 0 && process.stdin.isTTY) {
          // TTY：可选。当前模型 hint「当前」+ initial 定位（D8）
          ui.stopSpinner(); // C1：进入前收尾 spinner
          ui.blank();
          const options = models.map((m) => ({
            label: m,
            hint: m === cfg.model ? "当前" : undefined,
            value: m,
          }));
          const picked = await select("切换到哪个模型？", options, {
            ...selectDeps,
            initial: Math.max(0, models.indexOf(cfg.model)),
          });
          if (picked) {
            // 与显式 /model <id> 同一收尾（F2 缺口补齐）
            cfg.model = picked;
            agent.noteModelChange(cfg);
            ui.success(`模型已切到 ${picked}（本次会话内生效，已绕过档位）。`);
          } else {
            ui.info("已取消。");
          }
        } else if (models) {
          // 非 TTY / 空列表：维持现有纯列表展示（C8）
          ui.line(c.dim("  用 /model <id> 直接指定模型，或 /tier <档位> 切换档位"));
          ui.line(c.dim("  服务端可用模型："));
          for (const m of models) {
            ui.line(m === cfg.model ? `  ${c.accent("●")} ${c.bright(m)}` : `  ${c.dim("○")} ${c.muted(m)}`);
          }
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

    case "wiki-lint": {
      const dir = resolveWikiDir(cfg.cwd);
      if (!dir) {
        ui.warn(
          `未找到 wiki 目录（${join(cfg.cwd, ".neo", "wiki", "wiki")} 或 ${join(cfg.cwd, "wiki")}）。` +
            `先跑 /init 创建骨架，或确认目录位置。`,
        );
        break;
      }
      const result = lintWiki(dir);
      ui.line(formatLintReport(result));
      const s = result.summary;
      const total = s.broken + s.orphans + s.lowlinks + s.nosummary + s.nostamp;
      if (total === 0) ui.success("wiki 体检通过。");
      else {
        ui.warn(
          `共 ${total} 项待处理（断链 ${s.broken} / 孤儿 ${s.orphans} / 密度 ${s.lowlinks}` +
            ` / 摘要 ${s.nosummary} / 日期戳 ${s.nostamp}）`,
        );
      }
      break;
    }

    case "ingest": {
      const layout = resolveWikiLayout(cfg.cwd);
      if (!layout) {
        ui.warn(`未找到 wiki 骨架（${join(cfg.cwd, ".neo", "wiki")}）。先跑 /init。`);
        break;
      }
      let plan;
      try {
        plan = planIngest(layout, arg);
      } catch (e) {
        ui.warn((e as Error).message);
        break;
      }
      if (plan.files.length === 0 && plan.removed.length === 0) {
        ui.info(`raw/ 无变更，无需编译。`);
        finishIngest(layout);
        break;
      }
      if (plan.needsAnnounce) {
        ui.warn(`本次将做全量编译（${plan.reason}），处理 ${plan.files.length} 份 raw。`);
      } else {
        ui.info(`${plan.reason}；新增 ${plan.files.length} 份，删除 ${plan.removed.length} 份。`);
      }

      // 编译交给 fast 档子代理（机械编译活）；派发前主代理切回当前档，互不影响
      const prompt = buildIngestPrompt(layout, plan, loadIngestTemplate());
      ui.startSpinner(`子代理编译中（${plan.mode}）…`);
      const report = await runSubagent(agent, prompt, "fast", {
        cfg,
        approve: async () => true,
      });
      ui.stopSpinner();
      ui.line(report);

      finishIngest(layout);
      const hadChanges = plan.mode === "full" || plan.files.length > 0;
      if (hadChanges) {
        appendLog(layout, "ingest", `${plan.mode} 编译 ${plan.files.length} 份 raw`);
      }
      ui.success(`ingest 完成（${plan.mode}）。`);
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
        // TTY：选择器接入（与 /model 同款）；hint = 模式说明，initial 定位当前模式
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const modeList: Array<{ name: PermissionMode; desc: string }> = [
            { name: "ask", desc: "写文件/执行命令都需批准" },
            { name: "auto-edit", desc: "自动批准写文件，命令仍需批准" },
            { name: "auto-all", desc: "全部自动批准（慎用）" },
            { name: "plan", desc: "只读，禁止一切写操作" },
          ];
          const options = modeList.map((m) => ({
            label: m.name,
            hint: m.name === agent.mode ? `当前 · ${m.desc}` : m.desc,
            value: m.name,
          }));
          const picked = await select("切换到哪个权限模式？", options, {
            ...selectDeps,
            initial: Math.max(0, modeList.findIndex((m) => m.name === agent.mode)),
          });
          if (picked) {
            agent.mode = picked;
            ui.success(`权限模式 → ${picked}`);
          } else {
            ui.info("已取消。");
          }
          break;
        }
        // 非 TTY：维持编号列表（C8）
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
      // PRD §约束 14a / §约束 16 / §约束 17：额外初始化项目级 wiki 骨架 + 写 AGENTS.md 工作流段。
      // 失败按约束 17 不抛 — catch + stderr WARN。
      try {
        await initProjectLevelImpl(cfg, cfg.cwd);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`项目级 wiki 骨架创建失败（${reason}），本次会话不写索引`);
      }
      break;
    }

    case "memory": {
      // PRD §A：/memory 子命令族（status / list / forget / reindex / redact）分发占位。
      // 完整实现属 (5) 范围；本单仅落分发骨架 + status 一行。
      const sub = arg.trim();
      if (sub === "status") {
        const { listStatus } = await import("./memory/index.ts");
        const out = await listStatus(cfg, { cwd: cfg.cwd });
        ui.info(out);
      } else {
        ui.info(`/memory 子命令：status / list / forget / reindex / redact（${sub || "无"} 待 (5) 落地）`);
      }
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

    case "resume": {
      // /resume [id] —— 交互中恢复历史会话。无参时列出最近会话供选择。
      // 恢复 = 替换对话历史 + 把持久化重定向到该会话文件：
      // 这里的 meta 是 sess.meta 的同一引用，原地改写后 drain() 里的
      // persist() 会把后续对话写回被恢复的会话，而不是当前会话。
      let targetId = arg;
      if (targetId === "last") {
        const last = listSessions(1)[0];
        if (!last) {
          ui.warn("没有可恢复的历史会话。");
          break;
        }
        targetId = last.id;
      }
      if (!targetId) {
        const list = listSessions(8);
        if (list.length === 0) {
          ui.info("还没有历史会话。");
          break;
        }
        // 预览取该会话首条用户消息 —— id 是时间戳，辨识度全靠它
        const options = list.map((s) => {
          const f = loadSession(s.id);
          const firstUser = f?.messages.find((m) => m.role === "user" && (contentText(m.content) ?? "").trim());
          const preview = firstUser?.content
            ? truncate((contentText(firstUser.content) ?? "").replace(/\s+/g, " ").trim(), 46)
            : "（无文本预览）";
          return { label: `${s.id}  ${preview}`, hint: `${s.turns}轮 ${s.model}`, value: s.id };
        });
        // C1：进入前收尾 spinner；select 存续期间不得有其他输出写入
        ui.stopSpinner();
        ui.blank();
        const picked = await select("恢复哪个会话？", options, selectDeps);
        if (!picked) {
          ui.info("已取消。");
          break;
        }
        targetId = picked;
      }
      const full = loadSession(targetId);
      if (!full) {
        ui.warn(`未找到会话 ${targetId}`);
        break;
      }
      if (full.messages.length === 0) {
        ui.warn("该会话没有任何消息，无法恢复。");
        break;
      }
      agent.messages = applyRestored(agent.messages[0], full.messages);
      Object.assign(meta, full.meta, { model: cfg.model });
      ui.success(`已恢复会话 ${full.meta.id}（${full.messages.length} 条消息）`);
      const lastUser = [...full.messages]
        .reverse()
        .find((m) => m.role === "user" && (contentText(m.content) ?? "").trim());
      if (lastUser?.content) {
        ui.line(c.dim(`  上次输入：${truncate((contentText(lastUser.content) ?? "").replace(/\s+/g, " ").trim(), 60)}`));
      }
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
  ui.line(c.dim("  用 /resume <id> 或 neo --resume <id> 恢复"));
  ui.blank();
}

/* ------------------------------------------------------------------ */

const code = await main();
void homedir;
void rule;
process.exit(code);
