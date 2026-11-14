# neo-agent Web 版本页 · 静态问题修复记录（2026-11-14）

> 执行：version-manager-2（模型 `hy4:free`）｜性质：**仅静态、最小变更**
> 依据：`docs/neo-agent-web-qa-2026-11-14-static.md` §3 问题清单（2 项）、`docs/neo-agent-web-design-system.md` §0.5 / §3.2 / §3.8
> 修改范围：**仅** `web/neo-agent-version-evolution.html` 两行，另新增本修复记录 1 个文件
> 约束：不启动浏览器、不运行项目代码测试、不提交 / 推送 / 部署、不虚构任何公开 URL、不修改门户文件

---

## 1. 修复内容（替换前后逐行）

### 1.1 问题 2（低 / P3，QA §3 表第 2 行）· L792 brand 的 `aria-current` 语义

- 修复前（L792）：
  ```html
  <a class="brand" href="#main-content" aria-current="page" aria-label="neo-agent 版本演进页首">
  ```
- 修复后（L792）：
  ```html
  <a class="brand" href="#main-content" aria-label="neo-agent 版本演进页首">
  ```

说明：`href="#main-content"` 是页内片段，按设计系统 §3.2 不应标 `aria-current="page"`（该值应指向当前页面 URL，而非页内锚点）。按要求**直接移除该属性**；未改 `href`、未改成虚构外部 URL、未改成 `aria-current="location"` 或把品牌降级为非链接，保持最小变更。`aria-label` 与其余结构不变。

### 1.2 问题 1（中 / P2，QA §3 表第 1 行）· L1136 来源区本地 PRD 链接

- 修复前（L1136）：
  ```html
  <li><a href="../docs/neo-agent-iteration-2026-11-14-prd.md">本轮迭代盘点与增量 PRD（本地文档）</a>：状态纪律、#52 / #59 / #37 范围与 Web 禁区</li>
  ```
- 修复后（L1136）：
  ```html
  <li><span>本轮迭代盘点与增量 PRD（本地规划文档，不随静态站点发布）</span>：状态纪律、#52 / #59 / #37 范围与 Web 禁区</li>
  ```

说明：把 `<a href="../docs/…">` 改为非链接的 `<span>` 纯文本，并注明「本地规划文档，不随静态站点发布」。理由：以 `web/` 为静态站点根时 `../docs/` 会跳出根目录而 404（违反 §0.5 固定互链、§9.3 `file://` 与静态托管均可用），且该文件是本轮规划态本地 PRD、不宜作公开可点击来源（§3.8 只引用公开仓库可访问的 release note）。**保留**后半句「状态纪律、#52 / #59 / #37 范围与 Web 禁区」；**未改** Issue #52/#59/#37 的 GitHub 链接（L1038 / L1048 / L1058 / L1137）；**未新增**任何虚构公开 URL。

---

## 2. 静态复检（检查命令 / 工具与结果）

| # | 工具 / 命令（模式） | 对象 | 结果 |
| --- | --- | --- | --- |
| 1 | `Grep \.\./docs/\|aria-current="page"\|href=""` | `web/neo-agent-version-evolution.html` | **0 命中**：三项同类问题在版本页内均已清除 |
| 2 | `Grep aria-current` | `web/neo-agent-version-evolution.html` | **0 命中**：无残留 `aria-current` 用法 |
| 3 | `Grep issues/52\|issues/59\|issues/37` | `web/neo-agent-version-evolution.html` | 4 处命中（L1038 / L1048 / L1058 / L1137）：Issue 链接未被改动 |
| 4 | `Read` L788–797、L1133–1140 | `web/neo-agent-version-evolution.html` | 逐行确认两处替换结果，后半句与 Issue 链接完整保留 |
| 5 | `Grep \.\./docs/\|aria-current="page"\|href=""` | `web/portal/index.html` | 仅 1 处命中：L25 `aria-current="page"`（见下） |
| 6 | `Read` L20–31 | `web/portal/index.html` | 门户 L25 为 `<a class="brand" href="index.html" … aria-current="page">`，`href` 指向当前页自身 |
| 7 | `git status --short`、`git diff -- web/neo-agent-version-evolution.html` | 工作区 | 见下方说明 |

关于门户（任务 #3 要求）：门户 `index.html` L25 的品牌链接 `href="index.html"` **确实指向当前页**，其 `aria-current="page"` 符合设计系统 §3.2，与版本页 L792（指向页内片段 `#main-content`）不是同类问题；门户无 `../docs/`、无 `href=""`。按要求**未修改门户文件**。

关于 git：`git status --short` 显示 `web/`、`docs/` 等均为未跟踪新文件（`?? web/`），因此 `git diff` 为空是「尚未纳入 git 跟踪」所致，**不代表改动未生效**；两行内容变化已由 Edit 成功返回与 Read 复核确认。改动范围以本记录第 4 节的工具调用清单界定。

---

## 3. 未执行项（按阶段约束）

- **未启动**浏览器 / CDP / 截图 / Lighthouse / 远程 URL 批量访问；**未做**任何浏览器动态实测（360/768/1280/1440px 视口、控制台错误、键盘 Tab 与焦点、对比度工具、reduced motion、禁用 JS、200%/400% 缩放、A4 打印预览、外链 HTTP 可达性、Lighthouse 分数）——这些属下一阶段（任务 #12）。
- **未运行**项目代码测试；**未**做提交、推送、部署。
- 外链仅保持原有 URL 结构，**未**复核 HTTP 可达性（QA §4.3）。

---

## 4. 改动范围声明

- 写操作仅 2 次 `Edit`，目标均为 `web/neo-agent-version-evolution.html`（L792、L1136）。
- 新建文件 1 个：本记录 `docs/neo-agent-web-static-fixes-2026-11-14.md`。
- 其余全部为**只读**操作（`Read` / `Grep` / `git status` / `git diff`）：**未修改门户文件，未修改其它任何文件**。

---

## 5. 残余问题

1. QA 静态报告 §3 的 **2 项问题（1 中 / 1 低）已全部闭环**；本阶段结论为静态修复完成，**不等于最终 `IS_PASS`**，最终验收仍待浏览器与可访问性实测（QA §5、设计系统 §13）。
2. 门户同类链接复核归任务 #11（operations-expert 侧）；本记录仅做只读对照，未越界修改门户。
3. QA §3.1 的 3 项观察项（A 打印细节差异、B 实现类名差异、C 导航覆盖范围）为非缺陷，**未处理**。
4. 版本页 `@media print` 的 A4 打印预览、外链 HTTP 可达性、tokens 在成品页面的实际渲染，均待动态实测阶段复核。

---

## 6. 结论

```
STATIC_FIX: 2/2 已修复，静态复检通过
```

两处修复均为最小变更、纯静态、可回溯；未触碰事实状态、内容禁区、tokens、锚点闭环、本地资源与元数据；未改其它文件；未执行任何动态实测与项目代码测试。
