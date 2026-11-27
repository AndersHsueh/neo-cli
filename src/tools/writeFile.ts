/**
 * write_file / edit_file 工具：覆盖写入与精确替换，审批通过后再落盘。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { lspServers } from "../lsp/index.ts";
import { ToolError, gateTool, notExecuted, type ToolImpl } from "./types.ts";
import { abs, assertNotGlobalSkills, assertRawImmutable, requireFile } from "./fsPaths.ts";
import { staleWriteModelReason, staleWriteUserNotice } from "./fileFreshness.ts";

export const writeFileTool: ToolImpl = {
  sensitive: true,
  kind: "neither",
  spec: {
    type: "function",
    function: {
      name: "write_file",
      description: "写入文本文件（覆盖）。父目录会自动创建。这会破坏原内容，执行前需用户批准。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "完整文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args, ctx) {
    const path = abs(ctx, String(args["path"] ?? ""));
    assertNotGlobalSkills(ctx, path);
    assertRawImmutable(ctx, path);
    const content = String(args["content"] ?? "");
    const isNew = !existsSync(path);
    const detail = isNew ? `新建文件 ${path}` : `覆盖已有文件 ${path}（${content.length} 字符）`;
    // issue #94：路径已解析，在 gateTool 之前检测中间改动。过期则不弹审批、
    // 不跑 PreToolUse / beforeWrite，经 notExecuted 退出，不改磁盘。
    const stale = ctx.fileFreshness?.staleKind(path);
    if (stale) {
      ctx.onNotice?.(staleWriteUserNotice(path));
      notExecuted(staleWriteModelReason(path, stale));
    }
    // 审批 + PreToolUse（issue #3）：顺序由 gateTool 固化 —— 先审批，通过了才跑 hook。
    // hook 只能拦不能放行，所以被用户拒绝的调用根本走不到 hook。
    // 没执行必须走 notExecuted（异常通道），否则 dispatch 会误跑 PostToolUse。
    const denied = await gateTool(ctx, "write_file", args, detail);
    if (denied !== null) notExecuted(denied);
    if (ctx.signal?.aborted) notExecuted("本轮已取消，未执行（write_file）。");

    // 审批通过、写盘之前留检查点（P0-4）。失败不阻塞写入。
    try {
      ctx.checkpoint?.beforeWrite(path, "write_file");
    } catch {
      /* 检查点是增强项：失败不阻止写盘 */
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    ctx.fileFreshness?.recordCompleteWrite(path, content);
    // issue #23：编辑后诊断（没配语言服务器时 afterEdit 恒返回 ""，零开销）。
    const lspNote = await lspServers.afterEdit(path).catch(() => "");
    return `${isNew ? "已创建" : "已覆盖"} ${path}（${content.length} 字符，${content.split("\n").length} 行）${lspNote}`;
  },
};

export const editFile: ToolImpl = {
  sensitive: true,
  kind: "neither",
  spec: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "在文件中做精确字符串替换。old_string 必须在文件中唯一出现（出现多次会失败）。可传 replace_all 做全量替换。执行前需用户批准。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string", description: "要替换的原文，必须唯一" },
          new_string: { type: "string", description: "替换后的新文本" },
          replace_all: { type: "boolean", description: "是否替换所有出现，默认 false" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  async execute(args, ctx) {
    const path = abs(ctx, String(args["path"] ?? ""));
    assertNotGlobalSkills(ctx, path);
    assertRawImmutable(ctx, path);
    requireFile(path);
    const oldS = String(args["old_string"] ?? "");
    const newS = String(args["new_string"] ?? "");
    const all = args["replace_all"] === true || args["replace_all"] === "true";

    if (oldS === "") throw new ToolError("old_string 不能为空");

    const src = readFileSync(path, "utf8");
    const count = src.split(oldS).length - 1;
    if (count === 0) throw new ToolError(`在 ${path} 中找不到 old_string`);
    if (count > 1 && !all) {
      throw new ToolError(
        `old_string 在 ${path} 中出现 ${count} 次，不唯一。请加入更多上下文使其唯一，或设置 replace_all=true`,
      );
    }

    const denied = await gateTool(
      ctx,
      "edit_file",
      args,
      `修改 ${path}：${count > 1 ? `替换全部 ${count} 处` : "替换 1 处"}`,
    );
    if (denied !== null) notExecuted(denied);
    if (ctx.signal?.aborted) notExecuted("本轮已取消，未执行（edit_file）。");

    // 审批通过、写盘之前留检查点（P0-4）。失败不阻塞写入。
    try {
      ctx.checkpoint?.beforeWrite(path, "edit_file");
    } catch {
      /* 检查点是增强项：失败不阻止写盘 */
    }

    // 按字面写入，绝不能用 String.replace(old, new)：new_string 里的 $&、$1、$$、
    // $`、$' 会被当成替换模式展开，静默写坏代码（P0-3）。此时 count 已确认，
    // split/join 与单次 replace 语义等价，且没有模式展开。
    const out = src.split(oldS).join(newS);
    writeFileSync(path, out, "utf8");
    // issue #23：编辑后诊断（零配置零开销）。
    const lspNote = await lspServers.afterEdit(path).catch(() => "");
    return `已修改 ${path}（${all ? count : 1} 处）${lspNote}`;
  },
};
