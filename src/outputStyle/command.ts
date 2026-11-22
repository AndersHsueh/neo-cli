/**
 * `/output-style` 命令实现（issue #73）。
 *
 * 只改本会话，不写任何配置文件。TTY 用与 /tier、/mode 同款选择器；
 * 非 TTY 列出并标记当前项。切换后 invalidate + refreshSystemPrompt，
 * 从下一轮用户消息生效（在途轮次由 Agent.refreshSystemPrompt 自行跳过）。
 */
import type { CommandContext } from "../cli/commandContext.ts";
import { select } from "../ui/select.ts";
import { c } from "../ui/theme.ts";
import { applyOutputStyle } from "./apply.ts";
import { defaultStyleHome, discoverOutputStyles } from "./discover.ts";
import {
  buildOutputStyleOptions,
  keepCodingInstructionsNotice,
  persistOutputStyleHint,
} from "./render.ts";
import type { OutputStyle } from "./types.ts";

function currentStyleName(ctx: CommandContext): string {
  return ctx.cfg.outputStyle ?? "Default";
}

function confirmSwitch(style: OutputStyle, ctx: CommandContext): void {
  const { ui, cfg, agent, promptManager } = ctx;
  promptManager?.invalidate();
  agent.refreshSystemPrompt();
  if (style.name === "Default") {
    ui.success("输出风格 → Default（不加 style 段）");
  } else {
    ui.success(`输出风格 → ${style.name}`);
  }
  const notice = keepCodingInstructionsNotice(style);
  if (notice) ui.info(notice);
  ui.line(c.dim(persistOutputStyleHint(cfg.settingsPath)));
  ctx.onStatusLineRefresh?.();
}

export async function handleOutputStyleCommand(arg: string, ctx: CommandContext): Promise<boolean> {
  const { ui, cfg, selectDeps } = ctx;
  const home = defaultStyleHome();
  const found = discoverOutputStyles({ cwd: cfg.cwd, home });
  for (const d of found.diagnostics) ui.warn(d);

  let query = arg.trim();
  if (query === "") {
    const current = currentStyleName(ctx);
    const options = buildOutputStyleOptions(found.styles, current);
    if (!process.stdin.isTTY) {
      ui.blank();
      ui.kv("当前输出风格", c.accent(current));
      ui.blank();
      for (const o of options) {
        const on = o.label === current;
        ui.line(
          `${on ? c.accent("●") : c.dim("○")} ${on ? c.bright(o.label) : c.muted(o.label)} ` +
            `${c.dim(o.hint)}`,
        );
      }
      ui.line(c.dim("  用 /output-style <name> 切换"));
      ui.blank();
      return true;
    }
    ui.stopSpinner();
    ui.blank();
    const initial = Math.max(0, found.styles.findIndex((s) => s.name === current));
    const picked = await select("切换到哪个输出风格？", options, { ...selectDeps, initial });
    if (!picked) {
      ui.info("已取消。");
      return true;
    }
    query = picked;
  }

  const result = applyOutputStyle(cfg, query, { home });
  if (!result.ok) {
    ui.warn(result.error);
    return false;
  }
  ctx.meta.outputStyle = cfg.outputStyle;
  confirmSwitch(result.style, ctx);
  return true;
}
