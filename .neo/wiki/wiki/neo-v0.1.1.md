# neo v0.1.1

> 最后更新:2026-10-16

## 摘要

极小改动版本,核心是 `rewriteSearchUrl()`:把 google / duckduckgo 搜索页自动改写到 cn.bing.com,兜底境内不可达问题。提交 `a69f567`(feat)+ `6a2b4fb`(release),annotated tag `v0.1.1` 已推 gitee。全量测试 258 通过 / 0 失败,tsc 零错误。版本号 0.1.0 → 0.1.1 双源同步。

## 一、动机与改动

- 动机:本机在中国境内,google.com / duckduckgo.com 连接超时(实测 curl 000);模型可能凭习惯拼这些搜索 URL,白跑一次抓取
- `src/tools/index.ts` 新增 `rewriteSearchUrl()`:只改「搜索页」URL(带 `q` 参数),普通网页抓取不受影响;google 子域用 `endsWith(".google.com")` 匹配
- web_fetch 的 tool description 同步注明「搜索用 cn.bing.com」,从源头减少模型拼错 URL
- 顺带:`src/agent.ts:370` 工具结果展示 16 行 → 2 行;`neo.sh` 启动参数 `--edit` → `--yes`

## 二、测试与边界

- 补 2 组单测:改写命中(google / duckduckgo / scholar.google.com 子域)与非搜索原样返回(example.com / 无 q 首页 / 非法 URL)
- 已知边界:google.com.hk 这类国别域**不会**被改写——主机名以 `.com.hk` 结尾,不匹配 `endsWith(".google.com")`;现状可接受,要覆盖需单独加规则

## 三、发布流程

- 沿用仓库惯例:feat 与 release 分笔提交(先例 `b5d4aa4`)
- annotated tag(与 `v0.1.0` 等前例一致),`git push origin main --tags` 推 gitee
- 版本号双源:`package.json:3` 与 `src/index.ts:39`
- `docs/release-notes/` 未加 v0.1.1 篇目(改动极小,暂不单写)

## 修订记录

- 无

## 关联主题

- [[neo-v0.1.0]] —— 基线版本,双源版本号机制沿用自该版
- [[neo-开发踩坑]] —— 测试用例 google.com.hk 修正的完整教训
- [[karpathy-wiki-技能拓扑]] —— 同日完成的技能拓扑重构,与本版无代码耦合

## 来源

- `raw/2026-10-16_neo-v0.1.1-工作纪要.md` §二
- git 提交 `a69f567`、`6a2b4fb`,tag `v0.1.1`
