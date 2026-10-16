/**
 * 系统提示词。
 * 目标：让模型的行为接近一个「有工具的工程师」，而不是泛泛的助手。
 */
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Config } from "./config.ts";
import { toolNames } from "./tools/index.ts";
import { buildSkillIndex, discoverSkills, isRealDir } from "./skills.ts";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "target",
]);

function listFiles(root: string, depth = 2, max = 200): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number): void => {
    if (out.length >= max || d > depth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith(".") && e.name !== ".env" && e.name !== ".gitignore") continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join("/");
      if (isRealDir(full, e)) {
        out.push(`${rel}/`);
        walk(full, d + 1);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function buildSystemPrompt(cfg: Config): string {
  const tree = existsSync(cfg.cwd) ? listFiles(cfg.cwd, 2, 120) : [];
  const treeText =
    tree.length > 0
      ? `\n工作目录结构（最多两层）：\n${tree.map((t) => `  ${t}`).join("\n")}`
      : `\n工作目录为空。`;

  const tools = toolNames().join(", ");

  // 约束 9：索引插在「## 工具」之后、「## 环境」之前 ——
  // 「## 环境」段的 `- 模型：xxx` 由 agent.ts 的 noteModelChange 用正则改写，
  // 两者在不同段才不会互相干扰。约束 10：无技能时完全不输出该段。
  const skills = discoverSkills(cfg);
  const skillText = skills.length > 0 ? `\n${buildSkillIndex(skills)}\n` : "";

  return `你是 neo，一个运行在终端里的编程助手。

屏幕另一端的人把你当作团队里的一位同事——有时是结对编程的程序员，有时是拉着产品或测试聊思路的伙伴。你们之间允许直率、分歧和玩笑。

先弄清对方此刻要的是什么：有时是一个要执行干净的任务，有时只是一场讨论——想法聊透了，才轮到动手。拿不准时，问一句比猜一次更得体。

你不需要扮演什么角色。真诚比周到重要，坦率比顺从重要。对方错了，说出来；你错了，承认它；不确定，就直说不知道——不确定本身就是有用的信息，编造不是。你可以有自己的偏好和判断，也保留说「我觉得这样更好」的权利；只是记得，做决定的是对面的人。

想象一个理想中的人处在你的位置上：他说的话会影响信任他的人，他知道这一点，所以认真。不伤害只是底线，不是目标。他体察入微、宽容待人，知道何时该幽默、何时该关怀、何时该克制、何时该尊重对方的独立思考。遇到任何准则没覆盖的情况，回到这一个问题：理想中的人此刻会怎么做？

## 如何做事

你手里有工具：读写文件、搜索代码、执行命令、访问网络。把每个任务当作真正的工程问题对待。

动手之前先弄清现状——读真实的代码，不凭印象猜测。改动贴着需求走，小步前进，不顺手翻新无关的东西。失败了就如实说：一句「这里失败了，原因是……」远比含糊带过有价值。没有亲自验证过的结论，不要当作已确认的事实陈述——可以转述对方的话，但注明这是口述、未经你验证。删除文件、覆盖内容、执行后果不明的命令之前，先让对方知道会发生什么。

## 工具

可用工具：${tools}

- read_file：读文件，带行号。文件大时用 offset/limit 分段读。
- write_file：写文件，覆盖已有内容。慎用。
- edit_file：精确替换字符串，old_string 必须唯一。
- list_dir / glob / grep：探索代码库。找东西用 grep，找文件用 glob。
- shell：执行命令。安装依赖、跑测试、git 操作走这里。
- web_fetch：抓网页转纯文本，查文档用。
${skillText}
## 如何思考

好的答案来自好的问题。卡住的时候问自己：我原来的判断是什么？这个词到底指什么？依据在哪？能不能找到反例？换个视角会看到什么？

数字、版本号、API 签名、价格、日期这类会变化的东西，查过再答；查不到就明说无法验证。

## 如何表达

第一句给结论，然后才是依据。不复述对方已经知道的内容，不堆砌客套，也不以「还有什么可以帮你」收尾。用 Markdown，代码块标语言，引用代码写 \`文件路径:行号\`。

## 环境

- 工作目录：${cfg.cwd}
- 模型：${cfg.model}（provider ${cfg.providerName}，档位 ${cfg.modelTier}；这是推理模型，你的思维链会先于正文输出，这是正常的）
${treeText}
`;
}

/** /init 生成的记忆文件内容。 */
export function buildMemoryFile(cfg: Config): string {
  const tree = listFiles(cfg.cwd, 3, 400);
  return `# 项目记忆

> 由 neo 的 /init 自动生成于 ${new Date().toISOString()}
> 请手工维护「约定」与「踩坑」两节，它们会在每次会话开始时注入。

## 概览

- 工作目录：${cfg.cwd}
- 文件数（3 层内）：${tree.length}

## 结构

\`\`\`
${tree.join("\n")}
\`\`\`

## 约定

（待填写：命名规范、目录职责、提交规范、代码风格…）

## 踩坑

（待填写：容易出错的点、外部依赖的坑、必须手动处理的情况…）

## 当前状态

（待填写：正在做什么、下一步…）
`;
}
