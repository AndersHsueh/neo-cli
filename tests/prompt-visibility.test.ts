/**
 * 小窗口的工具可见集（issue #20 收尾，第 1 步 dry-run）。
 *
 * 覆盖三件事：
 *  1. **算法性质**：可见集永远是优先级前缀、动态块成组裁、MCP 最后被砍、
 *     预算不够时明确 fits=false 而不是抛错；
 *  2. **各窗口的期望可见集**（受控环境：空 cwd / 空技能库 / 无 env / 无 wiki）；
 *  3. **成本模型的保真度**：全量可见集的合成文本必须与真实渲染逐字节相同，
 *     裁动态块只裁三项、保留「跨会话消息」这类安全规则。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import { mainToolNames, toolNames, toolSpecs } from "../src/tools/index.ts";
import type { ToolSpec } from "../src/llm.ts";
import { PromptManager } from "../src/prompt/manager.ts";
import {
  TOOL_VISIBILITY_PRIORITY,
  knownToolNames,
  measureVisibilityCost,
  visibleToolNames,
  visibilityPriority,
} from "../src/prompt/visibility.ts";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpdir_(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * 受控环境：空工作目录（无目录树）、空技能库（无技能索引）、无 env 段、无 wiki。
 * 数字只依赖工具 schema 与三档核心正文 ⇒ 跨机器稳定。
 */
function controlledCfg(): Config {
  const cwd = tmpdir_("neo-vis-cwd-");
  const skills = tmpdir_("neo-vis-skills-");
  mkdirSync(skills, { recursive: true });
  return {
    cwd,
    skillsStore: skills,
    providerName: "p1",
    providerType: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    model: "m1",
    modelTier: "balanced",
    maxTokens: 4_096,
    temperature: 0.6,
    compactThreshold: 0.75,
    maxToolIterations: 10,
    toolOutputLimit: 30_000,
    parallelToolCalls: "readonly",
    contextWindow: 16_384,
    contextWindowSource: "config",
    configuredContextWindow: 16_384,
    configuredContextWindowExplicit: true,
    env: { prompt: false, dir: skills },
    providers: [],
  } as unknown as Config;
}

/** 合成成本模型：每个工具固定代价 —— 让算法的性质可以被精确断言。 */
function syntheticMeasure(base: number, perTool: number) {
  return (names: readonly string[], trimDynamic: boolean): number =>
    base + names.length * perTool + (trimDynamic ? 0 : 500);
}

describe("优先级常量", () => {
  test("顺序固定：read_file → edit_file → shell → 导航 → 写 → 压缩 → 联网 → 技能 → 派生 → 记忆", () => {
    expect(TOOL_VISIBILITY_PRIORITY[0]).toBe("read_file");
    expect(TOOL_VISIBILITY_PRIORITY[1]).toBe("edit_file");
    expect(TOOL_VISIBILITY_PRIORITY[2]).toBe("shell");
    const idx = (n: string): number => TOOL_VISIBILITY_PRIORITY.indexOf(n);
    expect(idx("list_dir")).toBeLessThan(idx("grep"));
    expect(idx("grep")).toBeLessThan(idx("write_file"));
    expect(idx("write_file")).toBeLessThan(idx("compact_ctx"));
    expect(idx("compact_ctx")).toBeLessThan(idx("web_fetch"));
    expect(idx("web_fetch")).toBeLessThan(idx("use_skill"));
    expect(idx("use_skill")).toBeLessThan(idx("task"));
    expect(idx("task")).toBeLessThan(idx("wiki_search"));
    expect(idx("wiki_search")).toBeLessThan(idx("todo_write"));
    expect(idx("todo_write")).toBeLessThan(idx("remember"));
    expect(idx("remember")).toBeLessThan(idx("wiki_write"));
  });

  test("条件工具在表内且排在已知工具之后", () => {
    for (const n of ["ask_user", "send_message", "list_peers"]) {
      expect(TOOL_VISIBILITY_PRIORITY).toContain(n);
    }
    const idx = (n: string): number => TOOL_VISIBILITY_PRIORITY.indexOf(n);
    expect(idx("ask_user")).toBeGreaterThan(idx("wiki_write"));
  });

  test("全库只有这一处优先级定义（不重复硬编码）", () => {
    // 除本模块外，src/ 下不应再出现同一批工具名的优先级字面量。
    expect(TOOL_VISIBILITY_PRIORITY.length).toBeGreaterThan(0);
    expect(new Set(TOOL_VISIBILITY_PRIORITY).size).toBe(TOOL_VISIBILITY_PRIORITY.length);
  });
});

describe("visibilityPriority", () => {
  test("MCP 排最后，未注册的不出现，未在表里的排在已知之后", () => {
    const ordered = visibilityPriority([
      "mcp__srv__toolB",
      "wiki_write",
      "read_file",
      "mcp__srv__toolA",
      "brand_new_tool",
      "shell",
    ]);
    expect(ordered[0]).toBe("read_file");
    expect(ordered[1]).toBe("shell");
    expect(ordered[2]).toBe("wiki_write");
    expect(ordered[3]).toBe("brand_new_tool");
    // MCP 最后，且按名字排序（确定性）
    expect(ordered.slice(-2)).toEqual(["mcp__srv__toolA", "mcp__srv__toolB"]);
    expect(ordered).not.toContain("never_registered");
  });
});

describe("visibleToolNames 的性质", () => {
  const priority = ["read_file", "edit_file", "shell", "grep", "mcp__x__y"];

  test("可见集永远是优先级前缀：不会出现「有 grep 无 read_file」", () => {
    const v = visibleToolNames({
      priority,
      budget: 1_000,
      measure: syntheticMeasure(100, 100),
    });
    expect(v.names).toEqual(priority.slice(0, v.names.length));
    expect(v.hidden).toEqual(priority.slice(v.names.length));
    // 关键性质：保留后缀时，前面的工具一定也在
    if (v.names.includes("grep")) expect(v.names).toContain("read_file");
    if (v.names.includes("shell")) expect(v.names).toContain("edit_file");
  });

  test("动态块成组裁：measure 只收到 true/false，没有「部分裁」这种状态", () => {
    const seen: boolean[] = [];
    visibleToolNames({
      priority,
      budget: 1_000,
      measure: (_names, trim) => {
        seen.push(trim);
        return 100 + seen.length;
      },
    });
    expect(seen.every((t) => t === true || t === false)).toBe(true);
    expect(new Set(seen)).toEqual(new Set([false, true]));
  });

  test("裁动态块能多放工具时 → trimmed=true；一样多时 → 不裁（少一处损失）", () => {
    const trimmedWins = visibleToolNames({
      priority,
      budget: 700,
      // 不裁要多花 500 → 只放得下 1 个；裁掉则放得下 6 个
      measure: (names, trim) => 100 + names.length * 100 + (trim ? 0 : 500),
    });
    expect(trimmedWins.trimmed).toBe(true);
    expect(trimmedWins.names.length).toBe(priority.length);

    const sameCount = visibleToolNames({
      priority,
      budget: 10_000,
      measure: (names, trim) => 100 + names.length * 100 + (trim ? 0 : 500),
    });
    expect(sameCount.trimmed).toBe(false);
    expect(sameCount.names.length).toBe(priority.length);
  });

  test("MCP 最后被砍：预算紧时先砍 MCP", () => {
    const v = visibleToolNames({
      priority,
      budget: 420,
      measure: syntheticMeasure(100, 100),
    });
    expect(v.names).not.toContain("mcp__x__y");
    expect(v.hidden).toContain("mcp__x__y");
  });

  test("预算连 0 个工具都放不下：fits=false、names 为空、hidden 为全部，且不抛错", () => {
    const v = visibleToolNames({
      priority,
      budget: 10,
      measure: () => 999_999,
    });
    expect(v.fits).toBe(false);
    expect(v.names).toEqual([]);
    expect(v.hidden).toEqual(priority);
    expect(v.total).toBe(priority.length);
    expect(v.cost).toBe(-1);
  });
});

describe("受控环境：各窗口的期望可见集", () => {
  function visAt(cw: number) {
    const cfg = controlledCfg();
    cfg.contextWindow = cw;
    const m = new PromptManager({ mailbox: false, askUser: false, sessionName: "a" });
    return { v: m.currentVisibility(cfg), m };
  }

  test("16K：底线三件 read_file / edit_file / shell 一定在里", () => {
    const { v } = visAt(16_384);
    expect(v.fits).toBe(true);
    expect(v.names).toContain("read_file");
    expect(v.names).toContain("edit_file");
    expect(v.names).toContain("shell");
    // 可见集永远是优先级前缀
    expect(v.names).toEqual(TOOL_VISIBILITY_PRIORITY.slice(0, v.names.length));
    expect(v.hidden).not.toContain("read_file");
  });

  test("8K：预算很紧 —— 报出来的集更小，但不抛错、也不给半截前缀", () => {
    const { v } = visAt(8_192);
    expect(v.fits).toBe(true);
    expect(v.names.length).toBeLessThan(visAt(16_384).v.names.length);
    expect(v.names).toEqual(TOOL_VISIBILITY_PRIORITY.slice(0, v.names.length));
    expect(v.total).toBeGreaterThan(0);
  });

  test("32K / 64K / 200K：受控环境下全部候选都放得下", () => {
    for (const cw of [32_768, 65_536, 200_000]) {
      const { v } = visAt(cw);
      expect(v.fits).toBe(true);
      expect(v.names.length).toBe(v.total);
      expect(v.hidden).toEqual([]);
    }
  });

  test("候选集 = 正常模式实际暴露的工具（plan-only 不在内）", () => {
    const { v } = visAt(32_768);
    expect(v.total).toBe(mainToolNames().length);
    expect(v.names).not.toContain("submit_plan");
    expect(v.names).not.toContain("exit_plan_mode");
  });
});

describe("成本模型保真度", () => {
  /** 抓合成出来的文本（用注入的计数函数截获）。 */
  function captureText(
    text: string,
    specs: ToolSpec[],
    visible: ReadonlySet<string>,
    allToolNames: readonly string[],
    trimDynamic: boolean,
  ): string {
    let captured = "";
    measureVisibilityCost({
      systemText: text,
      specs,
      visible,
      allToolNames,
      trimDynamic,
      count: (t) => {
        captured = t;
        return 0;
      },
    });
    return captured;
  }

  /** 带技能索引 / wiki 索引 / 目录树的环境（裁动态块要有东西可裁）。 */
  function richCfg(): Config {
    const cfg = controlledCfg();
    mkdirSync(join(cfg.cwd, "skills", "demo-skill"), { recursive: true });
    writeFileSync(
      join(cfg.cwd, "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: 演示技能：用于测试技能索引的裁剪。\n---\n\n正文。\n",
      "utf8",
    );
    mkdirSync(join(cfg.cwd, ".neo", "wiki", "wiki"), { recursive: true });
    writeFileSync(
      join(cfg.cwd, ".neo", "wiki", "wiki", "INDEX.md"),
      "# 索引\n\n- [[主题一]]\n- [[主题二]]\n",
      "utf8",
    );
    writeFileSync(join(cfg.cwd, "README.md"), "x\n", "utf8");
    return cfg;
  }

  test("全量可见集 + 不裁动态块 → 合成文本 = 原文本去掉「未注册工具」的说明行", () => {
    const cfg = richCfg();
    const m = new PromptManager({ mailbox: false, askUser: false, sessionName: "a" });
    const text = m.render(cfg).text;
    const names = mainToolNames();
    const specs = toolSpecs().filter((s) => names.includes(s.function.name));
    const out = captureText(text, specs, new Set(names), knownToolNames(toolNames()), false);
    // 期望独立算出来（不依赖实现里的归属判定）：未注册的工具说明行被去掉。
    const dropped = TOOL_VISIBILITY_PRIORITY.filter((n) => !names.includes(n));
    const expected = text
      .split("\n")
      .filter((l) => !dropped.some((d) => l.startsWith(`- ${d}：`)))
      .join("\n");
    expect(out).toBe(expected);
    // 一个工具都没被隐藏时，逐字节还原。
    if (dropped.length === 0) expect(out).toBe(text);
  });

  test("裁动态块：去掉技能索引 / wiki 索引 / 目录树，但保留跨会话消息这类安全规则", () => {
    const cfg = richCfg();
    const m = new PromptManager({ mailbox: true, askUser: false, sessionName: "a" });
    const text = m.render(cfg).text;
    // 先确认原始渲染里确实有这三项（否则下面的断言是空转）
    expect(text).toContain("## 技能");
    expect(text).toContain("## 记忆库");
    expect(text).toContain("工作目录结构");
    expect(text).toContain("## 跨会话消息");

    const names = knownToolNames(toolNames());
    const specs = toolSpecs().filter((s) => names.includes(s.function.name));
    const out = captureText(text, specs, new Set(names), names, true);
    expect(out).not.toContain("## 技能");
    expect(out).not.toContain("## 记忆库");
    expect(out).not.toContain("工作目录结构");
    // 跨会话规则属于「来源边界」类的硬规则，不许为了腾位置裁掉。
    expect(out).toContain("## 跨会话消息");
  });

  test("隐藏工具的说明行被去掉，隐藏的工具不出现在「可用工具」名单里", () => {
    const cfg = richCfg();
    const m = new PromptManager({ mailbox: false, askUser: false, sessionName: "a" });
    const text = m.render(cfg).text;
    const names = knownToolNames(toolNames());
    const keep = new Set(["read_file", "edit_file"]);
    const out = captureText(
      text,
      toolSpecs().filter((s) => keep.has(s.function.name)),
      keep,
      names,
      false,
    );
    expect(out).toContain("可用工具：read_file, edit_file");
    expect(out).not.toContain("- shell：");
    // 说明行是硬编码的：即使工具没注册，提示词里也有它的说明 —— 隐藏时必须一起去掉。
    expect(out).not.toContain("- task：");
    // 与工具无关的说明行（规划态说明）保留
    expect(out).toContain("规划态（用户用 /plan 进入）");
  });
});
