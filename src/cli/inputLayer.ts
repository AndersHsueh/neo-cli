import { createInterface } from "node:readline";
import { tierDisplayName } from "../config.ts";
import { editInEditor } from "../editor.ts";
import { persist, replayTranscript } from "./sessions.ts";
import { VERSION } from "./version.ts";
import { HotkeyRouter, doubleStrike } from "../hotkeys.ts";
import { PasteCollector, shouldFold, assemblePaste } from "../paste.ts";
import { makeTextAttachment, makeImageAttachment, bindAttachments, type Attachment } from "../attachments.ts";
import { clipboardImagePlatform, readClipboardImage } from "../clipboard.ts";
import type { SelectDeps } from "../ui/select.ts";
import { Composer, type ComposerStatus } from "../tui/composer.ts";
import { getBranch } from "../git.ts";
import { TitleAnimator } from "../tui/title.ts";
import { banner, c } from "../ui/theme.ts";
import { applyMatch, completeLine, formatCandidateHint, triggerAt } from "../input/completion.ts";
import { COMMANDS } from "../input/commands.ts";
import { appendContinuation, continuationPrompt, emptyContinuation, finishContinuation, isActiveContinuation, newlineKindsFromBytes, stripContinuationMarker, type Continuation } from "../input/multiline.ts";
import { todosSummary } from "../tools/todo.ts";
import { toolNames } from "../tools/index.ts";
import { describeShell, getShell } from "../shell.ts";
import { bootLines } from "../bootDiagnostics.ts";
import type { AppSession } from "./sessionStart.ts";
import { createRepl } from "./repl.ts";
import { installFatalSignalHandlers } from "../signals.ts";

type RlInternal = { line: string; cursor: number; _refreshLine?: () => void; history?: string[] };
interface TabCycle {
  start: number;
  matches: string[];
  index: number;
  /** 上次应用后的整行，用于判断用户是否改过。 */
  applied: string;
  /** 上次应用后的光标位置。 */
  cursorAfter: number;
}

/**
 * 交互模式：启动块 + 输入源（composer / readline）+ drain 循环，直到退出。
 */
export async function runInteractive(s: AppSession): Promise<number> {
  const {
    args,
    cfg,
    interactiveTTY,
    preComposerRows,
    dock,
    ui,
    restored,
    sess,
    checkpoints,
    rewindLog,
    memory,
    closeMailbox,
    overBudget,
    agent,
    sessionTodos,
    memoryFile
  } = s;
  // ---- 交互模式 ----
  if (process.stdin.isTTY) {
    // 启动输出顺序（issue #18）：banner → shell 行 → 项目记忆提示 → shell 解析告警 → --resume 回放。
    // 记忆提示必须**紧邻**真实 shell 状态行的下一行（用户先看到「在哪跑、用什么 shell」，
    // 再看到「带了哪份项目记忆」），所以注入留在上面、提示行挪到这里，且只打一次。
    // shell 解析告警（如 settings shell.path 不可执行而回退）仍然可见，但排在记忆提示之后：
    // 它插在中间会打断「shell 行 → 记忆提示」的紧邻关系（#18 独立验收 MUST FIX 1）。
    ui.line(banner(cfg.model, cfg.baseUrl, cfg.providerName, tierDisplayName(cfg.modelTier), toolNames(cfg).join(" ")));
    // v0.4.0 平台适配层：一眼可见实际使用的 shell，解析告警不静默。
    const bootShell = getShell(cfg);
    const overBudgetNotice = overBudget.takePending();
    for (const row of bootLines({
      shell: c.dim(`  shell ${describeShell(bootShell)}`),
      memory: memoryFile ? `已加载项目记忆 ${memoryFile}` : null,
      // issue #20 收尾：超预算提示排在启动块里（banner 之后），别插到 banner 前面。
      warnings: [
        ...bootShell.warnings,
        ...(overBudgetNotice ? [overBudgetNotice] : []),
      ],
    })) {
      if (row.kind === "shell") ui.line(row.text);
      else if (row.kind === "memory") ui.info(row.text);
      else ui.warn(row.text);
    }
    s.bootBlockPrinted = true;
    // v0.2.3 D4：--resume 之后屏幕不能是空的 —— 回放最近几轮，人和上下文对齐
    if (restored && restored.length > 0) replayTranscript(ui, agent.messages);
  }

  const repl = createRepl(s);
  // ---- 输入源二选一：TTY 用 composer（底部 live 帧）；非 TTY 保留 v0.2.4 readline ----
  if (interactiveTTY) {
    repl.composer = new Composer({
      stdin: process.stdin as unknown as NodeJS.ReadStream,
      stdout: process.stdout,
      getStatus: (): ComposerStatus => ({
        version: VERSION,
        model: cfg.model,
        tier: tierDisplayName(cfg.modelTier),
        mode:
          args.mode === "auto-edit" ? "edit" : args.mode === "auto-all" ? "yolo" : args.mode,
        // 规划态（issue #14）单独显示，避免与 /mode plan 的只读闸门混淆。
        planning: agent.planning,
        branch: getBranch(cfg.cwd),
        ctxUsage: repl.ctxUsage(),
        elapsedMs: repl.turnActive ? Math.max(0, Date.now() - repl.turnStartedAt) : repl.lastTurnMs,
        active: repl.turnActive,
        tokensTotal: agent.cumulative.prompt + agent.cumulative.completion,
        todosSummary: todosSummary(sessionTodos),
      }),
      commands: COMMANDS,
      files: () => repl.fileIndex.list(),
      onSubmit: (text, attachments) => repl.submitUserLine(text, attachments as Attachment[]),
      // issue #30：输入态 shell 模式 → 入队标记 shell，由 drain 直接跑 shell（与 `?` 悬浮态解耦）
      onShellCommand: (command) => {
        repl.queue.push({ text: command, attachments: [], origin: "user", shell: true });
        s.composerRef?.setQueueCount(repl.queue.length);
        repl.runDrainSafely();
      },
      onExit: () => {
        void repl.shutdown();
      },
      onCancelTurn: () => {
        agent.cancel();
        // issue #16：ESC 只取消当前 turn —— 后台任务是独立的，误杀会让用户白等。
        // 有在跑的就把出口指出来，别让人以为 ESC 也把后台一起停了。
        const running = s.backgroundTasks?.runningCount ?? 0;
        if (running > 0) ui.line(c.dim(`· ${running} 个后台子代理仍在运行（/tasks cancel 可取消）`));
      },
      pasteText: (text) => {
        repl.pasteTextCounter += 1;
        const att = makeTextAttachment(repl.pasteTextCounter, text);
        return { chip: att.chip, attachment: att };
      },
      pasteImage: async () => {
        // v0.4.0：Linux 暂无剪贴板图片实现（PD-2），直接当作无图。
        if (clipboardImagePlatform() === "unsupported") return null;
        const img = await readClipboardImage();
        if (!img) return null;
        if (img.data.length > cfg.paste.imageMaxBytes) {
          throw new Error(
            `图片超过 ${(cfg.paste.imageMaxBytes / 1024 / 1024).toFixed(0)}MB 上限`,
          );
        }
        repl.pasteImageCounter += 1;
        const att = makeImageAttachment(repl.pasteImageCounter, img.data);
        return { chip: att.chip, attachment: att };
      },
      // issue #62：Ctrl+G 用外部编辑器撰写提示词。
      // 输入框负责挂起/恢复 TUI；这里只提供「跑编辑器」这一件事。
      editInEditor: async (current: string) =>
        editInEditor({
          initial: current,
          env: { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR },
        }),
      paste: { foldLines: cfg.paste.foldLines, foldChars: cfg.paste.foldChars },
      beforeUserCommit: () => dock?.flushPending(),
      onResize: () => dock?.resize(),
      // issue #47：交互式 rewind 菜单（空闲连按两次 Esc）。与 /rewind 命令同一份 apply 逻辑。
      rewind: {
        list: () => rewindLog.list(),
        apply: (target, mode) => {
          const r = rewindLog.rewind({
            target,
            mode,
            store: { undoSeqs: (seqs) => checkpoints.undoSeqs(seqs) },
            conversation: {
              length: () => agent.messages.length,
              truncate: (n) => {
                agent.messages.length = Math.max(1, n);
              },
            },
          });
          sess.meta.rewind = rewindLog.serialize();
          persist(agent.messages, sess.meta);
          return r;
        },
      },
    });
    s.composerRef = repl.composer;
    repl.titleAnimator = new TitleAnimator({});
    repl.titleAnimator.setName(s.sessionLabel ?? "neo");
    repl.composer.setTitleAnimator(repl.titleAnimator);
    ui.setAsker((q: string) => repl.composer!.ask(q));
    repl.selectDeps = {
      isTTY: true,
      router: { on: ((_k, _fn) => () => {}) as SelectDeps["router"]["on"] },
      asker: (q: string) => repl.composer!.ask(q),
      clearLine: () => {},
      onActiveChange: () => {},
      present: (question, options, initial) => {
        repl.selectActive = true;
        return repl.composer!.choose(question, options, initial).finally(() => {
          repl.selectActive = false;
        });
      },
    } satisfies SelectDeps;
    repl.closeInput = () => repl.composer!.stop();
    repl.promptInput = () => repl.composer!.rerender();
    const onSigintTui = (): void => {
      // !cmd 在跑时把 Ctrl+C 让给子进程（父进程别退出/别取消 turn）。
      if (repl.externalShellActive) return;
      void repl.shutdown();
    };
    const reapSession = (): void => {
      try { repl.composer?.stop(); } catch { /* 尽力还原 */ }
      try { s.cleanupEphemeralResources(); } catch { /* 清理失败不掩盖原异常 */ }
    };
    const onCrash = (e: unknown): void => {
      reapSession();
      console.error(c.err(`✖ 未捕获异常，终端已还原：${(e as Error)?.message ?? String(e)}`));
      process.exit(1);
    };
    process.on("SIGINT", onSigintTui);
    process.once("uncaughtException", onCrash);
    process.once("unhandledRejection", onCrash);
    // issue #75：SIGHUP/SIGTERM 先回收（含后台 shell）再按 129/143 退出。
    const uninstallTermSignals = installFatalSignalHandlers({
      signals: ["SIGTERM", "SIGHUP"],
      cleanup: reapSession,
    });
    try {
      repl.composer.start();
      // 启动前的 banner / 记忆提示 / --resume 回放：补写到帧上方（顺序不变）
      if (preComposerRows.length > 0) {
        repl.composer.commitAbove([...preComposerRows]);
        preComposerRows.length = 0;
      }
      await repl.fileIndexPreheat;
      await repl.composer.closed;
    } finally {
      repl.composer.stop();
      process.off("SIGINT", onSigintTui);
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
      uninstallTermSignals();
    }
  } else {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${c.accent("❯")} `,
      historySize: 200,
      // M0 探针（docs/v0.2.4-m0-probes[done].md P1/P3）：真 PTY 下 bun 原生 completer **可用**，
      // 但不传它时 Tab 会被当字面量 `\t` 插进行缓冲。这里注册一个返回空候选的 no-op：
      // 让 readline 不插字符、也不做自己的补全，Tab 的语义统一交给 HotkeyRouter
      // （我们需要 @ 与 / 同一套排序 + token 精确替换；原生 completer 没有 cursor 入参）。
      // 将来若想迁回原生 completer，删掉这个 no-op 并改 onTab 即可 —— 路线是通的。
      completer: (line: string) => [[], line] as [string[], string],
    });
    const rlC = rl;
    const prompt = (): void => {
      rl.prompt();
    };

    // v0.2.3 D5：把「重绘提示符」交回 readline（保留行缓冲与已敲入的字符）。
    // flashNotice 只负责清行 + 写提示 + 换行，绝不自己画 ❯。
    ui.setPromptRestorer(() => {
      (rl as unknown as { _refreshLine?: () => void })._refreshLine?.();
    });

    // v0.2.3 D2：宽度变化时不再用失效坐标去覆盖行（否则会吃掉用户正在输入的行）。
    const onResize = (): void => {
      ui.handleResize();
    };
    if (process.stdout.isTTY) process.stdout.on("resize", onResize);

    // ---- v0.2.4 输入层 ----
    // Tab 由我们自己接管（readline 只挂 no-op completer）：摘掉可能被插入的 `\t`
    // → 计算候选 → 改写 rl.line/cursor → 重绘。
    // 为什么不用原生 completer：它只给整行、不给光标位置，且候选样式/排序不可控；
    // 而 `@` 需要「光标前 token 精确替换」。M0 文档 P1/P2 记录了这些限制。
    const rlInternal = (): RlInternal => rl as unknown as RlInternal;
    /**
     * 连续 Tab 的候选循环状态。
     *
     * 关键：第二按 Tab 时行内容已经变成「上一次插入的候选」，此时 triggerAt 的 token
     * 也变成了候选本身 —— 不能拿 token 当循环身份（旧实现因此第二按就重新搜索、
     * 候选集缩小，首轮候选永远轮不到）。正确做法是记住「上次应用后的整行 + 插入区间」，
     * 只有当当前行与它完全一致（用户没编辑过）时才继续在**同一批候选**里推进。
     */
    let tabCycle: TabCycle | null = null;

    /**
     * 把整行写回 readline 并重绘（Tab 补全 / 续行清空共用）。
     *
     * 实测（PTY，bun 1.3.13）：无参 `rl.prompt()` 会把 rl.cursor **归零**
     * （line="ABC"/cursor=3 调用后 cursor=0，再输入 X 得到 "XABC"）；
     * `_refreshLine()` 保留 cursor。两个都调会画两遍提示符（`❯ ❯ ...`）。
     * 所以固定用 _refreshLine，prompt() 只作缺失时的兜底。
     */
    const applyLine = (line: string, cursor: number): void => {
      const r = rlInternal();
      r.line = line;
      r.cursor = cursor;
      process.stdout.write("\r\x1b[2K"); // 清掉 readline 已经画出的旧行
      if (r._refreshLine) r._refreshLine();
      else rl.prompt();
    };

    /** 同一次触发里取第 index 个候选替换进整行（首次补全与连按循环共用）。 */
    const applyLineMatches = (
      line: string,
      cursor: number,
      start: number,
      matches: string[],
      index: number,
    ): { line: string; cursor: number } => {
      const match = matches[index];
      return match === undefined ? { line, cursor } : applyMatch(line, cursor, start, match);
    };

    const formatCandidates = (kind: "file" | "command", matches: string[]): string =>
      `· ${formatCandidateHint(kind, matches)}`;

    const onTab = (): void => {
      const r = rlInternal();
      const buf = r.line ?? "";
      let cursor = typeof r.cursor === "number" ? r.cursor : buf.length;
      // 兜底：若 readline 仍把 Tab 当普通字符插进缓冲，先摘掉（守卫提前返回时也不要留脏字符）
      let line = buf;
      if (cursor > 0 && buf[cursor - 1] === "\t") {
        line = buf.slice(0, cursor - 1) + buf.slice(cursor);
        cursor -= 1;
      }
      // 该不该接管：draining 期间写 stdout/清行会和流式输出抢同一行
      if (repl.draining || repl.selectActive || repl.questionPending) {
        if (line !== buf) applyLine(line, cursor);
        return;
      }

      // 连按 Tab：与上次应用结果完全一致（用户没编辑）→ 在同一批候选里推进
      if (tabCycle && line === tabCycle.applied && cursor === tabCycle.cursorAfter) {
        const index = (tabCycle.index + 1) % tabCycle.matches.length;
        const applied = applyLineMatches(line, cursor, tabCycle.start, tabCycle.matches, index);
        tabCycle = { ...tabCycle, index, applied: applied.line, cursorAfter: applied.cursor };
        applyLine(applied.line, applied.cursor);
        return;
      }

      // 命令行走 / 分支，不提供 @ 引用补全（否则用户补出来的 @x 在提交时会被静默忽略）
      const ctx = triggerAt(line, cursor);
      if (!ctx || (ctx.kind === "file" && line.trimStart().startsWith("/"))) {
        if (line !== buf) applyLine(line, cursor);
        tabCycle = null;
        return;
      }

      const result = completeLine(line, {
        files: ctx.kind === "file" ? repl.fileIndex.list() : [],
        commands: COMMANDS,
        cursor,
      });
      if (!result || result.matches.length === 0) {
        if (line !== buf) applyLine(line, cursor);
        tabCycle = null;
        return;
      }
      const applied = applyLineMatches(line, cursor, result.start, result.matches, 0);
      tabCycle = {
        start: result.start,
        matches: result.matches,
        index: 0,
        applied: applied.line,
        cursorAfter: applied.cursor,
      };
      // 多候选第一次给出提示：列出候选名（命令带说明），让用户知道有什么可选
      if (result.matches.length > 1 && repl.queue.length === 0) {
        // 提示必须自己以换行结尾：applyLine 的第一步是 `\r\x1b[2K`，
        // 如果光标还停在提示行尾，提示会被同一行清掉（PTY 实测：屏幕上永远看不到）。
        process.stdout.write(`\n${c.dim(formatCandidates(ctx.kind, result.matches))}\n`);
      }
      applyLine(applied.line, applied.cursor);
    };

    // ---- v0.2.4 C4 多行：continuation 状态机 ----
    // Ctrl+J(0x0A) 与 Enter(0x0D) 在 keypress 上可区分，但 keypress 与 line 事件的先后
    // 实测不可靠（同一次回车顺序随分块变化）；stdin 的 data 比 readline 处理更早，
    // 用 prependListener 记下换行字节，在 line 事件里读 —— 这是唯一稳定的判定方式。
    let continuation: Continuation = emptyContinuation();
    /** 换行种类队列：一个 stdin 数据块可能产生多个 line 事件，按序消费；队空按 Enter。 */
    const newlineQueue: Array<"lf" | "cr"> = [];
    if (process.stdin.isTTY) {
      process.stdin.prependListener("data", (buf: Buffer) => {
        newlineQueue.push(...newlineKindsFromBytes(buf));
      });
    }
    const promptForContinuation = (): void => {
      rl.setPrompt(c.accent(continuationPrompt(continuation)));
    };

    /**
     * readline 只把「非空且非纯空白」的行走进 history（PTY 实测）。
     * 续行的半行不该进历史，但空行/纯空白行本来就没进 —— 无条件 splice 会误删上一条真实历史。
     */
    const dropHistory = (entry: string): void => {
      if (entry.trim() === "") return;
      const h = rlInternal().history;
      if (Array.isArray(h) && h[0] === entry) h.splice(0, 1);
    };

    /**
     * 审批问句统一走 readline.question。
     * 关键：不要另开 raw-mode stdin 监听，否则 readline 会重复回显输入。
     * question 会自动挂起/恢复 line 事件，因此外层队列不会被问句污染。
     * questionPending 供粘贴热键 C1 判定：问句中 rl.write(chip) 会污染问句缓冲。
     */
    ui.setAsker((q: string) => new Promise<string>((resolve) => {
      repl.questionPending = true;
      rl.question(q, (a) => {
        repl.questionPending = false;
        resolve(a);
      });
    }));

    // Ctrl+C 双击退出（模仿 Claude Code）：第一次按下闪现橙色提示，
    // 2 秒内再按才真正退出。挂在 SIGINT 路径而非 keypress ——
    // 否则运行中一次 Ctrl+C 会同时触发信号与 keypress 两路，提示错乱。
    // 职责划分：Ctrl+C = 信号语义，其余按键 = HotkeyRouter（keypress 语义）。
    const exitStrike = doubleStrike(
      () => {
        void repl.shutdown();
      },
      {
        windowMs: 2000,
        notice: "Press Ctrl+C again to exit",
        flash: (t, ms) => ui.flashNotice(t, ms),
      },
    );

    const onSigint = (): void => {
      // C9：select 存续期间 Ctrl+C = 取消选择，不武装双击退出
      if (repl.selectActive && repl.selectCancel) {
        repl.selectCancel();
        return;
      }
      if (repl.queue.length > 0 || repl.draining) {
        agent.cancel();
        // 中断不回滚：跑了几十轮工具的进展不该被一次误按丢掉。
        // 回滚是 ESC 的语义（输入错了重来）。
        exitStrike();
        return;
      }
      exitStrike();
    };
    process.on("SIGINT", onSigint);

    // ---- 粘贴拦截（PRD §5.3 + §7 探针结论）----
    // readline 不自带 bracketed paste：启用 \x1b[?2004h 后终端才会在粘贴前后
    // 包裹 200~/201~ 标记，readline 才会发 paste-start/paste-end keypress。
    // 不支持的终端无标记，行为退化为现状（逐行提交），非回归。
    if (process.stdin.isTTY) process.stdout.write("\x1b[?2004h");
    const pasteCollector = new PasteCollector();
    /** 待绑定附件：chip 已写入缓冲、随下一次 line 提交绑定入队（PRD §5.4）。 */
    let pendingAttachments: Attachment[] = [];

    // 粘贴期间的 line 一律收集不提交（C11 同款模式）。
    // 收集态由 paste-end 的 collector.end() 撤销（探针 §7.2：此刻最后一段仍在缓冲，
    // 由 paste-end 处理器取出组装，之后无 flush）。
    const origLineHandler = (raw: string): void => {
      // 每种换行事件只消费一个；队空（例如脚本注入）按 Enter 处理
      const newline = newlineQueue.shift() ?? "cr";
      if (repl.selectActive) return; // C11：select 存续期间的 line 一律丢弃（残留提交）
      if (pasteCollector.consume(raw)) return; // 粘贴期间：收集，不入队

      // ---- v0.2.4 C4：续行判定（Ctrl+J 或行尾反斜杠）----
      const marker = stripContinuationMarker(raw);
      // 只在真 TTY 下把 LF(0x0A) 当 Ctrl+J：管道/脚本里 \n 就是普通行终止符，
      // 若也按续行处理，`printf '/help\n' | neo` 之类会用不了（v0.2.4 回归实测）。
      const lfIsCtrlJ = process.stdin.isTTY === true && newline === "lf";
      const wantsContinue = marker.cont || (lfIsCtrlJ && !marker.cont);
      if (wantsContinue) {
        continuation = appendContinuation(continuation, marker.cont ? marker.text : raw);
        dropHistory(raw); // 半行进 history 会让 ↑ 把未完成的多行塞回单行缓冲
        promptForContinuation();
        applyLine("", 0);
        return;
      }
      const composed = isActiveContinuation(continuation) ? finishContinuation(continuation, raw) : raw;
      if (isActiveContinuation(continuation)) {
        continuation = emptyContinuation();
        promptForContinuation();
      }

      const line = composed.trim();
      if (!line) return;
      const bound = bindAttachments(line, pendingAttachments);
      // 绑定即消费：chip 只对本次提交生效，防止后续消息引用同款字样被二次还原
      if (bound.length > 0) pendingAttachments = pendingAttachments.filter((a) => !bound.includes(a));
      repl.autoTurnChain = 0; // 人类输入重置自动 turn 链
      tabCycle = null;
      repl.queue.push({ text: line, attachments: bound, origin: "user" });
      repl.runDrainSafely();
    };
    rl.on("line", origLineHandler);

    // ESC 等按键走 keypress 语义。仅运行中响应：取消当前轮并回滚历史。
    const hotkeys = new HotkeyRouter();
    hotkeys.attach(rl, process.stdin);
    hotkeys.on("escape", () => {
      // v0.2.4：续行中 ESC = 放弃多行输入（不触发 agent 取消）
      if (isActiveContinuation(continuation)) {
        continuation = emptyContinuation();
        promptForContinuation();
        applyLine("", 0);
        return;
      }
      if (repl.draining) agent.cancel();
      // 空闲时无操作，留给将来的热键语义
    });

    // v0.2.4 C1/C2：Tab 补全（bun 的 readline 不处理 Tab，只能自己接管）
    hotkeys.on("tab", onTab);

    // ---- 粘贴边界接线（PRD §5.3 + §7 探针结论）----
    // paste-start：进入收集态。用户先打到一半的字随首行 line 提交天然带上，无需特殊处理。
    hotkeys.on("paste-start", () => pasteCollector.start());

    // ---- 图片粘贴热键（PRD §5.1 D1 + §5.2 D2）----
    // C1：仅在输入空闲时响应——readline 问句中 rl.write 会污染问句缓冲（console.ts 同源结论）。
    // C3：Ctrl+V（macOS 主键位）与 Alt+V（Win/WSL）同时绑定。
    // C4：异步读取，等待期间输入框可用；结果到达后 chip 追加到当前缓冲尾部。
    // C5：无图 → info 一行，不报错（用户可能只是想贴文本）。C6：8MB 上限。
    const onPasteImage = (): void => {
      if (repl.draining || repl.queue.length > 0 || repl.selectActive || repl.questionPending) return; // C1
      // v0.4.0 平台适配层：Linux 无剪贴板图片后端（PD-2），给一次性说明而不是伪装「无图」。
      if (clipboardImagePlatform() === "unsupported") {
        if (!repl.clipboardUnsupportedNotified) {
          repl.clipboardUnsupportedNotified = true;
          ui.info("当前平台暂不支持剪贴板贴图（Linux 记入 PD-2：wl-paste / xclip）");
        }
        return;
      }
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
        repl.pasteImageCounter += 1;
        const att = makeImageAttachment(repl.pasteImageCounter, img.data);
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
      repl.pasteTextCounter += 1;
      const att = makeTextAttachment(repl.pasteTextCounter, full);
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
    repl.selectDeps = {
      router: hotkeys,
      asker: (q: string): Promise<string> =>
        new Promise<string>((resolve) => rl.question(q, (a) => resolve(a))),
      clearLine: (): void => {
        (rl as unknown as { line: string }).line = "";
        (rl as unknown as { _refreshLine?: () => void })._refreshLine?.();
      },
      onActiveChange: (active, cancel): void => {
        repl.selectActive = active;
        repl.selectCancel = cancel; // C9：select 期间 Ctrl+C 路由为取消选择
      },
    } satisfies SelectDeps;

    rl.on("close", () => {
      process.off("SIGINT", onSigint);
      if (process.stdout.isTTY) process.stdout.off("resize", onResize);
      ui.setPromptRestorer(null);
      // issue #75：readline 路径同样走完整清理（含后台 shell），不只关 MCP。
      try { s.cleanupEphemeralResources(); } catch { /* 清理失败不阻止退出 */ }
      closeMailbox();
      if (process.stdin.isTTY) process.stdout.write("\x1b[?2004l"); // 退出还原终端 bracketed paste 模式
    });

    repl.closeInput = () => rlC.close();
    repl.promptInput = () => rlC.prompt();
    await repl.fileIndexPreheat;
    prompt();
    await new Promise<void>((resolve) => rlC.on("close", () => resolve()));
  }

  closeMailbox();
  // 正常退出路径已收过，这里兜底再调一次（幂等，含后台 shell）。
  try {
    s.cleanupEphemeralResources();
  } catch {
    // 清理失败不阻止退出
  }
  // 终端关闭（Ctrl+D 等）同样冲刷记忆写队列
  try {
    await memory.flush(2000);
  } catch {
    // 记忆失败不阻止退出
  }
  return 0;
}

