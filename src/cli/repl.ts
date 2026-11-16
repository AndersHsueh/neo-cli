import { dispatchCommand } from "./commands.ts";
import { persist, showStats } from "./sessions.ts";
import { authorizeShell, executeShell, runShell } from "./shell.ts";
import { bindAttachments, resolveLine, type Attachment } from "../attachments.ts";
import type { SelectDeps } from "../ui/select.ts";
import { c } from "../ui/theme.ts";
import { FileIndex } from "../input/fileIndex.ts";
import { expandReferences } from "../input/references.ts";
import { normalizeRelPath } from "../rules/index.ts";
import { chatStream, contentText } from "../llm.ts";
import { runSubagent } from "../tools/task.ts";
import { saveSubagentTranscript, loadSubagentTranscript } from "../tools/transcript.ts";
import type { ToolCtx } from "../tools/types.ts";
import { backgroundShells } from "../tools/backgroundShell.ts";
import { runDriveCheck } from "../driveCheck.ts";
import * as mailboxState from "../mailbox/state.ts";
import { formatIncomingFrame, formatNotice, formatNoticePreview, formatPreview } from "../mailbox/inbound.ts";
import { LoopScheduler, formatLoopStatus } from "../loop.ts";
import type { RewindMode } from "../rewind.ts";
import { DriveManager, formatDriveState } from "../drive.ts";
import { makeDriveJudge } from "../driveJudge.ts";
import { outcomeOf, type LastTurnMeta } from "../turnDiagnostics.ts";
import type { AppSession } from "./sessionStart.ts";

export type ReplState = Record<string, any>;

/**
 * 队列 / drain / shutdown / idle tick。输入源在 inputLayer 里接上。
 */
export function createRepl(s: AppSession): ReplState {
  const {
    cfg,
    ui,
    classifier,
    sess,
    checkpoints,
    rewindLog,
    memoryMode,
    memory,
    mailbox,
    inboundRefs,
    collectInbound,
    promptManager,
    projectRules,
    alwaysOnRules,
    agent,
    restoredJobs,
    syncBackgroundJobs,
    sessionTodos,
    mcpManager
  } = s;
  const repl = {} as ReplState;
  // ---- 共享：队列 / drain / 输入源抽象（TTY composer 与 readline 共用）----
  repl.composer = null;
  repl.titleAnimator = null;
  repl.externalShellActive = false;
  repl.promptInput = () => {};
  repl.closeInput = () => {};
  repl.selectDeps = {
    router: { on: ((_k, _fn) => () => {}) as SelectDeps["router"]["on"] },
    isTTY: false,
  };
  // 空闲 tick 的互斥条件（select / 审批问句期间不塞 mailbox 自动 turn）
  repl.selectActive = false;
  repl.selectCancel = undefined;
  repl.questionPending = false;
  repl.clipboardUnsupportedNotified = false;
  // 输入串行化：粘贴多行或快速回车时，readline 的 line 事件会并发触发。
  // 用队列 + 单 worker 保证处理顺序与输出不交错。
  // M1 粘贴增强（PRD §5.4）：queue 元素升级为 QueuedLine（行文本 + 绑定附件）。
  // 跨会话消息（PRD v1.2 §4.4 P2）：合成行带 origin，与用户行共享同一队列。
  repl.queue = [];
  repl.draining = false;
  /** 会话内 turn 序号（状态机审计用）。 */
  repl.turnSeq = 0;
  /** 连续自动 turn 计数（PRD §4.4 链条上限）；用户输入重置。 */
  repl.autoTurnChain = 0;
  /** 当前 turn 的 mailbox 触发者；只有它才允许 send_message 自动补 reply_to。 */
  s.activeTurnFrom = null;
  repl.turnStartedAt = 0;
  repl.lastTurnMs = 0;
  /** 真正在跑 agent turn（不含斜杠命令/选择菜单）；状态行的时长只认它。 */
  repl.turnActive = false;
  /**
   * 定时 / 自节奏循环提示（issue #25）。
   *
   * 丢弃条件用 `turnActive`（turn 正在跑）而不是 `draining`：`draining` 在「正在处理
   * /loop 命令」时也为 true，用它会把启动瞬间的第一拍误丢。命令本身不占 turn，
   * 此时把拍入队后 drain 的 while 会自然接上。
   */
  /**
   * 目标驱动自动续跑（issue #24 / #50）。
   *  - 检查命令：用户显式配置（与 hooks 同口径：不经审批、按配置自动跑）；
   *  - 模型判断：只在用户显式 `--judge` 时启用，一次独立小请求，结果标注为「模型判断」。
   */
  repl.drive = new DriveManager({
    runCheck: async (cmd) => {
      try {
        return await runDriveCheck(cmd, cfg);
      } catch (e) {
        return { ok: false, code: null, output: `检查命令执行失败：${(e as Error).message}` };
      }
    },
    enqueue: (prompt) => {
      if (repl.turnActive || repl.queue.length > 0) return false;
      // 与 /loop 同款：注入的拍回显一行，用户要知道自动发了什么。
      repl.queue.push({ text: prompt, attachments: [], origin: "user", loop: true });
      s.composerRef?.setQueueCount(repl.queue.length);
      repl.runDrainSafely();
      return true;
    },
    // issue #50：模型判断 —— 一次独立小请求（与 compactNow 同模式），要求 JSON 输出。
    // issue #51：提示词与解析抽到 driveJudge.ts，交互 `/drive` 与 `-p --drive` 共用同一份。
    evaluate: makeDriveJudge({
      cfg,
      stream: (c, messages, tools, opts) =>
        (agent.injectedStreamFn ?? chatStream)(
          c,
          messages as Parameters<typeof chatStream>[1],
          tools as Parameters<typeof chatStream>[2],
          opts,
        ),
      recordUsage: (usage) => agent.recordUsage(usage),
    }),
    onEnd: (state, action) => {
      if (action === "continue") {
        ui.info(`自动续跑（第 ${state.rounds}/${state.spec.maxRounds} 轮）：条件未达成，已再排一轮`);
      } else if (action === "done") {
        // issue #50：来源决定文案 —— verified 才能说「已验证」，model 只能说「模型判断」。
        if (state.source === "verified") ui.success(state.reason ?? "目标达成（已验证）");
        else ui.success(state.reason ?? "目标达成（模型判断）");
      } else {
        ui.warn(state.reason ?? "自动续跑已暂停");
      }
    },
  });

  repl.loopScheduler = new LoopScheduler({
    enqueue: (prompt) => {
      if (repl.turnActive || repl.queue.length > 0) return false;
      repl.queue.push({ text: prompt, attachments: [], origin: "user", loop: true });
      s.composerRef?.setQueueCount(repl.queue.length);
      repl.runDrainSafely();
      return true;
    },
  });
  repl.pasteTextCounter = 0; // chip 编号会话内递增（PRD §3），图片/文本各自独立  repl.pasteImageCounter = 0;
  // 文件索引：@ 补全的唯一来源。启动预热一次（2 万文件 ~75ms），按键路径只读缓存。
  repl.fileIndex = new FileIndex({ cwd: cfg.cwd });  // 不阻塞首帧：composer 先起来，索引在后台刷新（Tab 路径有 in-flight 去重）。
  repl.fileIndexPreheat = process.stdin.isTTY    ? repl.fileIndex.refresh().catch(() => {
        // 索引失败不影响会话：后续 Tab 会再踢一次刷新
      })
    : Promise.resolve();

  /** 人类输入统一入口（readline 的 line 事件与 composer 的 onSubmit 都走这里）。 */
  repl.submitUserLine = function submitUserLine(raw: string, attachments: Attachment[]): void {
    const line = raw.trim();
    if (!line) return;
    const bound = bindAttachments(line, attachments);
    repl.queue.push({ text: line, attachments: bound, origin: "user" });
    s.composerRef?.setQueueCount(repl.queue.length);
    repl.runDrainSafely();
  }

  /** 退出：两类输入源都收敛到 closeInput()。 */
  repl.shutdown = async function shutdown(): Promise<void> {
    // issue #45：退出前把后台任务表的最新状态同步进 session（任务可能在上一次请求之后才完成）。
    syncBackgroundJobs();
    // issue #40：资源清理统一走 cleanupEphemeral（与 -p / 非交互路径同一份清单）。
    s.cleanupEphemeralResources();
    try {
      await memory.flush();
    } catch {
      // 记忆失败不阻止退出
    }
    persist(agent.messages, sess.meta);
    ui.blank();
    ui.line(c.dim("再见。"));
    repl.closeInput();
    process.exit(0);
  }

  /** `!cmd`：TTY 下先让出终端（cooked + 显示光标 + 擦帧），命令跑完再恢复自绘帧。 */
  repl.runShellWithTui = async function runShellWithTui(cmd: string): Promise<void> {
    const command = cmd.trim();
    if (!command) return;
    if (!repl.composer || repl.composer.isSuspended) {
      await runShell(command, cfg, ui, agent.mode);
      return;
    }
    // issue #34：授权（ask 模式下会弹 y/N 确认框）必须在挂起输入框**之前**。
    // 旧顺序是先 suspend 再 runShell，而确认框要靠 composer 渲染 —— 挂起后 composer
    // 既不渲染也不收键，确认框永远不出现，shell 永远不执行（表面像「输入失效」的死锁）。
    const verdict = await authorizeShell(command, ui, agent.mode);
    if (verdict === "plan") {
      ui.warn(`plan 模式禁止执行 shell：${command}`);
      return;
    }
    if (verdict === "deny") {
      ui.info("已拒绝。");
      return;
    }
    repl.externalShellActive = true;
    repl.composer.suspend();
    try {
      await executeShell(command, cfg, ui);
    } finally {
      repl.externalShellActive = false;
      repl.composer.resume();
    }
  }

  repl.drain = async function drain(): Promise<void> {
    if (repl.draining) return;
    repl.draining = true;
    try {
    while (repl.queue.length > 0) {
      const q = repl.queue.shift();
      if (!q) continue;
      try {
      s.composerRef?.setQueueCount(repl.queue.length);
      const line = q.text;
      if (!line) continue;
      const origin = q.origin;

      if (origin === "user") {
        // issue #25：循环注入的拍不是用户亲手敲的，必须回显一行，否则用户不知道自动发了什么。
        if (q.loop) ui.line(`${c.accent("❯ ")}${c.text(line)}`);
        // issue #30：输入态 shell 模式提交的命令（原文，无 `!`）直接执行。
        if (q.shell) {
          await repl.runShellWithTui(line);
          continue;
        }
        if (line.startsWith("!")) {
          await repl.runShellWithTui(line.slice(1));
          continue;
        }
        if (line.startsWith("/")) {
          await dispatchCommand(line, {
            agent,
            ui,
            cfg,
            memory,
            classifier,
            meta: sess.meta,
            shutdown: repl.shutdown,
            selectDeps: repl.selectDeps,
            mailbox,
            checkpoints,
            injectMailbox: (env) => {
              ui.line(c.dim(formatPreview(env)));
              repl.queue.push({ text: formatIncomingFrame(env), attachments: [], origin: "mailbox", from: env.from.session });
            },
            onMailboxRekey: () => inboundRefs.clear(),
            // /context 要展示「当前 cfg 下会选哪一档」：探针回写窗口后到下一轮边界之间，
            // lastSelection 还是探针前的旧档，会和同一命令里的 window 行（读 cfg，已是新值）
            // 自相矛盾。currentSelection 只算不写 —— 不碰 messages[0]，提示词何时生效不受影响。
            promptSelection: () => promptManager.currentSelection(cfg),
            // issue #17：规则条数与命中原因（/context 展示）。
            rules: () => ({ alwaysOn: alwaysOnRules, loaded: agent.activeRules, total: projectRules.length }),
            // issue #20 收尾：工具可见集 dry-run（只算不生效，运行时工具集不变）。
            toolVisibility: () => promptManager.currentVisibility(cfg),
            onNameChange: (name) => {
              s.sessionLabel = name;
              repl.titleAnimator?.setName(name);
              // issue #19：名字进了系统提示词身份句，rename 后必须重建，否则模型仍自称旧名。
              promptManager.setSessionName(name);
              agent.refreshSystemPrompt();
            },
            // issue #13：/技能名 把合成消息排进队列，由 drain 的 while 在下一轮取出。
            // 不在这里直接 agent.send —— drain 正在跑，重入会打乱 draining 状态机。
            enqueueUserTurn: (text) => {
              repl.queue.push({ text, attachments: [], origin: "user" });
              s.composerRef?.setQueueCount(repl.queue.length);
            },
            memoryMode,
            todos: () => sessionTodos,
            mcp: () => mcpManager.statuses(),
            // issue #25：定时/自节奏循环（仅交互会话；-p 不传 → 命令提示不可用）
            loop: {
              start: (spec) => repl.loopScheduler.start(spec),
              stop: () => repl.loopScheduler.stop(),
              status: () => formatLoopStatus(repl.loopScheduler.state, Date.now()),
            },
            // issue #24：目标驱动自动续跑（完成条件 = 检查命令 exit 0）
            drive: {
              start: (spec) => repl.drive.start(spec),
              stop: () => repl.drive.stop(),
              status: () => formatDriveState(repl.drive.state),
            },
            // issue #27：按轮次回滚（代码 / 对话 / 两者）
            rewind: {
              list: () => rewindLog.list(),
              apply: (target, mode) => {
                const r = rewindLog.rewind({
                  target,
                  mode: mode as RewindMode,
                  store: { undoSeqs: (seqs) => checkpoints.undoSeqs(seqs) },
                  conversation: {
                    length: () => agent.messages.length,
                    truncate: (n) => {
                      agent.messages.length = Math.max(1, n); // 永远保住 messages[0] 系统提示
                    },
                  },
                });
                sess.meta.rewind = rewindLog.serialize();
                persist(agent.messages, sess.meta);
                return r;
              },
              // issue #46：用户轮次 → 该轮起点的消息下标（定点 compact 的锚点）。
              turnStart: (target) => {
                const turns = rewindLog.list();
                if (turns.length === 0) return null;
                const idx = target === "last" ? turns.length - 1 : target;
                return turns[idx]?.messagesBefore ?? null;
              },
            },
            // issue #28：后台长驻 shell（列表 / 停止）
            shells: {
              list: () => backgroundShells.list(),
              kill: (target) => backgroundShells.kill(target),
            },
            // issue #16：后台子代理任务（列表 / 取消）
            // issue #45：本进程没有任务时，回落到 resume 载入的只读历史（running 已映射成 interrupted）。
            tasks: {
              list: () => {
                const live = s.backgroundTasks?.list() ?? [];
                return live.length > 0 ? live : restoredJobs;
              },
              cancel: (target) => s.backgroundTasks?.cancel(target) ?? 0,
              // issue #48：续聊 —— 读回该任务的子代理对话，追加用户消息后继续跑。
              // 恢复后的任务没有活 Agent，这里重建一个（AbortController 也重新建）。
              chat: async (id, text) => {
                const messages = loadSubagentTranscript(sess.meta.id, id);
                if (!messages || messages.length === 0) {
                  return {
                    ok: false as const,
                    error: `任务 ${id} 没有可续聊的对话记录（可能未落盘或已被清理）。`,
                  };
                }
                const ctrl = new AbortController();
                const ctx: ToolCtx = {
                  cfg,
                  approve: (_tool, detail) => ui.confirm(detail),
                  checkpoint: checkpoints,
                  signal: ctrl.signal,
                };
                try {
                  const reply = await runSubagent(agent, text, undefined, ctx, undefined, {
                    messages,
                    onMessages: (msgs) => saveSubagentTranscript(sess.meta.id, id, msgs),
                  });
                  return { ok: true as const, reply };
                } catch (e) {
                  return { ok: false as const, error: `续聊失败：${(e as Error).message}` };
                }
              },
            },
          });
          continue;
        }
        repl.autoTurnChain = 0;
        if (mailbox) {
          try {
            mailboxState.noteHumanInput(mailbox.root, mailbox.sessionId);
          } catch {
            // 状态写入失败不阻塞交互
          }
        }
      } else {
        repl.autoTurnChain++;
      }

      // 合成行（mailbox/notice）文本已经是 frame 后的内容，不经命令分发、不做 chip 还原。
      // v0.2.4 C3：先展开 @ 引用，再做 chip 还原 ——
      // 反过来会把「粘贴内容里恰好出现的 @foo」也当成引用展开（用户并没有这个意图）。
      const expanded =
        origin === "user"
          ? expandReferences(line, { cwd: cfg.cwd })
          : { text: line, refs: [], errors: [] as string[] };
      const resolved =
        origin === "user"
          ? resolveLine(expanded.text, q.attachments)
          : { text: line, images: [] as string[] };
      if (expanded.refs.length > 0) {
        // issue #17：用户 @ 引用算触达（规则只看路径，不看被引用内容）。
        agent.noteTouchedPaths(
          expanded.refs
            .map((r) => normalizeRelPath(cfg.cwd, r.path))
            .filter((p): p is string => p !== null && p !== "."),
        );
        const lines = expanded.refs.reduce((n, r) => n + r.lines, 0);
        ui.line(c.dim(`· 已引用 ${expanded.refs.length} 个文件（+${lines} 行）`));
      }
      for (const e of expanded.errors) ui.line(c.dim(`· ${e}`));
      if (resolved.images.length > 0) {
        // PRD §5.8：用户对「发出去了什么」有知情权（图片可能含敏感信息）
        ui.line(c.dim(`· 已发送图片 ×${resolved.images.length}`));
      }
      ui.blank();
      repl.turnStartedAt = Date.now();
      repl.turnActive = true;
      s.composerRef?.setBusy(true);
      let outcome: "ok" | "aborted" | "error" = "ok";
      s.activeTurnFrom = origin === "user" ? null : (q.from ?? null);
      if (mailbox) {
        try {
          mailboxState.beginTurn(mailbox.root, mailbox.sessionId, {
            seq: ++repl.turnSeq,
            source: origin === "user" ? "user" : "mailbox",
            from: origin === "user" ? null : (q.from ?? null),
          });
        } catch {
          // 状态机失败不阻塞 turn
        }
      }
      // issue #27：轮次记账（回到「发这句话之前」的锚点）。begin 必须在 send 之前 ——
      // agent.send 会把 user 消息压进 messages，之后就拿不到精确边界了。
      const rewindPending = rewindLog.beginTurn({
        prompt: resolved.text,
        messagesLength: agent.messages.length,
        checkpointSeqBefore: checkpoints.list(1)[0]?.seq ?? 0,
        // issue #42：只有用户亲自发的轮次才是 /rewind 目标；跨会话 / 通知 / loop·drive 注入记为自动轮
        // （仍要记账，回滚用户轮次时它们的文件检查点也要一起恢复）。
        source: origin === "user" && !q.loop ? "human" : "auto",
      });
      let turnStats: Awaited<ReturnType<typeof agent.send>> | null = null;
      try {
        // ESC 回滚语义（PRD §4.11 裁决 A）：人类输入的 turn 保留回滚；
        // 由 mailbox / 状态通知触发的自动 turn 只停不删（否则会连任务消息与已完成结果一起抹掉）。
        turnStats = await agent.send(
          resolved.images.length > 0 ? { text: resolved.text, images: resolved.images } : resolved.text,
          { rollbackOnAbort: origin === "user" },
        );
        outcome = outcomeOf(turnStats);
        if (turnStats.hadError || turnStats.emptyResponse) {
          ui.error(`本轮未完成：${turnStats.errorMessage ?? "模型未产出正文"}`);
          ui.line(c.dim("  诊断日志：~/.neo/logs/turns/（可用 NEO_LOG_DIR 覆盖）"));
        }
        ui.blank();
        ui.blank();
        showStats(ui, agent, cfg, turnStats);
        const last: LastTurnMeta = {
          at: new Date().toISOString(),
          outcome,
          finishReason: turnStats.finishReason,
          errorMessage: turnStats.errorMessage,
          durationMs: turnStats.durationMs,
          promptTokens: turnStats.promptTokens,
          completionTokens: turnStats.completionTokens,
        };
        sess.meta.lastTurn = last;
      } catch (e) {
        outcome = "error";
        ui.error(`未捕获异常: ${(e as Error).message}`);
        sess.meta.lastTurn = {
          at: new Date().toISOString(),
          outcome: "error",
          finishReason: null,
          errorMessage: (e as Error).message,
        };
        // C9：本轮带图且请求失败 → 追加一行软提示（无法可靠区分「服务端拒绝图片」
        // 与其他 4xx，用软提示近似 PRD 要求，不误导为确定结论）
        if (resolved.images.length > 0) ui.line(c.dim("  当前 provider 可能不支持图片输入"));
        if (process.env["NEO_DEBUG"]) console.error(e);
      } finally {
        repl.turnActive = false;
        s.composerRef?.setBusy(false);
        // issue #25：self 节奏循环在「每轮结束」后排下一拍（interval 模式自己在定时器里排）。
        repl.loopScheduler.onTurnEnd();
        // issue #24：目标驱动续跑 —— 每轮结束跑检查命令，未通过则自动再排一轮。
        // issue #50：把最近一轮的工具输出摘要交给 judge（截断并标注，PRD §2.3）。
        // issue #50：只取**本轮**的工具输出（turnStats.toolCalls 条）；0 工具轮给空，避免混入上一轮尾巴。
        const thisTurnToolCalls = turnStats?.toolCalls ?? 0;
        const recentToolOutput =
          thisTurnToolCalls > 0
            ? agent.messages
                .filter((m) => m.role === "tool")
                .slice(-thisTurnToolCalls)
                .map((m) => `tool(${m.name ?? ""}): ${contentText(m.content) ?? ""}`)
                .join("\n")
            : "";
        const clipped =
          recentToolOutput.length > 2_000
            ? `${recentToolOutput.slice(-2_000)}\n…[已截断，只保留最近 2000 字符]`
            : recentToolOutput;
        void repl.drive
          .onTurnEnd({ toolCalls: turnStats?.toolCalls ?? 0, recentOutput: clipped })
          .catch((e: unknown) => {
            ui.warn(`自动续跑检查失败：${(e as Error).message}`);
          });
        // issue #27：把本轮新产生的检查点归到这一轮，并写回 session meta。
        try {
          const newSeqs = checkpoints
            .list(1_000)
            .filter((e) => e.seq > rewindPending.checkpointSeqBefore)
            .map((e) => e.seq);
          rewindLog.endTurn(rewindPending, newSeqs);
          sess.meta.rewind = rewindLog.serialize();
        } catch {
          /* 轮次记账失败不影响主流程 */
        }
        repl.lastTurnMs = repl.turnStartedAt > 0 ? Date.now() - repl.turnStartedAt : 0;
        s.activeTurnFrom = null;
        if (mailbox) {
          try {
            mailboxState.endTurn(mailbox.root, mailbox.sessionId, {
              outcome,
              abortSource: outcome === "aborted" ? "human" : outcome === "error" ? "error" : null,
            });
          } catch {
            // 状态机失败不阻塞交互
          }
        }
      }
      persist(agent.messages, sess.meta);
      } catch (e) {
        // 单条输入失败只丢这一条：命令/工具抛错不能让 draining 永久卡死。
        ui.error(`处理输入失败: ${(e as Error).message}`);
      }
    }
    } finally {
      repl.draining = false;
      s.composerRef?.setQueueCount(repl.queue.length);
      repl.promptInput();
    }
  }

  /** 所有触发点统一走安全包装：drain 异常时复位 draining 并恢复提示符。 */
  repl.runDrainSafely = function runDrainSafely(): void {
    void repl.drain().catch((e: unknown) => {
      repl.draining = false;
      ui.error(`队列处理异常: ${(e as Error).message}`);
      repl.promptInput();
    });
  }

  /**
   * P2 空闲 tick（PRD §4.4）：
   *  - 只在 draining=false && queue 空 && !questionPending && !selectActive 时工作；
   *  - inbox 每 1s 检查一次（消息落盘后静坐也能收到）；
   *  - 委派 watchdog 每 cross_session_watchdog_interval_s（默认 120s）检查一次；
   *  - 自动 turn 链超过上限时暂停拉取（用户输入会重置）。
   */
  repl.runIdleTick = (): void => {
    if (!mailbox) return;
    if (repl.draining || repl.queue.length > 0 || repl.selectActive || repl.questionPending) return;
    if (repl.autoTurnChain >= cfg.mailbox.autoTurnLimit) return;

    const now = Date.now();
    const remaining = cfg.mailbox.autoTurnLimit - repl.autoTurnChain;
    if (remaining <= 0) return;
    if (now - s.lastWatchdogAt >= cfg.mailbox.watchdogIntervalS * 1000) {
      s.lastWatchdogAt = now;
      try {
        for (const n of mailbox.watchdog()) {
          if (repl.queue.length >= remaining) break;
          ui.line(c.dim(formatNoticePreview(n)));
          repl.queue.push({ text: formatNotice(n), attachments: [], origin: "notice", from: n.target_id });
        }
      } catch {
        // watchdog 失败不阻塞交互
      }
    }
    if (repl.queue.length === 0) {
      for (const env of collectInbound(remaining)) {
        repl.queue.push({ text: formatIncomingFrame(env), attachments: [], origin: "mailbox", from: env.from.session });
      }
    }
    if (repl.queue.length > 0) repl.runDrainSafely();
  };

  if (mailbox) {
    s.mailboxTick = setInterval(repl.runIdleTick, 1000);
    // 不让 tick 阻止进程退出（Bun 定时器都有 unref）
    (s.mailboxTick as unknown as { unref?: () => void }).unref?.();
  }

  // 状态条每帧都会问 ctx；contextUsage() 会遍历全部 messages + stringify tools，
  // 500ms 节流一次即可（两位有效数字，人眼分辨不出）。
  repl.ctxCacheValue = 0;
  repl.ctxCacheAt = 0;
  repl.ctxUsage = (): number => {
    const now = Date.now();
    if (now - repl.ctxCacheAt >= 500) {
      repl.ctxCacheValue = agent.contextUsage();
      repl.ctxCacheAt = now;
    }
    return repl.ctxCacheValue;
  };


  s.drive = repl.drive;
  s.loopScheduler = repl.loopScheduler;
  return repl;
}
