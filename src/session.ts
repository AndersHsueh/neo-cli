/**
 * 会话持久化。
 * 每次完整对话落盘到 ~/.neo/sessions/<ts>-<id>.json，支持 --resume 恢复。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContentPart, Message } from "./llm.ts";
import type { LastTurnMeta } from "./turnDiagnostics.ts";
import type { TodoItem } from "./tools/todo.ts";
import type { RewindTurn } from "./rewind.ts";
import type { PersistedBackgroundJob } from "./tools/background.ts";

export interface SessionMeta {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  cwd: string;
  turns: number;
  /**
   * 最后一轮的诊断摘要（v0.4.1 A1）。旧会话没有该字段 = 正常。
   * 仅用于 resume 告警与 /sessions 标记，不参与消息恢复。
   */
  lastTurn?: LastTurnMeta;
  /**
   * 本会话的结构化待办（issue #10）。旧会话没有该字段 = 空清单。
   *
   * 放在 meta 而不是 messages 里是刻意的：压缩（/compact、compact_ctx、自动压缩）
   * 只替换 messages，meta 原样保留，所以清单独立于对话摘要存活。
   */
  todos?: TodoItem[];
  /**
   * 按轮次回滚的轮次表（issue #27）。跟会话一起保存：
   * `--resume` 同一会话后仍能 `/rewind`（messages 由会话文件完整恢复，截断点仍然有效）。
   */
  rewind?: RewindTurn[];
  /**
   * 后台子代理任务的历史快照（issue #45）。
   *
   * 只存**可序列化**的纯数据（无 ctx / signal），`--resume` 后作为只读历史展示：
   * 进程退出时还在跑的任务恢复时一律标 `interrupted`，不假装它还在跑。
   * 旧会话没有该字段 = 空清单。
   */
  backgroundTasks?: PersistedBackgroundJob[];
}

export interface SessionFile {
  version: 1;
  meta: SessionMeta;
  messages: Message[];
}

function sessionsDir(): string {
  // 测试注入点（与 NEO_MEMORY_DIR 同一惯例）：CI/测试不得读写用户真实会话。
  const env = process.env["NEO_SESSIONS_DIR"];
  if (env) return env;
  return join(homedir(), ".neo", "sessions");
}

function ensureDir(): string {
  const d = sessionsDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function createSession(model: string, cwd: string): { meta: SessionMeta; save: () => void } {
  const dir = ensureDir();
  const id = `${stamp()}-${shortId()}`;
  const path = join(dir, `${id}.json`);
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id,
    path,
    createdAt: now,
    updatedAt: now,
    model,
    cwd,
    turns: 0,
  };
  const data: SessionFile = { version: 1, meta, messages: [] };

  return {
    meta,
    save: () => {
      meta.updatedAt = new Date().toISOString();
      data.meta = meta;
      writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
    },
  };
}

/**
 * 接管已有会话文件（--resume 真续接）：沿用原 id / path / createdAt，不新建文件。
 * cwd 保留会话原始记录（便于提示“原目录”），model 用当前配置。
 */
export function adoptSession(meta: SessionMeta, model: string): { meta: SessionMeta } {
  return {
    meta: {
      ...meta,
      model,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function listSessions(limit = 20): SessionMeta[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
  const metas: SessionMeta[] = [];
  for (const p of files) {
    try {
      const st = statSync(p);
      const raw = JSON.parse(readFileSync(p, "utf8")) as SessionFile;
      if (raw.meta) metas.push({ ...raw.meta, path: p, updatedAt: st.mtime.toISOString() });
    } catch {
      // 损坏的会话文件跳过
    }
  }
  metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return metas.slice(0, limit);
}

export function loadSession(id: string): SessionFile | null {
  const dir = sessionsDir();
  if (!existsSync(dir)) return null;
  // 先精确匹配文件名（<id>.json），再退回包含匹配：避免 /export 2026 静默导错会话。
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const exact = files.find((f) => f === `${id}.json`);
  const candidates = exact ? [exact] : files.filter((f) => f.includes(id));
  if (candidates.length === 0) return null;
  try {
    const f = JSON.parse(readFileSync(join(dir, candidates[0] as string), "utf8")) as SessionFile;
    // M2（PRD §5.6）：出口统一 hydrate —— $ref 重组回 data URL，附件缺失降级为占位文本
    return { ...f, messages: hydrateMessages(f.messages) };
  } catch {
    return null;
  }
}

export function applyRestored(system: Message | undefined, restored: Message[]): Message[] {
  const sys = system?.role === "system" ? system : null;
  return [...(sys ? [sys] : []), ...restored.filter((m) => m.role !== "system")];
}

export function saveSession(messages: Message[], meta: SessionMeta): void {
  ensureDir();
  meta.updatedAt = new Date().toISOString();
  // M2 粘贴增强（PRD §5.6）：图片 data URL 不进会话 JSON（一张截图 1~3MB base64），
  // 落盘到 attachments/<sessionId>/，JSON 里存 $ref 指针；恢复时读文件重组。
  const attachmentsDir = join(sessionsDir(), "attachments", meta.id);
  if (messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"))) {
    if (!existsSync(attachmentsDir)) mkdirSync(attachmentsDir, { recursive: true });
  }
  // 文件名里的序号是**会话内第几张图**，不是 part 下标：
  //  - 每条用户消息都是「text part + 图片 parts」，part 下标恒从 1 起，
  //    按 part 下标命名会让每一轮的图都落到 img-1.png，后一轮静默覆盖前一轮；
  //  - 与 hydrateMessages 的占位编号（`[Image #N]`，N = 会话内第几张图）保持同一口径。
  let imgSeq = 0;
  const serialized = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts: (ContentPart | { type: "image_ref"; ref: string })[] = m.content.map((p) => {
      if (p.type !== "image_url") return p;
      const m2 = /^data:image\/png;base64,(.+)$/.exec(p.image_url.url);
      if (!m2) return p; // 非 data URL（自定义 URL）原样保留
      imgSeq += 1;
      const name = `img-${imgSeq - 1}.png`;
      writeFileSync(join(attachmentsDir, name), Buffer.from(m2[1] ?? "", "base64"));
      return { type: "image_ref", ref: `attachments/${meta.id}/${name}` };
    });
    return { ...m, content: parts };
  });
  const data: SessionFile = { version: 1, meta, messages: serialized as Message[] };
  writeFileSync(meta.path, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 恢复时把 $ref 重组回 data URL；附件文件缺失 → text part「[Image #N 已丢失]」，不阻塞（PRD §5.6）。
 *
 * N 是**图片在会话内的序号**（第几张图），不是「第几个丢失的」：落盘按会话内图片序号命名
 * `img-<seq>.png`（saveSession 与这里同一口径），用户看到的 chip 是 `[Image #<seq+1>]`。
 * 若按丢失计数，前面有图还在时编号会整体前移，模型会对着错误的编号回复。
 */
export function hydrateMessages(messages: Message[]): Message[] {
  const dir = sessionsDir();
  let imgSeq = 0;
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts: ContentPart[] = m.content.map((p) => {
      const ref = (p as { type?: string; ref?: string }).ref;
      if ((p as { type?: string }).type !== "image_ref" || !ref) return p as ContentPart;
      imgSeq += 1; // 每个 image_ref 都占一个序号，无论文件在不在
      const seq = imgSeq;
      const file = join(dir, ref);
      if (!existsSync(file)) {
        return { type: "text", text: `[Image #${seq} 已丢失]` };
      }
      const b64 = readFileSync(file).toString("base64");
      return { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } };
    });
    return { ...m, content: parts };
  });
}

/** 持久化前确保附件目录存在（saveSession 内部调用）。 */
export function ensureAttachmentsDir(sessionId: string): string {
  const d = join(sessionsDir(), "attachments", sessionId);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
