# 用外部编辑器撰写提示词（Ctrl+G）

> 状态：实施中（issue #62）
> 参考：Claude Code `Ctrl+G` / OpenCode `/editor`

## 1. 要做什么

用户在 neo 的输入框里敲 `Ctrl+G`，neo 把当前输入框内容写进一个临时文件，调起 `$EDITOR`（或 `$VISUAL`）指定的编辑器；用户保存退出后，neo 把文件内容读回来回填输入框。

做完能干什么：写长需求、粘贴并改写一大段日志、编辑多段结构化提示时，不必在终端里逐行敲。

## 2. 现状与缺口

- `src/tui/composer.ts` 只支持行内编辑（`src/tui/buffer.ts` 的 `TextBuffer`）。
- 源码中没有任何 `EDITOR` / `VISUAL` 调起逻辑，也没有对应快捷键。
- 已有现成地基：`src/tui/composer.ts` 的 `suspend()` / `resume()`（`!cmd` 执行外部进程时用的同一套：停按键监听、恢复 cooked mode、显示光标、擦帧），`src/tui/keys.ts` 的 `mapKey()` 键位归一化，`src/tui/buffer.ts` 的 `setText()` 回填。

## 3. 交互契约

| 环节 | 行为 |
| --- | --- |
| 触发 | 输入框内按 `Ctrl+G`（`mapKey` 归一为 `ctrl-g` 动作；`Ctrl+G` 与其它 `ctrl-*` 动作同级，不进插入文本路径） |
| 编辑器来源 | `$VISUAL` 优先，回落 `$EDITOR`；两者都没设 → 不启动编辑器，输入框不变，给一句可读提示 |
| 内容载体 | 当前输入框全文写入临时文件；编辑器带该文件路径启动（stdin/stdout/stderr 继承终端） |
| 回填 | 编辑器正常退出（exit 0）→ 读回文件全文，替换输入框内容，光标置于末尾 |
| 编辑器非 0 退出 | **不回填**，输入框保持原样，给可读提示（视作用户主动放弃，如 `vim :cq`） |
| 编辑器起不来（ENOENT 等） | 不回填，输入框保持原样，给可读提示（含可执行名与原因） |
| 临时文件 | 建在系统临时目录下的独立子目录，用完即删（`rm -rf` 那一层），不留残余 |
| 期间界面 | 编辑器运行期间输入框处于「挂起」态：按键不响应、帧已擦除、光标交给编辑器；退出后恢复 raw mode 并重画 |
| 无内容时 | 输入框为空也可以进编辑器（等价于「从空白起草」） |

## 4. 非目标（本版不做）

- `Ctrl+X Ctrl+E` 这类 readline 风格多键序列（v1 只有 `Ctrl+G`）。
- `/editor` 斜杠命令（会牵动命令注册表与漂移守卫，另开单）。
- 把上一条回复以 `#` 注释附在编辑器文件顶部（Claude Code 的做法）。
- 编辑器会话与 neo 会话的状态同步（不监视文件变化、不做外部改动回灌）。
- 非 TTY（readline 老路径）下的编辑器调用 —— v1 只在 TUI 输入框里可用。

## 5. 验收条款

每条都要能在测试里找到对应：

| 编号 | 条款 | 验证位置 |
| --- | --- | --- |
| E1 | `$VISUAL` 优先于 `$EDITOR`；只有 `$EDITOR` 时用它；都没有 → 不可用 | `tests/editor-prompt.test.ts`（E1a–E1d） |
| E2 | 编辑器命令按引号切分（`"my editor" --wait` → `["my editor","--wait"]`） | `tests/editor-prompt.test.ts`（E2a–E2d） |
| E3 | 提示词全文写入临时文件，编辑器被以该文件路径启动（文件后缀 `.md`） | `tests/editor-prompt.test.ts`（E3、E3b） |
| E4 | 编辑器 exit 0 → 回填文件内容 | `tests/editor-prompt.test.ts` + `tests/tui-composer.test.ts`（E9） |
| E5 | 编辑器非 0 退出 / 内容为空 → 不回填，输入框内容不变 | `tests/editor-prompt.test.ts`（E5、E5b）+ `tests/tui-composer.test.ts`（E10） |
| E6 | 编辑器启动失败 → 不回填，给可读原因 | `tests/editor-prompt.test.ts`（E6） |
| E7 | 临时文件用完即删 | `tests/editor-prompt.test.ts`（E7、E7b） |
| E8 | `Ctrl+G` 在输入框里映射为 `ctrl-g` 动作，不落成插入文本 | `tests/tui-keys.test.ts`（E8a、E8b） |
| E9 | `Ctrl+G` → 编辑器内容回填输入框、光标在末尾；编辑器期间输入框挂起，退出后恢复 | `tests/tui-composer.test.ts`（E9、E9b） |
| E10 | 未配置编辑器 → 输入框不变，给一句可读提示 | `tests/tui-composer.test.ts`（E10、E10b） |

## 6. 已知风险

- 编辑器接管终端期间若被强杀（SIGKILL），neo 的终端可能停在 cooked mode —— 与 `!cmd` 现有行为同级，由终端自身的 `reset` 兜底，本版不额外处理。
- 编辑器命令里带 shell 元字符时按「参数数组」原样传递（不经 shell），因此 `EDITOR="code --wait"` 可用，但 `EDITOR="code && echo x"` 不会被 shell 解释 —— 这是刻意的：不经 shell 就不会引入命令注入面。
