/**
 * 会话、上下文与模型档位命令
 */
import {
  CLASSIFIER_NAMES,
  isClassifierName,
} from "../classifier/index.ts";
import {
  describeRoute,
  isImplemented,
  maskKey,
  MODEL_TIERS,
  normalizeTierName,
  switchProvider,
  applyTier,
  tierChoiceLabel,
  tierDisplayName,
} from "../config.ts";
import {
  currentModelCapabilityView,
  formatCapabilityGapHint,
  refreshCapabilitiesAfterModelSwitch,
  resolveAndApplyModelWindow,
} from "../env/modelWindows.ts";
import { rulesReport } from "../rules/index.ts";
import { repoMapSummary } from "../prompt/repoMap.ts";
import { listModels } from "../llm.ts";
import type { PromptSelection } from "../prompt/select.ts";
import type { ToolVisibility } from "../prompt/visibility.ts";
import { select } from "../ui/select.ts";
import { c } from "../ui/theme.ts";
import { helpText } from "./help.ts";

import type { CommandContext } from "./commandContext.ts";

/** /auto 列表里各实现的说明。 */
const DESC: Record<string, string> = {
  off: "关闭自动分类，始终用手动选的档位",
  rule: "规则分类器，零延迟零成本（默认）",
  llm: "用 classifier_model_name 判定，多一次调用",
};


export async function handleSessionCommands(cmd: string, arg: string, rest: string[], ctx: CommandContext): Promise<boolean> {
  const {
    agent, ui, cfg, classifier, selectDeps, checkpoints,
    promptSelection, toolVisibility, rules, rewind,
  } = ctx;
  switch (cmd) {
    case "help":
    case "?":
      ui.line(helpText());
      return true;

    case "clear":
      agent.reset();
      ui.success("上下文已清空。");
      return true;

    case "compact": {
      // issue #46：`/compact --from <轮次>` 定点压缩 —— 以用户轮次为锚点，只压该轮往后那段。
      const fromArg = /^--from\s+(\S+)\s*$/.exec(arg.trim());
      if (arg.trim() !== "" && !fromArg) {
        ui.warn("用法：/compact（整体压缩）· /compact --from <轮次|last>（只压该轮往后）");
        return true;
      }
      if (fromArg) {
        const raw = fromArg[1]!;
        const target = raw === "last" ? ("last" as const) : Number(raw);
        if (target !== "last" && (!Number.isInteger(target) || target < 0)) {
          ui.warn(`轮次写法不对："${raw}"（用数字或 last）`);
          return true;
        }
        if (!rewind?.turnStart) {
          ui.warn("当前会话不支持定点压缩（未接线轮次表）。");
          return true;
        }
        const from = rewind.turnStart(target);
        if (from === null) {
          ui.warn(`用户轮次 ${raw} 不存在（先用 /rewind 看可用范围）。`);
          return true;
        }
        ui.line(`定点压缩：从第 ${raw} 轮往后…`);
        const ok = await agent.compact({ from });
        if (ok) ui.success(`压缩完成。上下文使用率 ${(agent.contextUsage() * 100).toFixed(1)}%`);
        else ui.warn("该轮之后的消息太少或压缩失败，未做处理。");
        return true;
      }
      ui.line("压缩上下文中…");
      const ok = await agent.compact();
      if (ok) ui.success(`压缩完成。上下文使用率 ${(agent.contextUsage() * 100).toFixed(1)}%`);
      else ui.warn("对话太短或压缩失败，未做处理。");
      return true;
    }

    case "undo": {
      const n = Math.max(1, Number(arg) || 1);
      if (!checkpoints) {
        ui.warn("当前没有启用写文件检查点。");
        return true;
      }
      const results = checkpoints.undo(n);
      if (results.length === 0) {
        ui.info("没有可撤销的写操作。");
        return true;
      }
      for (const r of results) {
        if (r.restored === "content") {
          ui.line(`${c.accent("↩")} 已还原 ${r.entry.rel}（${r.entry.op}）`);
        } else if (r.restored === "deleted") {
          ui.line(`${c.accent("↩")} 已删除 ${r.entry.rel}（恢复为写前不存在）`);
        } else {
          ui.warn(`未能恢复 ${r.entry.rel}：${r.reason ?? "未知原因"}`);
        }
      }
      return true;
    }

    case "checkpoints": {
      if (!checkpoints) {
        ui.warn("当前没有启用写文件检查点。");
        return true;
      }
      const n = Math.max(1, Number(arg) || 10);
      const list = checkpoints.list(n);
      if (list.length === 0) {
        ui.info("还没有写文件检查点。");
        return true;
      }
      ui.line(c.dim(`最近 ${list.length} 条写文件检查点（${checkpoints.dir}）：`));
      for (const e of list.slice().reverse()) {
        const meta = `${e.op} · ${e.existed ? `${e.size}B` : "新建"} · ${e.at}`;
        ui.line(`  #${e.seq} ${e.rel}  ${c.dim(meta)}${e.note ? `  ${c.warn(e.note)}` : ""}`);
      }
      return true;
    }

    case "context": {
      // A2：一眼看清「配置窗口 vs 估算用量 vs 最近压缩」，用于排查长会话/窗口配错。
      const resolved = resolveAndApplyModelWindow(cfg);
      const usage = agent.contextUsage();
      const est = Math.round(usage * cfg.contextWindow);
      const last = agent.lastCompactionInfo;
      ui.blank();
      ui.kv("model", `${cfg.providerName}/${cfg.model}`);
      ui.kv(
        "window",
        `${cfg.contextWindow.toLocaleString()} tokens ${c.dim(`(${cfg.contextWindowSource ?? resolved.source})`)}`,
      );
      // P2：当前模型的五项能力（context / max_output / vision / tools / reasoning）。
      // 未填与 unknown 一律「未知」；手写 settings 优先，env 探测补空缺。
      const caps = currentModelCapabilityView(cfg);
      ui.kv("context", caps.contextWindow);
      // 请求预算 ≠ 能力上限。两行都打出来，避免把 max_tokens 当成模型硬顶。
      ui.kv("max_tokens", `${cfg.maxTokens.toLocaleString()} ${c.dim("(请求预算)")}`);
      ui.kv("max_output_tokens", `${caps.maxOutputTokens} ${c.dim("(能力上限)")}`);
      ui.kv("vision", caps.vision);
      ui.kv("tools", caps.tools);
      ui.kv("reasoning", caps.reasoning);
      const gap = formatCapabilityGapHint(cfg);
      if (gap) ui.info(gap);
      // issue #20：系统提示词选了哪一档、为什么。只展示数字与原因，不打印提示词或记忆原文。
      // 取档要读目录树/技能/wiki 索引，可能抛错（cwd 权限、技能目录竞态）：
      // 失败就省略这一行，不让整条命令崩 —— 诊断是增强项，不是命令的依赖项。
      let psel: PromptSelection | null = null;
      try {
        psel = promptSelection?.() ?? null;
      } catch {
        psel = null;
      }
      if (psel) {
        ui.kv(
          "prompt",
          `${psel.tier} ${c.dim(`(${psel.fits ? "预算内" : "超预算"} · ${psel.estimatedSystemTokens ?? "?"}/${psel.budget} tokens 估计)`)}`,
        );
        ui.line(c.dim(`  ${psel.reason}`));
      }
      // issue #20 收尾：小窗口下的工具可见集方案（**dry-run：只算不生效**）。
      // 算档要读目录树/技能/wiki 索引并按候选集反复计数，可能抛错 —— 失败就省略这两行。
      let vis: ToolVisibility | null = null;
      try {
        vis = toolVisibility?.() ?? null;
      } catch {
        vis = null;
      }
      if (vis) {
        ui.kv(
          "可见工具",
          vis.fits
            ? `${vis.names.length}/${vis.total} 个 ${c.dim(`(预算内 · ${vis.cost}/${vis.budget} tokens 估计，dry-run 未启用)`)}`
            : `预算内放不下 ${c.dim("(dry-run 未启用)")}`,
        );
        ui.line(
          c.dim(
            vis.fits
              ? `  按当前预算最多可暴露 ${vis.names.length} 个工具${vis.trimmed ? "（需同时裁技能/wiki/目录树索引）" : ""}；` +
                  `收窄尚未启用，当前仍暴露全部 ${vis.total} 个。`
              : `  当前预算连 0 个工具都容不下；收窄尚未启用，当前仍暴露全部 ${vis.total} 个工具。`,
          ),
        );
      }
      // issue #15：仓库地图状态（命中缓存，不重复扫描）。
      try {
        ui.kv("repo map", repoMapSummary(cfg));
      } catch {
        /* 诊断是增强项 */
      }
      // issue #17：路径作用域规则 —— 每会话几条、本轮命中了哪几条、为什么。
      // 规则发现/匹配都可能抛错（cwd 权限、并发删除），失败就省略，不让 /context 崩。
      if (rules) {
        try {
          const r = rules();
          const report = rulesReport(r.alwaysOn, r.loaded, r.total);
          ui.kv("规则", report[0] ?? "");
          for (const line of report.slice(1)) ui.line(c.dim(line));
        } catch {
          /* 诊断是增强项 */
        }
      }
      ui.kv("threshold", `${(cfg.compactThreshold * 100).toFixed(0)}% · ${Math.round(
        cfg.compactThreshold * cfg.contextWindow,
      ).toLocaleString()} tokens`);
      ui.kv("estimate", `${est.toLocaleString()} tokens ${c.dim(`(${(usage * 100).toFixed(1)}%)`)}`);
      ui.kv("messages", String(agent.messages.length));
      if (last) {
        ui.kv(
          "last compact",
          `${last.beforeTokens.toLocaleString()} → ${last.afterTokens.toLocaleString()} tokens`,
        );
      } else {
        ui.kv("last compact", c.dim("无"));
      }
      ui.line(c.dim("  window 来源：config=settings；models_api=网关元数据；overflow_error=服务端错误校正"));
      ui.blank();
      return true;
    }

    case "cost": {
      const cum = agent.cumulative;
      ui.blank();
      ui.kv("provider", `${c.accent(cfg.providerName)} ${c.dim(`(${cfg.providerType})`)}`);
      ui.kv("tier", c.muted(tierDisplayName(cfg.modelTier)));
      ui.kv("model", c.accent(cfg.model));
      ui.kv("endpoint", c.muted(cfg.baseUrl));
      ui.kv("api key", c.muted(maskKey(cfg.apiKey)));
      ui.kv("max_tokens", `${cfg.maxTokens.toLocaleString()} ${c.dim("(请求预算)")}`);
      ui.kv("temperature", String(cfg.temperature));
      ui.kv("prompt", `${cum.prompt} tokens`);
      ui.kv("completion", `${cum.completion} tokens`);
      ui.kv("thinking", `${cum.reasoning} tokens`);
      ui.kv("context", `${(agent.contextUsage() * 100).toFixed(1)}% of ${cfg.contextWindow}`);
      ui.kv("messages", String(agent.messages.length));
      const buckets = agent.usageByModel();
      if (buckets.length > 1) {
        ui.blank();
        ui.line(c.dim("按实际响应模型分桶（#59）："));
        for (const b of buckets) {
          ui.line(
            `  ${c.accent(b.provider)}/${b.model}: ${b.prompt} prompt / ${b.completion} completion / ${b.reasoning} thinking`,
          );
        }
      }
      ui.blank();
      return true;
    }

    case "provider": {
      if (!arg) {
        ui.blank();
        ui.kv("当前", `${c.accent(cfg.providerName)} ${c.dim(`(${cfg.providerType})`)}`);
        ui.blank();
        // TTY：选择器接入（与 /model 同款）。含全部 provider——未接入的标注在 hint，
        // 选中后由 switchProvider 给出与显式 /provider <name> 相同的错误，不另设禁用态
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const options = cfg.providers.map((x) => ({
            label: x.name,
            hint:
              x.name === cfg.providerName
                ? `当前 · ${x.type}`
                : isImplemented(x.type)
                  ? x.type
                  : `${x.type} · 未接入`,
            value: x.name,
          }));
          const picked = await select("切换到哪个 provider？", options, {
            ...selectDeps,
            initial: Math.max(0, cfg.providers.findIndex((x) => x.name === cfg.providerName)),
          });
          if (!picked) {
            ui.info("已取消。");
            return true;
          }
          const r = switchProvider(cfg, picked);
          if (!r.ok) {
            ui.warn(r.error);
            return true;
          }
          agent.noteModelChange(cfg);
          refreshCapabilitiesAfterModelSwitch(cfg);
          ui.success(`provider → ${cfg.providerName}（${cfg.providerType}）`);
          ui.kv("model", `${cfg.model} ${c.dim(`[${tierDisplayName(cfg.modelTier)}]`)}`);
          ui.kv("endpoint", cfg.baseUrl);
          return true;
        }
        // 非 TTY：维持纯列表（C8）
        for (const x of cfg.providers) {
          const on = x.name === cfg.providerName;
          const usable = isImplemented(x.type);
          const tag = usable ? "" : c.warn(" [未接入]");
          ui.line(
            `${on ? c.accent("●") : c.dim("○")} ${on ? c.bright(x.name) : c.muted(x.name)} ` +
              `${c.dim((x.apiTypes ?? [x.type]).join("+"))} ${c.dim("→")} ${c.muted(x.baseUrl)}${tag}`,
          );
          if (on) {
            for (const tier of MODEL_TIERS) {
              const mark = tier === cfg.modelTier ? c.accent("▸") : " ";
              ui.line(`    ${mark} ${c.dim(tier.padEnd(15))} ${c.muted(x.models[tier])}`);
            }
          }
        }
        ui.line(c.dim("  用 /provider <name> 切换"));
        ui.blank();
        return true;
      }
      const r = switchProvider(cfg, arg);
      if (!r.ok) {
        ui.warn(r.error);
        return true;
      }
      agent.noteModelChange(cfg);
      refreshCapabilitiesAfterModelSwitch(cfg);
      ui.success(`provider → ${cfg.providerName}（${cfg.providerType}）`);
      ui.kv("model", `${cfg.model} ${c.dim(`[${tierDisplayName(cfg.modelTier)}]`)}`);
      ui.kv("endpoint", cfg.baseUrl);
      return true;
    }

    case "tier":
    // 档位快捷方式。存在的理由：规则分类器的 override 规则（/deep、/fast…）
    // 匹配的是用户输入，若没有对应分支，输入会在到达分类器之前
    // 就被 handleCommand 当成未知命令吃掉 —— 规则永远等不到它的输入。
    case "fast":
    case "balanced":
    case "deep":
    case "deep_reasoning":
    case "default": {
      // /deep 等价于 /tier deep_reasoning；带参数时（如 `/deep 分析这段代码`）
      // 前半段是档位指令，其余作为普通输入继续走 agent。
      // /tier 的档位名来自**参数**（rest[0]），不是命令名 —— 旧代码永远取 cmd，
      // 导致 `/tier default` 被解析成档位 "tier"，任何参数都报「未知档位」。
      // 快捷命令（/fast /balanced /deep…）没有参数概念，档位名就是命令名本身。
      const rawTarget = cmd === "tier" ? (rest[0] ?? "") : cmd;
      // 人类输入接受简写（deep/bal/fast/auto），内部仍落到规范 ModelTier。
      const target = normalizeTierName(rawTarget);
      // /tier 不带参数时是查询操作：列出全部档位的生效路由。
      // 用 target === "" 判断而非 rest.length === 0："/tier "（尾随空格）
      // split 后 rest = [""]，length 为 1，但语义上仍是查询。
      if (cmd === "tier" && rawTarget === "") {
        ui.blank();
        ui.kv("当前档位", c.accent(tierChoiceLabel(cfg.modelTier)));
        ui.kv("生效路由", `${c.accent(describeRoute(cfg, cfg.modelTier))}`);
        ui.blank();
        // TTY：选择器接入（与 /model 同款）；hint = 该档位生效路由，initial 定位当前档位
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const options = MODEL_TIERS.map((t) => ({
            label: tierDisplayName(t),
            hint: t === cfg.modelTier ? `当前 · ${describeRoute(cfg, t)}` : describeRoute(cfg, t),
            value: t,
          }));
          const picked = await select("切换到哪个档位？", options, {
            ...selectDeps,
            initial: Math.max(0, MODEL_TIERS.indexOf(cfg.modelTier)),
          });
          if (picked) {
            const r = applyTier(cfg, picked);
            if (r.ok) {
              agent.noteModelChange(cfg);
              refreshCapabilitiesAfterModelSwitch(cfg);
              if (r.degraded && r.note) ui.warn(r.note);
              ui.success(
                `档位 → ${tierChoiceLabel(cfg.modelTier)}（${cfg.providerName} / ${cfg.model}）`,
              );
            } else {
              ui.warn(r.error);
            }
          } else {
            ui.info("已取消。");
          }
          return true;
        }
        // 非 TTY：维持纯列表（C8）
        for (const tier of MODEL_TIERS) {
          const on = tier === cfg.modelTier;
          const label = tierChoiceLabel(tier);
          ui.line(
            `${on ? c.accent("●") : c.dim("○")} ${on ? c.bright(label.padEnd(20)) : c.muted(label.padEnd(20))} ` +
              `${c.dim("→")} ${c.muted(describeRoute(cfg, tier))}`,
          );
        }
        ui.line(c.dim("  用 /tier <name> 切换"));
        ui.blank();
        return true;
      }
      if (!target) {
        ui.warn(
          `未知档位 "${rawTarget}"。可选：${MODEL_TIERS.join(", ")}` +
            `（简写 deep / d / bal / b / f / auto）`,
        );
        return true;
      }
      const r = applyTier(cfg, target);
      if (!r.ok) {
        ui.warn(r.error);
        return true;
      }
      agent.noteModelChange(cfg);
      refreshCapabilitiesAfterModelSwitch(cfg);
      if (r.degraded && r.note) ui.warn(r.note);
      ui.success(
        `档位 → ${tierChoiceLabel(cfg.modelTier)}（${cfg.providerName} / ${cfg.model}）`,
      );
      // 剩余文本当作下一轮用户输入，不丢内容。
      // /tier 的 rest[0] 是档位名，已消费掉；快捷命令的 rest 全是剩余文本。
      const leftover = cmd === "tier" ? rest.slice(1) : rest;
      if (leftover.length > 0) await agent.send(leftover.join(" "));
      return true;
    }

    case "auto": {
      if (!arg) {
        ui.blank();
        ui.kv("自动分类", `${c.accent(classifier.name)}`);
        ui.kv("分类器模型", `${c.muted(cfg.classifierProvider)} / ${c.muted(cfg.classifierModel)}`);
        ui.kv("连续工具失败", String(agent.toolFailureStreak));
        ui.blank();
        for (const n of CLASSIFIER_NAMES) {
          ui.line(
            `${n === classifier.name ? c.accent("●") : c.dim("○")} ` +
              `${n === classifier.name ? c.bright(n) : c.muted(n)} ${c.dim(DESC[n] ?? "")}`,
          );
        }
        ui.line(c.dim("  用 /auto <off|rule|llm> 切换"));
        ui.blank();
        return true;
      }
      if (!isClassifierName(arg)) {
        ui.warn(`未知分类器 "${arg}"。可选：${CLASSIFIER_NAMES.join(", ")}`);
        return true;
      }
      try {
        classifier.use(arg, cfg);
        ui.success(`自动分类 → ${arg}`);
      } catch (e) {
        ui.warn((e as Error).message);
      }
      return true;
    }

    case "why": {
      ui.blank();
      ui.kv("分类器", c.accent(classifier.name));
      const last = classifier.lastResult;
      if (!last) {
        ui.info("还没有产生过判定。发一条消息后用 /why 查看。");
      } else {
        ui.kv("判定档位", c.accent(last.tier));
        ui.kv("来源", c.muted(last.source));
        ui.kv("理由", c.text(last.reason));
      }
      const fail = classifier.lastFailure;
      if (fail) ui.kv("上次失败", c.err(fail));
      ui.kv("当前生效", `${cfg.modelTier} → ${cfg.providerName} / ${cfg.model}`);
      ui.blank();
      return true;
    }

    case "model": {
      if (!arg) {
        ui.blank();
        ui.kv("当前模型", `${c.accent(cfg.model)} ${c.dim(`(${cfg.modelTier})`)}`);
        // D8：先取列表——失败维持现有错误输出，不进选择器
        let models: string[] | null = null;
        try {
          models = await listModels(cfg);
        } catch (e) {
          ui.error(`获取模型列表失败: ${(e as Error).message}`);
        }
        if (models && models.length > 0 && process.stdin.isTTY) {
          // TTY：可选。当前模型 hint「当前」+ initial 定位（D8）
          ui.stopSpinner(); // C1：进入前收尾 spinner
          ui.blank();
          const options = models.map((m) => ({
            label: m,
            hint: m === cfg.model ? "当前" : undefined,
            value: m,
          }));
          const picked = await select("切换到哪个模型？", options, {
            ...selectDeps,
            initial: Math.max(0, models.indexOf(cfg.model)),
          });
          if (picked) {
            // 与显式 /model <id> 同一收尾（F2 缺口补齐）
            cfg.model = picked;
            agent.noteModelChange(cfg);
            refreshCapabilitiesAfterModelSwitch(cfg);
            ui.success(`模型已切到 ${picked}（本次会话内生效，已绕过档位）。`);
          } else {
            ui.info("已取消。");
          }
        } else if (models) {
          // 非 TTY / 空列表：维持现有纯列表展示（C8）
          ui.line(c.dim("  用 /model <id> 直接指定模型，或 /tier <档位> 切换档位"));
          ui.line(c.dim("  服务端可用模型："));
          for (const m of models) {
            ui.line(m === cfg.model ? `  ${c.accent("●")} ${c.bright(m)}` : `  ${c.dim("○")} ${c.muted(m)}`);
          }
        }
        ui.blank();
        return true;
      }
      cfg.model = arg;
      agent.noteModelChange(cfg);
      refreshCapabilitiesAfterModelSwitch(cfg);
      ui.success(`模型已切到 ${arg}（本次会话内生效，已绕过档位）。`);
      return true;
    }

    default:
      return false;
  }
}
