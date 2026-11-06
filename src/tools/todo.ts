/**
 * 结构化待办（issue #10，TodoWrite 类会话 checklist）。
 *
 * 为什么单独做一层纯逻辑：待办是**会话级状态**，不是对话内容。
 * 压缩会把较早历史换成摘要，模型自己写进正文的清单会随之消失；
 * 存在 SessionMeta.todos 里则与 messages 解耦，压缩前后都在。
 *
 * 语义是**整表替换**：模型每次提交完整清单，宿主不做增量合并。
 * 这样「删掉一项」「改状态」都只有一种表达方式，不需要猜 diff。
 *
 * 子代理不可见（TOOL_NAMES_EXCLUDED_FOR_SUBAGENT）：子代理改的是主会话的 checklist，
 * 归属会乱。
 */
import { ToolError, type ToolImpl } from "./types.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];

/** 单条 content 上限：清单是给人看的，不是第二份对话。 */
const MAX_CONTENT = 500;

/** 清单条数上限：防止模型把整份计划书塞进状态条。 */
const MAX_ITEMS = 100;

export function isTodoStatus(v: unknown): v is TodoStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

function idOf(content: string, used: Set<string>, index: number): string {
  // 短 id：内容哈希（稳定）+ 序号兜底（内容重复时也不撞）。
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = (h * 31 + content.charCodeAt(i)) | 0;
  }
  let id = `t${(h >>> 0).toString(36).slice(0, 5)}`;
  if (used.has(id)) id = `t${(h >>> 0).toString(36).slice(0, 5)}${index}`;
  while (used.has(id)) id = `${id}x`;
  return id;
}

/**
 * 校验并规范化整表。
 *
 * 拒绝而不是「尽力修正」：清单是模型自己提交的，静默改写会让它以为状态已生效
 * （比如把两个 in_progress 悄悄改成 pending），下一轮继续基于错的状态推进。
 */
export function normalizeTodos(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) throw new ToolError("todos 必须是数组（整表替换：提交完整清单）");
  if (input.length > MAX_ITEMS) throw new ToolError(`待办最多 ${MAX_ITEMS} 条，当前 ${input.length} 条`);

  const out: TodoItem[] = [];
  const used = new Set<string>();
  let inProgress = 0;

  input.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ToolError(`todos[${i}] 必须是对象 {content, status, id?}`);
    }
    const o = raw as Record<string, unknown>;
    const content = typeof o["content"] === "string" ? o["content"].trim() : "";
    if (content === "") throw new ToolError(`todos[${i}].content 不能为空`);
    if (content.length > MAX_CONTENT) {
      throw new ToolError(`todos[${i}].content 过长（${content.length} 字符 > ${MAX_CONTENT}）`);
    }
    const status = o["status"];
    if (!isTodoStatus(status)) {
      throw new ToolError(
        `todos[${i}].status 非法：${String(status)}（只能是 ${STATUSES.join(" / ")}）`,
      );
    }
    if (status === "in_progress") inProgress += 1;

    const givenId = typeof o["id"] === "string" ? o["id"].trim() : "";
    let id = givenId;
    if (id === "") {
      id = idOf(content, used, i);
    } else if (used.has(id)) {
      throw new ToolError(`todos[${i}].id 重复：${id}（id 在清单内必须唯一）`);
    }
    used.add(id);
    out.push({ id, content, status });
  });

  if (inProgress > 1) {
    throw new ToolError(
      `同时最多一项 in_progress，当前有 ${inProgress} 项。请把其余项改成 pending 或 completed。`,
    );
  }
  return out;
}

const MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  cancelled: "[-]",
};

/** 给人看的清单（工具回执与 /todos 共用）。空清单返回空串。 */
export function formatTodos(items: readonly TodoItem[]): string {
  if (items.length === 0) return "";
  const total = items.length;
  const done = items.filter((t) => t.status === "completed").length;
  const lines = items.map(
    (t) => `${MARK[t.status]} ${t.content}${t.status === "in_progress" ? "  ← 进行中" : ""}`,
  );
  return `待办 ${done}/${total}\n${lines.join("\n")}`;
}

/**
 * 状态条短摘要：`✓2/5`。
 *
 * 分母是**未取消**的条数（取消项不参与进度），分子是 completed。
 * 全部取消或空清单 → null（状态条不显示空壳字段）。
 */
export function todosSummary(items: readonly TodoItem[]): string | null {
  const active = items.filter((t) => t.status !== "cancelled");
  if (active.length === 0) return null;
  const done = active.filter((t) => t.status === "completed").length;
  return `✓${done}/${active.length}`;
}

export interface TodoWriteDeps {
  /** 读当前清单（resume 后来自 meta.todos）。 */
  get: () => TodoItem[];
  /** 整表写回会话态；宿主负责落盘（meta.todos）。 */
  set: (items: TodoItem[]) => void;
  /** 可选的落盘钩子：写完立刻持久化，避免进程被杀时清单丢失。 */
  persist?: () => void;
}

/** 工具回执里附带的机器可读行（模型可据此确认 id 与状态）。 */
function jsonLine(items: readonly TodoItem[]): string {
  return JSON.stringify(items.map((t) => ({ id: t.id, status: t.status, content: t.content })));
}

export function makeTodoWriteTool(deps: TodoWriteDeps): ToolImpl {
  return {
    sensitive: false,
    kind: "neither",
    spec: {
      type: "function",
      function: {
        name: "todo_write",
        description:
          "写入/更新本会话的结构化待办清单（长任务用：多步骤、跨多轮、需要向人汇报进度时）。" +
          "语义是**整表替换**：每次提交完整清单，未提交的项视为删除；改状态也要重发整表。" +
          "状态：pending / in_progress / completed / cancelled。" +
          "**同时最多一项 in_progress**（多于一项会被拒绝）—— 一次只推进一项，完成一项再开始下一项。" +
          "清单存在会话里，压缩上下文后仍然保留；用户可用 /todos 查看。",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "完整清单（整表替换）。空数组 = 清空待办。",
              items: {
                type: "object",
                properties: {
                  content: { type: "string", description: "待办内容（一句话，非空）" },
                  status: {
                    type: "string",
                    enum: [...STATUSES],
                    description: "pending / in_progress / completed / cancelled",
                  },
                  id: {
                    type: "string",
                    description: "可选。省略则自动生成；改状态时原样带回可保持稳定",
                  },
                },
                required: ["content", "status"],
              },
            },
          },
          required: ["todos"],
        },
      },
    },
    execute(args) {
      const items = normalizeTodos(args["todos"]);
      deps.set(items);
      try {
        deps.persist?.();
      } catch {
        // 落盘失败不影响本轮语义：清单已在内存会话态里，退出时还会再存一次
      }
      if (items.length === 0) return "待办已清空。\n[]";
      const done = items.filter((t) => t.status === "completed").length;
      const active = items.find((t) => t.status === "in_progress");
      const head = `已更新待办（${done}/${items.length} 完成${active ? `，进行中：${active.content}` : ""}）`;
      return `${head}\n${formatTodos(items)}\n\n${jsonLine(items)}`;
    },
  };
}
