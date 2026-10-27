/**
 * 技能（Skill）—— 模型按需加载的说明书文件夹。
 *
 * 三层渐进式披露：
 *   第1 层 索引常驻 system prompt（discoverSkills + buildSkillIndex）
 *   第 2 层 SKILL.md 正文按需加载（use_skill → resolveSkill）
 *   第 3 层 references/ scripts/ 附件由模型自己按需读，本模块只列清单
 *
 * 两条硬约束，改动前务必确认：
 *  1. **零第三方依赖**。frontmatter 手写最小解析器，不引 yaml。
 *  2. **store 路径必须从 cfg 读**（Config.skillsStore），不得在此硬编码 homedir()。
 *     否则测试无法隔离，会写到用户真实的 ~/.neo/skills/。
 */
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync, realpathSync, lstatSync, mkdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { estimateTokens } from "./llm.ts";

/** 技能的来源标记。 */
export type SkillSource = "project" | "global" | "extra";

/** 一个技能的索引条目。 */
export interface SkillMeta {
  /** 目录名，即调用 use_skill 时传入的名字 */
  name: string;
  /** SKILL.md frontmatter 里的 description；缺失时回退为 SKILL.md 首行标题 */
  description: string;
  /** 真实目录的绝对路径（已解析软链） */
  absPath: string;
  /** 原始路径（可能是软链本身） */
  linkPath: string;
  source: SkillSource;
  /** 是否来自软链。用于 use_skill 的输出提示与 /skills 展示 */
  linked: boolean;
}

/** 解析结果：成功返回绝对路径，或失败返回原因。 */
export type ResolveResult =
  | { ok: true; meta: SkillMeta; createdLink: boolean }
  | { ok: false; reason: "not_found" | "malformed"; message: string; available: string[] };

/**
 * 技能名白名单。
 * name 来自模型，直接拼进路径 —— 不校验就是路径穿越。
 * 依据 Anthropic Agent Skills Spec：小写字母 / 数字 / 连字符，且不以连字符开头。
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 技能名是否合法。供CLI 的 `/skills <名>` 复用，避免在 UI 层复制一份正则而漂移。
 */
export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

/** 全局技能库路径。优先取 cfg.skillsStore（测试注入点），否则回落默认。 */
export function skillsStore(cfg: Config): string {
  return cfg.skillsStore || join(homedir(), ".neo", "skills");
}

/** 项目技能区路径。 */
export function projectSkillsDir(cfg: Config): string {
  return join(cfg.cwd, "skills");
}

/**
 * 额外技能目录（v0.4.1 B3）：settings.skills_extra_paths / NEO_SKILLS_PATHS。
 * 支持 ~ 展开；相对路径按工作目录解析。只读，不建软链。
 */
export function extraSkillsDirs(cfg: Config): string[] {
  return (cfg.skillsExtraPaths ?? [])
    .map((raw) => {
      const p = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
      return isAbsolute(p) ? p : resolve(cfg.cwd, p);
    })
    .filter((p, i, arr) => arr.indexOf(p) === i);
}

/* ------------------------------------------------------------------ */
/* frontmatter 最小解析                                                */
/* ------------------------------------------------------------------ */

/**
 * 读取并解析 SKILL.md 的 YAML frontmatter。不引入 yaml 依赖。
 *
 * 解析规则：
 *  - 以文件开头的 `---` 行开始，找到下一个 `---` 行结束
 *  - 每行按第一个 `: ` 分割键值对（因此 description 里的冒号不会截断）
 *  - 整个块解析失败不抛异常，返回空对象
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split("\n");

  // 必须从第一行开始就是 ---，否则视为无 frontmatter
  if ((lines[0] ?? "").trim() !== "---") return out;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  // 未闭合（A4）→ 空对象
  if (end === -1) return out;

  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(": ");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 2).trim();
    if (key) out[key] = val;
  }
  return out;
}

/** 取正文里第一个 `# 标题` 行，作为 description 的回退。 */
function firstHeading(content: string): string {
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t.startsWith("# ")) return t.slice(2).trim();
  }
  return "";
}

/** 读一个技能目录，产出 SkillMeta；目录缺 SKILL.md 返回 null。 */
function readSkill(name: string, dir: string, source: SkillSource): SkillMeta | null {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return null;

  let raw = "";
  try {
    raw = readFileSync(skillMd, "utf8");
  } catch {
    return null;
  }

  const fm = parseFrontmatter(raw);
  // 约束 1：无 description 时依次回退「首行标题」→「目录名」，永不返回空
  const description = (fm["description"] ?? "").trim() || firstHeading(raw) || name;

  const linked = lstatSync(dir).isSymbolicLink();
  let absPath = dir;
  try {
    absPath = realpathSync(dir);
  } catch {
    /* 软链断裂等，保留原路径 */
  }

  return { name, description, absPath, linkPath: dir, source, linked };
}

/** 列出一个目录下的技能（不递归）。非法名 / 缺 SKILL.md 的条目跳过。 */
function scanSkillsDir(base: string, source: SkillSource): SkillMeta[] {
  if (!existsSync(base)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const e of entries) {
    if (!isValidSkillName(e.name)) continue; // B7
    const full = join(base, e.name);
    if (!isRealDir(full, e)) continue;
    const meta = readSkill(e.name, full, source);
    if (meta) out.push(meta);
  }
  return out;
}

/**
 * 目录项是否指向一个真实目录（跟随软链判断）。
 *
 * symlink 指向目录时 `e.isDirectory()` 为false，glob/grep/list_dir 与工作目录树
 * 会完全跳过它 —— 本项目多处遍历依赖这个判定。
 *
 * 不能简单写成 `e.isDirectory() || e.isSymbolicLink()` —— `readdirSync` 对**指向文件**
 * 的软链同样返回 `isSymbolicLink()=true`。统一改后 glob/grep 会把「软链到文件」
 * 当目录走进 walk，`readdirSync` 抛错被 catch 吞掉 → 该文件永远不会被当作文件匹配，
 * 比修之前更差。故用 `statSync`（跟随软链）判真实类型。
 *
 * 三个遍历点（tools 的 glob/grep/list_dir、system-prompt 的 listFiles）共用此实现，
 * 避免同一判定在多处漂移。
 */
export function isRealDir(full: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (e.isSymbolicLink()) {
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 发现                                                                */
/* ------------------------------------------------------------------ */

/**
 * 扫描两处技能区，生成索引。项目技能优先（同名时项目条排在前面）。
 *
 * 同名两条都返回（PRD B2）—— 调用方需要知道两边都存在；
 * buildSkillIndex 会在生成索引文本时按名去重。
 */
export function discoverSkills(cfg: Config): SkillMeta[] {
  const project = scanSkillsDir(projectSkillsDir(cfg), "project");
  const global = scanSkillsDir(skillsStore(cfg), "global");
  const extras = extraSkillsDirs(cfg).flatMap((dir) => scanSkillsDir(dir, "extra"));
  // 约束 5：按 name 字典序；同名时项目条在前，保证顺序稳定可复现
  const all = [...project, ...global, ...extras].sort((a, b) =>
    a.name === b.name ? 0 : a.name < b.name ? -1 : 1,
  );

  // 按解析后的真实路径去重：项目区软链指回全局库时（use_skill 的懒加载产物），
  // 那是**同一个**技能而非两个 —— 不去重会让索引与 use_skill 的来源说明自相矛盾。
  // 排序已保证项目条在前，故保留的即 linked=true 的那条。
  const seen = new Set<string>();
  return all.filter((s) => {
    if (seen.has(s.absPath)) return false;
    seen.add(s.absPath);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* 索引文本                                                            */
/* ------------------------------------------------------------------ */

/**
 * 索引里单条 description 的 token 预算。
 *
 * 按 token 而非字符计量：CJK 约 1.5 字符/token、ASCII 约 4 字符/token，
 * 同样 40 tokens 能装 60 个汉字或 160 个英文字符 —— 按字符截断会砍掉
 * 中文描述一半的信息（见 PRD §9.4 修订说明）。
 *
 * 预算只针对 description，不含 `- name：` 前缀：技能名长度不受我们控制，
 * 把整行算进预算会导致长技能名 + 短描述时无论如何都超限（措辞不可达成）。
 */
const DESC_TOKEN_BUDGET = 40;

/**
 * 单段文本的 token 估算。复用 llm.ts 的同一算法，不引分词器（零依赖硬约束）。
 *
 * 必须扣掉 `estimateTokens` 的**每条消息固定开销**（`llm.ts:325` 的 `messages.length * 4`）：
 * 那个开销是给对话消息算的，与本函数要度量的「一段文本」无关。
 * 不扣的话 60 个汉字会被算成 45 tokens，从而被误判为超预算而截断 ——
 * 而 60 汉字按 CJK 1.5 字符/token 恰好就是 40 tokens，正是预算边界。
 *
 * **为什么用实测值而不是硬编码 4**：
 * `estimateTokens([{content: ""}])` 实测是 **5** 而不是 4 —— 因为
 * `Math.ceil(ascii/4 + cjk/1.5)` 对空串算出 0，但末尾仍会为每条消息加上 `messages.length * 4`。
 * 所以硬编码 `- 4` 会**整体多算1 个 token**，60 汉字会算成 41 而被误截。
 * 这里动态取实测值，若将来 llm.ts 调整了开销口径，本处自动跟随，不会静默偏移。
 */
const PER_MESSAGE_OVERHEAD = estimateTokens([{ role: "user", content: "" }], []);

function tokensOf(text: string): number {
  return Math.max(0, estimateTokens([{ role: "user", content: text }], []) - PER_MESSAGE_OVERHEAD);
}

/**
 * 把 description 压成单行并按 token 预算截断。
 *
 * 换行必须先压平 —— 否则「一行一技能」被破坏（约束 D3/H5）。
 * 截断按**字符逐步逼近**而非按 token 二分：token 与字符不是线性关系
 * （中英混排时差异可达 2.7 倍），逐步逼近的结果与预算的偏差最小。
 */
export function normalizeDescription(desc: string, fallbackName: string): string {
  const flat = (desc || "").replace(/\s*\n+\s*/g, " ").trim();
  const text = flat || fallbackName;
  if (tokensOf(text) <= DESC_TOKEN_BUDGET) return text;

  // 留出 `…` 的预算，避免标记本身把结果顶出预算
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tokensOf(text.slice(0, mid) + "…") <= DESC_TOKEN_BUDGET) lo = mid;
    else hi = mid - 1;
  }
  // 截断点落在词中间会产出半个词，退到最近的空白处
  const cut = text.slice(0, lo);
  const atSpace = cut.lastIndexOf(" ");
  const body = (atSpace > lo * 0.5 ? cut.slice(0, atSpace) : cut).trimEnd();
  return `${body}…`;
}

/** 索引行的唯一形态：`- name：description`。三处输出共用，保证逐字一致。 */
export function formatSkillLine(name: string, description: string): string {
  return `- ${name}：${normalizeDescription(description, name)}`;
}

/** 生成注入 system prompt 的索引文本。无技能时返回空字符串。 */
export function buildSkillIndex(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";

  // 同名去重，项目优先（discoverSkills 已把项目条排在前面）
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const s of skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    lines.push(formatSkillLine(s.name, s.description));
  }
  if (lines.length === 0) return "";

  return [
    "## 技能",
    "",
    "可用技能（仅在相关时用 use_skill 加载正文，不相关不要加载——正文占用上下文）：",
    "",
    ...lines,
    "",
    "技能说明位于 ./skills/<技能名>/SKILL.md 及同目录附件。",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/**
 * 读技能目录并把「缺 SKILL.md」折成统一的 malformed 结果（约束 8）。
 * 目录存在但缺 SKILL.md 不是有效技能，不能当成功 —— 项目区与全局库两处判定相同。
 */
function readOrMalformed(
  name: string,
  dir: string,
  source: SkillSource,
  available: string[],
): { ok: false; reason: "malformed"; message: string; available: string[] } | SkillMeta {
  const meta = readSkill(name, dir, source);
  if (meta) return meta;
  return {
    ok: false,
    reason: "malformed",
    message: `该技能目录缺少 SKILL.md，不是有效的技能：${dir}`,
    available,
  };
}

/**
 * 按两级规则解析技能名：
 *   1. <cwd>/skills/<name>/ 存在（真目录或软链）→ 直接用，不动全局库
 *   2. 否则全局库有 → 建软链 <cwd>/skills/<name>（绝对路径、幂等）
 *   3. 否则 → not_found，附可用技能名
 *
 * `opts.createLink === false` 时走纯只读路径：不建软链。`/skills` 诊断命令必须用它——
 * 那个命令是给人看的，若顺手建了软链，就把「诊断」变成了写操作，与约束16 的职责分离冲突。
 */
export function resolveSkill(cfg: Config, name: string, opts?: { createLink?: boolean }): ResolveResult {
  const createLink = opts?.createLink !== false;
  // 约束 2：先校验白名单，防路径穿越
  if (!isValidSkillName(name)) {
    return { ok: false, reason: "malformed", message: `技能名非法: ${name}`, available: [] };
  }

  const available = discoverSkills(cfg).map((s) => s.name);

  // 1. 项目区命中（约束 4：优先且不碰全局库）
  const localLink = join(projectSkillsDir(cfg), name);
  if (pathExists(localLink)) {
    const found = readOrMalformed(name, localLink, "project", available);
    if ("ok" in found) return found;
    // 项目区里的软链是全局技能的懒加载产物，不是项目私有技能。
    // 必须报 global，否则同一技能两次加载的「来源」行会不一致（global→project 跳变）。
    if (isSymlink(localLink) && isUnder(found.absPath, safeReal(skillsStore(cfg)) ?? "")) {
      return { ok: true, meta: { ...found, source: "global", linked: true }, createdLink: false };
    }
    return { ok: true, meta: found, createdLink: false };
  }

  // 2. 全局库命中 → 建软链
  const globalDir = join(skillsStore(cfg), name);
  if (!existsSync(globalDir)) {
    // 3. 额外技能目录（只读；不建软链）
    for (const dir of extraSkillsDirs(cfg)) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      const found = readOrMalformed(name, p, "extra", available);
      // 目录存在但缺 SKILL.md → 如实报 malformed，不能伪装成 not_found。
      if ("ok" in found) return found;
      return { ok: true, meta: found, createdLink: false };
    }
    const searched = [projectSkillsDir(cfg), skillsStore(cfg), ...extraSkillsDirs(cfg)];
    return {
      ok: false,
      reason: "not_found",
      message:
        `技能不存在: ${name}\n已搜索：${searched.join("、")}` +
        `\n把技能放到上述目录之一，或在 settings.json 配 skills_extra_paths / 设 NEO_SKILLS_PATHS。`,
      available,
    };
  }

  const found = readOrMalformed(name, globalDir, "global", available);
  if ("ok" in found) return found;
  const meta = found;

  // 约束 3：绝对路径软链，幂等。项目可能整体移动，相对路径会失效。
  // 只读模式（/skills 诊断）到此为止 —— 不建链、不mkdir，连父目录都不创建。
  if (!createLink) {
    return { ok: true, meta, createdLink: false };
  }

  let createdLink = false;
  try {
    mkdirSync(projectSkillsDir(cfg), { recursive: true });
    if (!pathExists(localLink)) {
      symlinkSync(globalDir, localLink, "dir");
      createdLink = true;
    }
  } catch {
    // 建链失败（如权限）不致命：全局库仍可读，返回成功但标明未建链
    createdLink = false;
  }

  // 对外呈现为「项目区软链」，因为此刻它确实可以从 ./skills/<name> 访问
  const linkedMeta: SkillMeta = {
    ...meta,
    linkPath: localLink,
    absPath: meta.absPath,
    linked: true,
  };
  return { ok: true, meta: linkedMeta, createdLink };
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 路径是否「占位存在」—— 目录/文件存在，**或**是一个软链（哪怕断链）。
 *
 * 不能只用 existsSync：它跟随软链，对断链软链返回 false，会把「这里已经有个
 * 软链了」误判成「空位置」而重复建链（symlinkSync 抛 EEXIST）或误报可解析。
 */
function pathExists(p: string): boolean {
  return existsSync(p) || isSymlink(p);
}

/* ------------------------------------------------------------------ */
/* 附件清单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 列出技能目录下的附件（references/ scripts/ 等），返回相对 absPath 的路径。
 * 只列两层，够用且不会在超大目录里失控。
 */
export function listSkillFiles(absPath: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 2) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (isRealDir(join(dir, e.name), e)) {
        walk(join(dir, e.name), rel, depth + 1);
      } else {
        out.push(rel);
      }
    }
  };
  walk(absPath, "", 0);
  out.sort();
  return out;
}

/* ------------------------------------------------------------------ */
/* 守卫（供 tools/index.ts 复用）                                       */
/* ------------------------------------------------------------------ */

/**
 * 路径是否落在全局技能库内（含经软链穿透的情况）。
 *
 * 必须 realpathSync —— `skills/pdf/SKILL.md` 与真实路径字符串不相等，
 * 字符串比较会漏判。路径不存在时（写新文件）回退到父目录判断。
 */
export function insideGlobalSkills(cfg: Config, p: string): boolean {
  // skillsStore 永不为空（缺配置时回落 homedir），所以只需判库路径能否解析
  const storeReal = safeReal(skillsStore(cfg));
  if (!storeReal) return false;

  // 约束 13：路径不存在时逐级上溯，找到第一个能 realpath 的祖先
  let probe = p;
  for (let i = 0; i < 64; i++) {
    const real = safeReal(probe);
    if (real) return isUnder(real, storeReal);
    const parent = parentOf(probe);
    if (!parent || parent === probe) return false;
    probe = parent;
  }
  return false;
}

function safeReal(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function parentOf(p: string): string | null {
  const idx = p.lastIndexOf(sep);
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

function isUnder(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep + ".."));
}

/**
 * use_skill 的来源说明行（约束 7：建软链是写文件系统操作，必须告知用户）。
 * 项目区软链指向全局库时仍报 global —— 软链只是懒加载产物，不是另一份技能。
 *
 * `_cfg` 目前用不到（形态已收敛为「名 / 来源 / 是否软链」，不再拼路径），
 * 但签名保留：tests 直接按三参调用，改签名会连带改测试契约。
 */
export function describeSource(_cfg: Config, meta: SkillMeta, createdLink: boolean): string {
  const linked = createdLink || (meta.linked && meta.source === "global");
  return `来源：${meta.name}（${meta.source} / ${linked ? "软链" : "本地"}）`;
}
