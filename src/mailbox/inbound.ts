/**
 * mailbox/inbound.ts — 入站策略判定与消息/通知的文本框架（M2）。
 *
 * 规格：docs/cross-session-messaging-prd[done].md v1.2 §4.5 / §4.6 / §4.10.4。
 * 纯函数，无 IO；便于单独测试。
 */
import type { Envelope, InboundPolicy, PermissionMode, WatchdogNotice } from "./types.ts";

export type InboundDecision = "accept" | "hold" | "refuse";

/**
 * 入站三态 + 权限档自动判定（PRD §4.6）。
 *
 * 信任档由接收方的暴露面决定，不由发送方声明决定：
 *  - 显式 accept/hold/refuse 直接生效；
 *  - auto：接收方 auto-all（无权限提示兜底）→ 默认 hold，除非发送方也声明 auto-all；
 *  - auto：接收方 ask/auto-edit/plan（有提示兜底）→ 默认 accept，仅当发送方声明 auto-all 时 hold。
 */
export function decideInbound(
  policy: InboundPolicy | "auto",
  receiverMode: PermissionMode,
  senderMode: PermissionMode,
): InboundDecision {
  if (policy !== "auto") return policy;
  if (receiverMode === "auto-all") return senderMode === "auto-all" ? "accept" : "hold";
  return senderMode === "auto-all" ? "hold" : "accept";
}

function senderLabel(env: Envelope): string {
  return env.from.name ? `@${env.from.name}` : env.from.session;
}

/** 注入给模型的 user 消息框架（PRD §4.5）。 */
export function formatIncomingFrame(env: Envelope): string {
  const attrs: string[] = [
    `id="${env.id}"`,
    `from="${senderLabel(env)}"`,
    `session="${env.from.session}"`,
    `mode="${env.from.mode}"`,
    `sent_at="${env.created_at}"`,
  ];
  if (env.reply_to) attrs.push(`reply_to="${env.reply_to}"`);
  if (env.exec) attrs.push(`exec="${Math.round(env.exec.ms / 1000)}s"`);
  return `<跨会话消息 ${attrs.join(" ")}>\n${env.body}\n</跨会话消息>`;
}

/** 注入前打印的一行暗淡预览。 */
export function formatPreview(env: Envelope): string {
  const body = env.body.replace(/\s+/g, " ").trim();
  const clipped = body.length > 60 ? `${body.slice(0, 60)}…` : body;
  return `› 来自 ${senderLabel(env)} (${env.from.session})：${clipped}`;
}

/** 宿主按状态机生成的告警（不是对方发来的消息，也不是用户指令）。 */
export function formatNotice(n: WatchdogNotice): string {
  const target = n.target_name ? `@${n.target_name}` : n.target_id;
  return (
    `<跨会话状态通知 target="${target}" session="${n.target_id}" kind="${n.kind}">\n` +
    `任务 ${n.message_id}：「${n.body_preview}」\n` +
    `${n.detail}\n` +
    `</跨会话状态通知>`
  );
}

/** 状态通知的一行预览。 */
export function formatNoticePreview(n: WatchdogNotice): string {
  return `⚠ 跨会话告警（${n.kind}）：${n.target_name ?? n.target_id} — ${n.detail}`;
}
