/**
 * 交互式规划工作流（issue #14）。
 *
 * 与「只读权限模式」是两套概念，不要混：
 *
 *  - `PermissionMode = "plan"`（`/mode plan`、`--plan`）：**只读闸门**。
 *    由 decidePermission 拒绝一切写副作用，没有「确认后放开」这一步。
 *  - 本文件的 `PlanSession`：**交互规划工作流**。进入后模型先澄清、再产出
 *    分步方案，用户在 `/plan` 里确认（或改方案）后才切回原权限模式并允许写。
 *
 * 规划态期间**借用**只读闸门（effectivePermissionMode 返回 "plan"），
 * 这样 write/edit/shell 的拒绝路径只有一条，不会出现第二条旁路；
 * 但用户可感知的入口是 `/plan`，与 `/mode plan` 分开。
 *
 * 纯逻辑模块：不 import agent 循环、不碰 IO。Agent 与 CLI 各自调用。
 */

/** 规划态里允许的只读工具。其余（写盘 / 执行 / 派生 / 记忆写入）一律从工具清单里摘掉。 */
export const PLAN_READONLY_TOOLS: readonly string[] = [
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "ask_user",
  "use_skill",
  "wiki_search",
  "list_peers",
  "todo_write",
  "compact_ctx",
];

/** 规划态额外可见的工具：提交方案 + 请求开始实施。 */
export const PLAN_CONTROL_TOOLS: readonly string[] = ["submit_plan", "exit_plan_mode"];

/** 规划态可见的全部工具。 */
export const PLAN_VISIBLE_TOOLS: readonly string[] = [...PLAN_READONLY_TOOLS, ...PLAN_CONTROL_TOOLS];

/** 规划态下模型能看到的工具清单（顺序沿用注册表顺序，过滤后返回）。 */
export function filterPlanTools<T extends { function: { name: string } }>(specs: T[]): T[] {
  return specs.filter((s) => PLAN_VISIBLE_TOOLS.includes(s.function.name));
}

/** 规划态生效的权限模式：借用只读闸门。 */
export function effectivePermissionMode(
  base: "ask" | "auto-edit" | "auto-all" | "plan",
  planning: boolean,
): "ask" | "auto-edit" | "auto-all" | "plan" {
  return planning ? "plan" : base;
}

/** 规划态的一步。 */
export interface PlanStep {
  title: string;
  detail?: string;
}

/** 结构化方案：步骤 / 风险 / 涉及文件。 */
export interface PlanDraft {
  title: string;
  summary?: string;
  steps: PlanStep[];
  risks: string[];
  files: string[];
}

export type PlanPhase = "clarify" | "proposed" | "implementing";

export interface PlanSnapshot {
  phase: PlanPhase;
  /** 进入规划态前的权限模式；确认后切回它。 */
  baseMode: "ask" | "auto-edit" | "auto-all" | "plan";
  /** 最近一次提交的方案（未提交过为 null）。 */
  draft: PlanDraft | null;
  /** 方案被修订过几次（用户要求修改时 +1）。 */
  revisions: number;
}

/**
 * 规划态会话。
 *
 * 只有三个状态：澄清中 → 已提交方案 → 实施中。没有「已批准」这种中间态：
 * 批准 = 离开规划态，状态本身就不存在了，避免出现「已批准但还在规划态」的鬼状态。
 */
export class PlanSession {
  private phaseValue: PlanPhase = "clarify";
  private draftValue: PlanDraft | null = null;
  private revisionsValue = 0;

  constructor(private readonly base: "ask" | "auto-edit" | "auto-all" | "plan") {}

  get active(): boolean {
    return this.phaseValue !== "implementing";
  }

  get phase(): PlanPhase {
    return this.phaseValue;
  }

  get draft(): PlanDraft | null {
    return this.draftValue;
  }

  get baseMode(): "ask" | "auto-edit" | "auto-all" | "plan" {
    return this.base;
  }

  get revisions(): number {
    return this.revisionsValue;
  }

  snapshot(): PlanSnapshot {
    return {
      phase: this.phaseValue,
      baseMode: this.base,
      draft: this.draftValue,
      revisions: this.revisionsValue,
    };
  }

  /** 模型提交方案：进入「待确认」。 */
  submit(draft: PlanDraft): void {
    this.draftValue = draft;
    this.phaseValue = "proposed";
  }

  /** 用户要求改方案：回到澄清态，保留上一版供模型参考。 */
  revise(): void {
    this.revisionsValue += 1;
    this.phaseValue = "clarify";
  }

  /** 用户确认（或直接开始实施）：离开规划态。 */
  approve(): void {
    this.phaseValue = "implementing";
  }
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

/**
 * 规划态的行为约束（每轮请求前注入临时 system 消息，请求后摘除）。
 *
 * 为什么不用改系统提示词：系统提示是会话级的，进/出规划态会反复改写它，
 * 与 noteModelChange 的正则改写互相踩。临时 system 消息是协议上最稳的旁路。
 */
export function planModeMessage(session: PlanSnapshot): string {
  const head = [
    "## 当前处于规划态（交互式 Plan 模式）",
    "",
    "现在是「先设计、再动手」阶段：只读工具可用，写盘/执行/派生类工具已从你的工具清单里摘掉。",
    "不要假装已经改过代码；不要用 shell 绕过（它现在也不在清单里）。",
  ];

  if (session.phase === "clarify") {
    head.push(
      "",
      "第一步是**澄清**，不是直接给方案：",
      "- 范围：这次要改什么、不改什么？",
      "- 约束：必须保持的接口/行为/兼容性？",
      "- 取舍：有几种做法时，各自的代价是什么？",
      "能自己查证的事实（读代码、看文档）先查，别问用户。真正需要人拍板的分叉用 ask_user 问，一次一个。",
      "澄清够了就产出方案，用 submit_plan 提交。",
    );
    if (session.draft) {
      head.push(
        "",
        `用户要求修改上一版方案（第 ${session.revisions} 次修订）。上一版要点：`,
        renderPlan(session.draft),
      );
    }
  } else {
    head.push(
      "",
      "方案已提交，正在等用户确认。**不要重复提交同一份方案**。",
      "用户可能：确认并开始实施、要求修改某几步、或直接改方案。等他们的回复。",
      "如果用户提出了修改意见，用 submit_plan 提交修订版。",
    );
  }

  head.push(
    "",
    "方案格式（submit_plan 的参数，用户会按这个结构看到）：",
    "- 步骤：3–8 步，每步一句话，写清「改哪里、改成什么」；",
    "- 风险：会影响什么、可能坏什么、需要回滚什么；没有风险就写「无」；",
    "- 涉及文件：具体路径，不要写「相关文件」。",
    "方案要短。用户要能一眼看完再决定，不是读一篇设计文档。",
  );
  return head.join("\n");
}

/** 把方案渲染成给模型/用户看的紧凑文本。 */
export function renderPlan(draft: PlanDraft): string {
  const lines: string[] = [`方案：${draft.title}`];
  if (draft.summary) lines.push(draft.summary);
  lines.push("", "步骤：");
  draft.steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s.title}${s.detail ? ` —— ${s.detail}` : ""}`);
  });
  lines.push("", "风险：");
  if (draft.risks.length === 0) lines.push("  无");
  else for (const r of draft.risks) lines.push(`  - ${r}`);
  lines.push("", "涉及文件：");
  if (draft.files.length === 0) lines.push("  （未列出）");
  else for (const f of draft.files) lines.push(`  - ${f}`);
  return lines.join("\n");
}

/** 用户确认后注入的「开始实施」提示：把已确认的方案钉在历史里，避免模型跑偏。 */
export function implementationMessage(draft: PlanDraft | null): string {
  const head = [
    "## 规划已确认，进入实施态",
    "",
    "写盘/执行类工具已恢复。按下面这份已确认的方案动手；用户中途改主意时以用户的话为准。",
    "改动贴着方案走，小步前进，不顺手翻新无关的东西。",
  ];
  if (draft) head.push("", renderPlan(draft));
  return head.join("\n");
}

/* ------------------------------------------------------------------ */
/* 方案解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把 submit_plan 的参数解析成 PlanDraft。
 *
 * 宽容解析：模型偶尔会把 steps 写成字符串数组、把 risks 写成单个字符串。
 * 校验失败抛 Error（由工具层转成 ToolError 回给模型），不要静默吞掉 ——
 * 一份空方案被当成「已提交」比报错更糟。
 */
export function parsePlanDraft(args: Record<string, unknown>): PlanDraft {
  const title = String(args["title"] ?? "").trim();
  if (!title) throw new Error("title 不能为空（一句话说清这份方案要做什么）");

  const rawSteps = args["steps"];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error("steps 必须是非空数组（3–8 步）");
  }
  const steps: PlanStep[] = rawSteps.map((s, i) => {
    if (typeof s === "string") {
      const t = s.trim();
      if (!t) throw new Error(`steps[${i}] 不能为空`);
      return { title: t };
    }
    if (typeof s !== "object" || s === null) throw new Error(`steps[${i}] 必须是字符串或对象`);
    const o = s as Record<string, unknown>;
    const t = String(o["title"] ?? "").trim();
    if (!t) throw new Error(`steps[${i}].title 不能为空`);
    const d = o["detail"] === undefined ? "" : String(o["detail"]).trim();
    return d ? { title: t, detail: d } : { title: t };
  });

  const risks = toStringList(args["risks"], "risks").filter((r) => r !== "无");
  const files = toStringList(args["files"], "files");
  const summaryRaw = args["summary"] === undefined ? "" : String(args["summary"]).trim();

  return {
    title,
    ...(summaryRaw ? { summary: summaryRaw } : {}),
    steps,
    risks,
    files,
  };
}

/** 字符串数组或单个字符串 → 去空数组。 */
function toStringList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") {
    const t = v.trim();
    return t ? [t] : [];
  }
  if (!Array.isArray(v)) throw new Error(`${field} 必须是字符串或字符串数组`);
  return v
    .map((x, i) => {
      if (typeof x !== "string") throw new Error(`${field}[${i}] 必须是字符串`);
      return x.trim();
    })
    .filter((x) => x.length > 0);
}
