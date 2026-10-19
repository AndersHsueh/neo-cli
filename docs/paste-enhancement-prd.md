# neo 输入粘贴增强 — 需求规格说明书（PRD）

> 版本：v0.1.6 - feature/粘贴增强
> 文档类型：需求规格说明书（PRD）
> 编写依据：`neo/` 全部输入链路源码通读 + Claude Code 官方文档（interactive-mode / common-workflows）+ anthropics/claude-code 相关 issue 实证
> 行数不标注约束力，随改动漂移；有约束力的是 §8 的逐文件改动清单
> 基线状态：`bunx tsc --noEmit` 零错误；`bun test` 全绿
> 日期：2026-10-18

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 一句话 | 让 neo 的输入框支持：剪贴板贴图显示为 `[Image #N]`、长文本粘贴折叠为 `[Pasted text #N +X lines]`，发送时还原真实内容 |
| 对标 | Claude Code 同名体验（Ctrl+V / Alt+V 贴图，长文本折叠） |
| 新增文件 | `src/clipboard.ts`（平台剪贴板读取）、`src/attachments.ts`（附件状态与占位符还原） |
| 核心改动 | `Message.content` 扩为多模态数组；queue 携带附件；热键路由加 Ctrl+V/Alt+V |
| 最大风险 | readline 对 bracketed paste 的行为差异 → §7 探针 P1 先行 |
| 分期 | M1 长文本折叠（纯本地）→ M2 macOS 贴图 → M3 Win/Linux 贴图 → M4 可选 |
| 明确不做 | 子代理传图、图片渲染到终端（sixel）、历史召回重发完整粘贴内容（v1） |

---

## 1. 背景与目标

### 1.1 要解决什么

neo 目前输入框是纯 readline 行编辑：贴图无反应（图片进不了对话），贴长文本会把几十行原样刷进输入框和终端回显，既难看又容易误触发逐行提交。

Claude Code 的成熟交互是：

- **贴图**：Ctrl+V（macOS）/ Alt+V（Windows/WSL）从剪贴板读图，光标处插入 `[Image #N]` chip，发送时作为 image block 进多模态消息；模型回复引用 `[Image #1]` 时可点击打开原图。
- **长文本**：粘贴大段文字折叠为 `[Pasted text #N]` 占位符，发送时模型收到完整内容，占位符只是 UI 层折叠。

### 1.2 目标与非目标

**目标**

1. macOS 下 Ctrl+V 贴剪贴板图片，输入框出现 `[Image #N]`，发送后模型能看到图。
2. 粘贴超阈值文本时输入框只显示 `[Pasted text #N +X lines]`，发送时还原完整文本。
3. 会话持久化 / 恢复（--resume、/resume）后图片仍可用。
4. 全程不破坏现有输入串行化队列（`src/index.ts` 的 queue + drain）与审批问句机制。

**非目标（v1 明确不做）**

- 子代理（task 工具）透传图片 —— prompt 是 string，结构性排除。
- 终端内渲染图片（sixel/kitty protocol）。
- 历史召回（↑）后重发完整粘贴内容 —— v1 中召回行里的 chip 退化为字面文本，§5.6 写明语义。
- 拖拽图片文件进终端窗口。

---

## 2. 现状与差距

### 2.1 输入链路现状

```
stdin → readline(createInterface) → rl.on("line") → queue: string[]
     → drain() 逐条 → agent.send(line) → messages.push({role:"user", content: line})
     → chatStream(cfg, messages, …)
```

关键事实（已逐一核实）：

| # | 事实 | 位置 | 对本方案的影响 |
|---|---|---|---|
| F1 | `Message.content: string \| null`，全库无多模态 | `src/llm.ts:20-26` | 必须扩类型，且所有消费 content 的代码要过一遍 |
| F2 | queue 是 `string[]`，line 与附件无绑定 | `src/index.ts:471` | queue 元素要升级为对象 |
| F3 | HotkeyRouter 对 ctrl/meta 一律忽略 | `src/hotkeys.ts:71-73` | Ctrl+V/Alt+V 需要在这里开洞 |
| F4 | 粘贴块到达 keypress 时 `key === undefined`、ch 为整段文本 | `src/hotkeys.ts:42` 注释已证实 | 长文本检测的现成抓手 |
| F5 | estimateTokens 只遍历 `m.content` 字符串 | `src/llm.ts:302-326` | content 变数组后要适配 |
| F6 | compact() 用 `truncateArgs(m.content ?? "")` 拼接 | `src/agent.ts:189-235` | 同上 |
| F7 | persist/saveSession 直接 JSON.stringify | `src/session.ts:115-120` | base64 图直接入库会话文件膨胀 → 需要附件落盘 |
| F8 | onFirstUserInput 把首条输入前 200 字符落盘 raw/ | `src/index.ts:484-493` | 落盘的是含 chip 的行 → 隐私上反而更好，写明即可 |
| F9 | 审批问句必须复用 readline.question，不能另开 raw 监听 | `src/ui/console.ts:240` 注释 | 剪贴板读取绝不能碰 stdin 数据流 |
| F10 | readline 实例在交互模式才创建；-p 模式无输入框 | `src/index.ts:419` | 粘贴增强只作用于交互模式 |

### 2.2 协议现状

OpenAI 兼容 `/chat/completions` 的多模态 user message 标准形态：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "看这张图 [Image #1]" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } }
  ]
}
```

这是本方案消息层的唯一协议形态。provider 是否真支持由服务端决定，neo 只负责按标准发，失败时报错清晰（§6 约束 C9）。

---

## 3. 显示规格（定死，与 Claude Code 对齐）

| 场景 | 输入框显示 | 发送给模型 |
|---|---|---|
| 贴图 | `[Image #N]`（N 会话内从 1 递增） | text part（含 `[Image #N]` 字样）+ image part |
| 长文本 | `[Pasted text #N +X lines]`（X = 折叠掉的行数） | 完整原文 |
| 短文本 | 原样 | 原样 |

- 编号 N：图片与文本共用一个计数器还是各自独立？**各自独立**（`[Image #1]` `[Image #2]`…、`[Pasted text #1]` `[Pasted text #2]`…），与 Claude Code 一致。
- 折叠阈值：**≥ 3 行 或 ≥ 300 字符**（可配置，§5.7）。低于阈值原样插入。
- chip 是普通文本，用户可手动删除；删除 chip 即放弃该附件（发送时按 chip 是否仍在行内决定是否还原，§5.4）。

---

## 4. 总体设计

```
┌─ 按键层 ──────────────────────────────────────────────┐
│ Ctrl+V/Alt+V ──→ HotkeyRouter("paste-image")          │
│ 粘贴块(key===undefined) ──→ PasteInterceptor          │
└──────────┬───────────────────────────────────────────┘
           ↓
┌─ 附件层 src/attachments.ts ───────────────────────────┐
│ pending: Array<{chip, kind, payload}>                  │
│  - 图片：clipboard 读出 PNG → base64 data URL          │
│  - 文本：原文 + 行数                                    │
│ chip 插入：rl.write(chip)（走 readline 正常回显）       │
└──────────┬───────────────────────────────────────────┘
           ↓
┌─ 发送层 src/index.ts drain() ─────────────────────────┐
│ queue: {text, attachments}[]                           │
│ resolveLine(text, attachments) →                       │
│   图片 chip → 多模态 content 数组                       │
│   文本 chip → 还原原文                                  │
│ → agent.send(resolved)                                 │
└──────────┬───────────────────────────────────────────┘
           ↓
┌─ 协议层 src/llm.ts ───────────────────────────────────┐
│ Message.content: string | ContentPart[] | null         │
│ estimateTokens / compact 适配数组                       │
└──────────────────────────────────────────────────────┘
```

---

## 5. 详细设计

### 5.1 按键捕获（D1）

`HotkeyRouter.mapKey` 增加两条映射：

- `ctrl+v` → `"paste-image"`（macOS 主键位）
- `alt+v` → `"paste-image"`（Windows/WSL；`meta+v` 到达形态按实测定）

约束：

- **C1**：粘贴热键仅在 `queue.length === 0 && !draining && 无 pending question` 时响应。readline 正在问句中时 `rl.write` 会污染问句缓冲——这与 console.ts confirm 的既有结论同源。
- **C2**：响应动作是 `rl.write(chip)`，让 chip 走 readline 自己的行缓冲与回显。**绝不另开 raw-mode stdin 监听**（F9）。
- **C3**：Ctrl+V 在 node readline 无默认绑定，拦截安全；但 WSL/Windows 终端常拦截 Ctrl+V，所以 Alt+V 必须同时可用。

### 5.2 剪贴板图片读取（D2）

新文件 `src/clipboard.ts`，导出 `readClipboardImage(): Promise<{data: Buffer, mime: string} | null>`：

| 平台 | 实现 | 备注 |
|---|---|---|
| macOS | `osascript -l JavaScript`（JXA + ObjC bridge 读 NSPasteboard，PNG 二进制直出 stdout） | 零依赖，单进程 |
| Windows/WSL | PowerShell `Get-Clipboard -Format Image` 单次 spawn，PNG 编码后输出 base64 | Claude Code 踩坑：双 spawn 每次慢 0.5~2s（issue #101444/#100899），必须单次 |
| Linux | 依次探测 `wl-paste`（Wayland）/ `xclip -selection clipboard -t image/png -o`（X11），不可用返回 null | 明确报「无可用剪贴板工具」 |

约束：

- **C4**：读取必须异步，且在等待期间输入框保持可用（Claude Code issue #101277：同步读 NSPasteboard 卡死 TUI 数分钟）。实现上：按下热键立即 `rl.write("[Image #…]")` 的 loading 形态不引入——直接异步等结果，期间用户可继续打字，结果到达后 `rl.write(chip)` 追加到当前光标处。若用户已回车发送，附件随下一行走。
- **C5**：剪贴板无图（或读出的是文本）→ 返回 null，UI 静默或闪现一行 `· 剪贴板里没有图片`，**不报错**——用户可能只是想贴文本。
- **C6**：图片大小上限默认 8MB（可配置），超限拒绝并提示。
- **C7**：`readClipboardImage` 做成可注入（构造参数 / 模块级 setter），测试注入假实现——与 `AgentOptions.chatStream` 注入同一惯例。

### 5.3 长文本折叠（D5）

**检测**：粘贴块以 `key === undefined` 的 keypress 到达（F4）。PasteInterceptor 挂在 `rl.on("keypress")`（经 HotkeyRouter 派发或独立监听），当 `ch` 长度或行数超阈值时判定为粘贴。

**折叠时机**是实现分水岭，两条路线：

- **路线 A（拦截重写）**：粘贴块到达时阻止 readline 原样插入，清掉已插入部分，`rl.write(chip)`。输入框实时只显示 chip，体验最好；但需要与 readline 内部缓冲博弈（kill-line 清缓冲 + 重绘），跨 node/bun 版本脆弱。
- **路线 B（line 时折叠）**：让 readline 正常接收（回显会先刷屏），line 事件到达后把超长段替换为 chip + 附件，再重绘当前行。实现稳，体验打折（回显闪一下全文）。

**决策：探针 P1（§7）先跑，按实测结果选。** 若 node/bun 的 readline 在 bracketed paste 下把 `\n` 保留在缓冲（整段一次 line 提交），选 A；若逐行触发 line（多行粘贴被拆成多条命令），则必须选 A 且额外解决逐行提交问题——这是功能性差异，不只是体验差异。

**还原**：发送时 chip 替换为原文。用户手动删了 chip → 视为放弃粘贴，原文不发送（§5.4）。

### 5.4 queue 与还原（D4）

```ts
interface QueuedLine {
  text: string;                      // 含 chip 的原始行
  attachments: Attachment[];         // 本行产生的附件
}
type Attachment =
  | { kind: "image"; chip: string; dataUrl: string; bytes: number }
  | { kind: "text";  chip: string; content: string; lines: number };
```

`resolveLine(q: QueuedLine): { text: string; images: string[] }`：

1. 扫描 `q.text` 中的每个 chip；
2. chip 仍在行内 → 图片 chip 收集为 image part、文本 chip 替换为原文；
3. chip 已被删除 → 丢弃该附件（文本不还原、图片不发送），无提示；
4. 返回纯文本 + 图片列表，由调用方组装 content。

`agent.send` 签名扩展为 `send(input: string | { text: string; images: string[] }, opts?)`，内部组装：

```ts
content: images.length > 0
  ? [{ type: "text", text }, ...images.map(u => ({ type: "image_url", image_url: { url: u } }))]
  : text
```

### 5.5 消息模型与 token 计量（D3/D6）

`src/llm.ts`：

```ts
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
content: string | ContentPart[] | null;
```

适配点（逐一改，不许漏）：

- `estimateTokens`：数组时 text part 按原算法；**image part 固定按 800 tokens/图估算**（OpenAI detail:low 档量级；各服务端口径不一，粗估即可，注释写明）。
- `compact()`：`convoText` 拼接时数组 → `[图片×N] + text parts`。
- 会话预览（`/resume` 的 preview、`/history`）：取 text part。
- 子代理 prompt、classifier 输入：只传 text（结构性排除，见 §1.2）。

### 5.6 会话持久化与恢复（D7）

base64 图直接进会话 JSON 会让文件膨胀（一张截图 1~3MB base64），且 `~/.neo/sessions/` 会迅速变大。方案：

- 附件落盘：`~/.neo/sessions/attachments/<sessionId>/img-<N>.png`（目录按会话 id 隔离，`NEO_SESSIONS_DIR` 注入惯例沿用）。
- 持久化时：`image_url.url` 若是 data URL → 存为 `{"$ref": "attachments/<sessionId>/img-1.png"}`；恢复时读文件重组 data URL。
- 恢复时附件文件缺失 → 该 part 替换为 text part `"[Image #N 已丢失]"`，不阻塞恢复。
- 历史召回（↑）：召回行含 chip 但 pending 附件已清空 → chip 保留为字面文本发送（模型看到 `[Image #1]` 字样但无图）。**在 /help 与本文档写明此语义**；M4 若做「召回重发完整内容」再升级。

### 5.7 配置（settings.json）

```jsonc
{
  "paste": {
    "fold_lines": 3,        // ≥3 行折叠
    "fold_chars": 300,      // ≥300 字符折叠
    "image_max_bytes": 8388608
  }
}
```

缺省即上述值；`paste` 整块缺省 = 功能开启。不做「总开关关闭」——chip 语义一旦上线，关闭会造成认知分裂。

### 5.8 UI 反馈

- 附件成功：光标处出现 chip，无需额外提示（chip 本身就是反馈）。
- 剪贴板无图：`console.info("· 剪贴板里没有图片")`（dim 一行，不打断输入）。
- 图片超限 / 读取失败：`console.warn`，一行说明原因。
- 发送带图：drain 时 `console.info("· 已附加图片 [Image #1] (245KB)")`——用户对「发出去了什么」有知情权（图片可能含敏感信息）。

---

## 6. 约束汇总（实现方逐条自检）

| # | 约束 |
|---|---|
| C1 | 粘贴热键仅在输入空闲（queue 空 && !draining && 无问句）时响应 |
| C2 | chip 插入只走 `rl.write()`，禁止另开 raw-mode stdin 监听 |
| C3 | Ctrl+V 与 Alt+V 同时绑定 |
| C4 | 剪贴板读取异步，不阻塞输入循环 |
| C5 | 剪贴板无图 → 静默/info，不报错 |
| C6 | 图片大小上限 8MB 可配置，超限明确拒绝 |
| C7 | `readClipboardImage` 可注入，测试不碰真实剪贴板 |
| C8 | `Message.content` 类型扩展后，estimateTokens / compact / 预览 / persist 四处必须适配（§5.5 清单） |
| C9 | provider 拒绝 image_url 时，错误信息原样透出并追加一行「当前 provider 可能不支持图片输入」 |
| C10 | 附件落盘路径必须经过 `NEO_SESSIONS_DIR` 注入点，测试不得写真实 `~/.neo` |
| C11 | chip 编号图片/文本各自独立递增；chip 被用户删除 = 放弃附件 |
| C12 | -p 单次模式与非 TTY 下本功能整体不激活（F10） |

---

## 7. 探针（实现前必须先跑）

> **P1/P3 已完成（2026-10-19，bun + node 双 runtime 实测，伪终端 script + 注入 bracketed paste 序列）。结论如下，与原假设冲突处以本节为准：**
>
> 1. **F4 证伪**：粘贴块不是「key===undefined 的整块 keypress」。实际形态：`paste-start` / `paste-end` **命名 keypress 事件**（`name:"paste-start"`，`code:"[200~"`），内容逐字符到达，粘贴内的 `\n` 变成 `name:"enter"` 的 keypress。bun 与 node 行为**完全一致**（R2 解除）。
> 2. **逐行提交实锤**（R1 成立）：3 行粘贴触发 3 次 `line` 事件逐行提交；`paste-end` 时 readline 还会**冲刷残留缓冲**再发一次 `line`（尾随 `\n` 的粘贴冲刷出空 line）。
> 3. **手段B（paste-end 清缓冲）无效**：line 提交发生在粘贴**过程中**，paste-end 已太晚；实测清空 `rl.line` 后冲刷 line 照发。
> 4. **readline 不自带 bracketed paste**：启动输出无 `\x1b[?2004h`。要拿到 paste-start/end 标记，**neo 必须自行启用**（启动写 `2004h`、退出写 `2004l`）；终端不支持该模式时无标记，行为退化为现状（不可修复，非回归）。
> 5. **历史污染**：粘贴的每一行都会进入 `rl.history`（↑ 召回会翻出粘贴碎片）——需在 paste-end 时回滚 history 长度。
> 6. **P3 键位**：Ctrl+V → `{name:"v", ctrl:true}`（ch=`\x16`）；Alt+V → `{name:"v", meta:true}`。两者均不进缓冲，可安全拦截。
> 7. **路线判定**：原路线 A/B 分野失效。正确路线为**「粘贴期间丢弃 + paste-end 重组」**：paste-start 置 `pasteActive` 标志 → line 处理器在标志期间丢弃并入栈（C11 同款模式）→ paste-end 把栈内行 join 成全文 → 按阈值折叠为 chip（`rl.write(chip)`）或原样回填（`rl.write(全文)`，短粘贴有回显闪现，可接受）。
> 8. P2（剪贴板 JXA）属 M2，未跑。

**P1 readline bracketed paste 行为**（决定 §5.3 路线 A/B）：

```ts
// probe-paste.ts —— bun probe-paste.ts 后手动粘贴多行文本
import { createInterface, emitKeypressEvents } from "node:readline";
const rl = createInterface({ input: process.stdin, output: process.stdout });
emitKeypressEvents(process.stdin, rl);
process.stdin.on("keypress", (ch, key) => {
  if (!key && ch && (ch.includes("\n") || ch.length > 50)) {
    console.error(`PASTE-BLOCK len=${ch.length} lines=${ch.split("\n").length}`);
  }
});
rl.on("line", (l) => console.error(`LINE lines=${l.split("\n").length} head=${JSON.stringify(l.slice(0, 40))}`));
```

判定：若一次粘贴只触发**一条** line（含全部 \n）→ 选路线 A，折叠体验完整；若触发**多条** line → 选路线 A 且必须先解决逐行提交（否则多行粘贴会连发多条消息，比不折叠更糟）。

**P2 macOS JXA 剪贴板脚本**：验证 `osascript -l JavaScript` 能否单进程输出 PNG 二进制（含「剪贴板无图」分支的退出码约定）。

**P3 Ctrl+V 键位到达形态**：验证 node readline 下 Ctrl+V 产生 `key={ctrl:true,name:"v"}` 且不插入缓冲；bun runtime 下行为一致（neo 跑在 bun 上，readline 是 node 兼容层，需实测）。

---

## 8. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/clipboard.ts` | **新增**。平台剪贴板读取（C7 注入点） |
| `src/attachments.ts` | **新增**。Attachment 类型、chip 生成与编号、resolveLine 还原、附件落盘/恢复 |
| `src/llm.ts` | `ContentPart` 类型；`Message.content` 扩展；estimateTokens 适配（图 800 tok/张） |
| `src/hotkeys.ts` | mapKey 增加 `paste-image`（ctrl+v / alt+v）；新增 `paste-block` 事件（key===undefined 的粘贴块） |
| `src/index.ts` | queue 元素升级 `QueuedLine`；drain 调 resolveLine；热键接线（C1 的空闲判定）；onFirstUserInput 传 chip 行（F8，语义不变） |
| `src/agent.ts` | `send` 接受多模态输入；compact 适配数组 |
| `src/session.ts` | 附件目录约定；持久化 data URL → `$ref`；恢复重组（C10） |
| `src/config.ts` | `paste` 配置块解析（§5.7） |
| `src/ui/console.ts` | 无结构改动；info/warn 复用现有方法 |
| `tests/paste.test.ts` | **新增**。见 §9 |
| `docs/release-notes/v0.1.6.md` | 发布说明 |

---

## 9. 测试与验收

自动测试（bun test，全部走注入点，不碰真实剪贴板与真实 `~/.neo`）：

1. **折叠判定**：3 行/300 字符边界值；2 行 299 字符不折叠。
2. **resolveLine**：chip 在 → 还原；chip 被删 → 丢弃；混合多附件；chip 文本恰好在普通正文出现（用户手打 `[Image #1]`）**不**被误还原——还原只认 pending 里的 chip 精确串。
3. **多模态序列化**：`send({text, images})` 组装出的 content 数组结构正确；纯文本路径退化为 string（不破坏现有 provider）。
4. **estimateTokens**：数组 content 不再返回 NaN/0；图片按 800 计。
5. **持久化往返**：save（data URL → $ref + 文件落盘）→ load（$ref → data URL）；附件文件缺失 → `[Image #N 已丢失]`。
6. **热键空闲判定**：draining 中按 Ctrl+V 不产生附件。

手动验收清单：

- [ ] macOS 贴图：微信截图 → Ctrl+V → `[Image #1]` → 发送 → 模型能描述图内容
- [ ] 连续贴 3 张图，编号 1/2/3 正确
- [ ] 贴 50 行日志 → 输入框只见 chip → 发送 → 模型引用了日志末尾内容（证明全文送达）
- [ ] 贴图后删掉 chip 再发送 → 模型收不到图、不报错
- [ ] `--resume` 恢复带图会话 → 重新提问，模型仍能看图
- [ ] 剪贴板是文本时按 Ctrl+V → info 一行，输入框无变化
- [ ] `-p` 模式与管道下无任何粘贴相关行为
- [ ] `bunx tsc --noEmit` 零错误；`bun test` 全绿

---

## 10. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | readline bracketed paste 逐行提交 → 多行粘贴连发多条消息 | 探针 P1 前置；路线 A 强制拦截 |
| R2 | bun 的 readline 兼容层与 node 行为差异 | 探针 P3 在 bun runtime 下实测 |
| R3 | provider 不支持 image_url | C9 明确报错；文档列出已验证 provider |
| R4 | 会话文件膨胀 | §5.6 落盘方案 |
| R5 | Windows PowerShell 慢 | 单次 spawn（C4 关联）；M3 交付时实测 < 500ms |
| R6 | chip 字符串与用户正文冲突 | 测试 2 的「手打 chip 不误还原」用例 |
| R7 | JXA 脚本在 macOS 版本间差异 | P2 探针 + clipboard.ts 内平台分支各自可注入测试 |

---

## 11. 分期交付

| 期 | 内容 | 依赖 |
|---|---|---|
| M1 | 长文本折叠（路线 A/B 按 P1 定）+ resolveLine + queue 升级 + 配置块 | 探针 P1/P3 —— **✅ 已完成（2026-10-19）**。路线按 §7 探针改为「粘贴期间丢弃 + paste-end 重组」；交付 `src/paste.ts` + `src/attachments.ts` + hotkeys paste-start/end + queue 升级 QueuedLine + 2004h/l 启停；17 条单测 + 真实 pty E2E（chip 显示/全文送达/无逐行提交/退出还原四判定全过） |
| M2 | macOS 贴图 + ContentPart 协议 + estimateTokens/compact 适配 + 附件落盘/恢复 | 探针 P2 |
| M3 | Windows/WSL + Linux 剪贴板 | M2 |
| M4（可选） | 历史召回重发完整粘贴内容（需把粘贴映射持久化到会话） | M1 |

每期独立可发布，M1 单独上线即有用户价值。
