# 门户同类链接问题复核（2026-11-14）

> 复核人：operations-expert-2｜范围：`web/portal/` 四文件｜性质：纯静态文本核查
> 参照：QA 报告 §3（`docs/neo-agent-web-qa-2026-11-14-static.md`），两项问题均在版本页 `web/neo-agent-version-evolution.html`，由 version-manager-2 处理；本复核仅查门户是否有同类问题。
> 未启动浏览器/静态服务器，未跑项目代码测试，未提交/推送/部署。

## 检查命令 / 工具

| # | 操作 | 目的 |
| --- | --- | --- |
| 1 | 逐行 Read `index.html` / `styles.css` / `script.js` / `favicon.svg` | 通读全文 |
| 2 | `Grep href="[^"]*"`（portal 目录） | 提取全部 href 逐项分类 |
| 3 | `Grep \.\./docs\|href="docs/\|href="[^"]*\.md"\|PRD\|迭代盘点\|本地文档\|本地规划` | 查跳出 `web/` 根的本地文档链接 |
| 4 | `Grep aria-current` | 查 aria-current 用法 |
| 5 | `Grep href=""\|href="#"\|javascript:\|占位\|敬请期待\|TODO\|lorem\|about:blank\|onclick=` | 查空/假链接/占位 CTA |
| 6 | `Grep url(\|https?://\|@import\|src=\|fetch(\|XHR\|href`（仅 css/js/svg） | 查非 HTML 文件里的链接/外部资源 |
| 7 | `Glob web/**/*.html` | 确认互链目标位置与站点根 |

## 结论：无问题，**未修改任何文件**

1. **部署根之外链接**：无 `../docs/`、无本地 `.md` 链接、无指向未公开本地规划文档的链接。含 `.md` 的链接全部是 `https://github.com/AndersHsueh/neo-cli/blob/<tag>/...` 公开 GitHub 链接；L442「PRD 或开放 Issue 中」为状态口径文字，非链接。4 处 `../neo-agent-version-evolution.html`（L66/378/457/475）从 `web/portal/` 解析到 `web/neo-agent-version-evolution.html`（Glob 确认存在），仍在 `web/` 静态站点根内，属设计系统 §0.5 固定互链、QA §2.3 已列通过项，**不构成跳出根**。
2. **aria-current 误用**：全目录仅 1 处 `aria-current="page"`，即 L25 brand `href="index.html"`，指向当前页 URL，为正确用法；无「页内片段/错误 URL 却标 page」的情况。footer brand（L466）无该属性，合理。
3. **空 href / 假链接 / 占位 CTA**：无 `href=""`、`href="#"`、`javascript:`、`about:blank`、`onclick=`，无占位词；所有 button CTA 均指向真实目标（GitHub / 站点内版本页 / 页内 `#quick-start`）。

## 残余风险

- 纯静态核查，未实测 `file://` 与以 `web/` 为根部署时的实际解析及外链 HTTP 状态（按指令禁止）。
- 4 处 `../` 互链依赖部署根为 `web/`；若日后单独以 `web/portal/` 为站点根部署，这些互链会跳出根 404——属部署口径约束，非当前缺陷，需与版本页修复一并确认。
- 版本页修复后门户无需联动；若版本页改名/移动，需回头复核门户这 4 处互链。
