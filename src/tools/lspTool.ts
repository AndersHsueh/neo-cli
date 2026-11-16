/**
 * lsp 工具：只读符号导航（issue #23 首期三种 + #43 扩展三种）。
 */
import { lspServers, LSP_OPERATIONS, LSP_POSITION_OPERATIONS, type CallDirection, type LspOperation } from "../lsp/index.ts";
import { ToolError, type ToolImpl } from "./types.ts";
import { abs } from "./fsPaths.ts";

export const lspTool: ToolImpl = {
  sensitive: false,
  kind: "evidence",
  spec: {
    type: "function",
    function: {
      name: "lsp",
      description:
        "只读符号导航（需在 settings.lsp.servers 配好语言服务器，如 typescript-language-server --stdio）。" +
        "operation=definition 找定义、references 找引用、hover 看类型/签名、workspaceSymbol 全仓搜符号（只需 query，不需要位置）、" +
        "callHierarchy 看调用链（direction=incoming 谁调我 / outgoing 我调谁）、completion 看补全候选。" +
        "除 workspaceSymbol 外都需要 file + line。未配置/未连接时返回可读错误；不写盘、无副作用。",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: [...LSP_OPERATIONS], description: "要做的查询" },
          file: { type: "string", description: "文件路径（相对项目根或绝对路径）；workspaceSymbol 不需要" },
          line: { type: "integer", description: "行号，1 起；workspaceSymbol 不需要" },
          character: { type: "integer", description: "列号，1 起；默认 1" },
          query: { type: "string", description: "workspaceSymbol 的搜索词；空串 = 尽量列出全仓符号" },
          direction: {
            type: "string",
            enum: ["incoming", "outgoing"],
            description: "callHierarchy 的方向：incoming=谁调用我（默认），outgoing=我调用了谁",
          },
        },
        required: ["operation"],
      },
    },
  },
  async execute(args, ctx) {
    if (!lspServers.configured) {
      throw new ToolError(
        "没有可用的语言服务器：在 settings.json 的 lsp.servers 里配置（如 " +
          '{ "command": "typescript-language-server", "args": ["--stdio"] }），未配置时该工具零开销不可用。',
      );
    }
    const op = String(args["operation"] ?? "");
    if (!isLspOperation(op)) {
      throw new ToolError(`operation 只能是 ${LSP_OPERATIONS.join(" / ")}（得到 "${op}"）`);
    }
    const direction = parseCallDirection(args["direction"], op);
    // workspaceSymbol 是全仓查询：不需要文件，也不需要位置。
    if (op === "workspaceSymbol") {
      const query = args["query"] === undefined ? "" : String(args["query"]);
      try {
        return await lspServers.navigate(op, { file: "", line: 1, character: 1 }, query, direction);
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
    }
    const file = String(args["file"] ?? "").trim();
    if (file === "") throw new ToolError("file 为空");
    if (LSP_POSITION_OPERATIONS.includes(op)) {
      const line = Number(args["line"]);
      if (args["line"] === undefined || !Number.isInteger(line) || line < 1) {
        throw new ToolError(`${op} 需要 line（≥1 的整数）；只有 workspaceSymbol 不需要位置`);
      }
    }
    const line = Number(args["line"]);
    const character = args["character"] === undefined ? 1 : Number(args["character"]);
    if (!Number.isInteger(character) || character < 1) throw new ToolError("character 必须是 ≥1 的整数");
    try {
      return await lspServers.navigate(op, { file: abs(ctx, file), line, character }, undefined, direction);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
  },
};

function isLspOperation(v: string): v is LspOperation {
  return (LSP_OPERATIONS as readonly string[]).includes(v);
}

/** direction 只对 callHierarchy 有意义；其它 operation 传了就报错，避免静默忽略。 */
function parseCallDirection(raw: unknown, op: LspOperation): CallDirection | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const v = String(raw);
  if (v !== "incoming" && v !== "outgoing") {
    throw new ToolError(`direction 只能是 incoming / outgoing（得到 "${v}"）`);
  }
  if (op !== "callHierarchy") {
    throw new ToolError(`direction 只用于 callHierarchy（当前 operation=${op}）`);
  }
  return v;
}
