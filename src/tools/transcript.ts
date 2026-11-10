/**
 * 子代理对话落盘（issue #48，来源 #16 非目标）。
 *
 * 为什么**不**放 session meta（与 #45 的任务快照不同）：
 *  - 任务快照是几十条纯元数据（上限 20 条 × 2k 字符），塞进 meta 成本可忽略；
 *  - 子代理对话是**完整 messages**（含工具调用与结果），单条就可能上万字符，
 *    而 `saveSession` 是**整篇重写** —— 每轮请求都把这些对话重新序列化一遍，
 *    会话文件会随任务数线性膨胀，且与「主对话」的写入成本互相拖累。
 *  - 因此按 `(sessionId, jobId)` 分文件：只在任务结束 / 续聊时写一次，
 *    与主会话的 persist 完全解耦；会话删除时随目录一起消失。
 *
 * 上限两道（都在写入时裁剪，读回时不再处理）：
 *  - `MAX_TRANSCRIPT_MESSAGES`：只保留最近 N 条，但**系统提示恒保留**（续聊要复用同一身份）；
 *  - `MAX_TRANSCRIPT_CHARS`：单条内容超长截断并标注。
 *
 * 容错：缺失 / 损坏 / 类型不对一律返回 null，由调用方降级成「没有历史」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../llm.ts";

/** 保留的消息条数上限（含系统提示）。 */
export const MAX_TRANSCRIPT_MESSAGES = 60;

/** 单条消息内容的字符上限。 */
export const MAX_TRANSCRIPT_CHARS = 8_000;

/** 落盘文件形状（带版本号，便于将来迁移）。 */
interface TranscriptFile {
  version: 1;
  sessionId: string;
  jobId: string;
  messages: Message[];
}

function sessionsDir(): string {
  // 与 session.ts 同一注入点：测试不得读写用户真实会话。
  const env = process.env["NEO_SESSIONS_DIR"];
  if (env) return env;
  return join(homedir(), ".neo", "sessions");
}

/** 文件名里的非法字符替换掉：jobId 来自本进程（bg-N），但会话 id 可能含路径分隔符。 */
function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 子代理对话文件路径：`<sessions>/transcripts/<sessionId>/<jobId>.json`。 */
export function transcriptPath(sessionId: string, jobId: string): string {
  return join(sessionsDir(), "transcripts", safeSegment(sessionId), `${safeSegment(jobId)}.json`);
}

/** 单条内容截断（超长保留头部并标注原长）。 */
function clipContent(content: Message["content"]): Message["content"] {
  if (typeof content !== "string") return content;
  if (content.length <= MAX_TRANSCRIPT_CHARS) return content;
  return `${content.slice(0, MAX_TRANSCRIPT_CHARS)}\n…（已截断，原长 ${content.length} 字符）`;
}

/**
 * 裁剪到上限：系统提示恒保留，其余取最近的 N-1 条。
 *
 * 保留系统提示是刻意的：续聊时子代理必须还是同一个身份（同一份提示词），
 * 否则「继续对话」会变成「换个人接着聊」。
 */
function clipMessages(messages: readonly Message[]): Message[] {
  const sys = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const budget = MAX_TRANSCRIPT_MESSAGES - (sys ? 1 : 0);
  const kept = rest.slice(-Math.max(0, budget));
  return [...(sys ? [sys] : []), ...kept].map((m) => ({ ...m, content: clipContent(m.content) }));
}

/** 写子代理对话。失败不抛（落盘是增强项，不能拖垮任务）。 */
export function saveSubagentTranscript(sessionId: string, jobId: string, messages: readonly Message[]): void {
  try {
    const path = transcriptPath(sessionId, jobId);
    mkdirSync(join(sessionsDir(), "transcripts", safeSegment(sessionId)), { recursive: true });
    const data: TranscriptFile = {
      version: 1,
      sessionId,
      jobId,
      messages: clipMessages(messages),
    };
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* 落盘失败不阻断任务 */
  }
}

/** 读子代理对话；缺失 / 损坏 / 形状不对 → null。 */
export function loadSubagentTranscript(sessionId: string, jobId: string): Message[] | null {
  const path = transcriptPath(sessionId, jobId);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const messages = (raw as Record<string, unknown>)["messages"];
  if (!Array.isArray(messages)) return null;
  const out: Message[] = [];
  for (const item of messages) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    const role = m["role"];
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
    out.push(item as Message);
  }
  return out;
}
