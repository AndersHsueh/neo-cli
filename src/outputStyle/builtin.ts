/**
 * 内置输出风格：中文指令、对齐公开语义，不抄竞品系统提示词原文，
 * 也不复刻 Insight 线框或「Learn by Doing」固定排版（issue #73）。
 */
import type { BuiltinOutputStyle, OutputStyle } from "./types.ts";
import { BUILTIN_OUTPUT_STYLES } from "./types.ts";

const CANON = new Map<string, BuiltinOutputStyle>(
  BUILTIN_OUTPUT_STYLES.map((n) => [n.toLowerCase(), n]),
);

export function isBuiltinOutputStyleName(name: string): name is BuiltinOutputStyle {
  return (BUILTIN_OUTPUT_STYLES as readonly string[]).includes(name);
}

export function normalizeBuiltinOutputStyle(raw: string): BuiltinOutputStyle | null {
  return CANON.get(raw.trim().toLowerCase()) ?? null;
}

const DESCRIPTIONS: Record<BuiltinOutputStyle, string> = {
  Default: "不加 style 段",
  Proactive: "自行开始工作并做常规假设；不改变权限模式",
  Concise: "先给结果，省前置与复述，工作仍须彻底",
  Explanatory: "补短设计取舍说明",
  Learning: "解释并留出小练习空白",
};

const BODIES: Record<BuiltinOutputStyle, string> = {
  Default: "",
  Proactive: `### 行动方式
自行开始工作，并对常规、可逆、低风险的细节做合理假设，不必每一步都先问用户。

### 权限说明
本风格只约束回复与工作方式，不改变权限模式；不会自动批准工具，也不会把权限模式切换为 auto-edit 或 auto-all。

### 先确认的情况
在破坏性、共享或生产环境的操作之前，先向用户确认。这是回复指令，不是权限变更。`,
  Concise: `### 先给结果
直接给出结论或改动，省去前置铺垫、过程叙述和对已知信息的复述。工作仍须彻底，不要为了短而漏步骤或省略必要细节。

### 完整长度
当用户明确要求展开，或安全、准确需要完整说明时，使用完整长度。`,
  Explanatory: `### 取舍说明
在给出方案或改动时，补一段简短的设计取舍：为什么这样选、放弃了什么、风险在哪里。说明要短，不要写成教程。`,
  Learning: `### 讲解
解释你在做什么、为什么这样做，帮助用户理解思路。

### 小练习
在合适的停顿处留出一小块练习空白，让用户自己试一试；不要把练习写成固定试卷或固定排版模板。`,
};

export function builtinOutputStyle(name: BuiltinOutputStyle): OutputStyle {
  return {
    name,
    description: DESCRIPTIONS[name],
    kind: "builtin",
    body: BODIES[name],
  };
}

export function builtinOutputStyles(): OutputStyle[] {
  return BUILTIN_OUTPUT_STYLES.map(builtinOutputStyle);
}

export function builtinHint(name: string): string {
  const canon = normalizeBuiltinOutputStyle(name);
  return canon ? DESCRIPTIONS[canon] : "";
}
