# neo 开发踩坑

> 最后更新:2026-10-20

## 摘要

neo 开发过程中沉淀的教训清单,持续追加。当前十条:zsh 变量不分词、gitignore 无法区分软链与真目录、google 国别域不命中搜索改写、fast 路由模型池判死、本地配置不进 git 的同步义务、bun test 单进程共享模块表导致 mock.module 泄漏、AbortSignal 上没有 abort()、双源版本号 bump 漏改一处、运行时工具被「子代理排除表」误过滤出主代理工具清单、watchdog 心跳不能挂在空闲 tick 上。每条按「现象 / 根因 / 教训」记录。

## 一、zsh 变量不分词

- **现象**:脚本里 `for s in $SKILLS` 遍历失败,`diff` 报 `No such file or directory`,整串技能名被当成一个路径
- **根因**:zsh 不对未加引号的 `$VAR` 做 word splitting(bash 会);`set -e` 让脚本在第一步安全中止,**未执行任何删除**
- **教训**:跨 shell 脚本用显式列表,或 zsh 的 `${=VAR}` 强制分词;`set -e` + 幂等设计让失败无害

## 二、gitignore 无法区分软链与真目录

- **现象**:想在项目里 ignore 掉 `skills/` 下的软链,但写 `skills/` 会连项目私有技能(真目录)一起 ignore
- **根因**:gitignore 按路径模式匹配,不感知文件类型
- **教训**:项目软链不入库,靠 `ensureSkill` 机制自动补链;`.gitignore:8` 有注释说明此约定

## 三、google 国别域不命中搜索改写

- **现象**:v0.1.1 测试用 `www.google.com.hk` 验证子域命中,断言失败
- **根因**:该主机名以 `.com.hk` 结尾,不匹配 `endsWith(".google.com")`;失败的是测试断言而非实现
- **教训**:写测试前先人工推演边界;实现边界行为(google.com.hk 不被改写)属预期外但可接受,要覆盖需单独加规则

## 四、fast 路由模型池判死

- **现象**:`settings.json` L44 `model_routes.fast.model = "l-deepseek-v4-flash"` 时,3 个 backend 池乱跳,最短 0.52s / 最长 180.51s,std ≈ 87s,差 350×
- **根因**:该模型名在 provider 端命中不稳定的 backend 池;删除该字段后回落 `ipsa.fast_model_name = "deepseek-flash"`(走快照 `Deepseek/deepseek-v4-flash-202605`),std ≈ 0.2s,稳
- **教训**:路由配置的回落逻辑(`routeModel()`,`src/config.ts:421`)是可靠路径;模型池稳定性要靠实测数据(Huang n=3)判定,不凭名义判断

## 五、本地配置不进 git 的同步义务

- **现象**:fast 路由修复改的是 `settings.json`,但它在 gitignore 中(本地配置不进版本控制),代码仓库里的修复无法自动到达用户
- **根因**:仓库政策与用户环境天然隔离
- **教训**:此类修复必须在 release note 单列「不进 git 的配置变更」一节,写明改前/改后与理由,由用户手动同步

## 六、bun test 单进程共享模块表,mock.module 全局泄漏

- **现象**:热键功能测试里 `mock.module("../src/llm.ts")` 注入假 chatStream 并把 `estimateTokens` mock 成常数,单文件跑全绿;全量跑时 `skill-budget.test.ts` M4 假失败(它真用 estimateTokens 算预算)
- **根因**:bun test 单进程共享模块表,`mock.module` 是进程级副作用,跨文件泄漏
- **教训**:共享模块不要 mock.module,给被测类开构造注入点(`AgentOptions.chatStream?`);「单文件过、全量挂」优先怀疑模块污染

## 七、AbortSignal 上没有 abort()

- **现象**:测试 mock 里写 `signal?.abort()` 报 TypeError,`abort is not a function`
- **根因**:`abort()` 在 `AbortController` 上,`AbortSignal` 只有只读的 `aborted` 与事件
- **教训**:mock 里触发取消走 `agent.cancel()` 真实路径,别直接操作 signal

## 八、双源版本号 bump 漏改一处

- **现象**:v0.1.3 发布时发现 `src/index.ts` 的 `VERSION` 仍停在 "0.1.1" —— v0.1.2 的 release commit 声称双源 bump,实际只改了 package.json
- **根因**:同一事实两处维护,靠人肉记忆同步;banner 显示版本与包版本静默分叉,无测试守护
- **教训**:发布检查清单里「双源 grep 验证」应固化为步骤(`grep -n '"version"' package.json` + `grep -n 'VERSION' src/index.ts`);更彻底的解法是单源化(package.json 为准,index.ts 运行时读取),待办

## 修订记录

- 无

## 关联主题

- [[neo-v0.1.1]] —— 第三条踩坑的出处版本
- [[karpathy-wiki-技能拓扑]] —— 第二条踩坑在拓扑重构中的落地
- [[neo-v0.1.0]] —— 开发周期中同类问题的早期记录(两轮 Coco review)
- [[热键系统-v0.1.2+]] —— 第六、七条踩坑的出处(2026-10-18 热键开发)

## 来源

- `raw/2026-10-16_neo-v0.1.1-工作纪要.md` §四

## 推理与依据

- **发布时先 tag 后 rebase 会让 tag 指向孤儿 commit**（2026-10-19，v0.1.10）：推送被拒（远程有网页端直加的 LICENSE commit）→ 本地 rebase 后 tag 仍指向 rebase 前的旧 release commit，远程 tag 脱离 main 历史。正确顺序：先 `git fetch` 处理分叉、rebase 完成，**最后**打 tag 再推。验证方法：`git ls-remote origin refs/tags/<tag> refs/heads/main` 两者应同 hash。另：gitee 网页端直改（如加 LICENSE）会造成本地推送被拒，发布前先 fetch 是必要动作。

- 2026-10-20（session 20261020-205625-7otggv）：第九条：运行时注册的工具不一定出现在主代理工具清单里（v0.2.1 已修）。

现象：验证跨会话消息时，`send_message` 是运行时注册的工具，系统提示里也写着有，但主代理的实际工具清单里没有，无法像普通工具那样调用；同一轮里 `task` / `wiki_*` / `remember` 也被悄悄过滤。

根因：`Agent.toolSpecsFor()` 把 `TOOL_NAMES_EXCLUDED_FOR_SUBAGENT`（子代理排除表）无条件套在了所有 Agent 上，运行时注册的工具全被主代理过滤。v0.2.0 之前就存在，只是跨会话功能把它显性暴露了。

修法（v0.2.1）：`AgentOptions` 增加 `isSubagent`；只有子代理应用排除表，主代理拿全量工具。回归测试断言主代理含 `compact_ctx` / `send_message` / `list_peers`，`isSubagent=true` 才排除。排查同款问题的入口：`Agent.toolSpecsFor()` + `tests/mailbox-agent.test.ts` 的「运行时工具可见性」用例。

- 2026-10-20（session 20261020-205621-mbd4fb）：第十条：watchdog 心跳不能挂在空闲 tick 上（v0.2.1 已修）。

现象：两个真实会话中，huan 在 150s 的长 LLM turn 里被 anders 的 watchdog 报 `dead`（心跳停约 234s），但 `ps -p` 进程存活、state 里 `phase: "working"`。

根因：15s 心跳只在 REPL 空闲 tick 里刷新；turn 进行中 tick 被 `draining` 挡住，心跳停止。watchdog 只看 `heartbeat_at` 就判死。

修法（v0.2.1）：心跳拆成独立 `setInterval`（turn 中照常刷）；流式输出按 30s 节流计入 `last_progress_at`；`PeerObservation.pid_alive` 用 `process.kill(pid,0)` 做第二道保险，心跳超时但进程存活时降级 `stale` 而非 `dead`。教训：**liveness 信号必须独立于业务忙闲**，不能用「没在处理输入」推断「进程死了」。

## 2026-10-19 JXA（osascript -l JavaScript）三坑：stdout 污染 / 退出码不可控 / 无 console.error

- 现象：P2 探针验证 PRD §5.2 原设计「JXA 读剪贴板 PNG 二进制直出 stdout」，输出比原始 PNG 多 2 字节；想用退出码区分「无图/异常」分支，全部失效。
- 根因：① JXA 的 `run()` 返回值**永远被序列化追加到 stdout**（返回 0 → 尾部 `"0\n"`，二进制通道被污染，`file` 命令只认头部发现不了）；② `return 2` → osascript exit 0；`$.exit(2)` → exit 1 且 stderr 空——退出码无法承载自定义语义；③ JXA 环境没有 `console.error`（调用即 TypeError 崩溃）。
- 对策：二进制走**临时文件协议**（`NSData.writeToFileAtomically`，实测与原始逐字节一致），TS 侧以文件存在性为成功判据，诊断走 `NSFileHandle.fileHandleWithStandardError`（实测可达 stderr）；退出码一律不信任。
- 教训：凡是「进程间传二进制」，先探针验证通道纯净性（`cmp` 逐字节比对），不能只看 `file` 认头部——PRD 阶段的「stdout 直出」设想在 macOS scripting 桥接层不成立，探针一次就省掉一整条脏数据链路。

## 2026-10-19 K6/K9 测试断言死路径：gitignore 修复后测试未联动

- 现象：`bun test` 长期 2 fail（K6/K9，gitignore-rules.test.ts），干净基线也挂，困扰多轮会话。
- 根因：v0.1.5 修复了 `.gitignore` 死规则（`.neo/.wiki/outputs/` → `.neo/wiki/outputs/`，路径多写一个点），但测试断言没跟着改——K5/K6/K9 仍在对死路径 `.neo/.wiki/` 断言。死路径上 K6 恒失败；更隐蔽的是 **K5 恒通过**：死路径永远不会被任何规则命中，「未被忽略」断言空过（vacuous pass），约束 15 实际处于无验证状态。
- 修复（2026-10-19）：动手前用 `git check-ignore` 对 8 条路径实证（死路径 unignored / 真路径 IGNORED，实现侧正确），确认方向后才改；测试内 19 处 `.neo/.wiki/` → `.neo/wiki/`，全量 366 pass / 0 fail / 1 skip。
- 教训：修 bug 时实现侧与测试侧必须同 commit 联动——只修实现不修测试，测试就从守护者变成假警报源。判断「测试错还是实现错」别靠推理定案，用 `git check-ignore` 这类工具对真实行为实证后再动手；同理，恒真断言（对死路径断言「未被忽略」）是测试套件的盲区，绿不代表验证了任何东西。

## 2026-10-18 select M0 阶段连续两轮会话超时

- 现象：select 组件 M0 探针阶段，连续两轮会话超时中断，用户被迫两次喊「继续」。
- 根因：单轮塞的动作太多。两轮的共同模式 = 长链推理 + 并行多工具调用（shell + read_file 同发）+ 大文件写入（150+ 行探针脚本）挤在同一轮；思维链越长、工具越多，超时概率越高。
- 对策（自本轮起执行的规划方式）：一轮只做一个小动作——要么一次工具调用，要么一次小编辑；大文件拆多次写；探针/实现拆成多轮，每轮结束即落盘中间结论，中断可续。
- 附带教训：探针结论要尽早写回 PRD（§6），不要攒在对话里——对话一断，未落盘的结论就悬空。

## 2026-10-20 记忆激活三坑：mkdir recursive 吞 EEXIST / 后台提炼退出留锁 / append 不同步 INDEX

- **`mkdirSync(dir,{recursive:true})` 不抛 EEXIST**：记忆互斥锁沿用它，导致「第二次加锁」静默成功，互斥从未生效（探针实测两次均成功）。正确做法：先递归建父目录，再对锁目录本身做**非递归** mkdir，EEXIST 才表示他方持锁。
- **后台提炼进程被杀会留下锁**：`-p` 模式 flush 超时后主进程退出，提炼仍在飞，`finally` 没机会释放锁 —— 实测留下 `.write.lock` 卡死后续捕获。两层修复：锁目录 mtime 超 2 分钟自动清理（`tryAcquireLock(lockDir,{staleMs})`）+ 先落 journal 后提炼，未完成的下次启动恢复。
- **`wiki_write append` 不同步 INDEX**：返回 `indexSynced:false`，自动沉淀的页面在 INDEX 里永远停着创建时的旧摘要。修复：append 后用更新后正文重算摘要并 `syncIndex`；顺带修了 append 段内容插到旧内容之前的顺序 bug。

## 2026-10-25 TUI 补漏三坑：PTY 必须 --auto off / script(1) 不吃 socketpair / COLUMNS 改不了 winsize

- **PTY E2E 不加 `--auto off` 会偷打真实网络**：规则分类器把「读一下 a.txt」判成 fast 档，`applyTier` 会经 provider 路由把 `cfg.baseUrl` 重置回 settings.json 里的真实 provider —— 假端点被绕过，测试时好时坏、还烧真钱。修复：所有 PTY 场景显式 `--auto off`。教训：**任何靠环境变量覆盖 baseUrl 的离线测试，都要先关掉所有会重算路由的开关**。
- **macOS `script(1)` 不接受 Bun 的 `stdin:"pipe"`**：Bun 的 pipe 是 socketpair，`script` 启动即报 `tcgetattr/ioctl: Operation not supported on socket`。解法：`mkfifo` + `/bin/sh -c 'cat <fifo> | script ...'`，让 script 拿到真 pipe；写入端 `O_NONBLOCK` 按行写。
- **`COLUMNS` 环境变量不改变 Bun 的 `process.stdout.columns`**：窄终端测试必须走 PTY wrapper 内 `stty cols 60 rows 40`（ioctl TIOCSWINSZ），`COLUMNS`/`LINES` 只能当双保险。顺带实证：Bun 1.3.13 在 winsize 变化时 `process.stdout` 会派发 `resize`，v0.2.3 的 `handleResize` 不是死代码。
- **别用会话 JSON 推断屏幕行为**：`~/.neo/sessions/*.json` 里有 2901 字正文，不代表它没上屏 —— 真实缺陷是流式状态泄漏（`●` 前缀只出现一次）。屏幕行为一律以真 PTY 捕获为准（证据见 `scripts/pty-e2e.ts`）。

## 2026-10-25 readline 三坑：非 TTY 不跑行编辑器 / 裸 Tab 插字面量 / Ctrl+J 顺序不可靠

- **readline 的「terminal 模式」取 `!!output.isTTY`，非 TTY 流上根本不跑行编辑器**：我用管道跑探针，看到「`completer` 从不被调用、Tab 被当普通字符插进 line（提交 `"ab\tZ"`）」，据此得出「bun 不支持 Tab 补全」——**真 PTY 复测推翻了它**（原生 completer 生效，单候选自动补全）。教训：**凡是要断言 readline 行为，必须在真 PTY（`script(1)`/pty）里跑**；管道只代表非交互语义。证据见 `docs/v0.2.4-m0-probes[done].md`。
- **不传 completer 时裸 Tab 会字面插入 `\t` 进 `rl.line`**：自接管 Tab 的实现在真 PTY 下会收到带 `\t` 的缓冲。修法两层：`createInterface({completer: () => [[], line]})` 注册 no-op 从源头吞掉 + 实现侧再兜底摘一次。
- **`Ctrl+J`(0x0A) 与 `Enter`(0x0D) 可区分，但 keypress / line 的先后顺序由监听器注册时机决定**：默认路径拦不住 Ctrl+J（line 先到）。稳定做法是在 stdin `data` 事件里按字节记类型（比 readline 处理更早），且要按**队列**消费——一个数据块可能产生多个 line 事件，CRLF 只算一个 Enter。
- **`rl.prompt()` 无参调用会把 `rl.cursor` 归零**：补全后继续输入会变成 `X@补全结果`；`_refreshLine()` 保留 cursor。用 `rl.line=` 改写缓冲后要么手动设 `rl.cursor`，要么走 `_refreshLine()`。
- **续行/多行与 readline history 的交互**：readline 只把非空且非纯空白的行写进 history；无条件 splice 会误删上一条真实历史。回滚前先校验 `history[0] === 该行`。

## 2026-10-25 v0.3.0 live 帧八坑：提交行后光标归零 / resize 残影 / activity 状态 / 粘贴丢包 / 用户消息 / 审批不卸载 / PTY 中间态 / stty 要 /dev/tty

- **提交行后必须把「帧内光标行号」归零**：`FrameRenderer` 用 `cursorRowInFrame` 决定下一次 `CSI nA` 上移几行；提交行写完栈顶光标已在帧下方，若仍按旧行号擦除，会把刚写进 scrollback 的提交行擦掉（M0 第一次实现就踩到，P2 场景固化）。
- **resize 只 invalidate 不擦旧帧会留残影**：`onResize` 先 `frame.erase()`（按 resize 前坐标尽力擦）再 `invalidate()` 重画；S15 一开始偶发「旧 100 列顶线留在历史里」。
- **状态行时长不能用 `draining` 判断**：斜杠命令/选择菜单期间 drain 也是 true，`Date.now() - 0` 会显示 49 万小时；新增 `turnActive` 只在 agent turn 期间为真。
- **`dock.finishActivity` 不能无条件 flush pending**：agent 在首个正文 chunk 前会再调一次 `stopSpinner`，若 spinner 收尾也 flush，「● 」前缀会被单独提交成一行（S1 回归，真 bug）；只有 persist 的工具行才 flush。
- **paste-end 丢包必须有 idle 兜底**：bracketed paste 缺结束标记会让 `pasteActive` 永久为真、之后所有按键被静默吞掉；1s idle 超时收尾（qwen 用注释标出的坑），单测用 `pasteIdleMs` 调小验证。
- **用户消息要在提交时写进 scrollback**：输入框提交后只清 buffer 的话，历史和屏幕上都会「查无此消息」；`commitUserInput` 负责首行 `❯ `、续行两空格，并先 `dock.flushPending()` 保证顺序。
- **审批态不能卸载输入框**：问题显示在框上方、顶线变「确认」，输入框继续可见（qwen 的 residual 类问题）；同时 `stopSpinner` 的 dock 分支必须清 `toolLineTimer/toolLineActive`，否则 350ms 计时器会把活动行画回来、同一工具重复落盘。
- **PTY 断言不能抓「流式字节的中间态」**：一次帧写入可能被 PTY 分块，断言前要等「顶线 + 状态行都在」的稳定帧（S15 偶发失败的原因）；后台 `stty` 必须 `< /dev/tty`，否则在 wrapper 里报 `stdin isn't a terminal`。
- **宽度模型必须含 emoji/组合字符**：`charWidth("😀")=1` 会让帧行实际超宽 → 终端 auto-wrap → 光标行号记账失效 → 串屏。修法：grapheme 级宽度（Intl.Segmenter + VS16/ZWJ/国旗/组合字符），`displayWidth/truncate/tokenize` 全部按 grapheme。
- **`!cmd` 与 live 帧是两套写端**：子进程 inherit tty 会写穿帧；实现 suspend/resume（cooked + 显示光标 + 擦帧 + 定格），但长子进程 Ctrl+C 的回显/归还时序在 PTY 下不稳定，v0.3.1 改子进程输出走 pipe。
