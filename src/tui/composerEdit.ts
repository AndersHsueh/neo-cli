/**
 * tui/composerEdit.ts — 输入框日常编辑、kill ring / 撤销、草稿召回与权限循环（issue #79）。
 *
 * 从 composerInput.ts 抽出，避免单文件超过 1000 行。纯按键/缓冲逻辑，不碰终端 IO。
 */
import { TextBuffer } from "./buffer.ts";
import type { KeyAction } from "./keys.ts";
import { whitespaceLeftIndex, wordLeftIndex, wordRightIndex } from "./wordBoundary.ts";
import { cycleMode } from "./permissionMode.ts";
import type { Composer } from "./composer.ts";

export function handleNormalAction(this: Composer, action: KeyAction): void {
  // issue #90：transcript 视图打开时所有键由视图消化，绝不穿透到输入框。
  if (this.transcriptView) {
    this.handleTranscriptViewKey(action);
    return;
  }
  // 未打开视图时 Ctrl+F 保持未绑定（无输入框语义）。
  if (action.type === "ctrl-f") return;
  // issue #74：检索态优先分发（普通插入/退格改的是查询，不是草稿）。
  if (this.search) {
    this.handleHistorySearchKey(action);
    return;
  }
  // issue #79：Ctrl+X 和弦前缀 —— 只认紧随其后的 Ctrl+S（立即发送排队），
  // 其它键取消前缀并按普通逻辑处理。单独 Ctrl+S 仍走 #74 的暂存。
  if (this.chordPending) {
    this.chordPending = false;
    if (action.type === "ctrl-s") {
      this.flushQueueNow();
      return;
    }
  }
  // issue #31：先按当前缓冲区同步菜单状态，菜单打开时优先吃掉它的导航/接受键。
  this.syncCommandMenu();
  if (this.menu && this.handleMenuKey(action)) return;
  // issue #79：帮助面板打开时，任何其它输入键先关掉帮助再按普通键处理（`?` 自己走 toggle）。
  if (this.helpOpen && !(action.type === "insert" && action.text === "?")) {
    this.helpOpen = false;
  }
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
      // issue #79：空输入框（且非 shell 命令正文）按 `?` = 开关快捷键帮助，不插入字符。
      if (action.text === "?" && this.buf.text === "" && !this.shellMode) {
        this.toggleHelp();
        return;
      }
      // issue #30：空缓冲区键入 `!` = 进入 shell 模式；`!` 是模式开关，不进正文。
      // 缓冲区非空时按字面插入（避免把普通句子误切成 shell 命令）。
      if (!this.shellMode && this.buf.text === "" && action.text === "!") {
        this.enterShellMode();
        return;
      }
      this.recordEdit();
      this.buf.insert(action.text);
      this.edits.breakYank();
      this.resetTabIfEdited();
      this.scheduleRender();
      return;
    case "submit":
      this.submit();
      return;
    case "newline":
      this.recordEdit();
      this.buf.newline();
      this.edits.breakYank();
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
    case "cycle-mode":
      this.cyclePermissionMode();
      return;
    case "ctrl-x":
      // 和弦前缀：下一个键决定语义（见上面的 chordPending 分支）。
      this.chordPending = true;
      this.hint = "Ctrl+X 前缀：再按 Ctrl+S 立即发送排队";
      this.scheduleRender();
      return;
    case "yank":
      this.yank();
      return;
    case "yank-pop":
      this.yankPop();
      return;
    case "undo":
      this.undo();
      return;
    case "escape":
    case "escape-escape": {
      const doubleEsc = action.type === "escape-escape";
      // issue #79：帮助面板打开时 Esc 先关帮助（不触发清空/回滚）。
      if (this.helpOpen) {
        this.helpOpen = false;
        this.scheduleRender();
        return;
      }
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
        const note = this.deps.onCancelTurn?.();
        this.notice(note || "已请求取消本轮");
      } else if (this.shellMode) {
        this.exitShellMode();
        this.buf.clear();
        this.history.reset();
        this.tabCycle = null;
        this.hint = null;
      } else if (this.buf.text !== "") {
        // issue #79：Esc 清空**不进**草稿召回环（C4k 语义不回退），所以 ↑ 不会复活它。
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
      else { this.recordEdit(); this.buf.delete(); this.scheduleRender(); }
      return;
    case "ctrl-o":
      this.toggleTranscriptView();
      return;
    case "ctrl-v":
      void this.pasteImage();
      return;
    case "ctrl-g":
      void this.editInExternal();
      return;
    case "ctrl-r":
      this.openHistorySearch();
      return;
    case "ctrl-s":
      this.stashDraft();
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
    // issue #79：空框按 ↑ 先召回 Ctrl+C 清掉的草稿（LIFO），再收回已排队内容，
    // 最后才翻提交历史 —— 三者都不提交。
    if (this.buf.text === "" && this.drafts.size > 0) {
      this.recallDraft();
      return true;
    }
    if (this.recallQueueOrHistory()) return true;
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

/**
 * issue #79：↑ 在输入框首视觉行时先尝试收回最近一条已排队内容。
 *
 * 返回 true = 已收回（文本与附件回填，可编辑后再提交）；false = 队列里没有可收回的，
 * 调用方继续走历史导航。
 */
export function recallQueueOrHistory(this: Composer): boolean {
  const item = this.deps.onRecallQueue?.();
  if (!item) return false;
  this.recordEdit();
  this.buf.setText(item.text, Array.from(item.text).length);
  this.attachments = item.attachments.slice();
  this.tabCycle = null;
  this.hint = "已收回排队内容（可编辑后提交）";
  this.scheduleRender();
  return true;
}

/**
 * issue #79：Ctrl+X Ctrl+S —— 先把输入框里的内容按普通提交发出去，再立即发送队列。
 *
 * 与单独 Ctrl+S（#74 暂存）严格分开：只有按下过 Ctrl+X 前缀才走到这里。
 */
export function flushQueueNow(this: Composer): void {
  this.hint = null;
  if (this.buf.text.trim() !== "") this.submit();
  this.deps.onFlushQueue?.();
  this.scheduleRender();
}

/** issue #79：把当前草稿压进撤销栈（改缓冲之前调用）。 */
export function recordEdit(this: Composer): void {
  this.edits.pushUndo({ text: this.buf.text, cursor: this.buf.cursor });
}


/** issue #79：Ctrl+Y —— 在光标处插入最近一次删除（空环无动作）。 */
export function yank(this: Composer): void {
  const text = this.edits.lastKill;
  if (text === null) return;
  this.recordEdit();
  const start = this.buf.cursor;
  this.buf.insert(text);
  this.edits.noteYank(start, text);
  this.resetTabIfEdited();
  this.scheduleRender();
}

/**
 * issue #79：Alt+Y —— 仅在刚 yank / yank-pop 之后生效，把刚插入的那段
 * 换成环里更早的一条删除记录（可环绕）。
 */
export function yankPop(this: Composer): void {
  const next = this.edits.nextYankPop();
  if (!next) return;
  const chars = Array.from(this.buf.text);
  const start = Math.max(0, Math.min(chars.length, next.range.start));
  const end = Math.max(start, Math.min(chars.length, next.range.end));
  this.recordEdit();
  const inserted = Array.from(next.text);
  this.buf.setText(chars.slice(0, start).concat(inserted, chars.slice(end)).join(""), start + inserted.length);
  this.scheduleRender();
}

/** issue #79：Ctrl+_ —— 撤销上一次输入编辑（恢复文本与光标；空栈无动作）。 */
export function undo(this: Composer): void {
  const snap = this.edits.popUndo();
  if (!snap) return;
  this.buf.setText(snap.text, snap.cursor);
  this.edits.breakYank();
  this.resetTabIfEdited();
  this.scheduleRender();
}

/** issue #79：空输入框 `?` 开关快捷键帮助（静态面板，不启动空闲 tick）。 */
export function toggleHelp(this: Composer): void {
  this.helpOpen = !this.helpOpen;
  this.hint = null;
  this.scheduleRender();
}

/** issue #79：把当前草稿推进召回环（Ctrl+C 清空前调用）。 */
export function pushDraftToRing(this: Composer): void {
  this.drafts.push({
    text: this.buf.text,
    cursor: this.buf.cursor,
    attachments: this.attachments,
    shellMode: this.shellMode,
  });
}

/** issue #79：从召回环 LIFO 取回一份草稿（不提交）。 */
export function recallDraft(this: Composer): void {
  const d = this.drafts.pop();
  if (!d) return;
  this.recordEdit();
  this.buf.setText(d.text, d.cursor);
  this.attachments = d.attachments.slice();
  this.shellMode = d.shellMode;
  this.tabCycle = null;
  this.hint = null;
  this.menu = null;
  this.menuDismissedFor = null;
  this.scheduleRender();
}

/**
 * issue #79：Shift+Tab / Alt+M 循环权限模式。
 *
 * 顺序是 `/mode` 的四个档位：ask → auto-edit → auto-all → plan → ask。
 * plan 是只读闸门（不是 `/plan` 的交互规划工作流）。提示走 `hint` 而不是
 * `notice()` —— notice 会让 #76 的空闲 tick 常驻。
 */
export function cyclePermissionMode(this: Composer): void {
  const next = cycleMode(this.deps.getStatus().mode);
  this.deps.onCycleMode?.(next);
  this.hint = `权限模式 → ${next}`;
  this.scheduleRender();
}

export function applyEditAction(this: Composer, action: KeyAction, buf: TextBuffer): void {
  const width = this.contentWidth();
  // issue #79：kill 类动作（Ctrl+K/U/W、Alt+D、Ctrl+Backspace）把删掉的文本推进
  // kill ring（空删除不进环），且都压一份撤销快照；移动类动作不碰 kill ring。
  const main = buf === this.buf;
  switch (action.type) {
    // issue #79 回归修复：普通 Backspace / Delete 只进撤销栈，**不进** kill ring ——
    // 否则「Ctrl+W 删词 → 打字 → Backspace 修一个字 → Ctrl+Y」会粘回那个单字符，
    // 而不是被删的那个词。空删除既不进环也不压空撤销。仍要 breakYank：
    // 删过东西后 Alt+Y 不能再替换上一次 yank 的那段。
    case "backspace":
    case "delete":
      if (buf.cursor <= 0 && action.type === "backspace") return;
      if (buf.cursor >= buf.length && action.type === "delete") return;
      // 模态缓冲（审批/自定义回答）只删字，不污染主输入框的撤销栈 / yank 链。
      if (main) this.recordEdit();
      if (action.type === "backspace") buf.backspace();
      else buf.delete();
      if (main) this.edits.breakYank();
      return;
    case "left": buf.move("left", width); return;
    case "right": buf.move("right", width); return;
    case "up": buf.move("up", width); return;
    case "down": buf.move("down", width); return;
    case "home": buf.move("home", width); return;
    case "end": buf.move("end", width); return;
    case "word-left": buf.move("word-left", width); return;
    case "word-right": buf.move("word-right", width); return;
    case "kill-end":
      return void this.killBufferRange(buf, main, buf.cursor, logicalEnd(buf));
    case "kill-start":
      return void this.killBufferRange(buf, main, logicalStart(buf), buf.cursor);
    case "kill-word":
      return void this.killBufferRange(buf, main, whitespaceLeft(buf), buf.cursor);
    case "kill-word-alnum":
      return void this.killBufferRange(buf, main, wordLeft(buf), buf.cursor);
    case "kill-word-right":
      return void this.killBufferRange(buf, main, buf.cursor, wordRight(buf));
    default: return;
  }
}

/** 逻辑行行尾（不含换行）。 */
function logicalEnd(buf: TextBuffer): number {
  const chars = Array.from(buf.text);
  let i = buf.cursor;
  while (i < chars.length && chars[i] !== "\n") i += 1;
  return i;
}

/** 逻辑行行首（不含换行）。 */
function logicalStart(buf: TextBuffer): number {
  const chars = Array.from(buf.text);
  let i = buf.cursor;
  while (i > 0 && chars[i - 1] !== "\n") i -= 1;
  return i;
}

function whitespaceLeft(buf: TextBuffer): number {
  return whitespaceLeftIndex(Array.from(buf.text), buf.cursor);
}

function wordLeft(buf: TextBuffer): number {
  return wordLeftIndex(Array.from(buf.text), buf.cursor);
}

function wordRight(buf: TextBuffer): number {
  return wordRightIndex(Array.from(buf.text), buf.cursor);
}

/**
 * issue #79：删掉 `[from, to)` 并把删掉的文本推进 kill ring。
 *
 * `main` 为真时走 composer 的 kill ring（Ctrl+Y 可粘回）；模态缓冲（审批/自定义回答）
 * 只做删除，不污染主输入框的环。
 */
export function killBufferRange(
  this: Composer,
  buf: TextBuffer,
  main: boolean,
  from: number,
  to: number,
): void {
  const chars = Array.from(buf.text);
  const start = Math.max(0, Math.min(chars.length, from));
  const end = Math.max(start, Math.min(chars.length, to));
  if (start === end) return;
  const killed = chars.slice(start, end).join("");
  if (main) this.recordEdit();
  buf.setText(chars.slice(0, start).concat(chars.slice(end)).join(""), start);
  if (main) {
    this.edits.pushKill(killed);
    this.resetTabIfEdited();
  }
  this.scheduleRender();
}
