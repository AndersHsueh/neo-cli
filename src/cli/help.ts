/**
 * `--help` 与 `/help` 共用的帮助文本。
 */
import { MODEL_TIERS } from "../config.ts";
import { c } from "../ui/theme.ts";
import { VERSION } from "./version.ts";

export function helpText(): string {
  return `
${c.accent("neo")} ${c.dim(`v${VERSION}`)} — Matrix 风格的终端编程助手

${c.bold("用法")}
  bun run src/index.ts                 进入交互模式
  bun run src/index.ts -p "问题"        单次执行一轮后退出
  bun run src/index.ts -P <provider>   指定 provider
  bun run src/index.ts -t <tier>       指定模型档位
  bun run src/index.ts -C <dir>        指定工作目录
  bun run src/index.ts -w <name>       在托管 worktree 里开会话（.neo/worktrees/<name>）
  bun run src/index.ts --resume        恢复上一次会话
  bun run src/index.ts --sessions      列出会话
  neo acp                              stdio 上的 ACP 服务端，供 Zed/JetBrains 等编辑器拉起
                                       （与 TUI / -p 互斥；stdin/stdout 整条归协议）
  neo doctor                           配置体检：只读报告，不进入 TUI、不发模型请求
                                       （别名斜杠命令 /doctor、/checkup）

${c.bold("选项")}
  -p, --print <text>    单次模式
      --output-format <fmt>  -p 输出格式：text（默认）| json（stdout 单行）| stream-json（stdout JSONL，仅 -p）
                        stream-json 只能与 -p 同用：stdout 纯 JSONL（每行一个事件信封），
                        Console/诊断/提示一律走 stderr；缺 -p 为用法错误 2
      --json-schema <schema>  仅 -p：把最终答案约束成符合该 JSON Schema 的 JSON 值
                        <schema> 可以是 inline JSON（以 { 或 [ 开头）或文件路径（@path 亦可，
                        相对 -C 指定的目录）；非法 / 读不到 / 不可编译 → 用法错误 2，不发请求
                        json：校验通过时多一个 structured_output（answer 仍是原文）；
                        text：stdout 只打那份紧凑单行 JSON，进度改走 stderr；
                        stream-json：只有最终 result 带该字段
                        只校验进程级最终答案；不合规把诊断回喂再跑，最多 2 次（共 3 次尝试）。
                        回喂在 drive 循环之外：不计入 --max、不重跑检查命令，但可能再调工具、
                        改变工作区（仍受既有权限 / -y 约束）；drive 退出来源仍按循环结束时计算。
                        回喂耗尽仍不合规时省略该字段，原本会是 0 的退出码改为 1
      --fallback <provider>:<model>  主模型故障时的有序备用链（可重复，出现顺序即优先级）
                        任一项出现即完整替换 settings.model_fallback；最多 8 项
      --no-fallback     本次禁用备用链（与 --fallback 互斥）
                        同模型重试耗尽后才切换；会话内保持目标，不自动回切、不改写 settings
                        仅主 Agent 请求生效；提高可恢复性，但不保证任务成功
      --safe-mode       以干净配置启动，用于排查自定义项故障（不加载 AGENTS.md / 路径规则 /
                        技能 / 自定义子代理 / hooks / MCP / LSP / 仓库地图 / 记忆 wiki / status line）。登录、provider /
                        模型、内置工具与 /mode 仍可用。只影响本次进程，不改 settings.json。
                        这不是沙箱。等效环境变量 NEO_SAFE_MODE=1/true/yes（大小写不敏感）
      --drive <检查命令>  -p 无人值守长跑：每轮结束跑检查命令，exit 0 = 达成（已验证）。
                        未达成自动再发同一提示。必须配 -y（无人值守无人类确认）
      --judge <标准>     模型判断完成标准（来源标注为「模型判断」，绝不冒充已验证）
      --max <N>          驱动轮次上限，默认 5（夹紧 1–20，与 /drive 同口径）
      --max-minutes <M>  墙钟上限，默认 30 分钟（夹紧 1–240），只在轮间检查
                        退出码：达成 0 / 未达成 1 / 仅模型判断完成 3 / SIGINT 130 / 用法错误 2；
                        结束时 stderr 打一行 [drive] status=… source=… rounds=… elapsed=…s
  -m, --model <id>      直接指定模型 ID（绕过档位）
  -P, --provider <name> 切换 provider
  -t, --tier <name>     模型档位：${MODEL_TIERS.join(" / ")}
  -C, --cwd <dir>       切换工作目录
  -w, --worktree <name> 在托管 worktree 里开会话：<仓库>/.neo/worktrees/<name>，
                        分支 neo/<name>（已存在则复用，不覆盖）。非 git 目录报错退出。
                        隔离的是文件，不是权限；建议把 .neo/ 加入 .gitignore
      --add-dir <路径>  本会话额外工作根（#63；也可写 --add-dir=<路径>）。每次只跟一个路径、可重复：
                        neo --add-dir ../apps --add-dir ../lib。主根不变；相对路径按进程启动目录解析
                        （不随 -C），~ 展开；必须已存在且是目录，拒绝文件系统根，否则用法错误 2、不启会话。
                        交互 TTY 下用了 --add-dir 又有多余位置参数会报错：每个目录各写一次 --add-dir；
                        非 TTY 时位置参数仍当一次性提示词。与 -p 同用有效；不能与 acp 同用
  -y, --yes             自动批准所有操作（慎用）
      --edit            自动批准文件写入，shell 仍需批准
      --plan            只读闸门：禁止一切写操作（≠ 交互规划工作流，后者在会话里用 /plan）
  -c, --continue        继续上一次会话
      --resume [id]     恢复会话（默认 last）
      --fork            必须搭配 --resume 或 --continue；拷贝对话并切进新会话（-p 同样生效）
      --sessions        列出历史会话
      --no-reasoning    不显示思维链
      --name <n>        设置本会话名字（跨会话寻址用）
  -h, --help            显示帮助
  -v, --version         显示版本

${c.bold("项目指令")}
  启动时加载会话 cwd 上的 AGENTS.md / NEO.md / .neo.md / CLAUDE.md（按此顺序取一个）；
  若 cwd 在 git 工作树内，再加载向上到工作树根的祖先指令文件。子目录里的同名文件不预载，
  只在本轮触达该子目录时按需注入，轮末从历史摘除（#54）。这与 #17 的 .neo/rules（paths: glob）
  不是同一件事；也与 #63 --add-dir / /add-dir（额外工作根）不同：额外根上的根指令文件及其
  自身 git 工作树内的祖先进入永久段，额外根里的子目录同样按 #54 按需加载（safe-mode 不加载）。

${c.bold("--add-dir / /add-dir 与 Claude Code 的差异")}
  - 每个 --add-dir 只跟一个路径（官方一个 flag 可跟多个，并为此修过吞提示词的问题）；交互 TTY 下
    neo --add-dir ../a ../b 报用法错误，提示每个目录各写一次 --add-dir；非 TTY 时位置参数仍当一次性提示词。
  - 与 Claude Code 不同：Claude Code 的 /cd 保留额外目录；neo 的 /cd 成功换主根会清空额外根，/cd - 不恢复。
  - 忙碌时 /add-dir 排队到轮末才生效（官方在本轮确认后马上生效）。
  - 没有信任询问，没有 DirectoryAdded hook，没有 --remember 持久化。
  - 不从额外根加载技能、命令、子代理；要用请走 skills_extra_paths。
  - 额外根的指令文件默认加载（根文件 + 它自己 git 范围内的祖先）；官方默认不加载额外目录里的 CLAUDE.md，
    要设 CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 才加载。这是有意不同。
  - /add-dir --remove 与不带参数列出所有根是 neo 自己加的。

${c.bold("交互命令")}
  /help            帮助            /clear       清空上下文
  /compact [--from n] 压缩上下文（--from 只压该轮往后）  /cost  token 统计
  /context         上下文窗口/用量 /env         环境快照
  /export [id]     导出会话 Markdown
  /provider        切换 provider   /model       查看/切模型
  /tools           工具列表        /mode        权限模式
  /mcp             MCP 外部工具 server 状态（stdio/http、连接数/工具数/错误；配置见 settings.json 的 mcpServers）
  /hooks           生命周期 hooks 列表与配置告警（配置见 settings.json 的 hooks；不是权限系统）
                   含 SubagentStart / SubagentStop：子代理真正派出后与结束时在父会话触发
  /doctor          配置体检（别名 /checkup）：汇总 settings、MCP、hooks、技能与规则问题，默认不改文件
  /checkup         别名：/doctor
  /plan [子命令]   交互规划工作流：先澄清 → 出方案 → 用户确认 → 开始实施
                   /plan            进入规划态（默认不写盘，先澄清再出方案）
                   /plan approve    确认方案并开始实施（别名 /plan go）
                   /plan revise     要求改方案（回到澄清态，保留上一版）
                   /plan cancel     放弃规划态（方案不生效）
                   规划态期间生效模式恒为 plan（借用只读闸门），确认后切回进入前的模式
                   注意：/mode plan 与 --plan 是「只读闸门」（禁止一切写操作，没有确认后放开
                   这一步），与 /plan 不是一回事
  /review [基线]   对照 git 改动做只读审查：默认审未提交改动（HEAD + 未跟踪名单），
                   可写分支名/tag/commit 作基线（如 /review main）；默认不改文件
  /worktree [子命令] 托管 git worktree：会话中进出隔离检出（对话保留），或启动时 --worktree <name>
                   /worktree create <name> 创建或复用托管树，并把本会话主根切过去
                   /worktree enter <name>  只进入已有的托管树（不存在则报错、不创建）
                   /worktree exit          退回 isolation origin（进入前的主根；--worktree 启动则是主检出）；
                                           永不删树、不删分支，删树用 remove
                   /worktree list          列出 neo 托管的 worktree（名/分支/脏/当前）
                   /worktree remove <name> 清理；有未提交改动或未跟踪文件时拒绝，
                                           加 --force 需再确认一次；不能删当前所在、也不能删在跑的隔离子代理的树
                   新建的托管树一律从主检出当前的 HEAD 分出：当前树里的提交和未提交改动都不带过去。
                   进入 / 切换 / 退出都会换主根：按 /cd 口径清空本会话额外根（/cd - 与 /worktree exit 都不恢复）。
                   模型用 enter_worktree / exit_worktree（同一批里作为屏障：前面的调用用旧根，后面的用新根；
                   新建走写操作审批，plan 模式拒绝；进入已有树与 exit 不审批）。忙碌时斜杠排队到轮末。
                   子代理：task 参数 isolation=worktree 或命名子代理 frontmatter isolation: worktree，
                   在新建的托管树里跑（只新建不复用；不继承额外根；沿用父会话的指令与技能）；
                   干净结束自动删树（分支保留），有改动则保留并在报告里写明路径。
                   .worktreeinclude（主仓根）：新建托管树时拷「匹配且被 gitignore」的文件（如 .env）；
                   复用不覆盖；--safe-mode 下照常拷。
                   /cd 到某棵托管树只是普通换根，不算进入；/cd 到当前树外会清除隔离绑定。
                   -c / --resume：记录在托管树里、树还在、启动目录属于同一个仓时，自动回到那棵树（续聊恢复隔离）；
                   显式 --worktree 以本次为准。与 Claude Code 的差异见 README「托管 worktree」对照段。
                   只碰 .neo/worktrees/ 下由 neo 创建的，不动你自己的其它 worktree
  /cd [路径]       在本会话中切换工作目录（对话保留，不是开新会话）
                   /cd                  打印当前会话工作目录
                   /cd ../other         相对当前会话 cwd（不是进程 cwd）；支持 ~、路径补全
                   /cd -                回到上一根（还没切换过则拒绝）
                   与 -C（启动时定根）、shell.cwd（只影响单条命令）、#63 /add-dir（主根不变、加额外范围；/cd 成功换主根会清空本会话额外根，/cd - 不恢复）、#9 --worktree（开新会话）、#54 嵌套 AGENTS.md / CLAUDE.md（/cd 会刷新新根及其 git 祖先的永久段；子目录仍按需加载，不在换根时预载）不同。
                   会话文件仍在全局 ~/.neo/sessions，只更新记录里的 cwd；在新目录可按同一 id --resume。这和 Claude 按项目搬家会话文件不是一回事。要新项目的 MCP / 本地 settings，须在该目录重新启动。
  /add-dir [路径…] 本会话额外工作根（#63；主根不变，扩展 @ 补全、默认 glob/grep、目录树、仓库地图与 #54 指令）
                   /add-dir ../lib ../apps     加入一个或多个（相对当前会话主根；~ 展开；只补目录）
                   /add-dir                    列出主根与当前额外根，不改状态
                   /add-dir --remove ../lib    去掉（按 realpath，目录已删时按记录的绝对路径）
                   失败的路径各报一行、不回滚已通过的；已在范围内的不重复添加。
                   /cd 成功换主根会清空本会话额外根；只活在本会话（启动参数、斜杠命令、会话记录）
  /env [refresh]   环境快照（平台/shell/资源/工具链）；refresh 重采并写 wiki 页
  /peers [name]    跨会话状态：列出存活会话 / 查单个
  /inbox           查看 held 消息；/inbox release <id> 放行一条
  /rename <name>   设置本会话名字（跨会话寻址；撞名自动加后缀）
  /skills          列出可用技能    /skills <名>  查看技能详情
  /agents          列出自定义命名子代理    /agents <名>  查看路径/工具/模型（不倾倒全文）
                   定义是 <cwd>/.neo/agents/*.md 或 ~/.neo/agents/*.md（也识别 .claude/agents）
                   经 task 的可选 agent 参数调用；不传则为通用子代理。与技能、#17 规则不是同一件事。
  /<技能名> [参数]  直接调用技能（正文随下一轮发给模型；$ARGUMENTS 替换为参数）
  /wiki-lint       wiki 体检：断链/orphan/摘要/日期戳/链接密度
  /ingest [f|i]    编译 raw → wiki（无参按 log 判定：超 1 周全量并告知，否则增量）
  /init            生成 AGENTS.md  /history     历史统计
  /memory ...      记忆：status / list / recall / why / flush / forget / migrate / lint / on|off
  /remember <文本> 显式记忆（--user 写用户级；-p 模式仅项目级）
  /save [path]     导出会话        /sessions    历史会话
  /resume [id]     恢复会话（无参进入选择；last = 最近一次）
  /fork            拷贝当前对话并立刻切进新会话；无名字/prompt 参数；/sessions 标注分叉自旧 id
                   官方 /branch 的交互，不是官方后台 /fork（#55 本轮不做）；不自动建 worktree
                   在托管 worktree 里 /fork：新会话共用这棵树并带上隔离绑定 —— 两个会话会在同一棵树里写
                   /btw 是临时旁问；/rewind 回滚当前历史/代码；--resume 接回同一 id；/fork 留住原快照再另走一条
                   当前 turn、/ps、/tasks、wiki worker、/loop、/drive 忙碌时先结束再分叉
  /last [n]        回看最近 n 次工具调用（默认 1；紧凑模式的信息找回入口）
  /undo [n]        撤销最近 n 次 write/edit（默认 1；仅工具写，不含 shell）
  /rewind [n|last] 按轮次回滚（默认 both = 代码+对话；可 code / conversation；--resume 后仍可用）
  /drive           目标驱动自动续跑：/drive [检查命令] [--judge "<标准>"] -- <提示> · stop
  /checkpoints [n] 列出最近的写文件检查点（默认 10）
  /todos           查看本会话结构化待办（模型用 todo_write 维护）
  /loop [re]       定时/自节奏循环提示：/loop 2m <提示> · /loop self <提示> · /loop stop
  /tasks           后台子代理任务（列表 / cancel [id|all]）
  /ps              后台长驻 shell（列表 / kill [id|all]）；模型用 shell background:true 启动
  /monitor         事件驱动监视：/monitor [--for <时长>] <命令> 启动 · /monitor 列表 · /monitor stop <id|all>
  /output-style [name] 查看/切输出风格（只改本会话；Default 不加 style 段）
  /tier [name]     查看/切档位      /auto [name] 切换分类器（off/rule/llm）
  /fast /balanced /deep            档位快捷方式（等价 /tier）
  /why             上次分类判定与理由
  /exit            退出（别名 /quit）
  !<cmd>           直接执行 shell（受权限模式约束）
  ESC              运行中取消本轮：未注入转向前回滚本轮输入（自动轮只停不删）；已注入转向则只停不回滚；空闲时清空输入
  Ctrl+C           双击退出（运行中第一次 = 取消本轮）
  Ctrl+O           打开/关闭 transcript 视图（视图内 / 搜索，或 Ctrl+F；Esc 关闭）

${c.bold("输入")}
  输入框           底部常驻（上下横线 + 状态行）：Enter 提交；Ctrl+J / Shift+Enter /
                   Alt+Enter 换行；多行超过可视高度时滚动窗口
  Tab              补全：@ 文件路径（模糊匹配，多个候选连按 Tab 循环）/ 命令名
  @path            引用文件内容随消息发送（≤5 个文件，单文件 ≤400 行，总 ≤60KB）
  ← → ↑ ↓          行内移动；↑↓ 在首/末行翻历史（前缀搜索）；Home/End 行首尾
  Ctrl+A/E/K/U/W   Home / End / 删到行尾 / 删到行首 / 删前一个词
  Ctrl+V           粘贴剪贴板图片（以 chip 形式进输入框）
  粘贴             小段多行直接进输入框；大段/超长折叠为 [Pasted text #N]
  行尾 \\          多行的等价触发（不支持 Ctrl+J 的终端用这个）
  鼠标/全屏        不使用 alt-screen：历史始终留在终端 scrollback，Cmd+F/tmux 可用


${c.bold("自定义状态区（settings.statusLine）")}
  配置写在获胜的那一份 settings.json 顶层 statusLine；第一份存在的文件全赢，不合并多层。
  改配置要新开会话（neo 不做 settings 热重载；官方是存盘即重载，改 command 立刻跑且跳过防抖）。
  布局：自定义行在输入框与内置状态行之间，不替换内置行。官方同样不替换 footer badges。
  官方配置自定义后会藏 "? for shortcuts" 等 hint；neo 无这些 footer hint，也不藏内置行。
  未配置或 command 为空则只有内置行，画面与现在完全一样。--safe-mode、-p、非 TTY、ACP 也不跑命令。
  失败 / 超时 / 非 0 / 空输出：只让自定义区空白，内置行不变，不往对话打错误、不弹横幅。
  不按帧跑；事件防抖 300ms；会话开始第一次立刻跑；可选 refreshInterval（最小 1 秒）；
  默认超时 2 秒、上限 10 秒（neo 自定；官方 schema 没有 timeout 字段）。
  刷新集比官方多：/cd、/add-dir、/worktree 及对应工具、/model、/clear、额外根变化。
  多行最多 5 行（丢底部）；padding 上限 8；stdout 硬上限 8KiB。均为 neo 自定。
  ANSI / OSC 8 可输出，但不承诺可点击。
  JSON 只含 neo 能诚实给出的官方字段名。context_window.used_percentage / remaining_percentage
  用 estimateTokens(messages, 当前工具规格) / contextWindow，与内置行同一口径，不是官方
  「最近一次 API 响应、只计 input/cache、不含 output」。workspace.project_dir 是经过
  -C / --worktree 解析后、第一次进对话的主根，不要按进程启动目录对账。version 是 neo 版本。
  没有费用、rate_limits、prompt_cache，也不输出 transcript_path。
  不提供 /statusline 命令，只支持手写 settings。
  这不是沙箱，也没有工作区信任对话框。用户自己 settings 里的命令按用户权限跑，口径与 hooks 相同。

${c.bold("环境变量")}
  NEO_PROVIDER / NEO_TIER / NEO_MODEL / NEO_BASE_URL / NEO_API_KEY  覆盖 settings.json
  NEO_CLASSIFIER_PROVIDER / NEO_CLASSIFIER_MODEL                    指定分类器用的 provider 与模型
  NEO_SAFE_MODE   1 / true / yes（大小写不敏感）时等效 --safe-mode

${c.bold("初次使用")}
  候选路径都没有 settings.json 时，交互运行 neo 会引导配置一个 default provider，
  测通后写入 ~/.neo/settings.json（权限 0600）。-p / 非 TTY / neo acp 不进入向导。
  环境变量不会跳过本向导，也不会被偷偷写进文件。
`;
}
