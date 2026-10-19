# select 组件 M0 探针结论

> 日期：2026-10-18
> 环境：bun 1.3.13 · macOS x64 · Apple_Terminal · TERM=xterm-256color
> 方法：无头模拟不可用（原因见 §6），最终经 pty（`script -q /dev/null`）喂真实按键字节全自动跑通
> 探针脚本：`probe-select.ts` + `probe-driver.sh`（仓库根目录，M1 合入后删除；非 PRD §7 交付物）
> 本文件是 PRD §6 的结论落点；PRD 侧只留指针，不重复正文。

## 0. 一页速览

| 探针 | 结论 | 对约束的影响 |
|---|---|---|
| P1 | 污染证实（↑ 召回历史进 rl.line）；PRD 手段A失效，手段B可用 | C5 定案：`rl.line = ""` + `_refreshLine()` |
| P2 | select 期间回车会把缓冲残留作为 line 事件发出，**非空残留会入队执行** | C11 需强化：line 处理器加 selectActive 丢弃守卫 |
| P3 | ESC 经 keypress 可达、不污染缓冲；但生产 ESC 处理器从未生效（见 §1 存量 bug） | C10 静态成立，动态依赖 §1 修复 |
| P4 | `\x1b[{n}A` + `\x1b[2K` 重绘正确；stdout `resize` 事件可用 | C13 可行；iTerm2 待 M1 人工验收 |

## 1. 重大意外发现：HotkeyRouter.attach 存量 bug（PRD F3 证伪）

实测 bun 1.3.13 与 node v24.21.0 **都**把 keypress 事件发在 **stdin** 上，而不是 readline 实例上：

- `rl.on("keypress", …)` → 0 个事件（两运行时一致）
- `process.stdin.on("keypress", …)` → 全部按键（bun 实测 19/19，node 实测 a/up/escape）

而 `src/hotkeys.ts:47` 的 attach 把监听挂在 `rl` 上——**生产环境所有热键（含运行中 ESC 取消）从未生效过**。单测没抓到是因为 `tests/hotkeys.test.ts:28` 的假 readline 直接在 rl 上 emit，测试工件 ≠ 真实事件路径。

连带发现：真实回车的 keypress name 是 **`"return"`** 不是 `"enter"`（两运行时一致），`mapKey`（hotkeys.ts:80）只认 `"enter"`，enter 映射也从未命中。

**修复方向（M1 内做，改动很小）**：attach 改为监听 `input`（第二个参数本来就传了 input 流）；`mapKey` 同时认 `"return"` 与 `"enter"`；同步修正测试 fake 的 emit 目标。PRD §7「hotkeys.ts 零改动」作废，以此节为改动依据。

## 2. P1 行缓冲污染与清理（C4/C5 定案）

实测时间线（pty 喂键，40ms 轮询 rl.line）：

| 步骤 | rl.line | 说明 |
|---|---|---|
| 输入 hello ⏎ | `""` | 进入 history |
| 按 ↑ | `"hello"` | **历史召回污染证实** |
| 继续输 12ab | `"hello12ab"` | 残留叠加 |

清理手段逐一实测：

| 手段 | 结果 | 判定 |
|---|---|---|
| A：`rl.write(null, {ctrl:true, name:"u"})` | bun 抛 `TypeError: ERR_INVALID_ARG_TYPE` | **不可用**（node 签名 bun 未实现） |
| A'：`rl.write("\x15")`（原始 ctrl-u 字节） | 不报错，但 `\x15` 被当作普通字符**插入行内容**（`"hello12ab\x15"`） | **不可用** |
| B：`rl.line = ""` + `rl._refreshLine?.()` | 行清空、重绘正常（`_refreshLine` 存在） | **✅ C5 定案采用** |

手段B生效后最终提示符干净（`❯` 后无残留）。已知小代价：污染提交会进 readline history（实测 historyLen 2），M1 不做 history 清理。

## 3. P2 回车双路径（C11 强化）

- select 期间按回车，readline 照常发 line 事件，内容是**当时缓冲里的残留**：实测非空残留 `"q9"`（另一轮为 `"12ab"`）与空 `""` 都出现过。
- 空行：生产代码已忽略（`src/index.ts:541-543` trim 后 return）——PRD 设想的 C11 守卫已存在。
- **非空残留是真风险**：会入队，在 handleCommand 返回后被当成命令/聊天消息执行（`"q9"` → 未知命令噪音；若像聊天文本则触发意外轮次）。
- **C11 强化**：index.ts 的 line 处理器加 selectActive 守卫——select 存续期间 line 事件一律丢弃；select 结束时用手段B清缓冲兜底。

## 4. P3 ESC

- ESC 的 keypress 可达（stdin 路径，见 §1），且**不污染行缓冲**（esc 后 rl.line 保持空，随后的空行提交被生产代码忽略）。
- ESC 处理器「仅运行中响应」的静态守卫在 `src/index.ts:477-480`，成立；但其动态生效以 §1 修复为前提。
- Ctrl+C 走 SIGINT（F7），不经 keypress，与本结论无冲突。

## 5. P4 渲染与 resize（C13）

- `\x1b[{n}A` 上移 + `\x1b[2K` 清行 + `\r` 的重绘序列在 Apple_Terminal 实测正确：连续 5 次重绘无残影、无错位，光标数学成立。
- `process.stdout` 的 `resize` 事件实测触发（stty 改 pty 尺寸两次 → 事件 2 次）→ C13 的 resize 重画方案可行。
- iTerm2 未测（本探针只自动化了 Apple_Terminal）→ 列入 M1 人工验收清单，不阻塞 M1。

## 6. 方法备注：为什么必须 pty

- bun 的 readline 在非 TTY 流（PassThrough）上**不运行行编辑器**：rl.line 恒空、无 keypress、history 恒空——无头模拟对 P1 完全无效。
- `rl.write(string)` 在无头下也不进编辑器；`rl.write(null, {name})` 直接抛 TypeError（见 §2 手段A）。
- 可行方法：`script -q /dev/null bun probe-select.ts` 造真 pty，driver 脚本按时间线喂原始字节（↑=`\x1b[A`、ctrl-u=`\x15`、esc=`\x1b`）。此方法可复用于后续一切 readline 行为探针。

## 7. 对 M1 的直接影响（实现清单）

1. hotkeys.ts 小改：attach 监听 input；mapKey 认 `"return"`（保留 `"enter"` 别名）；同步修 tests/hotkeys.test.ts 的 fake emit 目标（§1）。
2. C5 定案：select 结束/取消时 `rl.line = ""` + `(rl as any)._refreshLine?.()`（§2 手段B）。
3. C11 强化：line 处理器加 selectActive 丢弃守卫；空行守卫已存在（§3）。
4. select 打开前 `stopSpinner()` + `blank()`（C1，沿用 choose 惯例）。
5. resize 监听直接做（C13 可行，§5）。
6. M3 数字直选：清理手段已验证，技术上解锁；仍按 PRD 延后。
