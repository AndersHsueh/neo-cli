# neo 选择器组件（select）— 需求规格说明书（PRD）

> 版本：v0.1.7 - feature/选择器组件（暂定；v0.1.6 已被粘贴增强 PRD 占用，若本feature先行发布则顺延调整）
> 文档类型：需求规格说明书（PRD）
> 编写依据：`src/ui/console.ts`、`src/hotkeys.ts`、`src/index.ts` 相关段落通读 + 与 paste-enhancement-prd 同一套事实核查方法
> 行数不标注约束力，随改动漂移；有约束力的是 §5 约束汇总与 §7 文件改动清单
> 基线状态：v0.1.5。实现前先确认 `bunx tsc --noEmit` 零错误、`bun test` 全绿（编写本 PRD 时未重跑）
> 日期：2026-10-20

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 一句话 | 新增可复用的行内选择组件 `select<T>`：↑↓ 移动、回车确认、esc 取消，**不违反 append-only**；先接入 `/resume` 与 `/model` |
| 起源 | 终端崩溃事故验证了 resume 持久化零丢失，同时暴露摩擦点：`/resume` 列表只能输数字回车 |
| 新增文件 | `src/ui/select.ts`（组件 + 纯状态机）、`tests/select.test.ts` |
| 核心改动 | `/resume` 选择器换组件；`/model` 无参时从「只列不选」变为可选 |
| 最大风险 | readline 行缓冲污染（方向键历史召回 / 数字残留）→ §6 探针 P1 先行 |
| 分期 | M0 探针 → M1 组件 + /resume → M2 /model + 守卫 → M3 可选增强 |
| 明确不做 | 全屏化、模糊搜索、多选、鼠标、/tier /provider /mode 接入（后续一行调用的事） |

---

## 1. 背景与目标

### 1.1 起源

2026-10-20 macOS 终端进程崩溃，neo 会话经 resume 完整恢复、零丢失——这验证了「每轮 `writeFileSync` 同步落盘」的持久化设计（`src/session.ts:73`、`:119`）。事故同时暴露了真正的摩擦点：`/resume` 无参时列出 8 条会话，用户只能**看列表 → 记数字 → 输入 → 回车**四步操作。

本次改造遵循两条已确立的原则：

1. **从最不爽的地方改起**，而不是从没问题的地方改。
2. **文本 oracle 过滤器**：任何 UI 改动先问「它的文本 oracle 是什么」。选择器的核心是纯状态机（按键 → 状态转移），bun test 可完整验证——这是 neo 能自己维护自己的前提。

### 1.2 与 append-only 的关系（本方案成立的基础）

neo 的输出模型是线性 append-only，这是它能管道、能 `-p`、能进 CI、能被 neo 自己维护的根基。全屏 TUI 之所以被否决，是因为它把整个界面变成视觉状态，文本 oracle 消失。

选择器**不是**全屏 TUI：它只重绘**自己的 N 行块**，进出前后主输出流依然是线性的。菜单终态定格在回滚区（scrollback）里，会话记录可读。这是「有界行内重绘」与「全屏视觉状态」的本质区别，也是本方案不违反既有设计约束的原因。

### 1.3 目标与非目标

**目标**

1. `/resume` 无参时：↑↓ 选择会话，回车恢复，esc 取消。
2. `/model` 无参时：服务端模型列表变为可选，选中即切换（现状是只列出，用户仍需手打 `/model <id>`，见 F2）。
3. 组件可复用：`/tier`、`/provider`、`/mode` 未来接入各是一行调用。
4. 非 TTY（管道、CI、`-p`）回退到现有数字问答行为，一切照旧。

**非目标（v1 明确不做）**

- 全屏 alternate-screen 化。
- fzf 式模糊搜索过滤。
- 多选、鼠标支持。
- 数字直选（v1 不做，原因见 §4.4 与探针 P1）。

---

## 2. 现状与事实

关键事实（已逐一核实，标注推断的除外）：

| # | 事实 | 位置 | 对本方案的影响 |
|---|---|---|---|
| F1 | `ui.choose()` 存在，但**全库只有一个调用方**（`/resume`）；`/mode`、`/tier` 并不经过它 | `src/ui/console.ts:270-279`、`src/index.ts:1063` | 改造面比预想小；choose 可被 select 整体替代 |
| F2 | `/model` 无参时列出服务端模型（`●`/`○` 标记当前），**但只能看不能选** | `src/index.ts:791-806` | 比 `/resume` 更迫切的受益者 |
| F3 | HotkeyRouter 已映射 up/down/enter/escape，`on()` 返回注销函数 | `src/hotkeys.ts:16-23`、`:60-69` | **hotkeys.ts 零改动**，组件直接消费 |
| F4 | 数字等未映射按键：`mapKey` 返回 null 不派发事件，**但字节已被 readline 行编辑缓冲消费**（推断，P1 实证） | `src/hotkeys.ts:71-83` | 数字直选延后的原因；缓冲清理问题 |
| F5 | 方向键会被 readline 自身解释为历史召回，改变 `rl.line`（推断，P1 实证）——keypress 监听与 readline 内部键绑定是并行的两条通路 | readline 语义 | 选择期间按 ↑↓ 会污染行缓冲，见 C5 |
| F6 | ESC 处理器「仅运行中响应：取消当前轮」；select 只在空闲时打开，理论上不冲突 | `src/index.ts:474` 注释 | P3 实证；若冲突需加 selectActive 守卫 |
| F7 | Ctrl+C 走 SIGINT 信号语义 + 双击确认退出，不经 keypress | `src/index.ts:445-447` | select 期间 Ctrl+C 应取消选择而非武装退出，见 C9 |
| F8 | `/resume` 现状：列 8 条、preview 截 46 字符、`Number()` 校验失败一律「已取消」 | `src/index.ts:1048-1071` | 正确性没问题，纯体验问题；回退路径照抄 |
| F9 | 非 TTY 判断先例：`!process.stdin.isTTY` 时拒绝问句；`-p` 模式根本不创建 readline | `src/ui/console.ts:242`、`src/index.ts:419` | 回退路径与不激活条件 |
| F10 | 已有宽度感知助手 `padEndW`；choose 进入时会 `stopSpinner()` + `blank()` | `src/ui/console.ts:271-272`、`:284` | 截断与 spinner 处理有现成惯例 |

---

## 3. 总体设计

```
┌─ 按键层 ─────────────────────────────────────────────┐
│ HotkeyRouter.on("up"/"down"/"enter"/"escape")         │
│ → select 注册的 handler（返回注销函数，finally 全摘） │
└──────────┬───────────────────────────────────────────┘
           ↓
┌─ 状态机（纯函数，可测）src/ui/select.ts ──────────────┐
│ reduce(state, action, optionCount, viewportRows)      │
│   state = { cursor, scroll }                          │
│   action = up | down | goto(i) | resize(rows)         │
│ enter / esc 不进 reducer —— 它们是终止事件，由         │
│ select() 的 Promise 直接 resolve                       │
└──────────┬───────────────────────────────────────────┘
           ↓
┌─ 渲染层（有界重绘）──────────────────────────────────┐
│ 首次画 1+viewport 行；此后光标上移 viewport 行逐行重写 │
│ \x1b[{n}A + \x1b[2K + 内容；只碰自己的块               │
│ 终态定格：❯ 标记所选项，留在 scrollback                │
└──────────┬───────────────────────────────────────────┘
           ↓
┌─ 调用方 ─────────────────────────────────────────────┐
│ /resume：value = 会话 id → loadSession → 恢复         │
│ /model ：value = 模型 id → cfg.model + noteModelChange│
└──────────────────────────────────────────────────────┘
```

两个设计决策，记录理由：

- **到顶/到底 clamp，不循环（wrap）**：可预测、与 gh 等主流 CLI 一致；wrap 在长列表滚动窗口下心智负担更高。
- **终态留存，不擦除菜单**：擦除会让「我刚才选了什么」从会话记录里消失，违背 append-only 的可读性精神；留存只多占 N 行。

---

## 4. 详细设计

### 4.1 API（D1）

新文件 `src/ui/select.ts`：

```ts
export interface SelectOption<T> {
  label: string;   // 主文本（渲染前按终端宽度截断，C6）
  hint?: string;   // 右侧暗色提示，如 "当前" / "12轮"
  value: T;        // 选中后返回的载荷（会话 id、模型 id…）
}

export interface SelectDeps {
  /** HotkeyRouter 的结构化子集，便于测试注入假 router */
  router: { on(key: HotkeyKey, fn: () => void): () => void };
  isTTY?: boolean;                    // 默认 process.stdin.isTTY
  columns?: () => number;             // 默认 () => process.stdout.columns ?? 80
  /** select 激活状态变化回调，SIGINT 处理器据此切换语义（C9） */
  onActiveChange?: (active: boolean) => void;
  /** 非 TTY 回退用问句函数（即 ui.asker） */
  asker?: (q: string) => Promise<string>;
}

export async function select<T>(
  question: string,
  options: SelectOption<T>[],
  deps: SelectDeps,
): Promise<T | null>   // null = esc / Ctrl+C 取消
```

依赖注入与 `AgentOptions.chatStream`、`readClipboardImage`（paste PRD C7）同一惯例。

### 4.2 状态机（D2）

```ts
export interface SelectState { cursor: number; scroll: number }
export type SelectAction =
  | { type: "up" } | { type: "down" }
  | { type: "goto"; index: number }
  | { type: "resize"; viewportRows: number };

export function reduce(
  s: SelectState, a: SelectAction,
  optionCount: number, viewportRows: number,
): SelectState
```

- 可见窗口 `[scroll, scroll + viewportRows)`；cursor 移动后若越出窗口，scroll 跟随滑动。
- up/down 在 0 与 `optionCount - 1` 处 clamp。
- `goto` 供未来数字直选复用（v1 不接线）。
- 0 选项时调用方不应调 select（现有调用方都有空列表分支）；1 选项时正常显示。

### 4.3 渲染协议（D3）

- viewport 行数：`min(options.length, 10)`。固定 10 是刻意简化——`/model` 的列表可能 30+，滚动窗口必须先做对，动态高度留给 M3。
- 首次绘制：question 行 + viewport 行选项。记录 `paintedRows`。
- 重绘：`\x1b[{paintedRows}A`（上移）→ 逐行 `\x1b[2K`（清行）+ 内容 → 光标自然落在块末。**所有写入直接 `process.stdout.write`**，不走 ui.line（避免前缀污染）。
- 选中行：`❯` 高亮；其余 ` ` 前缀暗色；hint 右侧对齐暗色。
- 终态：确认 → ❯ 定格在所选项；取消 → 全部变暗。之后主流继续 append-only。
- resize：监听 `process.stdout` 的 `'resize'` 事件，触发全块重画（C13；M1 可选，M2 必须）。

### 4.4 键盘语义（D4）

| 键 | 行为 |
|---|---|
| ↑ / ↓ | 移动 cursor（clamp） |
| 回车 | resolve 当前 cursor 的 value |
| esc | resolve null |
| Ctrl+C | resolve null（经 SIGINT 路径协调，C9） |
| 数字/字母 | **v1 不拦截**。原因见 F4/F5：字节会进 readline 行缓冲，选择结束后污染提示符。探针 P1 验证清理手段后再决定 M3 是否加数字直选 |

**行缓冲清理（C5，本方案最关键的坑）**：选择期间按过的键（↑↓ 的历史召回、误触的字母数字）会留在 `rl.line` 里。select 结束时必须清理，否则用户下一个提示符里出现垃圾字符。候选手段：`rl.write(null, { ctrl: true, name: "u" })`（emacs unix-line-discard）+ 重绘 prompt。**能否在 bun 的 readline 兼容层生效，由探针 P1 判定**；若失效，降级方案是接受污染并在 /help 注明——这是已知代价，不是未知 bug。

### 4.5 非 TTY 回退（D5）

`isTTY === false`（或无 router）时，select 内部落回现有数字问答路径：打印编号列表 → `asker("❯ ")` → `Number()` 校验，失败即 null。行为与 `console.ts:270` 的 choose 完全一致（F8 的校验语义照抄）。`-p` 模式无 readline，`/resume`、`/model` 维持现有文本输出（F9）。

### 4.6 与 SIGINT / ESC 的协调（D6）

- **Ctrl+C**：index.ts 的 SIGINT 处理器维护双击退出逻辑（F7）。select 激活期间经 `onActiveChange(true)` 置标志，SIGINT 处理器改为调用 select 的取消函数（resolve null），**不武装双击退出**；select 结束 `onActiveChange(false)` 恢复。
- **ESC**：index.ts 的 ESC 处理器仅在 agent 运行中响应（F6），select 只在空闲时打开，理论无冲突。P3 实证；若实测冲突，给该处理器补 `selectActive` 守卫。

### 4.7 接入点一：/resume（D7）

替换 `src/index.ts:1048-1071` 的 choose 块：

- options：`listSessions(8)` → label = preview（沿用 46 字符截断逻辑，改用 C6 的宽度感知截断）、hint = `${s.turns}轮 ${s.model}`、value = `s.id`。
- `initial` cursor = 0；esc/取消 → 「已取消。」（现状语义不变）。
- `last` 与显式 id 两条路径**不动**。

### 4.8 接入点二：/model（D8）

改造 `src/index.ts:791-806` 无参分支：

- TTY：`listModels(cfg)` 成功 → options（当前模型 `hint: "当前"`，initial cursor 定位到它）→ 选中后 `cfg.model = value; agent.noteModelChange(cfg)` + success 行（与显式 `/model <id>` 同一收尾，F2 的缺口补齐）。
- `listModels` 失败 → 维持现有错误输出，不进选择器。
- 非 TTY：维持现有纯列表展示。

---

## 5. 约束汇总（实现方逐条自检）

| # | 约束 |
|---|---|
| C1 | **append-only 不变量**：select 只重绘自己的块；块外输出仍 append-only；select 存续期间禁止其他输出写入（进入前 `stopSpinner()`，沿用 choose 惯例） |
| C2 | 按键事件只经 HotkeyRouter，**禁止另开 raw-mode stdin 监听**（house rule，与 paste PRD C2 同源） |
| C3 | 进出必须干净：finally 中注销全部 keypress handler 与 resize 监听，不得泄漏 |
| C4 | v1 只绑非打印键（up/down/enter/esc）；数字直选延后至 P1 结论之后 |
| C5 | select 结束时清理 readline 行缓冲（手段由 P1 判定），防止 ↑↓ 历史召回 / 数字残留污染下一提示符 |
| C6 | label/hint 渲染前按 `columns()` 宽度感知截断，CJK 安全（复用 padEndW 系助手）；超宽不得折行——折行会破坏「上移 N 行」的数学 |
| C7 | viewport = `min(N, 10)`，滚动窗口跟随 cursor；`/model` 长列表必须可用 |
| C8 | 非 TTY 回退数字问答；`-p` / 管道下选择器不激活，行为与 v0.1.5 一致 |
| C9 | Ctrl+C 在 select 期间 = 取消选择，不武装双击退出（SIGINT 处理器经 onActiveChange 感知） |
| C10 | ESC 在 select 期间 = 取消；确认 index.ts ESC 守卫不冲突（P3），冲突则补 selectActive 守卫 |
| C11 | 回车产生的空 line 不得进入消息队列（P2 验证主循环现有空行处理；无守卫则补） |
| C12 | 终态定格留存于 scrollback（❯ 标记所选项 / 取消全暗），不擦除 |
| C13 | resize 触发全块重画（M1 可选，M2 必须） |
| C14 | 组件唯一：`src/ui/select.ts`；迁移完成后 `console.ts` 的 choose() 删除或委托给 select，不得两套并存 |

---

## 6. 探针（实现前必须先跑）

> **M0 已完成（2026-10-18）**。四组探针结论全文见 `docs/select-component-m0-probes[done].md`（含 hotkeys.ts 存量 bug 的发现与证据）。本节保留探针设计原文，结论以该文件为准，冲突处以该文件为准。

**P1 行缓冲污染与清理**（决定 C4/C5 的最终形态）：

```ts
// probe-select.ts —— bun probe-select.ts，按提示操作
// 步骤：① 创建 readline + emitKeypressEvents
//       ② 模拟 select 打开期间按 ↑ ↓ 数字字母
//       ③ 检查 rl.line 内容（历史召回？数字残留？）
//       ④ 执行 rl.write(null, {ctrl:true, name:"u"}) 再查 rl.line
//       ⑤ 另测直接赋值 rl.line = "" 是否可用
```

判定：④ 或 ⑤ 任一在 bun 下生效 → C5 采用该手段，M3 可加数字直选；都失效 → C5 降级为「接受污染 + 文档注明」，数字直选无限期搁置。

**P2 回车空 line**：select 期间按回车，观察主循环是否收到空 line。核实 index.ts 现有代码是否忽略空输入；无守卫则 C11 补上。

**P3 ESC 守卫**：agent 空闲时按 esc，确认 index.ts 的 ESC 处理器确实不动作（F6 的「仅运行中」守卫实测）。

**P4 渲染实证**：Terminal.app 与 iTerm2 各跑一遍 `\x1b[{n}A` + `\x1b[2K` 重绘序列，确认 bun 的 stdout 写入无缓冲异常、光标数学正确；顺手验证 resize 重画。

---

## 7. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/ui/select.ts` | **新增**。SelectOption/SelectDeps/select() + 纯状态机 reduce()（导出供测试） |
| `src/index.ts` | `/resume` 选择块换 select（D7）；`/model` 无参分支可选化（D8）；SIGINT 处理器加 selectActive 协调（C9）；P2 结论落点（C11） |
| `src/ui/console.ts` | choose() 删除或委托 select（C14）；asker 暴露给 select 的回退路径 |
| `src/hotkeys.ts` | ~~零改动~~ **M0 证伪，小改**：attach 改监听 input 流、mapKey 认 `"return"`（依据 `docs/select-component-m0-probes[done].md` §1） |
| `tests/select.test.ts` | **新增**。见 §8 |
| `docs/release-notes/v0.1.7.md` | 发布说明（版本号随发布顺延调整） |

---

## 8. 测试与验收

自动测试（bun test，全部走注入点，不碰真实 TTY）：

1. **reduce**：up/down clamp（到顶/到底不再动）；cursor 越过 viewport 边界时 scroll 正确滑动；goto；resize 后窗口重算。
2. **reduce 边界**：0 选项、1 选项不崩。
3. **select() 集成**（注入假 router + 假 stdout 收集器）：按键序列 `down down up enter` → 返回正确 value；`esc` → null。
4. **注销干净**：select 结束后假 router 上无残留 handler（C3）。
5. **非 TTY 回退**：注入 asker，数字路径选择成功、非法输入返回 null（F8 语义）。
6. **截断**：超宽 label（含 CJK）不产生换行宽度。

手动验收清单：

- [ ] `/resume`：↑↓ 移动、回车恢复、esc 取消；**选择结束后提示符干净无残留字符**（P1/C5 生效的直接证据）
- [ ] `/model`：长列表滚动正常；选当前模型无副作用；切换后状态栏/`/why` 显示新模型，系统提示词已同步（noteModelChange）
- [ ] select 期间 Ctrl+C：选择取消，neo 不退出
- [ ] 管道 / `-p` 下 `/resume`、`/model` 行为与 v0.1.5 一致
- [ ] Terminal.app 与 iTerm2 双端视觉验收；拖拽改变窗口大小不破版
- [ ] `bunx tsc --noEmit` 零错误；`bun test` 全绿

---

## 9. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | bun readline 兼容层与 node 行为差异，缓冲清理手段失效 | 探针 P1 前置；失效则降级为已知代价并文档化，不硬扛 |
| R2 | 回车空 line 入队产生空轮次 | C11 + P2 |
| R3 | SIGINT 与 select 状态竞态 | C9 集中在 index.ts 一处协调；测试 4 覆盖注销 |
| R4 | 长列表 / 终端滚动导致光标数学错位 | C7 固定 viewport + C13 resize 重画 + P4 实证 |
| R5 | select 期间其他输出（如双击退出 flash）交错破坏重绘 | C1 进入前 stopSpinner；接线时确认 flash 路径在 selectActive 下被抑制 |
| R6 | 宽度计算在 emoji / 组合字符上失准 | C6 只承诺 CJK 安全；极端字符截断宁可多切，验收清单覆盖 |

---

## 10. 分期交付

| 期 | 内容 | 依赖 |
|---|---|---|
| M0 | 探针 P1-P4，产出结论写入本文档 §6 下方 | 无（**已完成**，结论在 `docs/select-component-m0-probes[done].md`） |
| M1 | select.ts + reduce 测试 + `/resume` 接入 + 非 TTY 回退 | M0 |
| M2 | `/model` 接入 + C9/C10/C13 守卫 + choose() 迁移收尾（C14） | M1 |
| M3（可选） | 数字直选（P1 通过为前提）、wrap 循环、viewport 动态高度 | M1 + P1 |

每期独立可发布；M1 单独上线即消除 `/resume` 的四步操作。

---

## 11. 与既有规划的关系

- 本 feature 与 paste-enhancement-prd（v0.1.6）同属输入/交互层，互不依赖，可并行；都动 `src/index.ts` 主循环附近，**后合入的一方负责 rebase**。
- 本组件是「全屏只做模态插件」路线的第一块砖：有界进入、有界退出、中间状态可测。后续 `/tier`、`/provider`、`/mode` 接入不在本 PRD 范围，但接口已为其留好（一行调用）。
