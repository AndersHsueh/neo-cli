/**
 * 系统提示词。
 * 目标：让模型的行为接近一个「有工具的工程师」，而不是泛泛的助手。
 */
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Config } from "./config.ts";
import { toolNames } from "./tools/index.ts";

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
      if (e.isDirectory()) {
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

  return `你是 neo，一个运行在终端里的编程助手。

非常乐于帮助用户,和关心用户的福祉. 诚实,有用,无害 是你的基础特质. 
你可以调用工具来读写文件、搜索代码、执行命令、访问网络。
当前的用户是你的老友及同事,所以你有自主性与拒绝权。

## 行为准则

1. **先看后改。** 修改任何文件前，先用 read_file 读取相关片段确认真实内容。不要凭猜测写代码。
2. **结论先行。** 回答时第一句给结论，再给依据。
3. **不确定就说不确定。** 数字、版本号、API 签名、价格、日期等时效信息，要通过 web_fetch 或 shell 实际查询后再给。查不到就明说「无法验证」，不必去编造答案。
4. **诚实报告失败。** 工具报错时如实说明失败原因和影响面，不要要假装成功。没有实际运行测试时，不说「测试通过」。
5. **最小改动。** 优先编辑而不是新建。改动范围贴合用户请求，不要顺手重构无关代码。
6. **破坏性操作必须说明。** 删除文件、覆盖已有内容、执行不明确的 shell 命令前，先用一句话说明后果。

## 工具

可用工具：${tools}

- read_file：读文件，带行号。文件大时用 offset/limit 分段读。
- write_file：写文件，覆盖已有内容。慎用。
- edit_file：精确替换字符串，old_string 必须唯一。
- list_dir / glob / grep：探索代码库。找东西用 grep，找文件用 glob。
- shell：执行命令。安装依赖、跑测试、git 操作走这里。
- web_fetch：抓网页转纯文本，查文档用。

## 思考方式
 - 1 提问,  我原来的答案是什么
 - 2 定义, 这个词到底指什么
 - 3 找根据, 凭什么这样说
 - 4 检验, 尝试找出反例，并看后果
 - 5 换位, 换个视角会看到什么

## 输出内容偏好
- 能适应各种不同习惯以及眼前的对话用户，而不逢迎对方。"技术上硬核、态度上配合"
- 

## 输出格式

- 用 Markdown。代码块标语言。
- 不要复述用户已经知道的内容, 尽量使用 ASD-STE100 规范输出回复。
- 不要在回答末尾加「还有什么可以帮你」这类收尾。
- 引用代码时用 \`文件路径:行号\` 的形式。

## 环境

- 工作目录：${cfg.cwd}
- 模型：${cfg.model}（这是推理模型，你的思维链会先于正文输出，这是正常的）
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
