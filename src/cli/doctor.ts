/**
 * doctor.ts — /doctor 与 `neo doctor` 的只读配置体检（issue #91）。
 *
 * 把已有的分散诊断收成一条用户可感知的路径：先报告，默认不改文件。
 * 这不是 --safe-mode，也不替代初次使用向导。
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Args } from "./args.ts";
import { HELP } from "./args.ts";
import { isSafeModeEnabled, SAFE_MODE_NOTICE } from "./safeMode.ts";
import { settingsCandidates } from "../config/settingsPath.ts";
import { parseMcpServers, parseSkillsExtraPaths, type Config } from "../config.ts";
import { MISSING_SETTINGS_MESSAGE } from "./firstUseOnboard.ts";
import { parseHooksConfig } from "../hooks/types.ts";
import { discoverProjectRules, RULE_DIRS } from "../rules/index.ts";
import {
  extraSkillsDirs,
  isRealDir,
  isValidSkillName,
  parseFrontmatter,
  projectSkillsDir,
  skillsStore,
} from "../skills.ts";
import type { McpServerState } from "../mcp/client.ts";
import { VERSION } from "./version.ts";
import { c } from "../ui/theme.ts";

/** 成功打印报告（即便有发现）。体检是诊断，不是闸门。 */
export const DOCTOR_OK_EXIT = 0;
/** 用法错误（多余参数、与 -p 等会话旗标互斥）。 */
export const DOCTOR_USAGE_EXIT = 2;

/** CLI 不实时连接 MCP 时的说明（避免挂起）。 */
export const MCP_CLI_NO_CONNECT_NOTE =
  "CLI 未尝试实时连接 MCP（避免挂起）；交互会话里的 /doctor 会使用已加载的 MCP 状态。";

export type DoctorSeverity = "error" | "warning" | "info";

export interface DoctorFinding {
  severity: DoctorSeverity;
  problem: string;
  location: string;
  advice: string;
}

export interface DoctorReport {
  settingsPath: string | null;
  /** null = 未找到文件；true/false = 找到后是否可解析为 JSON 对象。 */
  settingsParseable: boolean | null;
  safeMode: boolean;
  findings: DoctorFinding[];
  notes: string[];
  summary: string[];
}

export interface RunDoctorOptions {
  cwd?: string;
  safeMode?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * 已加载的 MCP 状态。
   * - 传入数组（可空）：交互会话，使用实时状态，不再连接。
   * - 不传（undefined）：CLI 路径，只做配置层检查，不启动进程。
   */
  mcpStates?: McpServerState[];
}

export type SecretStatus = "present" | "missing";

/** 只回答密钥是否存在，绝不回显原文。 */
export function maskSecretStatus(value: string | null | undefined): SecretStatus {
  return value != null && value.trim() !== "" ? "present" : "missing";
}

export function formatSecretLabel(status: SecretStatus): string {
  return status === "present" ? "已配置（***）" : "缺失";
}

export function runDoctorCheckup(opts: RunDoctorOptions = {}): DoctorReport {
  const env = opts.env ?? process.env;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const safeMode = isSafeModeEnabled(opts.safeMode ?? false, env);
  const findings: DoctorFinding[] = [];
  const notes: string[] = [];
  const summary: string[] = [];

  const settingsPath = findSettingsForDoctor(cwd, env);
  const home = env["HOME"] || env["USERPROFILE"] || homedir();

  let raw: Record<string, unknown> | null = null;
  let settingsParseable: boolean | null = null;

  if (settingsPath == null) {
    settingsParseable = null;
    findings.push({
      severity: "error",
      problem: "尚未找到 settings.json",
      location: `候选路径（工作区 ${join(cwd, "settings.json")}、用户级 ${join(home, ".neo", "settings.json")} 等，搜索顺序未改）`,
      advice: `${MISSING_SETTINGS_MESSAGE} neo doctor 不会启动初次配置向导，也不会写文件。`,
    });
    summary.push("配置文件：未找到 settings.json");
  } else {
    const parsed = readSettingsObject(settingsPath);
    if (!parsed.ok) {
      settingsParseable = false;
      findings.push({
        severity: "error",
        problem: `settings.json 无法解析（解析失败：${parsed.error}）`,
        location: settingsPath,
        advice: "检查 JSON 语法（引号、逗号、括号），修好后再运行 neo doctor。本命令不会改文件，也不会把文件内容写入报告。",
      });
      summary.push(`配置文件：${settingsPath}（不可解析）`);
    } else {
      settingsParseable = true;
      raw = parsed.value;
      summary.push(`配置文件：${settingsPath}（可解析）`);
      inspectProviders(raw, env, findings, summary);
      inspectHooks(raw, findings, summary);
      inspectMcp(raw, opts.mcpStates, findings, notes, summary);
    }
  }

  if (safeMode) {
    notes.unshift(`${SAFE_MODE_NOTICE}；以下仍检查了 settings 与磁盘上的文件。`);
  }

  if (raw == null && settingsParseable !== false) {
    // 无文件时 MCP 说明仍按 CLI/交互口径补一句，避免调用方误以为检查被跳过。
    if (opts.mcpStates === undefined) notes.push(MCP_CLI_NO_CONNECT_NOTE);
  }

  const skillCfg = {
    cwd,
    skillsStore: typeof raw?.["skills_store"] === "string" && raw["skills_store"].trim()
      ? String(raw["skills_store"]).trim()
      : join(home, ".neo", "skills"),
    skillsExtraPaths: parseSkillsExtraPaths(raw?.["skills_extra_paths"], env),
    safeMode: false,
  } as Config;
  inspectSkills(skillCfg, findings, summary);
  inspectRulesAndAgents(cwd, findings, summary);

  return { settingsPath, settingsParseable, safeMode, findings, notes, summary };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["neo 配置体检", ""];
  for (const s of report.summary) lines.push(s);
  if (report.summary.length > 0) lines.push("");

  for (const note of report.notes) lines.push(note);
  if (report.notes.length > 0) lines.push("");

  if (report.findings.length === 0) {
    lines.push("问题：未发现配置问题");
    lines.push("位置：—");
    lines.push("建议：无需修改。本命令默认不改任何文件。");
  } else {
    lines.push("发现：");
    report.findings.forEach((f, i) => {
      lines.push(`问题 ${i + 1}（${severityLabel(f.severity)}）：${f.problem}`);
      lines.push(`位置：${f.location}`);
      lines.push(`建议：${f.advice}`);
      lines.push("");
    });
    lines.push("本命令默认不改任何文件。");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function doctorUsageError(args: Args): string | null {
  if (args.rest[0] !== "doctor") return null;
  if (args.rest.length > 1) {
    return `neo doctor 不接受额外参数（收到 ${args.rest.slice(1).join(" ")}）`;
  }
  if (args.print !== null) return "neo doctor 是独立体检入口，不能与 -p/--print 同时使用（不进入 TUI、不发模型请求）";
  if (args.outputFormat !== "text") return "neo doctor 不能与 --output-format 同时使用";
  if (args.jsonSchema !== null) return "neo doctor 不能与 --json-schema 同时使用";
  if (args.worktree !== null) return "neo doctor 不能与 --worktree 同时使用";
  if (args.resume !== null) return "neo doctor 不能与 --resume 同时使用";
  if (args.listSessions) return "neo doctor 不能与 --sessions 同时使用";
  if (args.continueLast) return "neo doctor 不能与 --continue 同时使用";
  return null;
}

/** CLI 入口：打印报告并返回退出码。不进入 TUI，不发模型请求，不写文件。 */
export function runDoctorCli(args: Args, env: NodeJS.ProcessEnv = process.env): number {
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.version) {
    console.log(c.accent(`neo v${VERSION}`));
    return 0;
  }
  const err = doctorUsageError(args);
  if (err) {
    console.error(c.err(`✖ ${err}`));
    return DOCTOR_USAGE_EXIT;
  }
  const cwd = args.cwd ? resolve(process.cwd(), args.cwd) : process.cwd();
  const report = runDoctorCheckup({
    cwd,
    safeMode: args.safeMode,
    env,
  });
  console.log(formatDoctorReport(report));
  return DOCTOR_OK_EXIT;
}

/* ------------------------------------------------------------------ */
/* 内部：settings / provider                                           */
/* ------------------------------------------------------------------ */

/** 与 findSettingsPath 同一搜索顺序，只用 opts.env 的 HOME，不改 process.env。 */
function findSettingsForDoctor(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const home = env["HOME"] || env["USERPROFILE"] || homedir();
  const cands = settingsCandidates({ settingsDir: cwd });
  cands[cands.length - 1] = join(home, ".neo", "settings.json");
  const seen = new Set<string>();
  for (const p of cands) {
    const key = resolve(p);
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(p)) return p;
  }
  return null;
}

function readSettingsObject(
  path: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: "根值必须是 JSON 对象" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (e) {
    const msg = (e as Error).message.replace(/\s+/g, " ").trim();
    return { ok: false, error: msg };
  }
}

function inspectProviders(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  findings: DoctorFinding[],
  summary: string[],
): void {
  const providers = listProviders(raw);
  const defaultName = typeof raw["default_provider"] === "string" ? raw["default_provider"].trim() : "";
  if (providers.length === 0) {
    findings.push({
      severity: "error",
      problem: "缺少 providers 配置",
      location: "settings.json",
      advice: "参考 settings.example.json 添加 providers 数组（含 provider_name、api_type 或 provider_type、api_key）。",
    });
    summary.push("provider：缺失");
    summary.push(`api_key：${formatSecretLabel("missing")}`);
    return;
  }

  if (!defaultName) {
    findings.push({
      severity: "warning",
      problem: "未设置 default_provider",
      location: "settings.json",
      advice: `补上 default_provider（当前将回落到列表第一项 ${providers[0]?.name || "?"}）。`,
    });
  } else if (!providers.some((p) => p.name === defaultName)) {
    findings.push({
      severity: "error",
      problem: `default_provider "${defaultName}" 不在 providers 列表中`,
      location: "settings.json",
      advice: `把 default_provider 改成已配置的名字：${providers.map((p) => p.name).filter(Boolean).join("、") || "（列表为空）"}。`,
    });
  }

  const envKey = maskSecretStatus(env["NEO_API_KEY"]);
  let anyMissing = false;
  for (const p of providers) {
    const status = maskSecretStatus(p.apiKey);
    if (status === "missing") {
      anyMissing = true;
      const envHint =
        envKey === "present"
          ? "本进程环境变量 NEO_API_KEY 已提供密钥（未写入报告）。若希望配置文件自洽，仍建议在对应 provider 下填写 api_key。"
          : "在对应 provider 下填写 api_key，或设置环境变量 NEO_API_KEY（本命令不会写入）。";
      findings.push({
        severity: "error",
        problem: "api_key 缺失",
        location: p.where,
        advice: envHint,
      });
    }
  }

  const focus = defaultName ? providers.find((p) => p.name === defaultName) ?? providers[0] : providers[0];
  const focusStatus = focus ? maskSecretStatus(focus.apiKey) : "missing";
  const processStatus = focusStatus === "present" || envKey === "present" ? "present" : "missing";
  summary.push(`default provider：${defaultName || focus?.name || "（未设置）"}`);
  summary.push(`api_key：${formatSecretLabel(anyMissing && envKey === "missing" ? "missing" : processStatus)}`);
}

function listProviders(raw: Record<string, unknown>): Array<{ name: string; apiKey: string; where: string }> {
  const list = raw["providers"];
  if (Array.isArray(list)) {
    return list.map((item, i) => {
      const where = `providers[${i}]`;
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return { name: "", apiKey: "", where };
      }
      const p = item as Record<string, unknown>;
      const name = typeof p["provider_name"] === "string" ? p["provider_name"].trim() : "";
      const apiKey = firstString(p["api_key"], p["api-key"]);
      return { name, apiKey, where: name ? `providers.${name}.api_key` : `${where}.api_key` };
    });
  }
  const legacyKey = firstString(raw["api_key"], raw["api-key"]);
  if (legacyKey || raw["model_name"] !== undefined || raw["OpenAI"] !== undefined) {
    return [{ name: "legacy", apiKey: legacyKey, where: "settings.json 顶层 api_key（旧版扁平格式）" }];
  }
  return [];
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string") return v;
  }
  return "";
}

function inspectHooks(
  raw: Record<string, unknown>,
  findings: DoctorFinding[],
  summary: string[],
): void {
  const hooks = parseHooksConfig(raw["hooks"]);
  const total = Object.values(hooks.hooks).reduce((n, list) => n + list.length, 0);
  summary.push(`hooks：${hooks.enabled ? "已启用" : "未启用"}，有效条目 ${total} 条，告警 ${hooks.warnings.length} 条`);
  for (const w of hooks.warnings) {
    findings.push({
      severity: "warning",
      problem: `hooks 配置告警：${w}`,
      location: "settings.json 的 hooks 段",
      advice: "按告警修好对应条目（例如补上 command、修正 matcher）；写错的条目在启动时已被丢弃。改完需重启会话后再生效。",
    });
  }
}

function inspectMcp(
  raw: Record<string, unknown>,
  mcpStates: McpServerState[] | undefined,
  findings: DoctorFinding[],
  notes: string[],
  summary: string[],
): void {
  const parsed = parseMcpServers(raw["mcpServers"]);
  summary.push(`MCP：配置了 ${parsed.servers.length} 个 server`);
  for (const w of parsed.warnings) {
    findings.push({
      severity: "warning",
      problem: `MCP 配置告警：${w}`,
      location: "settings.json 的 mcpServers 段",
      advice: "按告警补全 command / url 或修正名字与 transport（stdio / http / sse）。",
    });
  }
  if (mcpStates === undefined) {
    notes.push(MCP_CLI_NO_CONNECT_NOTE);
    return;
  }
  if (mcpStates.length === 0) return;
  for (const s of mcpStates) {
    if (s.status === "error") {
      findings.push({
        severity: "error",
        problem: `MCP 连接失败：${s.error ?? s.name}`,
        location: `mcpServers.${s.name}`,
        advice: "查看 /mcp 与该错误原文，检查 command/url、环境与网络后重启 neo。neo doctor 不会替你启动或重连。",
      });
    }
    for (const r of s.rejected ?? []) {
      findings.push({
        severity: "warning",
        problem: `MCP 工具注册失败：${r.name}（${r.reason}）`,
        location: `mcpServers.${s.name} / ${r.remote}`,
        advice: "改名或停用冲突的 server 后重启。",
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 内部：技能 / 规则 / AGENTS.md                                       */
/* ------------------------------------------------------------------ */

function inspectSkills(
  cfg: Config,
  findings: DoctorFinding[],
  summary: string[],
): void {
  const dirs: Array<{ dir: string; source: string }> = [
    { dir: projectSkillsDir(cfg), source: "project" },
    { dir: skillsStore(cfg), source: "global" },
    ...extraSkillsDirs(cfg).map((dir) => ({ dir, source: "extra" })),
  ];
  const found: Array<{ name: string; source: string; path: string }> = [];
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      findings.push({
        severity: "warning",
        problem: `技能目录无法读取：${(e as Error).message}`,
        location: dir,
        advice: "检查目录权限后重试。",
      });
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (!isRealDir(full, e)) continue;
      if (!isValidSkillName(e.name)) {
        findings.push({
          severity: "info",
          problem: `技能目录名非法，未作为技能加载：${e.name}`,
          location: full,
          advice: "技能名只允许小写字母、数字与连字符，且不以连字符开头。",
        });
        continue;
      }
      const skillMd = join(full, "SKILL.md");
      if (!existsSync(skillMd)) {
        findings.push({
          severity: "warning",
          problem: `技能损坏：目录 ${e.name} 缺少 SKILL.md`,
          location: full,
          advice: "补上 SKILL.md（含 description 的 frontmatter），或删除这个空目录。",
        });
        continue;
      }
      try {
        const raw = readFileSync(skillMd, "utf8");
        parseFrontmatter(raw);
        found.push({ name: e.name, source, path: full });
      } catch (err) {
        findings.push({
          severity: "warning",
          problem: `技能损坏：无法读取 ${e.name} 的 SKILL.md（${(err as Error).message}）`,
          location: skillMd,
          advice: "检查文件权限与内容后重试。",
        });
      }
    }
  }

  const byName = new Map<string, Array<{ name: string; source: string; path: string }>>();
  for (const s of found) {
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  }
  let dupes = 0;
  for (const [name, list] of byName) {
    const unique = [...new Map(list.map((x) => [x.path, x])).values()];
    if (unique.length < 2) continue;
    dupes += 1;
    findings.push({
      severity: "warning",
      problem: `技能重名：${name}（${unique.map((x) => x.source).join(" / ")}）`,
      location: unique.map((x) => x.path).join("；"),
      advice: "同名时项目技能优先；若不是有意覆盖，请改名以免混淆。",
    });
  }
  summary.push(`技能：发现 ${found.length} 个，重名 ${dupes} 组`);
}

function inspectRulesAndAgents(
  cwd: string,
  findings: DoctorFinding[],
  summary: string[],
): void {
  const memoryNames = ["AGENTS.md", "NEO.md", ".neo.md"] as const;
  const memoryFile = memoryNames.map((f) => join(cwd, f)).find((p) => existsSync(p));
  if (memoryFile) {
    summary.push(`项目指令：已找到 ${memoryFile.slice(cwd.length).replace(/^[/\\]/, "") || memoryFile}`);
  } else {
    summary.push("项目指令：未找到 AGENTS.md / NEO.md / .neo.md");
  }

  const rules = discoverProjectRules(cwd);
  const onDisk = listRuleFiles(cwd);
  const loaded = new Set(rules.map((r) => r.file));
  for (const file of onDisk) {
    if (loaded.has(file)) continue;
    findings.push({
      severity: "warning",
      problem: "规则文件损坏或无法读取，已被跳过",
      location: file,
      advice: "检查该 .md 的权限与内容后重试。",
    });
  }

  const byName = new Map<string, string[]>();
  for (const r of rules) {
    const list = byName.get(r.name) ?? [];
    list.push(r.file);
    byName.set(r.name, list);
  }
  let dupes = 0;
  for (const [name, files] of byName) {
    if (files.length < 2) continue;
    dupes += 1;
    findings.push({
      severity: "warning",
      problem: `规则重名：${name}`,
      location: files.join("；"),
      advice: "给规则加上互不相同的 title，或合并重复文件，以免难以区分。",
    });
  }

  if (rules.length === 0 && onDisk.length === 0) {
    summary.push("项目规则：未发现项目规则（.neo/rules 或 .claude/rules）");
  } else {
    summary.push(`项目规则：找到 ${rules.length} 个，重名 ${dupes} 组`);
  }
}

function listRuleFiles(cwd: string): string[] {
  const found: string[] = [];
  for (const dir of RULE_DIRS) walkRuleMd(cwd, dir, found);
  return found;
}

function walkRuleMd(root: string, relDir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(join(root, relDir));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const rel = `${relDir}/${entry}`;
    const abs = join(root, rel);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walkRuleMd(root, rel, out);
    else if (/\.md$/i.test(entry)) out.push(abs);
  }
}

function severityLabel(s: DoctorSeverity): string {
  return s === "error" ? "错误" : s === "warning" ? "警告" : "信息";
}
