# neo 开发踩坑

> 最后更新:2026-10-18

## 摘要

neo 开发过程中沉淀的教训清单,持续追加。当前八条:zsh 变量不分词、gitignore 无法区分软链与真目录、google 国别域不命中搜索改写、fast 路由模型池判死、本地配置不进 git 的同步义务、bun test 单进程共享模块表导致 mock.module 泄漏、AbortSignal 上没有 abort()、双源版本号 bump 漏改一处。每条按「现象 / 根因 / 教训」记录。

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

## 2026-10-18 select M0 阶段连续两轮会话超时

- 现象：select 组件 M0 探针阶段，连续两轮会话超时中断，用户被迫两次喊「继续」。
- 根因：单轮塞的动作太多。两轮的共同模式 = 长链推理 + 并行多工具调用（shell + read_file 同发）+ 大文件写入（150+ 行探针脚本）挤在同一轮；思维链越长、工具越多，超时概率越高。
- 对策（自本轮起执行的规划方式）：一轮只做一个小动作——要么一次工具调用，要么一次小编辑；大文件拆多次写；探针/实现拆成多轮，每轮结束即落盘中间结论，中断可续。
- 附带教训：探针结论要尽早写回 PRD（§6），不要攒在对话里——对话一断，未落盘的结论就悬空。
