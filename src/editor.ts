/**
 * editor.ts — 用外部编辑器撰写提示词（issue #62）。
 *
 * 契约：
 *  - 编辑器来自环境变量：`$VISUAL` 优先，回落 `$EDITOR`；都没有 = 不可用；
 *  - 提示词全文写进临时文件，编辑器带该文件路径启动（stdin/stdout/stderr 继承终端）；
 *  - 编辑器正常退出 → 读回文件全文回填输入框；非 0 退出 / 起不来 / 内容为空 → 不回填，
 *    原草稿原样保留（**不拿空内容覆盖用户已经写的东西**）；
 *  - 临时文件用完即删，不留残余。
 *
 * 命令切分按 shell 习惯（空白分隔 + 单/双引号），但**不经 shell 执行**：
 * argv 直接交给 spawn，所以 `EDITOR="code --wait"` 可用，而 `EDITOR="x && rm -rf /"`
 * 不会被解释 —— 不引入命令注入面。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 编辑器来源的环境变量（只读这两个，不读别的）。 */
export interface EditorEnv {
  VISUAL?: string | undefined;
  EDITOR?: string | undefined;
}

/** 解析出的编辑器命令（argv，不含文件路径）。 */
export type EditorArgv = string[];

/**
 * 从环境变量解析编辑器命令。
 *
 * `$VISUAL` 优先（约定上是「交互式编辑器」），回落 `$EDITOR`；都没有 → null，
 * 由调用方给可读提示，**不静默失败也不猜一个默认编辑器**。
 */
export function resolveEditorArgv(env: EditorEnv): EditorArgv | null {
  const raw = (env.VISUAL ?? "").trim() || (env.EDITOR ?? "").trim();
  if (raw === "") return null;
  const argv = splitEditorCommand(raw);
  return argv.length > 0 ? argv : null;
}

/**
 * 按 shell 习惯切分命令：空白分隔，单引号/双引号内的空白保留。
 *
 * 引号本身不进入参数（`"my editor"` → `my editor`），与 shell 的字面量语义一致。
 */
export function splitEditorCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** 打开编辑器后的两种结局。 */
export type EditResult = { ok: true; text: string } | { ok: false; error: string };

export interface EditInEditorOptions {
  /** 当前输入框内容（写进临时文件给编辑器）。 */
  initial: string;
  /** 编辑器来源环境（注入便于测试）。 */
  env: EditorEnv;
  /**
   * 启动编辑器。默认用 node:child_process spawn 并继承终端 stdio；
   * 测试注入假实现，返回退出码。
   */
  spawnFn?: (argv: string[], file: string) => Promise<number>;
  /** 临时目录的父目录（默认系统 tmp）。 */
  tmpRoot?: string;
}

/**
 * 打开编辑器 → 读回内容。
 *
 * 失败一律收敛成 `{ ok: false, error }`（可读中文），不抛异常：
 * 调用方（输入框）据此保持原草稿不变。
 */
export async function editInEditor(opts: EditInEditorOptions): Promise<EditResult> {
  const argv = resolveEditorArgv(opts.env);
  if (argv === null) {
    return {
      ok: false,
      error: "未设置 $VISUAL / $EDITOR，无法调起外部编辑器（设置任一环境变量后重试）",
    };
  }

  let dir: string;
  try {
    dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "neo-editor-"));
  } catch (e) {
    return { ok: false, error: `创建临时文件失败：${(e as Error).message}` };
  }

  // .md 后缀：编辑器按 markdown 语法高亮，写提示词时观感更好。
  const file = join(dir, "prompt.md");
  try {
    writeFileSync(file, opts.initial, "utf8");
    const spawnFn = opts.spawnFn ?? spawnEditor;
    let code: number;
    try {
      code = await spawnFn([...argv, file], file);
    } catch (e) {
      return { ok: false, error: `启动编辑器失败（${argv[0]}）：${(e as Error).message}` };
    }
    if (code !== 0) {
      return { ok: false, error: `编辑器以退出码 ${code} 结束，未回填输入框` };
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { ok: false, error: "读回编辑器内容失败，未回填输入框" };
    }
    if (text.trim() === "") {
      return { ok: false, error: "编辑器内容为空，未回填输入框" };
    }
    return { ok: true, text };
  } finally {
    // 临时文件与它的目录一起删：提示词可能含敏感内容，不留残余。
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 默认启动方式：argv 直接 spawn，stdin/stdout/stderr 继承终端（编辑器要接管 tty）。 */
function spawnEditor(argv: string[], _file: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code ?? 0));
  });
}
