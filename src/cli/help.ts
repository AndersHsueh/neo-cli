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
  bun run src/index.ts --resume        恢复上一次会话
  bun run src/index.ts --sessions      列出会话

${c.bold("选项")}
  -p, --print <text>    单次模式
      --output-format <fmt>  -p 输出格式：text（默认）| json（CI 可解析，stdout 单行）
  -m, --model <id>      直接指定模型 ID（绕过档位）
  -P, --provider <name> 切换 provider
  -t, --tier <name>     模型档位：${MODEL_TIERS.join(" / ")}
  -C, --cwd <dir>       切换工作目录
  -y, --yes             自动批准所有操作（慎用）
      --edit            自动批准文件写入，shell 仍需批准
      --plan            只读模式，禁止一切写操作
  -c, --continue        继续上一次会话
      --resume [id]     恢复会话（默认 last）
      --sessions        列出历史会话
      --no-reasoning    不显示思维链
      --name <n>        设置本会话名字（跨会话寻址用）
  -h, --help            显示帮助
  -v, --version         显示版本

${c.bold("交互命令")}
  /help            帮助            /clear       清空上下文
  /compact         压缩上下文      /cost        token 统计
  /context         上下文窗口/用量 /env         环境快照
  /export [id]     导出会话 Markdown
  /provider        切换 provider   /model       查看/切模型
  /tools           工具列表        /mode        权限模式
  /env [refresh]   环境快照（平台/shell/资源/工具链）；refresh 重采并写 wiki 页
  /peers [name]    跨会话状态：列出存活会话 / 查单个
  /inbox           查看 held 消息；/inbox release <id> 放行一条
  /rename <name>   设置本会话名字（跨会话寻址；撞名自动加后缀）
  /skills          列出可用技能    /skills <名>  查看技能详情
  /<技能名> [参数]  直接调用技能（正文随下一轮发给模型；$ARGUMENTS 替换为参数）
  /wiki-lint       wiki 体检：断链/orphan/摘要/日期戳/链接密度
  /ingest [f|i]    编译 raw → wiki（无参按 log 判定：超 1 周全量并告知，否则增量）
  /init            生成 AGENTS.md  /history     历史统计
  /memory ...      记忆：status / list / recall / why / flush / forget / migrate / lint / on|off
  /remember <文本> 显式记忆（--user 写用户级；-p 模式仅项目级）
  /save [path]     导出会话        /sessions    历史会话
  /resume [id]     恢复会话（无参进入选择；last = 最近一次）
  /last [n]        回看最近 n 次工具调用（默认 1；紧凑模式的信息找回入口）
  /undo [n]        撤销最近 n 次 write/edit（默认 1；仅工具写，不含 shell）
  /checkpoints [n] 列出最近的写文件检查点（默认 10）
  /todos           查看本会话结构化待办（模型用 todo_write 维护）
  /tier [name]     查看/切档位      /auto [name] 切换分类器（off/rule/llm）
  /fast /balanced /deep            档位快捷方式（等价 /tier）
  /why             上次分类判定与理由
  /exit            退出（别名 /quit）
  !<cmd>           直接执行 shell（受权限模式约束）
  ESC              运行中取消本轮（不回滚历史）；空闲时清空输入
  Ctrl+C           双击退出（运行中第一次 = 取消本轮）
  Ctrl+O           transcript 视图（v0.3.1 提供；当前按下一行提示）

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

${c.bold("环境变量")}
  NEO_PROVIDER / NEO_TIER / NEO_MODEL / NEO_BASE_URL / NEO_API_KEY  覆盖 settings.json
  NEO_CLASSIFIER_PROVIDER / NEO_CLASSIFIER_MODEL                    指定分类器用的 provider 与模型
`;
}
