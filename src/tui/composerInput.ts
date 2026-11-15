/**
 * Composer 按键、命令菜单与粘贴/外部编辑。
 */
import { c, displayWidth, truncate } from "../ui/theme.ts";
import {
  formatCandidateHint,
  applyMatch,
  completeLine,
  rankCommands,
  triggerAt,
  type CommandEntry,
} from "../input/completion.ts";
import { reduce as reduceSelect, type SelectOption, type SelectState } from "../ui/select.ts";
import {
  askAnswerText,
  buildAskOptions,
  reduceAskUser,
  toggleSelected,
  type AskUserAnswer,
  type AskUserOptionView,
  type AskUserRequest,
  type AskUserState,
} from "../ui/askUser.ts";
import { TextBuffer, InputHistory, layoutBuffer, type VisualLine } from "./buffer.ts";
import { stripAnsi, truncateAnsi, wrapAnsi } from "./ansi.ts";
import { PasteMachine, mapKey, type RawKey, type KeyAction } from "./keys.ts";
import { shouldFold } from "../paste.ts";
import {
  EscDoublePress,
  REWIND_MODE_QUESTION,
  REWIND_TURN_QUESTION,
  modeMenuItems,
  rewindSummary,
  turnMenuItems,
} from "./rewindMenu.ts";
import type { RewindMode, RewindResult, RewindTurn } from "../rewind.ts";
import {
  INPUT_VIEWPORT,
  DOUBLE_CTRL_C_MS,
  NOTICE_DEFAULT_MS,
  identityPaint,
  type Composer,
  type SelectSession,
  type AskState,
  type AskUserSession,
  type TabCycle,
} from "./composer.ts";

  // ---------------------------------------------------------------- 按键

  /** 入口：由 stdin keypress 调用；测试也可直接调。 */
export function handleKey(this: Composer, ch: string | undefined, key: RawKey): void {
    if (this.stopped || this.suspended) return;
    const raw: RawKey = { ...key, ch: key.ch ?? ch };

    // 粘贴态优先：Ctrl+C 先救场，其余全部按字面文本收（含 \r\n）。
    // 状态机用 keys.ts 的 PasteMachine，composer 只做「收文本 / idle 兜底 / 折叠」的 IO 层。
    if (this.paste.active) {
      if (raw.ctrl && raw.name === "c") {
        this.finishPaste(false);
        this.handleCtrlC();
        return;
      }
      const r = this.paste.feed(raw);
      if (r.kind === "end") {
        this.finishPaste(true);
        return;
      }
      if (r.kind === "text") {
        this.pasteChunks.push(r.text);
        this.armPasteTimer();
      }
      return;
    }

    const action = mapKey(raw);
    if (!action) return;
    // issue #47：Esc 之外的任何键都复位双击窗口（Esc → 打字 → Esc 不算双击）。
    if (action.type !== "escape" && action.type !== "escape-escape") this.escDouble.reset();

    // 粘贴边界必须先于模态分发：否则审批/选择态里 paste-start 被当普通键吃掉，
    // 粘贴内容会逐字符走 mapKey（审批可能被 "y\r" 代答）。
    if (action.type === "paste-start") {
      this.paste.start();
      this.pasteChunks = [];
      this.hint = "粘贴中…";
      this.armPasteTimer();
      this.scheduleRender();
      return;
    }
    if (action.type === "paste-end") return; // 不在粘贴态：忽略迟到边界

    if (this.mode === "select" && this.select) {
      this.handleSelectKey(action);
      return;
    }
    if (this.mode === "ask_user" && this.askUserState) {
      this.handleAskUserKey(action);
      return;
    }
    if (this.mode === "ask" && this.askState) {
      this.handleAskKey(action);
      return;
    }
    this.handleNormalAction(action);
  }

export function handleSelectKey(this: Composer, action: KeyAction): void {
    const sel = this.select;
    if (!sel) return;
    if (action.type === "up" || action.type === "down") {
      sel.state = reduceSelect(sel.state, { type: action.type }, sel.options.length, sel.viewport);
      this.scheduleRender();
      return;
    }
    if (action.type === "submit") {
      const v = sel.options[sel.state.cursor]?.value ?? null;
      this.finishSelect();
      sel.resolve(v);
      return;
    }
    if (action.type === "escape" || action.type === "ctrl-c") {
      this.finishSelect();
      sel.resolve(null);
      return;
    }
  }

  /**
   * 交互式 rewind 菜单（issue #47）：选轮次 → 选模式 → 交给宿主执行。
   *
   * 复用 `choose()`（select 模态）而不是新造一套：Esc 取消、↑↓ 移动、状态行保持
   * 都由现有实现保证。菜单存续期间 `rewindMenuOpen` 挡住重复打开。
   */
export async function openRewindMenu(this: Composer): Promise<void> {
    const rewind = this.deps.rewind;
    if (!rewind || this.rewindMenuOpen) return;
    this.rewindMenuOpen = true;
    try {
      const turns = rewind.list();
      if (turns.length === 0) {
        this.notice("还没有可回滚的轮次（只算用户轮次）");
        return;
      }
      const target = await this.choose<number>(REWIND_TURN_QUESTION, turnMenuItems(turns), turns.length - 1);
      if (target === null) {
        this.notice("已取消");
        return;
      }
      const mode = await this.choose<RewindMode>(REWIND_MODE_QUESTION, modeMenuItems(), 0);
      if (mode === null) {
        this.notice("已取消");
        return;
      }
      const r = rewind.apply(target, mode);
      if (r.turnsRemoved === 0) {
        for (const note of r.notes) this.notice(note);
        return;
      }
      // 结果进 scrollback（与 /rewind 命令同口径），note 用 dim 行补在后面。
      const rows = [c.ok(`✓ ${rewindSummary(r)}`)];
      for (const note of r.notes) rows.push(c.dim(`  ${note}`));
      this.frame.commitAboveAndRender(rows, this.compose());
    } finally {
      this.rewindMenuOpen = false;
    }
  }

export function finishSelect(this: Composer): void {
    this.mode = "normal";
    this.select = null;
    this.scheduleRender();
  }

export function handleAskUserKey(this: Composer, action: KeyAction): void {
    const s = this.askUserState;
    if (!s) return;

    if (s.phase === "custom") {
      if (action.type === "submit") {
        const text = s.customBuf.text.trim();
        if (text === "") {
          this.notice("自定义回答不能为空");
          return;
        }
        this.finishAskUser(s, {
          status: "answered",
          selected: this.selectedAskLabels(s),
          custom: text,
        });
        return;
      }
      if (action.type === "escape" || action.type === "ctrl-c") {
        this.finishAskUser(s, { status: "canceled" });
        if (action.type === "ctrl-c") this.handleCtrlC();
        return;
      }
      if (action.type === "insert") s.customBuf.insert(action.text);
      else this.applyEditAction(action, s.customBuf);
      this.scheduleRender();
      return;
    }

    if (action.type === "up" || action.type === "down") {
      s.state = reduceAskUser(s.state, action.type, s.options.length, s.viewport);
      this.scheduleRender();
      return;
    }
    // 多选：空格切换；只在普通选项上生效（「其他」由 Enter 进入输入态）。
    if (action.type === "insert" && action.text === " " && s.req.multiSelect) {
      const o = s.options[s.state.cursor];
      if (o && !o.custom) s.selected = toggleSelected(s.selected, s.state.cursor);
      this.scheduleRender();
      return;
    }
    if (action.type === "submit") {
      const o = s.options[s.state.cursor];
      if (!o) return;
      if (o.custom) {
        s.phase = "custom";
        s.customBuf = new TextBuffer();
        this.scheduleRender();
        return;
      }
      if (s.req.multiSelect && s.selected.size === 0) {
        this.notice("请至少选择一项（Space 勾选）");
        this.scheduleRender();
        return;
      }
      const selected = s.req.multiSelect
        ? this.selectedAskLabels(s)
        : [o.label];
      this.finishAskUser(s, { status: "answered", selected, custom: null });
      return;
    }
    if (action.type === "escape" || action.type === "ctrl-c") {
      this.finishAskUser(s, { status: "canceled" });
      if (action.type === "ctrl-c") this.handleCtrlC();
    }
  }

export function selectedAskLabels(this: Composer, s: AskUserSession): string[] {
    return [...s.selected]
      .sort((a, b) => a - b)
      .map((i) => s.options[i]?.label)
      .filter((x): x is string => typeof x === "string");
  }

  /** 结束 askUser 模态：先把「提问/回答」提交进 scrollback，再 resolve。 */
export function finishAskUser(this: Composer, s: AskUserSession, answer: AskUserAnswer): void {
    if (this.askUserState !== s) return;
    this.mode = "normal";
    this.askUserState = null;
    this.hint = null;
    const width = this.cols();
    const rows = [
      ...wrapAnsi(c.bold(`提问：${s.req.question}`), Math.max(4, width - 2)),
      ...wrapAnsi(c.dim(`回答：${askAnswerText(answer)}`), Math.max(4, width - 2)),
    ];
    this.frame.commitAboveAndRender(rows, this.compose());
    s.resolve(answer);
  }

export function handleAskKey(this: Composer, action: KeyAction): void {
    const ask = this.askState;
    if (!ask) return;
    if (action.type === "submit") {
      const text = ask.buf.text;
      this.finishAsk();
      ask.resolve(text);
      return;
    }
    if (action.type === "escape") {
      this.finishAsk();
      ask.resolve("");
      return;
    }
    if (action.type === "ctrl-c") {
      // 审批中 Ctrl+C = 拒绝 + 恢复「取消本轮 / 双击退出」语义（v0.2.4 的 SIGINT 行为）。
      this.finishAsk();
      ask.resolve("");
      this.handleCtrlC();
      return;
    }
    if (action.type === "insert") ask.buf.insert(action.text);
    else this.applyEditAction(action, ask.buf);
    this.scheduleRender();
  }

export function finishAsk(this: Composer): void {
    this.mode = "normal";
    this.askState = null;
    this.scheduleRender();
  }

export function handleNormalAction(this: Composer, action: KeyAction): void {
    // issue #31：先按当前缓冲区同步菜单状态，菜单打开时优先吃掉它的导航/接受键。
    this.syncCommandMenu();
    if (this.menu && this.handleMenuKey(action)) return;
    // issue #30：shell 模式下空缓冲区再删 = 退出模式（不执行、不残留）。
    if (
      (action.type === "backspace" || action.type === "delete") &&
      this.shellMode &&
      this.buf.text === ""
    ) {
      this.exitShellMode();
      return;
    }
    switch (action.type) {
      case "insert":
        // issue #30：空缓冲区键入 `!` = 进入 shell 模式；`!` 是模式开关，不进正文。
        // 缓冲区非空时按字面插入（避免把普通句子误切成 shell 命令）。
        if (!this.shellMode && this.buf.text === "" && action.text === "!") {
          this.enterShellMode();
          return;
        }
        this.buf.insert(action.text);
        this.resetTabIfEdited();
        this.scheduleRender();
        return;
      case "submit":
        this.submit();
        return;
      case "newline":
        this.buf.newline();
        this.resetTabIfEdited();
        this.scheduleRender();
        return;
      case "tab":
        // issue #30：shell 命令是外部语法，不套用 neo 的命令/文件补全。
        if (this.shellMode) {
          this.hint = null;
          this.scheduleRender();
          return;
        }
        this.tabComplete();
        return;
      case "escape":
      case "escape-escape": {
        const doubleEsc = action.type === "escape-escape";
        // issue #47：终端/readline 会把连按两下 Esc 合并成一个事件（sequence 是两个 ESC 字节）
        // → keys.ts 映射成 escape-escape。只在「Esc 本来无事可做」（空闲 + 空缓冲 + 非 shell 模式）
        // 才打开 rewind 菜单；其它状态退回单 Esc 语义（不多做任何事）。
        if (
          doubleEsc &&
          !this.busy &&
          !this.shellMode &&
          this.buf.text === "" &&
          this.deps.rewind &&
          !this.rewindMenuOpen
        ) {
          void this.openRewindMenu();
          return;
        }
        if (this.busy) {
          this.deps.onCancelTurn?.();
          this.notice("已请求取消本轮");
        } else if (this.shellMode) {
          this.exitShellMode();
          this.buf.clear();
          this.history.reset();
          this.tabCycle = null;
          this.hint = null;
        } else if (this.buf.text !== "") {
          this.buf.clear();
          this.history.reset(); // 清空后 ↓ 不能把 ↑ 之前的草稿复活
          this.tabCycle = null;
          this.hint = null;
        } else if (!doubleEsc && this.deps.rewind && !this.rewindMenuOpen) {
          // issue #47：只有「Esc 本来无事可做」（空闲 + 空缓冲 + 无 shell 模式）才武装双击。
          // 上面三条分支各自 return 前都不武装 —— 单 Esc 的 5 种语义一律不变。
          if (this.escDouble.arm(this.now())) {
            void this.openRewindMenu();
            return;
          }
        }
        this.scheduleRender();
        return;
      }
      case "ctrl-c":
        this.handleCtrlC();
        return;
      case "ctrl-d":
        if (this.buf.text === "") this.deps.onExit();
        else { this.buf.delete(); this.scheduleRender(); }
        return;
      case "ctrl-o":
        this.notice("transcript 视图将在 v0.3.1 提供");
        return;
      case "ctrl-v":
        void this.pasteImage();
        return;
      case "ctrl-g":
        void this.editInExternal();
        return;
      case "up":
      case "down":
        if (this.moveLineOrHistory(action.type)) return;
        return;
      default:
        this.applyEditAction(action, this.buf);
        this.resetTabIfEdited();
        this.scheduleRender();
    }
  }

  /** ↑↓：在视觉行内移动；到首/末行时走历史。 */
export function moveLineOrHistory(this: Composer, dir: "up" | "down"): boolean {
    const width = this.contentWidth();
    const layout = this.layoutFor(this.buf.text, this.buf.cursor, width);
    if (dir === "up" && layout.cursorRow === 0) {
      const entry = this.history.up(this.buf.text);
      if (entry !== null) {
        this.buf.setText(entry, entry.length);
        this.scheduleRender();
      }
      return true;
    }
    if (dir === "down" && layout.cursorRow === layout.lines.length - 1) {
      const entry = this.history.down(this.buf.text);
      if (entry !== null) {
        this.buf.setText(entry, entry.length);
        this.scheduleRender();
      }
      return true;
    }
    this.applyEditAction({ type: dir }, this.buf);
    this.resetTabIfEdited();
    this.scheduleRender();
    return true;
  }

export function applyEditAction(this: Composer, action: KeyAction, buf: TextBuffer): void {
    const width = this.contentWidth();
    switch (action.type) {
      case "backspace": buf.backspace(); return;
      case "delete": buf.delete(); return;
      case "left": buf.move("left", width); return;
      case "right": buf.move("right", width); return;
      case "up": buf.move("up", width); return;
      case "down": buf.move("down", width); return;
      case "home": buf.move("home", width); return;
      case "end": buf.move("end", width); return;
      case "word-left": buf.move("word-left", width); return;
      case "word-right": buf.move("word-right", width); return;
      case "kill-end": buf.killToEnd(); return;
      case "kill-start": buf.killToStart(); return;
      case "kill-word": buf.deleteWordLeft(); return;
      default: return;
    }
  }

export function resetTabIfEdited(this: Composer): void {
    this.tabCycle = null;
  }

export function submit(this: Composer): void {
    this.menu = null;
    // issue #30：shell 模式下走独立路径（命令原文交给 onShellCommand，不经过 `!` 前缀剥离）。
    if (this.shellMode) {
      this.submitShellCommand();
      return;
    }
    let text = this.buf.text;
    if (text.trim() === "") return;
    // 行尾反斜杠 = 续行（与 v0.2.4 兼容）
    if (text.endsWith("\\") && !text.endsWith("\\\\")) {
      this.buf.setText(`${text.slice(0, -1)}\n`, text.length);
      this.scheduleRender();
      return;
    }
    const attachments = this.attachments;
    this.history.push(text);
    // 先把流式未完成行落定，再提交用户行，保证 scrollback 顺序。
    this.deps.beforeUserCommit?.();
    // 输入框提交后清空：用户消息必须落进上方 scrollback（否则历史里只剩助手输出）。
    this.commitUserInput(text);
    this.buf.clear();
    this.attachments = [];
    this.tabCycle = null;
    this.hint = null;
    this.inputScroll = 0;
    // 注意：onSubmit 里可能同步触发新一轮（命令），先把状态清理干净再回调。
    this.deps.onSubmit(text, attachments);
    this.scheduleRender();
  }

  /** 进入 shell 输入模式（issue #30）：清掉补全 hint，按 shell 前缀重画。 */
export function enterShellMode(this: Composer): void {
    this.shellMode = true;
    this.hint = null;
    this.tabCycle = null;
    this.scheduleRender();
  }

  /** 退出 shell 输入模式（不执行）。 */
export function exitShellMode(this: Composer): void {
    this.shellMode = false;
    this.scheduleRender();
  }

  /**
   * shell 模式提交：命令原文交给宿主（`onShellCommand`），提交后回普通态。
   * 空命令不执行，直接回普通态；宿主没接回调时退回旧语法 `!${cmd}` 交给 onSubmit。
   */
export function submitShellCommand(this: Composer): void {
    const command = this.buf.text.trim();
    if (command === "") {
      this.shellMode = false;
      this.buf.clear();
      this.scheduleRender();
      return;
    }
    const attachments = this.attachments;
    this.history.push(`!${command}`);
    this.deps.beforeUserCommit?.();
    this.commitUserInput(command, c.warn("! "));
    this.buf.clear();
    this.attachments = [];
    this.tabCycle = null;
    this.hint = null;
    this.inputScroll = 0;
    this.shellMode = false;
    // 先清干净状态再回调：回调里可能同步触发 shell 执行 / 新一轮。
    this.scheduleRender();
    if (this.deps.onShellCommand) this.deps.onShellCommand(command);
    else this.deps.onSubmit(`!${command}`, attachments);
  }

  /** 用户消息进 scrollback：首行 `❯ `、续行两空格；折行与输入框共用 layoutBuffer。 */
export function commitUserInput(this: Composer, text: string, firstPrefix = c.accent("❯ ")): void {
    const contentW = this.contentWidth();
    const rows: string[] = [];
    text.split("\n").forEach((line, i) => {
      const prefix = i === 0 ? firstPrefix : "  ";
      const layout = layoutBuffer(line, line.length, contentW);
      for (const vl of layout.lines) rows.push(prefix + c.text(vl.text));
    });
    this.frame.commitAboveAndRender(rows, this.compose());
  }

export function handleCtrlC(this: Composer): void {
    if (this.busy) this.deps.onCancelTurn?.();
    const now = this.now();
    if (this.armedExit && now - this.lastCtrlCAt <= DOUBLE_CTRL_C_MS) {
      this.deps.onExit();
      return;
    }
    this.armedExit = true;
    this.lastCtrlCAt = now;
    this.notice("再按 Ctrl+C 退出", DOUBLE_CTRL_C_MS);
  }

  // ---------------------------------------------------------------- 命令菜单（issue #31）

  /** 按当前缓冲区同步 `/` 命令菜单；不在命令上下文（如已敲空格/非行首）就关闭。 */
export function syncCommandMenu(this: Composer): void {
    if (this.mode !== "normal") {
      this.menu = null;
      return;
    }
    if (this.menuDismissedFor !== null && this.menuDismissedFor === this.buf.text) {
      this.menu = null;
      return;
    }
    this.menuDismissedFor = null;
    const ctx = triggerAt(this.buf.text, this.buf.cursor);
    if (!ctx || ctx.kind !== "command") {
      this.menu = null;
      return;
    }
    const items = rankCommands(ctx.query, this.deps.commands, 50);
    if (items.length === 0) {
      this.menu = { query: ctx.query, items, index: 0 };
      return;
    }
    const keep = this.menu && this.menu.query === ctx.query ? this.menu.index : 0;
    this.menu = { query: ctx.query, items, index: Math.min(keep, items.length - 1) };
  }

  /** 菜单行：左 `/name`、右短说明；超过 8 行滚动并提示剩余。 */
export function menuRows(this: Composer, width: number): string[] {
    const menu = this.menu;
    if (!menu) return [];
    if (menu.items.length === 0) {
      return [truncateAnsi(`${c.warn("  无匹配")} ${c.dim(`"/${menu.query}"`)}`, width)];
    }
    const max = 8;
    const total = menu.items.length;
    const start = Math.max(0, Math.min(menu.index - Math.floor(max / 2), total - max));
    const visible = menu.items.slice(start, start + max);
    const nameW = Math.min(
      26,
      Math.max(...menu.items.map((it) => displayWidth(`/${it.name}`))) + 1,
    );
    const rows = visible.map((item, i) => {
      const selected = start + i === menu.index;
      const marker = selected ? c.accent("❯ ") : "  ";
      const name = `/${item.name}`;
      const pad = " ".repeat(Math.max(1, nameW - displayWidth(name)));
      const desc = truncate(item.description, Math.max(4, width - 2 - nameW - 1));
      return `${marker}${selected ? c.accent(name) : c.text(name)}${pad}${c.dim(desc)}`;
    });
    const hidden = total - visible.length;
    if (hidden > 0) rows.push(c.dim(`   … 还有 ${hidden} 项（继续输入过滤）`));
    return rows.map((r) => truncateAnsi(r, width));
  }

  /** 菜单打开时的按键：↑↓ 移动、Tab 接受不执行、Enter 接受并执行、Esc 关闭。 */
export function handleMenuKey(this: Composer, action: KeyAction): boolean {
    const menu = this.menu;
    if (!menu) return false;
    if (action.type === "up" || action.type === "down" || action.type === "page-up" || action.type === "page-down") {
      // 空态也吃掉，避免 ↑ 误翻出历史。
      if (menu.items.length === 0) return true;
      const n = menu.items.length;
      const step =
        action.type === "up" ? -1 : action.type === "down" ? 1 : action.type === "page-up" ? -5 : 5;
      menu.index = (menu.index + step + n * 100) % n;
      this.scheduleRender();
      return true;
    }
    if (action.type === "tab") {
      this.acceptMenuCommand(false);
      return true;
    }
    if (action.type === "submit") {
      this.acceptMenuCommand(true);
      return true;
    }
    if (action.type === "escape") {
      this.menu = null;
      this.menuDismissedFor = this.buf.text;
      this.scheduleRender();
      return true;
    }
    return false;
  }

  /** 接受高亮项：写进缓冲区；execute=true 时立即提交（Enter）。 */
export function acceptMenuCommand(this: Composer, execute: boolean): void {
    const menu = this.menu;
    if (!menu || menu.items.length === 0) return;
    const item = menu.items[menu.index];
    if (!item) return;
    const text = `/${item.name}`;
    this.menu = null;
    this.hint = null;
    this.tabCycle = null;
    this.buf.setText(text, text.length);
    this.resetTabIfEdited();
    if (execute) this.submit();
    else this.scheduleRender();
  }

export function tabComplete(this: Composer): void {
    const line = this.buf.text;
    const cursor = this.buf.cursor;
    if (this.tabCycle && line === this.tabCycle.applied && cursor === this.tabCycle.cursorAfter) {
      const cyc = this.tabCycle;
      const index = (cyc.index + 1) % cyc.matches.length;
      const applied = applyMatch(line, cursor, cyc.start, cyc.matches[index] as string);
      this.buf.setText(applied.line, applied.cursor);
      this.tabCycle = { ...cyc, index, applied: applied.line, cursorAfter: applied.cursor };
      this.hint = formatCandidateHint("file", cyc.matches);
      this.scheduleRender();
      return;
    }
    const ctx = triggerAt(line, cursor);
    // issue #31：命令补全改走菜单（Tab 只接受高亮项），这里只剩文件补全。
    if (!ctx || ctx.kind === "command") return;
    if (line.trimStart().startsWith("/")) return;
    const result = completeLine(line, {
      files: ctx.kind === "file" ? this.deps.files() : [],
      commands: this.deps.commands,
      cursor,
    });
    if (!result || result.matches.length === 0) {
      this.hint = "无候选";
      this.tabCycle = null;
      this.scheduleRender();
      return;
    }
    const applied = applyMatch(line, cursor, result.start, result.matches[0] as string);
    this.buf.setText(applied.line, applied.cursor);
    this.tabCycle = {
      start: result.start,
      matches: result.matches,
      index: 0,
      applied: applied.line,
      cursorAfter: applied.cursor,
    };
    this.hint = result.matches.length > 1 ? formatCandidateHint("file", result.matches) : null;
    this.scheduleRender();
  }

export async function pasteImage(this: Composer): Promise<void> {
    if (!this.deps.pasteImage) return;
    let r: { chip: string; attachment: unknown } | null = null;
    try {
      r = await this.deps.pasteImage();
    } catch (e) {
      this.notice((e as Error).message);
      return;
    }
    if (!r) {
      this.notice("剪贴板里没有图片");
      return;
    }
    this.attachments.push(r.attachment);
    this.buf.insert(r.chip);
    this.scheduleRender();
  }

  /**
   * Ctrl+G：用外部编辑器撰写提示词（issue #62）。
   *
   * 顺序是硬约束：编辑器要接管终端，所以先 suspend（让出 tty：停按键监听、
   * 恢复 cooked mode、显示光标、擦掉帧），编辑器退出后再 resume（回 raw + 重画）。
   * 编辑器失败 / 取消 → 原输入原样保留，只给一句可读提示。
   */
export async function editInExternal(this: Composer): Promise<void> {
    if (!this.deps.editInEditor) {
      this.notice("当前环境不支持外部编辑器");
      return;
    }
    const current = this.buf.text;
    this.suspend();
    let r: { ok: true; text: string } | { ok: false; error: string };
    try {
      r = await this.deps.editInEditor(current);
    } catch (e) {
      r = { ok: false, error: `外部编辑器失败：${(e as Error).message}` };
    } finally {
      this.resume();
    }
    if (!r.ok) {
      this.notice(r.error);
      return;
    }
    // 光标落在末尾：编辑器里写的内容通常是「写完就发」，末尾最顺手。
    this.buf.setText(r.text, r.text.length);
    this.scheduleRender();
  }

  /** paste-end 丢包保护：idle 超时按「粘贴已结束」收尾，避免之后所有按键被吞。 */
export function armPasteTimer(this: Composer): void {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => {
      this.pasteTimer = null;
      if (this.paste.active) this.finishPaste(true);
    }, this.pasteIdleMs);
    this.pasteTimer.unref?.();
  }

export function finishPaste(this: Composer, commit: boolean): void {
    if (this.pasteTimer) { clearTimeout(this.pasteTimer); this.pasteTimer = null; }
    this.paste.reset();
    const text = this.pasteChunks.join("");
    this.pasteChunks = [];
    this.hint = null;
    if (!commit) { this.scheduleRender(); return; }
    if (text === "") { this.scheduleRender(); return; }
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // 模态：审批答案进 ask buffer；选择菜单直接丢弃（避免 "y" 代答 / 残留污染主缓冲）。
    if (this.mode === "select") { this.scheduleRender(); return; }
    if (this.mode === "ask_user" && this.askUserState) {
      if (this.askUserState.phase === "custom") {
        this.askUserState.customBuf.insert(normalized);
        this.scheduleRender();
      }
      return;
    }
    if (this.mode === "ask" && this.askState) {
      this.askState.buf.insert(normalized);
      this.scheduleRender();
      return;
    }
    // 自绘输入框允许小段多行直接插入；只有超过阈值才折叠为 chip。
    const fold = shouldFold(text, this.fold, { allowMultiline: true });
    if (fold && this.deps.pasteText) {
      const r = this.deps.pasteText(text);
      this.attachments.push(r.attachment);
      this.buf.insert(r.chip);
    } else {
      this.buf.insert(normalized);
    }
    this.scheduleRender();
  }

