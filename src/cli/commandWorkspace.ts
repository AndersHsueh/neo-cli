/**
 * 工作区、技能、记忆与会话落盘命令
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { PermissionMode } from "../agent.ts";
import { renderPlan } from "../agent.ts";
import { contentText } from "../llm.ts";
import { initProjectLevel as initProjectLevelImpl } from "../memory/init.ts";
import { readProfile, sessionLiveness, renameSession, takenAliveNames } from "../mailbox/identity.ts";
import { mailboxRoot } from "../mailbox/types.ts";
import { chooseSessionName } from "../sessionName.ts";
import {
  buildReviewPrompt,
  collectReviewDiff,
  REVIEW_DIFF_LIMIT,
  summarizePatch,
} from "../review.ts";
import {
  detectRepo,
  listManaged,
  removeWorktree,
  WORKTREE_BRANCH_PREFIX,
  worktreeBranch,
  worktreeRoot,
} from "../worktree.ts";
import {
  applyRestored,
  listSessions,
  loadSession,
} from "../session.ts";
import { renderSessionMarkdown } from "../sessionExport.ts";
import {
  discoverSkills,
  formatSkillLine,
  isValidSkillName,
  normalizeDescription,
} from "../skills.ts";
import { runSubagent } from "../tools/task.ts";
import { select } from "../ui/select.ts";
import { formatToolCall } from "../ui/toolLog.ts";
import { c, truncate } from "../ui/theme.ts";
import { buildMemoryFile } from "../system-prompt.ts";
import {
  buildIngestPrompt,
  finishIngest,
  loadIngestTemplate,
  planIngest,
} from "../wiki/ingest.ts";
import { formatLintReport, lintWiki, resolveWikiDir } from "../wiki/lint.ts";
import { resolveWikiLayout } from "../wiki/paths.ts";
import { appendLog } from "../wiki/write.ts";
import { printSessions, replayTranscript } from "./sessions.ts";

import type { CommandContext } from "./commandContext.ts";

export async function handleWorkspaceCommands(cmd: string, arg: string, rest: string[], ctx: CommandContext): Promise<boolean> {
  const {
    agent, ui, cfg, memory, meta, shutdown, selectDeps, mailbox,
    onMailboxRekey, onNameChange,
  } = ctx;
  switch (cmd) {
    case "skills": {
      const skills = discoverSkills(cfg);
      if (arg) {
        // 约束 16：这是给**人**看的只读诊断入口 —— 不加载全文，也不建软链。
        // 软链只由 use_skill 创建（那是模型行为，且会在输出里告知）。
        // 所以这里只从已发现的索引里查，不能走 resolveSkill —— 它会建软链，
        // 让一条纯查看命令悄悄改动了用户的项目目录。
        //
        // 但名称白名单仍要先过：arg 来自用户输入，`../etc` 这类必须报「非法」而非
        // 混入下面的 find() 变成一句语义错误的「不存在」—— 否则路径穿越的形态被掩盖了。
        if (!isValidSkillName(arg)) {
          ui.error(`技能名非法: ${arg}`);
          if (skills.length > 0) ui.info(`可用技能：${skills.map((s) => s.name).join(", ")}`);
          return true;
        }
        const hit = skills.find((s) => s.name === arg);
        if (!hit) {
          ui.error(`技能不存在: ${arg}`);
          if (skills.length > 0) ui.info(`可用技能：${skills.map((s) => s.name).join(", ")}`);
          return true;
        }
        ui.blank();
        ui.kv("名称", hit.name);
        // 用与索引/list 完全相同的规范化函数，保证三处 description 逐字一致
        ui.kv("说明", normalizeDescription(hit.description, hit.name));
        ui.kv("来源", hit.source === "project" ? "项目" : "全局");
        ui.kv("路径", hit.absPath);
        let first = "";
        try {
          first = (readFileSync(join(hit.absPath, "SKILL.md"), "utf8").split("\n") ?? [])
            .find((l) => l.trim().startsWith("# "))
            ?.trim() ?? "";
        } catch {
          /* ignore */
        }
        if (first) ui.kv("标题", first);
        ui.blank();
        // 约束 16：这里仍不打印正文。正文的两条入口都写明 —— 人直接 /名称，模型 use_skill。
        ui.info(`完整正文：直接输入 /${hit.name} [参数] 调用，或让模型 use_skill 加载。`);
        return true;
      }

      ui.blank();
      if (skills.length === 0) {
        ui.info(`没有可用技能。把技能目录放到 ${join(cfg.cwd, "skills")} 或全局技能库。`);
        ui.blank();
        return true;
      }
      ui.kv("可用技能", String(skills.length));
      for (const s of skills) {
        const dot = c.tool("●");
        // 形态与 system prompt 索引一致（formatSkillLine 保证 description 截断口径统一），
        // 但**保留来源与软链标注** —— 它们是 name/description 之外的信息，
        // 去掉会让用户看不出某技能是项目私有还是全局、是否为软链产物。
        // 统一的是「技能行里name:description 的写法」，不是「只能有这两项」。
        const origin = `${s.source === "project" ? "项目" : "全局"}${s.linked ? " · 软链" : ""}`;
        ui.line(`  ${dot} ${formatSkillLine(s.name, s.description)}${origin ? `　[${origin}]` : ""}`);
      }
      ui.blank();
      ui.info("直接输入 /名称 [参数] 调用技能，或让模型按需 use_skill；/skills <名称> 看详情。");
      ui.blank();
      return true;
    }

    case "wiki-lint": {
      const dir = resolveWikiDir(cfg.cwd);
      if (!dir) {
        ui.warn(
          `未找到 wiki 目录（${join(cfg.cwd, ".neo", "wiki", "wiki")} 或 ${join(cfg.cwd, "wiki")}）。` +
            `先跑 /init 创建骨架，或确认目录位置。`,
        );
        return true;
      }
      const result = lintWiki(dir);
      ui.line(formatLintReport(result));
      const s = result.summary;
      const total = s.broken + s.orphans + s.lowlinks + s.nosummary + s.nostamp;
      if (total === 0) ui.success("wiki 体检通过。");
      else {
        ui.warn(
          `共 ${total} 项待处理（断链 ${s.broken} / 孤儿 ${s.orphans} / 密度 ${s.lowlinks}` +
            ` / 摘要 ${s.nosummary} / 日期戳 ${s.nostamp}）`,
        );
      }
      return true;
    }

    case "ingest": {
      // issue #53：后台 wiki 维护在跑时拒绝手动派发（单飞）—— 两路同时写 wiki 会互相覆盖。
      if (ctx.wikiMaintainer?.running) {
        ui.warn("后台 wiki 维护正在运行，等它结束再用 /ingest（/tasks 可查看进度）。");
        return true;
      }
      const layout = resolveWikiLayout(cfg.cwd);
      if (!layout) {
        ui.warn(`未找到 wiki 骨架（${join(cfg.cwd, ".neo", "wiki")}）。先跑 /init。`);
        return true;
      }
      let plan;
      try {
        plan = planIngest(layout, arg);
      } catch (e) {
        ui.warn((e as Error).message);
        return true;
      }
      if (plan.files.length === 0 && plan.removed.length === 0) {
        ui.info(`raw/ 无变更，无需编译。`);
        finishIngest(layout);
        return true;
      }
      if (plan.needsAnnounce) {
        ui.warn(`本次将做全量编译（${plan.reason}），处理 ${plan.files.length} 份 raw。`);
      } else {
        ui.info(`${plan.reason}；新增 ${plan.files.length} 份，删除 ${plan.removed.length} 份。`);
      }

      // 编译交给 fast 档子代理（机械编译活）；派发前主代理切回当前档，互不影响
      const prompt = buildIngestPrompt(layout, plan, loadIngestTemplate());
      ui.startSpinner(`子代理编译中（${plan.mode}）…`);
      let report: string;
      try {
        // issue #53 P1：子代理失败/中止不再被当成成功 —— 不 finishIngest、不登 log。
        report = await runSubagent(
          agent,
          prompt,
          "fast",
          {
            cfg,
            approve: async () => true,
          },
          undefined,
          undefined,
          { failOnError: true },
        );
      } catch (e) {
        ui.stopSpinner();
        ui.error(`ingest 失败：${(e as Error).message}`);
        return true;
      }
      ui.stopSpinner();
      ui.line(report);

      finishIngest(layout);
      const hadChanges = plan.mode === "full" || plan.files.length > 0;
      if (hadChanges) {
        appendLog(layout, "ingest", `${plan.mode} 编译 ${plan.files.length} 份 raw`);
      }
      ui.success(`ingest 完成（${plan.mode}）。`);
      return true;
    }

    case "mode": {
      const modes: Array<[string, string]> = [
        ["1", "ask — 写文件/执行命令都需批准"],
        ["2", "auto-edit — 自动批准写文件，命令仍需批准"],
        ["3", "auto-all — 全部自动批准（慎用）"],
        ["4", "plan — 只读，禁止一切写操作（要先出方案再动手请用 /plan）"],
      ];
      if (!arg) {
        ui.blank();
        ui.kv("当前模式", c.accent(agent.mode));
        if (agent.planning) {
          ui.kv("规划态", c.warn("进行中（生效模式恒为 plan）"));
        }
        // TTY：选择器接入（与 /model 同款）；hint = 模式说明，initial 定位当前模式
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const modeList: Array<{ name: PermissionMode; desc: string }> = [
            { name: "ask", desc: "写文件/执行命令都需批准" },
            { name: "auto-edit", desc: "自动批准写文件，命令仍需批准" },
            { name: "auto-all", desc: "全部自动批准（慎用）" },
            { name: "plan", desc: "只读，禁止一切写操作；要先出方案再动手请用 /plan" },
          ];
          const options = modeList.map((m) => ({
            label: m.name,
            hint: m.name === agent.mode ? `当前 · ${m.desc}` : m.desc,
            value: m.name,
          }));
          const picked = await select("切换到哪个权限模式？", options, {
            ...selectDeps,
            initial: Math.max(0, modeList.findIndex((m) => m.name === agent.mode)),
          });
          if (picked) {
            agent.mode = picked;
            try {
              mailbox?.setMode(picked);
            } catch {
              // 状态同步失败不影响模式切换
            }
            ui.success(`权限模式 → ${picked}`);
          } else {
            ui.info("已取消。");
          }
          return true;
        }
        // 非 TTY：维持编号列表（C8）
        for (const [k, d] of modes) ui.line(`  ${c.accent(k)}) ${d}`);
        ui.line(c.dim("  用 /mode <1-4> 切换"));
        ui.blank();
        return true;
      }
      const map: Record<string, PermissionMode> = {
        "1": "ask", ask: "ask", "2": "auto-edit", "3": "auto-all", "4": "plan", plan: "plan",
      };
      const m = map[arg];
      if (!m) {
        ui.warn(`未知模式 ${arg}`);
        return true;
      }
      agent.mode = m;
      try {
        mailbox?.setMode(m);
      } catch {
        // 状态同步失败不影响模式切换
      }
      ui.success(`权限模式 → ${m}`);
      // 两套概念别混（issue #14）：/mode plan 只是只读闸门，不会进入交互规划工作流。
      if (m === "plan") {
        ui.info("这是只读闸门：禁止一切写操作，没有「确认后放开」这一步。");
        ui.info("要「先澄清 → 出方案 → 用户确认 → 开始实施」，用 /plan。");
      }
      return true;
    }

    case "plan": {
      // 交互式规划工作流（issue #14）。与 /mode plan（只读闸门）是两套概念：
      // 这里进入的是会话态，规划期借用只读闸门，用户确认后切回进入前的权限模式。
      const sub = (rest[0] ?? "").toLowerCase();
      const snap = agent.plan;

      if (sub === "" || sub === "start") {
        if (agent.planning) {
          // 重复进入不重置已提交的方案，只把当前状态摆出来。
          ui.info("已在规划态。");
        } else {
          const base = agent.mode;
          agent.enterPlan(base);
          ui.success(`已进入规划态（规划期间生效模式 plan，确认后切回 ${base}）。`);
          ui.info("默认不写盘：先澄清范围/约束/取舍，再产出分步方案。");
        }
        const cur = agent.plan;
        if (cur?.draft) {
          ui.blank();
          ui.line(renderPlan(cur.draft));
          ui.blank();
          ui.line(c.dim("  方案待确认：/plan approve 开始实施 · /plan revise 修改 · /plan cancel 放弃"));
        } else {
          ui.line(c.dim("  直接说需求即可；模型会先澄清再提交方案，确认用 /plan approve。"));
        }
        return true;
      }

      if (sub === "approve" || sub === "go") {
        if (!agent.planning) {
          ui.warn("当前不在规划态。用 /plan 进入。");
          return true;
        }
        if (!snap?.draft) {
          ui.warn("还没有已提交的方案。先让模型提交方案（submit_plan），或 /plan cancel 放弃规划。");
          return true;
        }
        const done = agent.approvePlan();
        const base = done?.baseMode ?? agent.mode;
        ui.success(`方案已确认，开始实施（权限模式 → ${base}，写盘/执行已恢复）。`);
        ui.info("已确认的方案已钉进上下文，模型按它动手。");
        return true;
      }

      if (sub === "revise") {
        if (!agent.planning) {
          ui.warn("当前不在规划态。用 /plan 进入。");
          return true;
        }
        agent.revisePlan();
        ui.success("已回到澄清态：告诉模型要改哪几步，它会提交修订版方案。");
        if (snap?.draft) {
          ui.blank();
          ui.line(renderPlan(snap.draft));
          ui.blank();
          ui.line(c.dim("  上一版方案保留在上下文里，供模型参考。"));
        }
        return true;
      }

      if (sub === "cancel") {
        if (!agent.planning) {
          ui.warn("当前不在规划态。");
          return true;
        }
        const base = snap?.baseMode ?? agent.mode;
        agent.cancelPlan();
        ui.success(`已退出规划态（权限模式 → ${base}），未确认的方案不生效。`);
        return true;
      }

      // /plan 带其它参数：当作「进入规划态 + 这条需求」一起发出去。
      // 用户不用先 /plan 再打一遍需求，两步合成一步。
      if (!agent.planning) {
        const base = agent.mode;
        agent.enterPlan(base);
        ui.success(`已进入规划态（确认后切回 ${base}）。`);
      }
      await agent.send(arg);
      return true;
    }

    case "review": {
      // 一等公民代码审查（issue #12）。与 /plan 的分工：
      // /plan 是「先出方案再动手」的会话态；/review 是「对着已有 diff 只读挑毛病」。
      // 采集在 CLI 侧用 git 完成 —— 「工作区干净」必须是确定性结论，不能交给模型判断。
      const collected = collectReviewDiff(cfg.cwd, arg);
      if (!collected.ok) {
        ui.warn(collected.message);
        return true;
      }
      if (!collected.hasChanges) {
        // 干净：只打结论，不发请求。省一次模型调用，也不会让模型凭空编出 findings。
        ui.success(
          arg ? `相对 ${arg} 无差异，工作区干净。` : "工作区干净（相对 HEAD 无差异，也没有未跟踪文件）。",
        );
        return true;
      }

      const stat = summarizePatch(collected.patch);
      ui.line(
        `${c.accent("◆")} 审查范围：${c.bright(collected.label)}` +
          ` ${c.dim(
            `· ${stat.files} 个文件 +${stat.added} −${stat.removed}` +
              (collected.untracked.length > 0 ? ` · ${collected.untracked.length} 个未跟踪文件` : ""),
          )}`,
      );
      if (collected.truncated) {
        ui.warn(
          `diff 过大（${collected.patchLength} 字符），已截断到 ${REVIEW_DIFF_LIMIT} 字符；未覆盖部分不会被审查。`,
        );
      }

      // 本轮禁写：临时借用只读闸门（decidePermission 的 plan 分支拒绝一切写操作），
      // 结束后在 finally 里恢复原模式。刻意不走 enterPlan —— 那会把会话拖进
      // #14 的交互规划态，状态栏变成「planning · 规划中」，用户只是想看个审查。
      const prevMode = agent.mode;
      agent.mode = "plan";
      try {
        await agent.send(buildReviewPrompt(collected));
      } finally {
        agent.mode = prevMode;
      }
      return true;
    }

    case "worktree": {
      // issue #9：托管 worktree 的查看与清理。创建走命令行 `--worktree <name>`，
      // 因为「会话 cwd」必须在启动时就定好 —— 中途切 cwd 会让记忆/检查点/工具沙箱
      // 一半指着旧目录。
      const [subRaw, ...subRest] = arg.split(/\s+/).filter(Boolean);
      const sub = (subRaw ?? "list").toLowerCase();
      const repo = detectRepo(cfg.cwd);
      if (!repo.ok) {
        ui.warn(repo.message);
        return true;
      }
      if (sub === "list" || sub === "ls") {
        const items = listManaged(repo.mainRoot, {}, cfg.cwd);
        ui.blank();
        if (items.length === 0) {
          ui.info(`没有 neo 托管的 worktree（目录 ${worktreeRoot(repo.mainRoot)}）。`);
          ui.line(c.dim("  新建：neo --worktree <name>（整会话在隔离检出里跑）"));
          return true;
        }
        ui.line(
          c.dim(`neo 托管的 worktree（${worktreeRoot(repo.mainRoot)}；分支前缀 ${WORKTREE_BRANCH_PREFIX}）`),
        );
        for (const w of items) {
          const marks = [
            w.current ? c.accent("← 当前") : "",
            w.dirty ? c.warn("改动未提交") : c.dim("干净"),
          ]
            .filter(Boolean)
            .join(" ");
          ui.line(`  ${c.bright(w.name)} ${c.dim(w.branch ?? "(detached)")} ${marks}`);
          ui.line(`    ${c.dim(w.path)}`);
        }
        ui.line(
          c.dim(
            "  只列 .neo/worktrees/ 下由 neo 创建的；你自己的其它 worktree 不在此列、也不会被这里删除。",
          ),
        );
        return true;
      }
      if (sub === "remove" || sub === "rm") {
        const name = subRest[0] ?? "";
        const force = subRest.slice(1).includes("--force");
        if (!name) {
          ui.warn("用法：/worktree remove <name> [--force]");
          return true;
        }
        // 关键：先按 force=false 探测，**不**把 --force 直接透传下去。
        // 透传会让脏工作区在第一次调用就删掉，审批那一步被静默跳过 ——
        // 而「丢弃未提交改动」恰恰是最需要人看一眼再点头的动作。
        const probe = removeWorktree(repo.mainRoot, name, { force: false, cwd: cfg.cwd });
        if (probe.ok) {
          ui.success(
            `已删除 worktree ${probe.name}（${probe.path}）${probe.pruned ? "，已 prune" : ""}`,
          );
          ui.line(c.dim(`  分支 ${worktreeBranch(probe.name)} 保留，方便复查或重新挂载。`));
          return true;
        }
        if (!probe.needsForce) {
          // 名字不存在 / 是当前会话 / 不是托管 worktree：都不是 --force 能解决的。
          ui.warn(probe.message);
          return true;
        }
        // 脏工作区。--force 只代表「用户已经表达了丢弃意图」，不代表免审批：
        // 仍要把将被丢弃的改动摆到眼前，点一次头。
        // 措辞分两套：无 --force 时说「拒绝删除 + 怎么强制」；有 --force 时
        // 再说「拒绝删除」就是误导（用户已经要求删了），改成「将丢弃以下改动」。
        if (!force) {
          ui.warn(probe.message);
          ui.line(c.dim(`  确认要丢弃这些改动就再执行一次：/worktree remove ${name} --force`));
          return true;
        }
        ui.warn(`"${name}" 有未提交改动或未跟踪文件，--force 将丢弃它们：`);
        for (const line of probe.message.split("\n")) {
          // 只取改动清单那几行（缩进两格的 status 行），跳过解释性文字。
          if (/^ {2}\S/.test(line)) ui.line(c.dim(line));
        }
        const ok = await ui.confirm(`worktree_remove — 删除 ${name} 并丢弃其未提交改动 / 未跟踪文件`);
        if (!ok) {
          ui.info("已取消，未删除任何东西。");
          return true;
        }
        const forced = removeWorktree(repo.mainRoot, name, { force: true, cwd: cfg.cwd });
        if (forced.ok) {
          ui.success(`已强制删除 worktree ${forced.name}（未提交改动已丢弃）`);
        } else {
          ui.warn(forced.message);
        }
        return true;
      }
      ui.warn(`未知子命令 /worktree ${sub}。可用：list | remove <name> [--force]`);
      return true;
    }

    case "init": {
      const target = join(cfg.cwd, arg || "AGENTS.md");
      if (existsSync(target)) {
        const ok = await ui.confirm(`${target} 已存在，覆盖？`);
        if (!ok) {
          ui.info("已取消。");
          return true;
        }
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buildMemoryFile(cfg), "utf8");
      ui.success(`已生成 ${target}`);
      // PRD §约束 14a / §约束 16 / §约束 17：额外初始化项目级 wiki 骨架 + 写 AGENTS.md 工作流段。
      // 失败按约束 17 不抛 — catch + stderr WARN。
      try {
        await initProjectLevelImpl(cfg, cfg.cwd);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`项目级 wiki 骨架创建失败（${reason}），本次会话不写索引`);
      }
      return true;
    }

    case "memory": {
      // v0.2 记忆激活：完整子命令族（规格 §7.10）。
      const [subRaw, ...subRest] = arg.split(/\s+/).filter(Boolean);
      const sub = (subRaw ?? "").toLowerCase();
      const subArg = subRest.join(" ").trim();
      switch (sub) {
        case "":
        case "status":
          ui.line(memory.status());
          break;
        case "list": {
          const scope = subArg === "user" || subArg === "project" ? subArg : "all";
          ui.line(memory.list(scope));
          break;
        }
        case "recall":
          if (!subArg) {
            ui.warn("用法：/memory recall <关键词>");
            break;
          }
          ui.line(memory.recallForHuman(subArg));
          break;
        case "why":
          ui.line(memory.why());
          break;
        case "flush":
          ui.info("冲刷记忆写队列…");
          await memory.flush(10_000);
          ui.success("记忆写队列已处理。");
          break;
        case "forget": {
          const m = /^(project|user)[/:](.+\.md)$/.exec(subArg);
          if (!m) {
            ui.warn("用法：/memory forget <project|user>/<页面.md>");
            break;
          }
          const ok = await ui.confirm(`确定删除 ${m[1]}/${m[2]}？此操作不可撤销。`);
          if (!ok) {
            ui.info("已取消。");
            break;
          }
          ui.line(memory.forget(m[1] as "project" | "user", m[2] ?? ""));
          break;
        }
        case "migrate":
          ui.line(memory.migrate());
          break;
        case "lint":
          ui.line(memory.lint());
          break;
        case "on":
        case "off":
          cfg.memory.enabled = sub === "on";
          ui.success(`记忆已${sub === "on" ? "开启" : "关闭"}（仅本会话，不改配置文件）`);
          break;
        default:
          ui.warn(
            `未知 /memory 子命令：${subRaw}。可用：status / list [project|user] / recall <q> / why / flush / forget <scope>/<page> / migrate / lint / on|off`,
          );
      }
      return true;
    }

    case "remember": {
      // 显式记忆：/remember <内容> [--user|--project]
      const flag = /\s*--(user|project)\s*$/.exec(arg);
      const body = (flag ? arg.slice(0, flag.index) : arg).trim();
      if (!body) {
        ui.warn("用法：/remember <要记住的内容> [--user|--project]");
        return true;
      }
      const scope = flag?.[1] as "user" | "project" | undefined;
      ui.line(await memory.remember(body, scope));
      await memory.flush(10_000);
      ui.success("记忆已处理。");
      return true;
    }

    case "history": {
      const msgs = agent.messages;
      ui.blank();
      ui.kv("消息总数", String(msgs.length));
      ui.kv("用户消息", String(msgs.filter((m) => m.role === "user").length));
      ui.kv("助手消息", String(msgs.filter((m) => m.role === "assistant").length));
      ui.kv("工具结果", String(msgs.filter((m) => m.role === "tool").length));
      ui.kv("工具调用", String(msgs.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0)));
      ui.blank();
      return true;
    }

    case "save": {
      const target = arg ? resolve(cfg.cwd, arg) : join(cfg.cwd, "neo-session.json");
      writeFileSync(target, JSON.stringify({ meta, messages: agent.messages }, null, 2), "utf8");
      ui.success(`会话已保存到 ${target}`);
      return true;
    }

    case "export": {
      const id = arg.trim();
      const loaded = id ? loadSession(id) : null;
      if (id && !loaded) {
        ui.warn(`会话不存在: ${id}（用 /sessions 查看）`);
        return true;
      }
      const targetMeta = loaded?.meta ?? meta;
      const targetMessages = loaded?.messages ?? agent.messages;
      const dir = join(cfg.cwd, ".neo", "exports");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${targetMeta.id}.md`);
      writeFileSync(file, renderSessionMarkdown(targetMeta, targetMessages), "utf8");
      ui.success(`已导出会话 ${targetMeta.id} → ${file}（${targetMessages.length} 条消息）`);
      return true;
    }

    case "resume": {
      // /resume [id] —— 交互中恢复历史会话（真续接：沿用目标 session-id/文件/信箱身份）。
      // 运行中的会话不列出、也不允许恢复（2026-10-26 裁决）。
      const resumeRoot = mailbox?.root ?? mailboxRoot();
      const isRunning = (id: string): boolean =>
        sessionLiveness(resumeRoot, id, { deadAfterMs: cfg.mailbox.deadAfterMs }) === "running";
      let targetId = arg;
      if (targetId === "last") {
        const available = listSessions(50).find((x) => x.id !== meta.id && !isRunning(x.id));
        if (!available) {
          ui.info("没有可恢复的会话（运行中的会话不列出）。");
          return true;
        }
        targetId = available.id;
      }
      if (!targetId) {
        const list = listSessions(50)
          .filter((x) => x.id !== meta.id && !isRunning(x.id))
          .slice(0, 8);
        if (list.length === 0) {
          ui.info("没有可恢复的会话（运行中的会话不列出）。");
          return true;
        }
        // 预览取该会话首条用户消息 —— id 是时间戳，辨识度全靠它
        const options = list.map((s) => {
          const f = loadSession(s.id);
          const firstUser = f?.messages.find((m) => m.role === "user" && (contentText(m.content) ?? "").trim());
          const preview = firstUser?.content
            ? truncate((contentText(firstUser.content) ?? "").replace(/\s+/g, " ").trim(), 46)
            : "（无文本预览）";
          return { label: `${s.id}  ${preview}`, hint: `${s.turns}轮 ${s.model}`, value: s.id };
        });
        // C1：进入前收尾 spinner；select 存续期间不得有其他输出写入
        ui.stopSpinner();
        ui.blank();
        const picked = await select("恢复哪个会话？", options, selectDeps);
        if (!picked) {
          ui.info("已取消。");
          return true;
        }
        targetId = picked;
      }
      const full = loadSession(targetId);
      if (!full) {
        ui.warn(`未找到会话 ${targetId}`);
        return true;
      }
      if (full.messages.length === 0) {
        ui.warn("该会话没有任何消息，无法恢复。");
        return true;
      }
      if (isRunning(full.meta.id)) {
        ui.warn(`会话 ${full.meta.id} 正在另一个进程中运行，不能恢复（/peers 可查看存活会话）。`);
        return true;
      }
      // 先接管信箱身份；失败则不改对话/持久化，避免身份与会话不一致。
      if (mailbox) {
        const beforeName = readProfile(mailbox.root, full.meta.id)?.name ?? null;
        try {
          const p = mailbox.adopt(full.meta.id);
          if (beforeName && p.name && beforeName !== p.name) {
            ui.info(`目标代号 ${beforeName} 已被占用，恢复为 ${p.name}`);
          }
          onMailboxRekey?.();
          if (p.name) {
            onNameChange?.(p.name);
          } else {
            // 目标 profile 无名字：按 A2 随机一个池内名并写回（不随机覆盖已有名字）。
            const chosen = chooseSessionName({
              taken: takenAliveNames(mailbox.root, { deadAfterMs: cfg.mailbox.deadAfterMs }),
            });
            if (chosen) {
              const renamed = renameSession(mailbox.root, mailbox.sessionId, chosen.name, {
                deadAfterMs: cfg.mailbox.deadAfterMs,
              });
              onNameChange?.(renamed.name ?? "");
            }
          }
          ui.info(`跨会话信箱身份已切换到 ${full.meta.id}${p.name ? `（${p.name}）` : ""}`);
        } catch (e) {
          ui.warn(`无法恢复 ${full.meta.id}：${(e as Error).message}`);
          return true;
        }
      }
      agent.messages = applyRestored(agent.messages[0], full.messages);
      Object.assign(meta, full.meta, { model: cfg.model });
      // #64 SessionStart(resume)：历史恢复成功后触发一次。
      // 回放（下面的 replayTranscript）只是把旧对话画到屏幕上，**不算**用户提交，
      // 因此这里不发 UserPromptSubmit —— 否则 resume 会凭空触发一次 UPS。
      await agent.runSessionStart("resume");
      if (full.meta.cwd && full.meta.cwd !== cfg.cwd) {
        ui.info(`会话原目录 ${full.meta.cwd}，本次按 ${cfg.cwd} 运行`);
      }
      ui.success(`已恢复会话 ${full.meta.id}（${full.messages.length} 条消息）`);
      // v0.2.3 D4：恢复后回放，避免「上下文都在、屏幕上什么都没有」
      replayTranscript(ui, full.messages);
      const lastUser = [...full.messages]
        .reverse()
        .find((m) => m.role === "user" && (contentText(m.content) ?? "").trim());
      if (lastUser?.content) {
        ui.line(c.dim(`  上次输入：${truncate((contentText(lastUser.content) ?? "").replace(/\s+/g, " ").trim(), 60)}`));
      }
      return true;
    }

    case "last": {
      // v0.2.3 D3：紧凑模式不打印工具正文，这里用内存缓存把最近 n 次找回来。
      // 范围夹取在 recentToolCalls 内部完成，这里不做第二遍。
      const recs = ui.recentToolCalls(arg ? Number(arg) || 1 : 1).reverse(); // 时间顺序：旧 → 新
      if (recs.length === 0) {
        ui.info("本次会话还没有工具调用记录。");
        return true;
      }
      for (const r of recs) {
        for (const l of formatToolCall(r, ui.width)) ui.line(l);
        ui.blank();
      }
      return true;
    }

    case "sessions":
      printSessions(ui, {
        root: mailbox?.root ?? mailboxRoot(),
        deadAfterMs: cfg.mailbox.deadAfterMs,
        currentId: meta.id,
      });
      return true;

    case "exit":
    case "quit":
      void shutdown();
      return true;

    default:
      return false;
  }
}
