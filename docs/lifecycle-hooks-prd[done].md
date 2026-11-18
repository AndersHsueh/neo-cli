# 生命周期 hooks：SessionStart / UserPromptSubmit / Stop / PreCompact（#64）

- 关联：[#64](https://github.com/AndersHsueh/neo-cli/issues/64)
- 实现基线：029a040，package 版本保持 0.4.91；本规格不代表已发布。
- 适用：交互、`-p`、ACP **主会话**。不改变权限、shell、composer 或既有四事件语义。

## 1. 事件与真实输入边界

| 事件 | 触发 | 不触发 |
| --- | --- | --- |
| SessionStart | 新建 `new`、恢复 `resume`、清空 `clear` | 构造 Agent、fork、compact、工具迭代 |
| UserPromptSubmit | 真实人类输入；`-p` 一次输入；ACP 每次 session/prompt | load 历史回放、Stop 续跑、drive/loop 内部轮及其它合成输入 |
| Stop | 模型正常终止，无工具调用 | 工具迭代、截断、abort、error |
| PreCompact | 手动/工具压缩、阈值/窗口/overflow 自动压缩 | 被阻断后的同轮重试 |

四个新事件在子代理/wiki worker 中不运行；只读/plan 模式继续沿用不执行外部 hook 的承诺。
SessionStart 由宿主恢复历史后显式触发，失败只诊断，不能让会话起不来。
不支持 fork、ENV_FILE；compact 只触发 PreCompact，不触发 SessionStart。与竞品不是全量兼容协议。

## 2. 配置与匹配

沿用顶层 `hooks`：`enabled` 默认 false，`verbose` 默认 true，每事件数组按配置顺序执行。
条目字段仍为 `command: string`（必填）、`matcher?: string`、`timeout?: number`（秒，默认30、上限600）、
`onFailure?: "continue" | "block"`（默认 continue）。配置错误仍给可读告警而非中止启动。

```json
{
  "hooks": {
    "enabled": true,
    "SessionStart": [{"command": "sh .neo/hooks/start.sh"}],
    "UserPromptSubmit": [{"command": "sh .neo/hooks/prompt.sh"}],
    "Stop": [{"command": "sh .neo/hooks/stop.sh"}],
    "PreCompact": [{"command": "sh .neo/hooks/compact.sh", "matcher": "auto", "timeout": 5}]
  }
}
```

PreCompact 的 matcher 匹配 `manual` / `auto`，支持精确、尾部通配、`/正则/`；
SessionStart / UserPromptSubmit / Stop 无匹配对象，恒匹配。旧工具事件匹配工具名，Notification 匹配 reason。
`/hooks` 列出八类配置及告警；PreCompact 标签为 `trigger=`。

## 3. stdin JSON 字段

每次 stdin 一行 JSON。公共字段沿用：

| 字段 | 类型/约束 |
| --- | --- |
| event | 事件名，大小写敏感 |
| session_id | 当前会话 ID 字符串 |
| cwd | 运行目录字符串 |
| mode | ask / auto-edit / auto-all / plan |
| subagent | boolean；新四事件实际仅主会话触发 |
| turn | 会话内轮次序号 number；会话启动可为0 |

新增事件专属字段：

| 事件 | 字段 |
| --- | --- |
| SessionStart | `source: "new" | "resume" | "clear"` |
| UserPromptSubmit | `prompt: string`，当前真实用户输入 |
| Stop | `stop_hook_active: boolean`，原输入是否已经用过一次 Stop 续跑 |
| PreCompact | `trigger: "manual" | "auto"`；`message_count: number`，当前历史长度减首系统消息（下限0） |

环境变量公共部分仍为 NEO_HOOK_EVENT / NEO_HOOK_SESSION / NEO_HOOK_MODE；
新增 NEO_HOOK_SOURCE（SessionStart）与 NEO_HOOK_TRIGGER（PreCompact）。新四事件没有 NEO_HOOK_TOOL。
脚本 cwd 为当前 neo 工作目录。已有工具事件载荷与 Notification reason 不变。

## 4. stdout / 退出码 schema

### 上下文事件

SessionStart / UserPromptSubmit / PreCompact 在 **exit 0** 时接受：

- 纯文本 stdout：去首尾空白后作为附加上下文；空文本不注入。
- JSON 对象：`{"additionalContext": "字符串"}`；只消费此字段值，不将原 JSON 再注入。
- 合法对象缺字段或字段类型错误：忽略上下文。未知字段忽略。
- 以 `{` 开始但解析失败：不抛错，按纯文本回退。无论哪种都不能崩会话。

SessionStart 上下文给主模型并随会话使用；UserPromptSubmit 上下文仅本次原输入及其内部续跑使用，
边界结束后摘除，下一输入不重复上次上下文；PreCompact 附加指令只拼入摘要器请求，不永久写主历史。

### Stop

只有 exit 0 且 stdout 为 JSON 对象 `{"decision":"block","reason":"非空字符串"}` 才请求续跑。
reason 去空白并沿用 hook 原因长度上限；其它字段忽略。普通文本、空/非字符串 reason、坏 JSON、
exit 2 或其它失败都不会凭输出/失败原因发起续跑，只诊断。多条 hook 的有效续跑请求按配置顺序处理。

每条真实输入最多一次自动续跑；drive/loop 内部轮共用额度，不因内部 send 重置。
续跑消耗**原请求迭代预算**，与工具轮累计不超过 maxToolIterations；预算耗尽只提示，不新增请求。
沿用同一取消信号，不另建 send/预算；取消、错误或压缩阻断不能被 Stop 复活。
第二次 block 只诊断上限，没有第三轮。Stop 扩展不额外产生 TurnEnd / Notification：最终收口各一次，
原有 drive 每轮的旧事件口径不变。

### 语义载荷与诊断尾部分离（B1 复审修复）

生命周期事件的 exit 0 输出是**语义载荷**，与旧四事件（PreToolUse / PostToolUse / TurnEnd /
Notification）的**诊断尾部**是两条通道，不能混用：

- 诊断尾部：`HookOutcome.stdout` / `stderr`，保留末尾 800 字符（超出加 `…` 前缀），只给人看。
- 语义载荷：`HookOutcome.semantic`，仅生命周期事件 exit 0 时有值，保存**完整原始 stdout**。
  additionalContext 与 Stop 的 decision/reason 一律从它解析，**先完整 parse 再按字段限长**。
- 原始语义输出上限 **1 MiB = 1048576 字节**（`HOOK_SEMANTIC_OUTPUT_LIMIT`），
  **按原始 UTF-8 字节计**（`Buffer.byteLength`），不按 JS `string.length`：
  否则 1 MiB 的中文实际能到约 3 MiB。恰好等于上限成功，多 1 字节整体拒绝（不做部分保留）。
- 判限发生在**接收缓冲**阶段：累积字节超限即停止累积语义，不靠「先收完无限字符串再判限」。
  分块接收用流式 UTF-8 解码（`StringDecoder`），码点跨块不会被解成替换符；
  语义载荷因此与原始合法 JSON 逐字相等。
- **新生命周期接收有界**：stdout完整缓冲限1 MiB，stderr完整原因缓冲也限1 MiB
  （`HOOK_DIAGNOSTIC_BUFFER_LIMIT`）；诊断尾部独立流式保留真正的最后800字符，不是首1 MiB的尾巴。
  超限后丢弃完整缓冲、置 `HookOutcome.outputTruncated`，但继续更新尾部、排空管道并等待退出，
  不杀进程；exit2仍阻断，失败诊断明确标注接收超限。
- **字段级上限**（`HOOK_CONTEXT_FIELD_LIMIT` = **32000 字符**）：`additionalContext` 字段与
  纯文本 stdout 两条路径共用同一上限。1 MiB 的合法 JSON 里塞 30 万字正文一样会挤爆主模型
  与摘要器，所以字段必须单独限长。超限保留前 32000 字符（仍注入），并给一条裁剪诊断
  （`describeContextTruncation`，含「字段上限」字样）。
- Stop 的 `reason` 沿用既有 **2000 字符**上限：先 parse 出 reason 再裁剪，裁剪后**续跑请求仍有效**，
  另给一条 `describeReasonTruncation` 诊断；续跑仍受原额度、预算与取消约束。
- 超限 = 显式诊断 + 拒绝其语义：不注入上下文、不续跑，也不把截断输出降格成纯文本。
  诊断文案含「上限」字样并走 stderr（交互为 console.warn）。
- 合法 JSON 对象没有 `additionalContext` 时一律忽略，**不论未知字段多大**（例如
  `diagnosticMetadata` 长 1100 字符也不得进模型上下文）。
- 坏 JSON 维持既有非崩溃语义：上下文路径按纯文本回退，Stop 路径不续跑。
- 旧四事件不受影响：保留完整输出解析JSON失败原因，再单独保留800字符诊断尾部；
  不给旧事件新增原始接收上限，exit / onFailure 策略不变。

| 项 | 常量 | 数值 | 计限口径 | 超限行为 |
| --- | --- | --- | --- | --- |
| 语义载荷 | `HOOK_SEMANTIC_OUTPUT_LIMIT` | 1048576 | 原始字节 | 丢弃语义 + 诊断，不注入/不续跑 |
| 新生命周期stderr完整原因 | `HOOK_DIAGNOSTIC_BUFFER_LIMIT` | 1048576 | 原始字节 | 丢弃完整缓冲、保留原因前缀/诊断尾部、继续drain |
| 上下文字段 | `HOOK_CONTEXT_FIELD_LIMIT` | 32000 | 字符（parse 后） | 保留前 32000 字符 + 裁剪诊断 |
| Stop reason | `REASON_LIMIT`（runner 内部） | 2000 | 字符（parse 后） | 保留前 2000 字符 + 裁剪诊断，续跑请求不变 |
| 诊断尾部 | `TAIL_LIMIT`（runner 内部） | 800 | 字符 | 加 `…` 前缀 |

### 失败策略

| 事件 | exit 2 | 其它失败/超时 |
| --- | --- | --- |
| SessionStart | 诊断后继续 | 诊断后继续，不受 onFailure:block 阻断 |
| UserPromptSubmit | 写主历史/分类器/首模型请求前阻断，原因可见 | 默认继续；onFailure:block 阻断 |
| Stop | 仅诊断，不自动续跑 | 仅诊断，不自动续跑 |
| PreCompact | 拒绝压缩，保留原历史/快照 | 默认继续；onFailure:block 拒绝 |

UserPromptSubmit 阻断不是模型错误；`-p` 以非零退出，结构化输出不回填旧答案；ACP 用合法协议响应
收口且不会挂起。所有 ACP 诊断写 stderr/协议通知，不向 stdout 写裸文本。

## 5. 压缩与取消

PreCompact 在任何破坏历史/快照动作、摘要器请求前运行。拒绝时原历史、原 compaction 信息及持久化
快照不变。自动拒绝明确结束当前轮并提示，不再次调用 hook，不降级裁剪旧工具输出，也不递归重试。
普通压缩失败仍保留原有恢复路径，不能与用户明确拒绝混淆。

沿用 hook 既有超时与进程组回收保护；取消会回收在途 hook，禁止重新激活请求。
不改变 shell 权限与错误处理边界。

## 6. 验收与证据

测试名称包含 #64：

- `tests/lifecycle-hooks-64.test.ts`：基础输入阻断、上下文、Stop 上限及手动/自动压缩。
- `tests/lifecycle-hooks-64-agent.test.ts`：来源、分类前零调用、取消、工具轮、共享额度、快照不变和子代理排除；
  以及 B1 复审反例（1200 字 additionalContext、1100 字未知字段、1007/3007 字 Stop reason、
  4 MiB 超限诊断、旧四事件诊断尾部不变），以及 B1 自修反例（逐字节分块的 UTF-8 语义载荷、
  按原始字节计的 1 MiB 上限与恰好边界、三事件 10 万字的字段级限长、
  超载 stdout 下 exit 2 仍阻断 UserPromptSubmit / PreCompact、超1MiB旧事件的真实tail/JSON失败原因）。
- `tests/lifecycle-hooks-64-entry.test.ts`：真实 -p / ACP / /hooks、协议 stdout、入口次数与可见拒绝；
  以及 B1 真实 ACP 长 metadata-only JSON 不进模型请求。
- 真 PTY S31/S32/S33/S34：交互事件顺序与阻断、resume 一次、Stop 续跑与最终事件计数、交互 drive 额度和 clear 事件。
- 旧 hooks / Notification / compact / drive 测试继续回归；官方闸门为 tsc → bun test → PTY。

红/绿与全量日志存本地 `/workspace/neo-64-evidence/`，不提交证据、settings、密钥或发版改动。
