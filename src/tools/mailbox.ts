/**
 * tools/mailbox.ts — send_message / list_peers 工具实现（M2）。
 *
 * 规格：docs/cross-session-messaging-prd[done].md v1.2 §4.3 / §4.8 / §4.10。
 * 运行时注册（组合根装配），与 task / wiki / remember 同一模式；
 * 子代理不可见（加入 TOOL_NAMES_EXCLUDED_FOR_SUBAGENT）。
 */
import type { Mailbox } from "../mailbox/store.ts";
import { MailboxError, type Envelope } from "../mailbox/types.ts";
import { ToolError, type ToolImpl } from "./types.ts";

export interface SendMessageDeps {
  mailbox: Mailbox;
  /**
   * 缺省 reply_to 的自动补全：当本会话最近收到该 target 的任务且尚未回信时，
   * 返回那条消息 id（= 任务号）。由组合根维护 inbound 提示表。
   */
  replyHint?: (target: string) => string | undefined;
  /** 发送成功后回调（组合根用来清理 replyHint）。 */
  onSent?: (env: Envelope, replyTo: string | undefined) => void;
}

export function makeSendMessageTool(deps: SendMessageDeps): ToolImpl {
  return {
    // 投递本身不直接改工作区；它只写信箱文件，属于会话协作而非文件操作。
    sensitive: false,
    spec: {
      type: "function",
      function: {
        name: "send_message",
        description:
          "给另一个存活的 neo 会话投递一条纯文本消息（跨会话协作/派活/回信）。" +
          "消息不携带上下文或文件；对方的路径/结论请写在正文里。" +
          "回信时把原任务消息 id 传给 reply_to，宿主会自动计算执行时长。" +
          "对方进程已退出时返回错误；v1 不排队、不缓存。",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "目标：精确 session id > id 片段 > 名字（/rename 设置的名字）",
            },
            body: { type: "string", description: "纯文本正文，不要超过 100k 字符" },
            reply_to: {
              type: "string",
              description: "可选：在回哪条消息（任务号 = 原消息 id）。缺省时宿主尝试自动填",
            },
            expect_reply: {
              type: "boolean",
              description: "可选：是否把这条登记为等待回信的委派。默认非回信消息为 true；纯通知可传 false",
            },
          },
          required: ["target", "body"],
        },
      },
    },
    execute(args) {
      const target = String(args["target"] ?? "").trim();
      const body = typeof args["body"] === "string" ? args["body"] : "";
      const replyArg = typeof args["reply_to"] === "string" ? args["reply_to"].trim() : "";
      const expectRaw = args["expect_reply"];
      const expectReply = typeof expectRaw === "boolean" ? expectRaw : undefined;
      if (!target) throw new ToolError("target 不能为空");
      if (!body.trim()) throw new ToolError("body 不能为空");

      const replyTo = replyArg || deps.replyHint?.(target);
      try {
        const env = deps.mailbox.send(target, body, { reply_to: replyTo, expect_reply: expectReply });
        deps.onSent?.(env, replyTo);
        const who = env.from.name ? `@${env.from.name}` : env.from.session;
        const replyNote = replyTo ? `（回应任务 ${replyTo}）` : "";
        return (
          `已投递到 ${env.to}${replyNote}，消息 id=${env.id}。` +
          `发起方：${who}。` +
          `若对方需要回信，请让它在回信时把 id 作为 reply_to 传回。`
        );
      } catch (e) {
        if (e instanceof MailboxError) throw new ToolError(e.message);
        throw e;
      }
    },
  };
}

export interface ListPeersDeps {
  mailbox: Mailbox;
}

export function makeListPeersTool(deps: ListPeersDeps): ToolImpl {
  return {
    sensitive: false,
    spec: {
      type: "function",
      function: {
        name: "list_peers",
        description:
          "列出当前存活的 neo 会话及其状态机摘要（空闲/工作中/等待人类/在等别的会话/停滞/已死）。" +
          "带 target 时查询单个会话详情。只读；不要求先有任务。",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: "可选：session id / id 片段 / 名字，查单个会话详情" },
          },
          required: [],
        },
      },
    },
    execute(args) {
      const target = typeof args["target"] === "string" ? args["target"].trim() : "";
      try {
        if (target) return describePeer(deps.mailbox, target);
        return listAll(deps.mailbox);
      } catch (e) {
        if (e instanceof MailboxError) throw new ToolError(e.message);
        throw e;
      }
    },
  };
}

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    starting: "启动中",
    idle: "空闲",
    working: "工作中",
    waiting_input: "等待人类",
    exiting: "退出中",
  };
  return map[phase] ?? phase;
}

function listAll(mailbox: Mailbox): string {
  const peers = mailbox.peers();
  if (peers.length <= 1) {
    return "没有其他可达会话（v1 只服务活着的前台进程；用 /rename 命名后保持终端存活）";
  }
  const lines = [`可达会话 ${peers.length} 个：`];
  for (const p of peers) {
    const self = p.is_self ? "（自己）" : "";
    const name = p.name ? `@${p.name}` : "(未命名)";
    const eff = p.effective === "alive" ? "alive" : p.effective === "stale" ? "stale" : "dead";
    const st = p.state;
    const phase = st ? phaseLabel(st.phase) : "无状态文件";
    const hb = p.heartbeat_age_ms >= 0 ? `${Math.round(p.heartbeat_age_ms / 1000)}s前` : "?";
    const outstanding = st?.outstanding.length ?? 0;
    const wait = outstanding > 0 ? ` · 在等 ${outstanding} 个会话` : "";
    const turn = st?.turn ? ` · turn来自 ${st.turn.from ?? st.turn.source}` : "";
    lines.push(
      `- ${name}${self} ${p.session} [${eff}] ${phase} ${hb}${wait}${turn} · mode=${p.mode} · cwd=${p.cwd || "?"}`,
    );
  }
  lines.push("提示：状态由各进程自己维护；dead/stale 表示心跳停止或 .alive 消失。");
  return lines.join("\n");
}

function describePeer(mailbox: Mailbox, target: string): string {
  const profile = mailbox.resolvePeer(target);
  const obs = mailbox.observe(profile.session);
  const st = obs.state;
  const lines = [
    `会话 ${profile.name ? `@${profile.name}` : "(未命名)"} / ${profile.session}`,
    `有效状态：${obs.effective}${obs.alive ? "" : "（.alive 不存在）"}`,
    `phase：${st ? phaseLabel(st.phase) : "无状态文件"}${st ? `（since ${st.since}）` : ""}`,
    `mode：${profile.mode} · cwd：${profile.cwd}`,
    `心跳：${st?.heartbeat_at ?? "?"} · 最后进展：${st?.last_progress_at ?? "?"}`,
    `本轮：${st?.turn ? `${st.turn.source} from ${st.turn.from ?? "-"} since ${st.turn.started_at}` : "无"}`,
    `最近入站：${st?.last_inbound ? `${st.last_inbound.from} / ${st.last_inbound.message_id} @ ${st.last_inbound.at}` : "无"}`,
    `最近出站：${st?.last_outbound ? `${st.last_outbound.to} / ${st.last_outbound.message_id} @ ${st.last_outbound.at}` : "无"}`,
    `在等回信：${(st?.outstanding ?? []).map((o) => o.message_id).join(", ") || "无"}`,
    `inbox 深度：${mailbox.inboxDepthOf(profile.session)}`,
  ];
  return lines.join("\n");
}
