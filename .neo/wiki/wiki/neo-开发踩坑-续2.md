# neo-开发踩坑

## 摘要

版本号自 c88c4b0 起改为 package.json 单源机制

> 最后更新:2026-11-10
> 来源:session 20261108-181934-g0zw27 · 2026-11-08 · 自动归纳

## 正文

新增版本号维护约定：自 commit `c88c4b0` 起改为单源机制，`package.json` 是发布版本号唯一真源；`src/index.ts` 不再硬编码 `VERSION`，而是在运行时通过 `src/cli/version.ts` 读取。发布时只需 bump `package.json` 即完成版本同步，不应再手工修改 `src/index.ts`。`AGENTS.md` 中「版本号双源（package.json + src/index.ts 的 VERSION）同步 bump」的说明已过时。issue #22（v0.4.77，wiki_write 链接目标校验）实现时已核实全仓无版本号硬编码残留。

## 推理与依据

- 2026-11-08（session 20261108-180540-w6ssty）：Git 发布核验增加两条纪律：第一，检查当前 main 时必须显式指定 ref（如 `git log --oneline -1 main`），不能只看未限定 ref 的 HEAD；本轮曾因 cherry-pick 实际落在工作分支、却把 HEAD 当作 main，误报“已合入”，最终将 main 快进后才纠正。第二，清理分支时不能只依赖 patch-id 判断提交是否进入 main；cherry-pick 解冲突后 base 变化会改变 diff 形态，即使文件内容完全一致，patch-id 也可能不同。应改为文件内容级核验，并检查关键符号引用；本轮通过核对 `src/worktree.ts`、`tests/worktree.test.ts`、文档 diff 及 `canonicalize` 的 9 处引用确认无丢失。

- 2026-11-10（session 20261110-095402-g4op80）：新增踩坑：在 `-p` 清理路径中，`loopScheduler` / `drive` 是 `const` 且声明位置晚于相关分支，访问时可能处于暂时性死区（TDZ）。Bun 1.3.13 实测表明，`typeof variable` 仍可能抛出 `ReferenceError`，不能用它作为 TDZ 防护。应通过 `try/catch` 安全取值；本次实现以 `tdzSafe()` 封装这一处理。

- 2026-11-10（session 20261110-095430-3sc7f0）：issue #46 的定点压缩踩坑：当用户指定的 `from` 落在 tool 结果消息上时，不能直接按该消息切分。第一版实现得到的 `kept` 段以 `assistant(tool_calls)` 结尾，而摘要侧 `head` 以 tool 结果开头，导致 tool_calls 与 tool result 被拆到压缩区间两侧，服务端会拒绝请求。修法是将压缩起点整体前移到该工具链对应的 `assistant(tool_calls)` 消息之前，以保持配对完整。相应测试不应断言“head 必须以 user 开头”，而应断言更本质的协议约束：“工具调用与工具结果配对完整”。该策略允许被压区间比用户指定范围多包含一条消息，优先保证请求合法性。另一个已知边界是 `kept` 不参与摘要，因此定点压缩实际节省的 token 会少于整体压缩。
