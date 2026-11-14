# neo-agent Web 视觉与体验设计系统

> 版本：1.0（2026-11-14）
>
> 适用范围：`web/neo-agent-version-evolution.html`（版本演进页）与 `web/portal/index.html`（宣传门户）
>
> 规范性质：公开级交付约束。两页实现者只需本文与 `docs/neo-agent-iteration-2026-11-14-prd.md`，无需互相约定额外视觉规则。
>
> 事实基线：当前已发布版本为 `v0.4.84` / 2026-11-10 / `a2858ae`。核心 Issue 在合入并验证前均为“本轮规划”，不得预设下一版本号或发布日期。

## 0. 交付契约：统一语言，不共用运行依赖

1. 两页复制第 2 节的 tokens 与基础规则，保持变量名和值一致；不要为了“各自优化”改色、改字号或改状态样式。
2. 版本页必须是单一 HTML，CSS 与必要 JS 内联，直接通过 `file://` 可读。门户可使用本地 CSS/JS，但不得依赖构建、后端、CDN、在线字体、图片服务或追踪脚本。
3. 第 3 节的组件名是**语义与视觉契约**，不是要求引入第三方组件库。版本页可将所需 CSS 内联；门户可抽到本地样式表。
4. 两页互链固定使用相对地址：
   - 版本页到门户：`portal/index.html`
   - 门户到版本页：`../neo-agent-version-evolution.html`
5. 公共锚点固定为 `#main-content`、`#quick-start`、`#workflows`、`#versions`、`#boundaries`、`#sources`。版本页没有真实工作流区时，不保留空锚点；门户必须保留 `#quick-start`、`#workflows`、`#versions`、`#boundaries`。
6. 所有公开事实以 PRD §5.4、§6 与对应仓库文档为准。视觉层级不得把“本轮规划”做得比“已发布”更醒目，也不得用动效制造“已经可用”的错觉。
7. 本文给出的对比度是按 WCAG 相对亮度公式计算的调色板基线，不替代成品页面、实际状态和打印模式的复测。

## 1. 品牌性格与设计原则

### 1.1 三层品牌名称

- **neo-agent**：对外产品名，用于页面标题、Hero 与正文介绍。
- **neo-cli**：GitHub 仓库名，用于仓库链接、克隆与源码语境。
- **neo**：真实命令入口，用于所有命令示例；不得写成可执行文件 `neo-agent`。

首次介绍采用：

> neo-agent 是 neo-cli 仓库中的 Matrix 风格终端编程助手，命令行入口为 `neo`。它通过 Bun 运行，可连接 OpenAI 兼容或 Anthropic Messages 协议的 LLM 网关。

主口号采用：**“把终端编程、长任务验证与多会话协作放进同一个 CLI。”**

### 1.2 品牌性格

- **技术可信**：事实、状态、来源先于装饰；每一项能力都能回溯，每一个限制都容易找到。
- **终端原生**：深色、等宽、精确对齐、命令与输出是主要视觉素材，而非泛 AI 聊天气泡。
- **清晰克制**： Matrix 只表现为低对比代码氛围、细线与绿色强调，不用满屏高亮绿字、故障闪烁或电影桥段。
- **工程秩序**：网格稳定、间距一致、状态明确、交互可预测；不用无意义玻璃拟态、渐变文字和多层霓虹。
- **诚实开放**：公开“已实现，未发布”和“本轮规划”，同时清楚解释模型网关、密钥与平台前提。

### 1.3 五条设计原则

1. **先回答事实，再制造氛围**：首屏先出现产品/版本、核心说明与真实入口；背景永不抢过标题和正文。
2. **用证据替代形容词**：优先写协议、命令、退出码、发布记录与限制，少用“颠覆”“终极”“无缝”“绝对可靠”。
3. **状态是内容，不是颜色**：状态徽章始终含完整文字和形状标识，时间线默认展开，不依赖悬停。
4. **命令必须真实可复制**：示例使用 README 中的 `neo` 或 `bun run src/index.ts`，不伪造交互截图、输出、安装包或在线服务。
5. **离线仍是一份完整文档**：禁用 JS、动画关闭或外部网络不可用时，标题、正文、时间线、命令、边界与真实链接仍可阅读和操作。

### 1.4 Matrix 风格边界

允许：数字、代码符号、终端字符、绿色微光、稀疏字符雨、网格与扫描线式的极淡静态纹理。

禁止：电影海报、角色、标志、台词截图、权利方 Logo，以及“官方授权”“电影联名”“官方 Matrix 产品”等暗示。不要使用电影原句作为公开 Hero 文案。Matrix 是对终端视觉风格的描述，不是权利关系声明。

## 2. 精确设计 tokens

### 2.1 色彩

```css
:root {
  color-scheme: dark;

  --color-bg: #07110d;
  --color-bg-deep: #030806;
  --color-surface: #0d1a14;
  --color-surface-raised: #12241b;
  --color-text: #f0f7f2;
  --color-text-muted: #a9bab0;
  --color-border: #355044;
  --color-border-strong: #708b7b;

  --color-accent: #66f2a3;
  --color-accent-strong: #8affba;
  --color-accent-ink: #04130b;

  --color-released: #66f2a3;
  --color-unreleased: #ffd166;
  --color-planned: #c4b5fd;
  --color-info: #8fdcff;
  --color-warning: #ffd166;
  --color-danger: #ff8a8a;
  --color-focus: #ffd166;

  --color-print-bg: #ffffff;
  --color-print-text: #111411;
  --color-print-muted: #3f4741;
  --color-print-border: #747d76;
}
```

| 角色 | 值 | 用途 |
| --- | --- | --- |
| `bg` | `#07110D` | 页面主背景，不用纯黑 |
| `bg-deep` | `#030806` | 代码块、页脚或 Hero 最底层 |
| `surface` | `#0D1A14` | 卡片、导航、时间线条目 |
| `surface-raised` | `#12241B` | 当前版本摘要、悬停表面；不是文字色 |
| `text` | `#F0F7F2` | 标题与正文 |
| `text-muted` | `#A9BAB0` | 次要说明、日期、来源标签；不能继续降低透明度 |
| `border` | `#355044` | 装饰分隔线、卡片默认边框 |
| `border-strong` | `#708B7B` | 输入/滚动区等需要可辨识边界的组件 |
| `accent` | `#66F2A3` | 主按钮底色、链接、重点数据、已发布状态 |
| `accent-strong` | `#8AFFBA` | 链接/按钮悬停，不用于整段正文 |
| `accent-ink` | `#04130B` | 绿色主按钮上的文字与图标 |
| `unreleased` | `#FFD166` | “已实现，未发布”及警告；始终配文字 |
| `planned` | `#C4B5FD` | “本轮规划”；不使用低饱和灰紫 |
| `info` | `#8FDCFF` | 说明性信息，不表示发布状态 |
| `danger` | `#FF8A8A` | 错误与禁止事项；页面无真实错误时不作装饰 |

在 `bg` / `surface` / `surface-raised` 上的最小计算对比度：

| 前景色 | 对 `bg` | 对 `surface` | 对 `surface-raised` |
| --- | ---: | ---: | ---: |
| `text` | 17.62:1 | 16.42:1 | 14.91:1 |
| `text-muted` | 9.44:1 | 8.80:1 | 7.99:1 |
| `accent` | 13.51:1 | 12.59:1 | 11.43:1 |
| `unreleased` / `warning` | 13.30:1 | 12.40:1 | 11.26:1 |
| `planned` | 10.39:1 | 9.68:1 | 8.79:1 |
| `info` | 12.65:1 | 11.79:1 | 10.70:1 |
| `danger` | 8.45:1 | 7.88:1 | 7.15:1 |
| `border-strong`（非文字边界） | 5.18:1 | 4.82:1 | 4.38:1 |

`accent-ink` 对 `accent` 为 **13.41:1**，主按钮必须使用这组搭配。禁止用 `bg` 色文字放在 `surface` 上，禁止给正文加 opacity，禁止用 `#00FF00` 高饱和纯绿铺满正文。卡片若新增其它底色，必须重新验证所有文字与状态组合达到正文 4.5:1、大字 3:1、必要非文字边界 3:1。

### 2.2 字体与排版

```css
:root {
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    "Noto Sans CJK SC", sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", "Cascadia Code",
    "Cascadia Mono", Consolas, "Liberation Mono", "Noto Sans Mono CJK SC",
    monospace;

  --text-xs: 0.75rem;    /* 12px：仅非关键装饰标签 */
  --text-sm: 0.875rem;   /* 14px：元信息、徽章 */
  --text-base: 1rem;     /* 16px：正文 */
  --text-md: 1.125rem;   /* 18px：导语 */
  --text-lg: 1.25rem;    /* 20px：卡片标题 */
  --text-xl: 1.5rem;     /* 24px：小节标题 */
  --text-2xl: 1.875rem;  /* 30px */
  --text-3xl: 2.375rem;  /* 38px */
  --text-4xl: 3rem;      /* 48px */

  --leading-tight: 1.2;
  --leading-heading: 1.3;
  --leading-body: 1.75;
  --leading-code: 1.6;

  --tracking-label: 0.08em;
}
```

- 页面 `font-size: 100%`，正文 16px / 1.75，门户导语 18px / 1.7；不锁定像素字号，不用小于 14px 的事实、来源或操作文字。
- 中文正文使用 sans；版本号、commit、命令、代码、事件名与简短数据使用 mono。长中文段落不要整段等宽。
- H1 使用 `clamp(2.25rem, 6vw, 4rem)`；版本页可封顶 48px，门户 Hero 可封顶 64px。H2 使用 `clamp(1.75rem, 3vw, 2.375rem)`，H3 为 20px。
- 标题字重 650–700，正文 400，按钮与徽章 600。系统字体没有中间字重时接受浏览器合成，不加载字体文件。
- 正文行宽以容器限制：长文理想每行约 35–45 个中文字符，阅读容器最大 760px；不得靠 `text-align: justify` 拉大中文字间距。
- 英文大写只用于 12–14px 的短 eyebrow/标签，配 `--tracking-label`；中文不增加大字距。

### 2.3 间距、尺寸、圆角、阴影

```css
:root {
  --space-1: 0.25rem;  /* 4 */
  --space-2: 0.5rem;   /* 8 */
  --space-3: 0.75rem;  /* 12 */
  --space-4: 1rem;     /* 16 */
  --space-5: 1.5rem;   /* 24 */
  --space-6: 2rem;     /* 32 */
  --space-7: 3rem;     /* 48 */
  --space-8: 4rem;     /* 64 */
  --space-9: 5rem;     /* 80 */
  --space-10: 6rem;    /* 96 */

  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-pill: 999px;

  --shadow-card: 0 12px 32px rgb(0 0 0 / 0.24);
  --shadow-focus: 0 0 0 4px rgb(255 209 102 / 0.2);

  --container: 75rem;       /* 1200px */
  --measure: 47.5rem;       /* 760px */
  --header-height: 4.5rem;  /* 72px，仅作最小高度参考 */
  --target-min: 2.75rem;    /* 44px */
  --duration-fast: 120ms;
  --duration-normal: 180ms;
}
```

- 基础间距单位为 4px；组件内距只用 8/12/16/24，区块间距用 48/64/80/96。
- 卡片内距统一使用 24px（`--space-5`），卡片间距 16px，主要分区上下 64px，宽屏 80px。
- 按钮/徽章可用胶囊圆角；卡片和代码块统一 12px，不用超大圆形或过多浮层。
- 阴影只用于当前版本卡或悬停提升；普通卡片依靠边框分层，禁止大面积绿色外发光。
- 所有点击目标最小 44×44px；文本链接可保留行内尺寸，但独立导航与按钮必须满足目标尺寸。

### 2.4 容器与基础交互

```css
.container {
  width: min(calc(100% - 2rem), var(--container));
  margin-inline: auto;
}

@media (min-width: 48rem) {
  .container { width: min(calc(100% - 4rem), var(--container)); }
}

@media (min-width: 80rem) {
  .container { width: min(calc(100% - 6rem), var(--container)); }
}

:where(a, button, [tabindex]):focus-visible {
  outline: 3px solid var(--color-focus);
  outline-offset: 3px;
  box-shadow: var(--shadow-focus);
}

:where(section, h1, h2, h3)[id] { scroll-margin-top: 6rem; }
```

360px 时左右 gutter 16px，768px 时 32px，1280/1440px 时 48px；1440px 容器最大 1200px 并居中。不得设置固定页面宽度。主内容、导航、代码块均不得造成页面级横向滚动。

## 3. 两页共享组件契约

### 3.1 跳至正文与语义骨架

每页 DOM 顺序固定为：

```html
<a class="skip-link" href="#main-content">跳至正文</a>
<header class="site-header">…</header>
<main id="main-content" tabindex="-1">…</main>
<footer class="site-footer">…</footer>
```

- `.skip-link` 默认移出视口，获得焦点时位于左上 16px，层级最高，使用 `surface-raised` 底、`text` 字和 3px focus 边框。
- 每页仅一个 H1；区块标题为 H2，卡片标题为 H3。导航用 `nav aria-label="主导航"`，多导航时分别命名。
- `main tabindex="-1"` 只用于跳转后聚焦，不加入正常 Tab 顺序。
- 不用 `div` 模拟按钮、链接、列表、表格或标题。

### 3.2 品牌标识与导航 `.site-header`

品牌标识采用纯文本：绿色细边框方块中的 `neo`，旁边是 `neo-agent`；版本页下方或右侧附“版本演进”，门户可附“终端编程助手”。不使用影视标志。

导航内容：

- 版本页：`产品门户`、`当前版本`、`演进时间线`、`已知边界`、`GitHub`。
- 门户：`核心能力`、`真实工作流`、`版本演进`、`使用边界`、`GitHub`。
- 当前页链接使用 `aria-current="page"`；页内当前位置可用 `aria-current="location"`，但不要仅随滚动自动改变焦点。

行为：导航使用深色不透明或至少 96% 不透明背景；可选择 sticky，但不能遮挡锚点。360px 下品牌与链接自然换成两行，链接可横向换行，页面本身不横向滚动。优先保留少量可见链接，**不默认做依赖 JS 的汉堡菜单**。若链接过多，应减少页内项，而非隐藏核心入口。

### 3.3 状态徽章 `.status-badge`

只允许以下三种发布状态，文字逐字使用：

| class | 可见文字 | 非颜色标识 | 颜色 | 使用条件 |
| --- | --- | --- | --- | --- |
| `.status-badge--released` | `已发布` | 对勾 SVG | 绿色 | 有已发布 tag/release note/README 事实 |
| `.status-badge--unreleased` | `已实现，未发布` | 菱形 SVG | 黄色 | 已合入并验证，能指向实际提交/证据，尚未发版 |
| `.status-badge--planned` | `本轮规划` | 空心圆 SVG | 浅紫色 | 仅在 PRD 或开放 Issue 中 |

统一结构：

```html
<span class="status-badge status-badge--planned">
  <svg aria-hidden="true" focusable="false">…</svg>
  <span>本轮规划</span>
</span>
```

- 高度至少 28px，独立可点击徽章则为 44px；字号 14px、字重 600、圆角 pill、1px 同色边框、深色表面底。
- SVG 为 16×16、`currentColor`、装饰性并 `aria-hidden="true"`。不可只显示图形或圆点。
- 徽章文本不可缩写成“已上线”“已完成”“即将推出”“Beta”。“实验性”“已实测”等是事实描述，不得代替三种发布状态。
- 同一对象只挂一个当前发布状态。门户第三卖点若同时包含现有 drive 与规划 #59/#37，应拆成子项分别标状态，不能给整卡笼统一枚“已发布”。

### 3.4 按钮与文字链接 `.button`

| 类型 | 外观 | 用途 |
| --- | --- | --- |
| `.button--primary` | `accent` 底、`accent-ink` 字、无边框 | 每屏最多一个主 CTA，如“查看 GitHub 仓库” |
| `.button--secondary` | 深色底、`accent` 字、1px `border-strong` | “快速开始”“查看版本演进” |
| `.button--ghost` | 透明底、`text` 字，hover 出 `surface-raised` | 低优先级操作，如复制代码 |

- 高度最小 44px，水平内距 20px，圆角 8px，字体 16px/600；图标 18px。
- hover 只改变底色/边框，不移动布局；active 可用 1px 向下位移，但 reduced motion 下取消过渡。
- 不用空 `href`、`javascript:`、假禁用按钮或“即将上线”按钮。真实链接用 `<a>`，复制等动作用 `<button type="button">`。
- 正文链接始终保留下划线，颜色只是辅助；导航、按钮和卡片标题中的链接可在有明显交互语义时去下划线。
- 外链默认同页打开；若新窗口打开，使用 `rel="noopener noreferrer"` 并在可访问名称中说明“在新窗口打开”。

### 3.5 卡片 `.card`

基础结构为 `article.card > h3 + 内容 + 可选来源/状态`。边框 1px `border`、`surface` 底、12px 圆角，不用整卡 hover 才显示正文。

变体：

- `.card--current`：当前版本摘要，使用 `surface-raised` 和 `accent` 左边框（4px），允许 `--shadow-card`。
- `.card--fact`：事实/能力卡，顶部短标签，随后 H3、说明和状态；不夸大数字。
- `.card--boundary`：边界说明，使用 `warning` 小图标和明确标题，不将整块染成黄色。
- `.card--planned`：规划条目，左边框用 `planned`，同时放完整“本轮规划”徽章。

禁止整卡嵌套链接、一个卡片多个重叠点击层或无文字的图标按钮。卡片高度可视觉对齐，但内容不截断、不用固定高度。

### 3.6 代码块 `.code-block`

```html
<figure class="code-block">
  <figcaption class="code-block__header">源码运行 · Bash</figcaption>
  <pre tabindex="0" aria-label="源码运行命令，可横向滚动"><code>…</code></pre>
</figure>
```

使用以下规则：

- `pre` 使用 `bg-deep`、`text`、14–16px mono / 1.6，内距 16–20px，圆角 12px，`overflow-x: auto`，`overscroll-behavior-inline: contain`。
- 代码保持原始空白，不在窄屏强制换行命令；页面其它区域不得跟随横向滚动。键盘可聚焦滚动区。
- 提示符 `$`、输出和注释若用于示例，必须明确区分；优先只放可复制命令，不把假输出包装成实测。
- 复制按钮是 JS 增强：初始 HTML 中 `hidden`，JS 成功初始化后才显示；点击后在 `aria-live="polite"` 区显示“已复制”或“复制失败，请手动选择”，2–3 秒后清除。无 Clipboard API 时保留手动选择，不报错阻塞页面。
- 不展示真实 API key、私有网关地址或个人配置。示例配置用明确占位符，不能看似真实密钥。

### 3.7 时间线 `.timeline`

版本页主时间线使用 `<ol class="timeline">`，按**最新到最早**排列。每个 `<li>` 包含：

1. `article` 或等价语义容器；
2. H3：`v0.4.84` 等真实版本；
3. “已发布”徽章；
4. `<time datetime="2026-11-10">2026-11-10</time>`；
5. 一段准确摘要；
6. 能力轴标签（可选）；
7. “来源：对应 release note / README”真实链接。

视觉：左侧 2px `border` 竖轴，节点为 12px 圆形，当前版本用 `accent` 实心，其余用 `surface` 底和 `border-strong` 边。节点只是辅助，版本、日期、摘要、状态与来源默认全部显示。360px 下轴与内容间距 16px，不用左右交错；任何宽度都不用横向时间线、悬停弹层或点击展开才能看摘要。

### 3.8 来源与验证记录 `.source-list` / `.evidence-note`

- 来源列表是真实 `<ul>`，链接文字包含文档名或版本，不写一排无法区分的“这里”。
- 当前版本四件套固定展示：版本号、发布日期、基线 commit、release note/README 来源。
- 历史验证数字使用提示框：标题“v0.4.84 发布时验证记录”，正文明确“该版本发布记录”，随后才是 1995 pass / 0 fail / 0 skip、PTY 32/32、ALL GREEN；不得写“本次复测”“当前全绿”。
- 本地证据路径不得作为公开可下载资源展示。只引用公开仓库可访问的 release note，不暴露 `.workbuddy/` 或 `docs/evidence/` 内容。

### 3.9 页脚 `.site-footer`

包含：`neo-agent / neo-cli / neo` 名称说明、仓库链接、版本页/门户互链、事实基线日期、内容状态说明。可写“本地静态页面，无追踪脚本”，但只有实际满足时才保留。

页脚顶部 1px `border`，使用 `text-muted` 14–16px；不得放虚假社交账号、备案号、版权归属、下载或订阅框。

## 4. 页面 A：独立版本演进 HTML

### 4.1 页面定位

页面气质是**可核查的发布档案**，不是营销首页。以阅读容器和时间线为主，少用多列卡片，不用大面积 Hero 字符雨。目标是回答：当前版本是什么、为什么演进、近期解决了什么、哪些仍有限制。

### 4.2 信息层级与顺序

1. **导航**：品牌 + “版本演进”，真实互链和 GitHub。
2. **页首摘要**：eyebrow `RELEASE LEDGER / 版本事实`；H1“neo-agent 版本演进”；一段 60–100 字说明；不使用夸张营销口号。
3. **当前版本卡 `#current-version`**：首先出现 `v0.4.84` 与“已发布”，并列 2026-11-10、commit `a2858ae`，提供对应 release note、tag/commit 与仓库链接。commit 使用完整或至少 7 位短哈希，但链接目标必须准确。
4. **发布时验证记录**：作为当前版本卡后的证据说明，明确历史属性，不伪装成本次复测。
5. **近期演进时间线 `#timeline`**：v0.4.84 → v0.4.80，摘要严格来自 PRD §2.2。可选早期节点须逐个补来源，否则不做。
6. **关键能力轴 `#capabilities`**：终端交互、模型/协议、上下文/记忆、工具/协作、目标驱动与质量闸门。用紧凑定义列表或单列条目说明“哪些版本推动了什么”，不要变成第二套重复时间线。
7. **本轮规划 `#planned`**：#52、#59、#37 三个条目，全部带“本轮规划”，简述用户价值与边界；完成前不得改变状态。
8. **已知边界 `#boundaries`**：Windows 11 实验性且未实机验证；worktree/hooks 非沙箱；模型判断不等于验证；#28 PTY/attach 与 #29 OAuth 暂停。补充“用户需自备 Bun、兼容 LLM 网关与 API key”。
9. **事实来源与更新口径 `#sources`**：README、v0.4.80–v0.4.84 release notes、PRD；解释三种发布状态和“功能合入不等于发布”。
10. **页脚**：互链与事实基线日期。

### 4.3 版本页布局

- 主容器最大 1200px，但页首正文、时间线、来源区使用最大 760px 阅读列；当前版本卡可扩到 920px，避免过宽的数据行。
- 当前版本卡内部在 768px 起使用两列“标签/值”定义列表；版本号、状态和主来源始终在第一视觉组。
- 时间线单列，不将 v0.4.80–v0.4.84 做成需要横滑的五列卡片。
- 能力轴在 768px 起可两列，1280px 起仍最多三列；每条内容完整，不为了对齐截断。
- 字符氛围仅使用页首静态纹理；默认不启动字符雨，以突出档案感。

### 4.4 版本页推荐链接

- 仓库：`https://github.com/AndersHsueh/neo-cli`
- 当前 release note：`https://github.com/AndersHsueh/neo-cli/blob/v0.4.84/docs/release-notes/v0.4.84.md`
- 当前 tag：`https://github.com/AndersHsueh/neo-cli/releases/tag/v0.4.84`
- 当前 commit：`https://github.com/AndersHsueh/neo-cli/commit/a2858ae`

上线或更新前仍须实际检查链接；不得因为本文列出 URL 就免除链接验收。更早版本使用其对应 tag 路径，不统一指向 `main` 冒充历史快照。

## 5. 页面 B：响应式宣传门户

### 5.1 页面定位

页面气质是**面向技术用户的快速评估入口**：一分钟理解产品、场景、真实起步方式与边界。比版本页更有节奏和空间，但不能复刻成另一个时间线页。

### 5.2 信息层级与顺序

1. **导航**：品牌、核心能力、真实工作流、版本演进、使用边界、GitHub。
2. **Hero**：短 eyebrow `TERMINAL CODING ASSISTANT`；H1“Matrix 风格的终端编程助手”；neo-agent 品牌说明与主口号；当前 `v0.4.84 · 已发布` 小徽章组。主 CTA“查看 GitHub 仓库”，次 CTA“阅读快速开始”，第三入口用正文链接“查看版本演进”。
3. **Hero 终端面板**：放 README 真实命令的静态 `<pre><code>`，旁边或下方明确“前提：Bun >=1.1、自有兼容 LLM 网关与 API key”。不得伪造截图、打字输出或成功结果。复制仅作 JS 增强。
4. **三大核心卖点 `#capabilities`**：
   - 多协议与可控模型路由：现有 OpenAI 兼容、Anthropic Messages、provider/tier/model 路由，标“已发布”。
   - 终端内编程、协作与记忆：文件/搜索/shell、MCP、worktree、后台任务、wiki 等，按真实事实标“已发布”。
   - 面向无人值守的可信执行：现有 `-p --drive`、上限与 verified/model 来源可标“已发布”；#59 备用链与 #37 stream-json 必须分别标“本轮规划”，不得让整卡状态含糊。
5. **真实工作流 `#workflows`**：依次展示交互开发、`-p` 单次、`--drive` 长跑、worktree + 跨会话协作。采用四个编号条目或 2×2 卡片，不做依赖 JS 的 tabs。命令与 README 一致；未实现的新参数不出现。
6. **快速开始 `#quick-start`**：Bun/网关/密钥前提、源码运行命令、README 链接。用“从源码运行”，不用“下载”“安装 neo-agent”“npm install”。
7. **版本摘要 `#versions`**：当前 v0.4.84、日期、基线、历史验证记录说明和最近 3–5 个节点的精简摘要；主链接“查看完整版本演进”。门户摘要不得另造版本事实。
8. **平台与使用边界 `#boundaries`**：macOS、Ubuntu/Debian 实测；Windows 11 实验性未实机验证；worktree 只隔离文件；hooks 不是权限系统；两者都不是安全沙箱；模型判断不等于验证；规划能力未上线。
9. **最终 CTA**：H2“从源码了解并运行 neo-agent”，只放 GitHub、README/文档、版本页入口。无下载、登录、价格、在线体验。
10. **页脚**：同共享契约。

### 5.3 门户布局

- Hero 在 1280px 起使用约 `1.05fr / 0.95fr` 两列：左文案、右终端面板，最小列宽为 0，防止代码撑破网格。768–1279px 为单列，终端面板紧随 CTA；360px 同样单列。
- 三大卖点：360px 单列；768–1023px 两列，第三张跨两列；1024px 起三列。卡片内容自然增高，不截断。
- 真实工作流：360px 单列；768px 起两列；1280px 起仍保持 2×2，以保留命令宽度，不做四列窄卡。
- 快速开始与版本摘要在 1280px 起可 5:7 两列；768–1279px 单列。边界区采用单列清单，确保限制不被视觉弱化。
- 字符雨只允许出现在 Hero 背景层，正文与终端面板置于不透明表面上；其它区块使用干净背景。

### 5.4 两页“统一但不雷同”的硬性差异

| 维度 | 版本演进页 | 宣传门户 |
| --- | --- | --- |
| 主任务 | 核查版本与来源 | 理解价值并找到真实入口 |
| 主结构 | 760px 阅读列 + 单列时间线 | 宽容器 + Hero + 卖点/工作流网格 |
| 首屏 | 当前版本卡优先 | 产品说明、CTA、真实命令优先 |
| 动效 | 默认静态纹理 | Hero 可选克制字符雨 |
| 证据 | 每节点来源、历史验证记录完整 | 摘要 + 链到版本页，不堆全部节点 |
| 语气 | 档案、精确、版本导向 | 清晰、场景导向、保留条件 |

## 6. 响应式行为契约

采用移动优先，主要断点为 `48rem`（768px）、`64rem`（1024px）、`80rem`（1280px）。以下四个视口是必须实测的验收点，不是只调浏览器窗口凭印象检查。

| 视口 | 容器与导航 | 版本页 | 门户 |
| --- | --- | --- | --- |
| **360px** | 16px gutter；导航可两行换行；无汉堡依赖 | H1 36px 起；当前版本事实单列；时间线单列；代码内部横滚 | Hero/终端/卖点/工作流全部单列；按钮可满宽但不超出；第三 CTA 为正文链接 |
| **768px** | 32px gutter；品牌与导航尽量一行，空间不足可换行 | 阅读列约 704px；当前版本定义列表两列；能力轴可两列 | Hero 单列；卖点两列且第三张跨行；工作流两列；版本摘要单列 |
| **1280px** | 48px gutter，实际内容宽约 1184px | 阅读列 760px 居中，当前卡最多 920px；不做左右交错时间线 | Hero 两列；卖点三列；工作流 2×2；快速开始/摘要可两列 |
| **1440px** | 容器封顶 1200px 居中，外侧留白增加 | 与 1280px 同构，不继续拉宽正文或放大所有元素 | 与 1280px 同构，Hero 两列间距可增加至 48px，不扩代码到难读宽度 |

所有宽度共同要求：

- 使用 `min-width: 0` 处理 grid/flex 子项，媒体、SVG、代码和 URL 不撑破容器。
- 长 URL 在普通文字中用有意义链接文本；必须显示时可 `overflow-wrap: anywhere`，但命令与版本号不任意断行。
- 200% 文本缩放和 400% 页面缩放时内容不丢失、不重叠；不能用固定高度限制卡片与导航。
- 不出现只针对某一台设备的写死高度、绝对定位正文或横向页面滚动。

## 7. Matrix 背景与字符雨方案

### 7.1 静态背景（两页默认）

只使用本地 CSS：主背景 `bg`，Hero/页首叠加一层低对比径向渐变和稀疏网格。装饰层 `aria-hidden="true"`、`pointer-events: none`，不进入 Tab 顺序。

约束：

- 装饰不透明度总量不超过 0.12；网格线不使用比 `border` 更亮的颜色。
- 标题、正文、命令、链接背后必须是实色或足够不透明的 `bg/surface`；装饰不得穿过文字造成局部对比度下降。
- 不使用持续扫描线、闪屏、 glitch、色差抖动、鼠标追逐或自动视差。
- 背景用纯 CSS 或内联 SVG，不请求外部图片。

### 7.2 可选字符雨（仅门户 Hero）

字符雨是渐进增强，不是核心内容。允许用本地内联 JS + `<canvas aria-hidden="true">`，限制在 Hero 内：

- 字符集只用数字、ASCII 字母与 `<>/{}[]#$+-*` 等代码符号；不使用电影画面或台词。
- 颜色仅用 `accent`，canvas 整体 opacity ≤0.10；文字层与装饰层分离。
- 上限 24fps、24 列（窄屏）或 36 列（宽屏）；只在 Hero 可见且 `document.visibilityState === "visible"` 时运行。
- 页面隐藏、Hero 离开视口、组件销毁时停止 `requestAnimationFrame`；resize 做节流，不积累监听器。
- 不出现高频闪烁；不改变布局；不捕获鼠标、触摸或键盘事件。
- 无 JS、canvas 不可用或脚本初始化失败时，静态背景和完整 Hero 内容仍在，控制台不报错。

### 7.3 reduced motion 与无 JS

```css
.matrix-rain { display: none; }

@media (prefers-reduced-motion: no-preference) {
  .js .matrix-rain[data-ready="true"] { display: block; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .matrix-rain { display: none !important; }
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
  }
}
```

JS 必须先用 `matchMedia("(prefers-reduced-motion: reduce)")` 判断；为 reduce 时不得启动循环，并监听偏好变化以停止已运行的动画。`.js` 类只能在脚本成功运行后添加，禁止 CSS 默认隐藏正文再靠 JS 恢复。所有核心文字、链接、命令、时间线直接存在于 HTML。

## 8. 内容语气、图标与装饰

### 8.1 内容语气

- 使用“支持……”“提供……”“发布记录为……”“本轮规划……”，避免“最强”“完美”“零故障”“全自动且绝对可靠”。
- 句首先说用户可做什么，再补真实条件。例如：“通过 Bun 从源码运行；需要自备兼容模型网关和 API key。”
- “可信”只能指可核查的验证来源、退出码或事件契约，不等于模型不会犯错。备用链只能表述为提高恢复机会，结构化事件只能表述为提高可观测性。
- 明确历史时点：“v0.4.84 发布记录为……”而不是“测试全部通过”。
- 数字只使用版本、日期、commit、轮次/退出码和带来源的发布记录；不编用户数、星标、benchmark、客户、合作伙伴、价格或许可证。

推荐 CTA：`查看 GitHub 仓库`、`从源码运行`、`阅读 README`、`查看完整版本演进`、`了解使用边界`。

禁止 CTA：`立即下载`、`npm 安装`、`在线体验`、`免费试用`、`登录`、`获取企业版`，除非未来有真实事实并另行评审。

### 8.2 图标策略

- 使用本地内联 SVG，统一 24px viewBox、1.75–2px stroke、`currentColor`、圆角线帽；常用尺寸 16/18/20px。
- 只保留有语义的图标：外部链接、仓库、文档、复制、状态、警告。每个卡片不强行配不同图标。
- 装饰 SVG 必须 `aria-hidden="true" focusable="false"`；独立图标按钮必须有可访问名称和 44px 目标。
- 不用 emoji 代替正式状态图标，不使用第三方图标 CDN、图标字体或远程 SVG。
- 若未来使用真实产品截图，必须有等价 alt 与来源；本轮优先真实 HTML 终端面板，不制造截图。

### 8.3 装饰策略

绿色短线、编号、代码符号和网格是辅助；同屏只允许一个主要装饰焦点。禁止大面积渐变标题、3D 球体、机器人头像、发光芯片、股票式数据图和无事实依据的计数器。

## 9. 可访问性、打印与健壮性

### 9.1 可访问性基线

目标为 WCAG 2.2 AA：

- `html lang="zh-CN"`，英文短句或代码按需局部标 `lang="en"`；标题层级连续，landmark 完整。
- 所有功能可键盘完成，Tab 顺序与 DOM 一致；无键盘陷阱、无自动聚焦、无仅 hover 才出现的信息。
- 正文/交互文字 ≥4.5:1，大字 ≥3:1，必要组件边界和焦点 ≥3:1；焦点不被 sticky header 或装饰遮挡。
- 状态用文字 + 图形 + 颜色三重表达；错误不能只写红色图标。
- canvas、背景、装饰 SVG 对辅助技术隐藏；有信息图片使用准确 alt，不能把整段正文只放在图片里。
- 复制结果通过 `aria-live="polite"` 宣告；不要对时间变化字符雨使用 live region。
- 导航当前位置、链接新窗口行为、代码滚动区均有可访问名称。
- 页面在 reduced motion、无 JS、200% 文本缩放、400% 页面缩放下保留内容和功能。

### 9.2 打印

两页都提供 `@media print`，不要求“和屏幕一样”，要求事实完整可读：

```css
@media print {
  :root {
    color-scheme: light;
    --color-bg: #ffffff;
    --color-bg-deep: #ffffff;
    --color-surface: #ffffff;
    --color-surface-raised: #ffffff;
    --color-text: #111411;
    --color-text-muted: #3f4741;
    --color-border: #747d76;
    --color-border-strong: #3f4741;
    --color-accent: #075f32;
    --color-accent-ink: #111411;
    --color-released: #111411;
    --color-unreleased: #111411;
    --color-planned: #111411;
    --color-info: #111411;
    --color-warning: #111411;
    --color-danger: #111411;
  }
  html, body {
    background: var(--color-print-bg) !important;
    color: var(--color-print-text) !important;
  }
  .site-header, .skip-link, .matrix-rain, .matrix-atmosphere,
  .button--copy, .screen-only { display: none !important; }
  .container { width: 100%; max-width: none; }
  .card, .code-block, .timeline > li, .evidence-note {
    background: transparent !important;
    color: var(--color-print-text) !important;
    border-color: var(--color-print-border) !important;
    box-shadow: none !important;
    break-inside: avoid;
  }
  a { color: var(--color-print-text) !important; text-decoration: underline; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow: visible; }
}
```

- 次要文字使用 `print-muted`，状态仍打印完整文字与形状，不靠彩色底色。
- 版本页的时间线条目避免跨页，H2/H3 与后续内容避免孤行；门户打印时可折叠成单列，但不能用 CSS 隐藏核心边界或来源。
- 对外链接可在打印稿中通过 `a[href^="http"]::after` 附加 URL；页内锚点和重复导航不附加。避免 URL 与正文挤成一团，可在来源区优先显示完整文档名。
- 实际打印预览检查 A4，不能仅提供打印 CSS 就声称通过。

### 9.3 无外部请求与降级

- 首次加载只能请求当前 HTML 及明确存在的本地 CSS/JS/favicon；点击 GitHub 等外链才进入网络。
- 不使用 CDN、在线字体、远程图片、分析统计、第三方埋点、远程模块导入或 service worker 强制联网。
- 版本页所有样式与必要脚本内联；门户本地资源使用相对路径，`file://` 与静态服务器均可读。
- 无 JS 时复制按钮隐藏，所有正文和链接保留；脚本失败不留下空白 Hero、锁定导航或控制台异常。

## 10. SEO、分享元信息与页面身份

### 10.1 两页共同必备

```html
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#07110d">
<meta name="description" content="…">
<meta property="og:type" content="website">
<meta property="og:locale" content="zh_CN">
<meta property="og:site_name" content="neo-agent">
<meta property="og:title" content="…与 title 一致">
<meta property="og:description" content="…与 description 一致">
<meta name="twitter:card" content="summary">
```

- 每页有唯一、准确的 `<title>` 与 description，不含未发布承诺；OG/Twitter 文案与页面同步。
- favicon 使用内联 data SVG 或门户本地 SVG，图形为简单的 `neo`/方块，不引用电影标志；确保无 404。
- `canonical`、`og:url` 只有在主理人确认真实公开 URL 后填写；本地成果禁止写虚构域名、`file://` 或示例 URL。
- 没有真实公开分享图时不写 `og:image`，使用 `twitter:card=summary`。未来若添加，必须是实际部署的绝对 URL、准确 alt 和本地拥有的图片资产。
- 不添加虚假 Organization、评分、价格、下载数或许可证结构化数据。若使用 JSON-LD，只描述可证实的 SoftwareSourceCode 事实并另行核对。
- 页面发布地址未确定时，不擅自添加 `robots` 放行公开索引承诺，也不以 `noindex` 代替真实发布决策。

### 10.2 推荐元信息

**版本页**

- title：`版本演进｜neo-agent`
- description：`查阅 neo-agent 当前版本、近期发布节点、验证记录、事实来源与已知边界。当前已发布版本为 v0.4.84。`

**宣传门户**

- title：`neo-agent｜Matrix 风格的终端编程助手`
- description：`neo-agent 是 neo-cli 仓库中的终端编程助手，通过 Bun 运行，支持 OpenAI 兼容与 Anthropic Messages 协议；了解真实工作流、源码运行方式与使用边界。`

核心功能状态变化时，description、分享文案与正文一起复核，不能只改首页一处。

## 11. 状态更新与事实维护规则

1. 初版统一以 `v0.4.84 / 2026-11-10 / a2858ae / 已发布` 为当前基线；#52、#59、#37 为“本轮规划”。
2. 核心 Issue 合入并验证后，只把对应条目改为“已实现，未发布”，并补真实 commit/证据；其它未合入项保持规划。
3. 只有实际发版后才能改“已发布”，并由版本管理员同步版本号、tag、发布日期、commit、release note、README 与验证记录。
4. 不猜下一版本号，不提前写未来日期，不把历史发布测试数字改成当前复测结果，不回改历史 release note 来迎合新行为。
5. #52 后说明当前退出码行为时，须区分历史 v0.4.84 记录与新行为；视觉上的“当前”与“历史”标签要清楚。
6. 页面任何摘要、OG 文案、门户卖点与版本页状态必须来自同一次事实复核；不完整更新比少一个卖点更严重。

## 12. 可直接执行的交付检查清单

### 12.1 给版本管理员 / 版本页实现者

**事实与状态**

- [ ] 当前四件套已核对：`v0.4.84`、2026-11-10、`a2858ae`、对应 release note/README；仓库与 tag/commit 链接真实可达。
- [ ] v0.4.80–v0.4.84 按最新到最早展示，日期、摘要逐项对照 PRD §2.2 和各 release note；新增早期节点有独立来源。
- [ ] 1995 pass / 0 fail / 0 skip、PTY 32/32、ALL GREEN 明确标为“v0.4.84 发布时验证记录”，未冒充本次复测。
- [ ] #52/#59/#37 初版全部标“本轮规划”；状态升级有真实合入/发布依据，未预填版本号和日期。
- [ ] 已写明 Windows 实验性未实机验证、worktree/hooks 非沙箱、模型判断不等于验证、#28/#29 暂停及运行前提。
- [ ] 每个版本、能力轴和验证数字有来源；没有公开本地证据路径、私有配置或内部 `.workbuddy/` 内容。
- [ ] 旧 `fallback_allowed` 没有被描述成 #59 有序备用链；历史退出码与新行为没有混写。

**视觉与结构**

- [ ] 原样使用第 2 节 tokens、三种状态徽章、焦点、按钮、卡片、代码、时间线和页脚契约。
- [ ] 页面是档案式阅读列，首屏当前版本卡优先，未改成营销 Hero；时间线非横向、非 hover 专属、非仅颜色编码。
- [ ] 当前版本、最近节点、能力轴、规划、边界、来源顺序完整；门户互链为 `portal/index.html`。
- [ ] 只使用静态 Matrix 纹理；若额外加动效，仍满足 reduced motion，且不削弱事实层级。
- [ ] 单一 HTML 内联 CSS/必要 JS，无构建、CDN、外部字体、图片服务、追踪脚本或自动网络请求。

**实测验收**

- [ ] `file://` 直接打开可读，禁用 JS 后正文、时间线、命令、来源与链接完整，控制台无错误、无资源 404。
- [ ] 360/768/1280/1440px 无页面级横向溢出、遮挡、截断；代码区可键盘聚焦并内部滚动。
- [ ] 键盘依次检查跳至正文、导航、所有链接与按钮；焦点清晰，sticky header 不挡锚点。
- [ ] 实际工具复测正文/交互对比度、非颜色状态、200%/400% 缩放、reduced motion 和 A4 打印预览。
- [ ] title、description、lang、OG/Twitter、favicon 完整且相互一致；未虚构 canonical、公开 URL 或分享图。
- [ ] 所有链接真实，无空 href、假按钮、lorem ipsum；未执行的环境或检查明确记录“未执行”。

### 12.2 给运营专家 / 门户实现者

**内容与转化入口**

- [ ] 首次出现准确说明 neo-agent / neo-cli / neo 的关系，使用主口号与“Matrix 风格的终端编程助手”，无影视授权暗示。
- [ ] Hero 主 CTA 只到真实 GitHub，次 CTA 到真实快速开始；有版本页互链 `../neo-agent-version-evolution.html`。
- [ ] 三大卖点完整：多协议/模型路由、终端编程/协作/记忆、无人值守验证/恢复/可观测性；混合状态已拆成子项。
- [ ] #59 与 #37 完成前分别标“本轮规划”，未把备用链、stream-json 或正确的新退出码写成已上线。
- [ ] 工作流覆盖交互开发、`-p` 单次、`--drive` 长跑、worktree + 跨会话协作；示例命令与 README 一致且可复制。
- [ ] 快速开始明确 Bun >=1.1、自有兼容 LLM 网关/API key，以“从源码运行”表述；没有 npm、下载、登录、在线体验或价格 CTA。
- [ ] 平台与边界显著可读：macOS/Ubuntu/Debian 实测，Windows 11 实验性未实机验证；worktree/hooks 非沙箱；模型判断不等于验证。
- [ ] 未编用户数、星标、benchmark、评价、合作伙伴、许可证、截图或绝对可靠承诺；版本摘要与版本页同源。

**视觉与体验**

- [ ] 原样使用第 2 节 tokens 与共享组件，状态徽章完整文字为“已发布 / 已实现，未发布 / 本轮规划”，不只靠颜色。
- [ ] 页面是 Hero + 卖点 + 工作流 + 版本摘要 + 边界，不是把版本时间线换成宣传文案；与版本页差异符合 §5.4。
- [ ] 360px 单列；768px 卖点两列且第三张跨行、工作流两列；1280/1440px Hero 两列、卖点三列、工作流 2×2。
- [ ] Matrix 字符雨仅在 Hero、低对比、不挡文字；reduce 时完全不启动，无 JS 时静态内容与 CTA 完整。
- [ ] 代码块无假输出，复制按钮为可选增强；无 JS/Clipboard API 失败不影响手动复制。
- [ ] 所有本地 CSS/JS/favicon 使用相对路径且无外部运行依赖；无追踪脚本、在线字体、CDN 或图片服务。

**发布前实测**

- [ ] `file://` 和静态服务器均打开验证；控制台无错误，本地资源无 404，外部链接人工或工具检查可达。
- [ ] 360/768/1280/1440px 无横向页面滚动、重叠、截断；导航、按钮、代码滚动和复制均可键盘操作。
- [ ] 实测对比度、跳至正文、焦点、44px 目标、200%/400% 缩放、reduced motion、禁用 JS 与打印预览。
- [ ] title、description、OG/Twitter、favicon 与正文事实一致；公开 URL 未确认前不填 canonical/og:url/og:image。
- [ ] 若运行 Lighthouse，记录浏览器/设备/网络与运行方式，四项以实际报告为准；未运行则明确记录，不宣称分数。
- [ ] 最终 CTA 与页脚没有虚构入口；所有状态、日期、版本与验证数字经产品/QA 对照来源复核。

## 13. 最小完成定义

两页只有在以下条件同时满足时才算视觉与体验完成：tokens 未漂移；三类状态可非颜色识别；两页信息架构和相对互链符合本文；360/768/1280/1440px、键盘、对比度、reduced motion、无 JS、打印和链接经过实际检查；所有公开事实可回溯，无虚假 CTA、外部依赖或未说明的验证结果。任何无法执行的检查必须记录，不得以设计规范或人工印象替代验收。
