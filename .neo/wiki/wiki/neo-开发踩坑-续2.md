# neo-开发踩坑

## 摘要

版本号自 c88c4b0 起改为 package.json 单源机制

> 最后更新:2026-11-08
> 来源:session 20261108-181934-g0zw27 · 2026-11-08 · 自动归纳

## 正文

新增版本号维护约定：自 commit `c88c4b0` 起改为单源机制，`package.json` 是发布版本号唯一真源；`src/index.ts` 不再硬编码 `VERSION`，而是在运行时通过 `src/cli/version.ts` 读取。发布时只需 bump `package.json` 即完成版本同步，不应再手工修改 `src/index.ts`。`AGENTS.md` 中「版本号双源（package.json + src/index.ts 的 VERSION）同步 bump」的说明已过时。issue #22（v0.4.77，wiki_write 链接目标校验）实现时已核实全仓无版本号硬编码残留。
