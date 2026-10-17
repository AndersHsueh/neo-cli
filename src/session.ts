/**
 * 会话持久化。
 * 每次完整对话落盘到 ~/.neo/sessions/<ts>-<id>.json，支持 --resume 恢复。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "./llm.ts";

export interface SessionMeta {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  cwd: string;
  turns: number;
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
  const candidates = readdirSync(dir).filter((f) => f.includes(id) && f.endsWith(".json"));
  if (candidates.length === 0) return null;
  try {
    return JSON.parse(readFileSync(join(dir, candidates[0] as string), "utf8")) as SessionFile;
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
  const data: SessionFile = { version: 1, meta, messages };
  writeFileSync(meta.path, JSON.stringify(data, null, 2), "utf8");
}
