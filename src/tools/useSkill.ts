/**
 * use_skill 工具：加载技能 SKILL.md 正文与附件清单。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeSource, listSkillFiles, resolveSkill } from "../skills.ts";
import { ToolError, type ToolImpl } from "./types.ts";

export const useSkill: ToolImpl = {
  // 只读：不改任何文件。首次加载全局技能会在 <cwd>/skills/ 建一个软链，
  // 那是一次无害且会在输出里明说的操作，不构成破坏性行为。
  sensitive: false,
  kind: "capability",
  spec: {
    type: "function",
    function: {
      name: "use_skill",
      description:
        "加载指定技能的完整操作说明（SKILL.md 正文）。仅当系统提示的技能索引中某技能与当前任务相关时调用。不相关就不要调用——技能正文会占用上下文。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名，取自技能索引" },
        },
        required: ["name"],
      },
    },
  },
  execute(args, ctx) {
    const r = resolveSkill(ctx.cfg, String(args["name"] ?? ""));
    if (!r.ok) {
      // 抛 ToolError 而非返回字符串 —— dispatch 会转成 ok:false 并计入连续失败数，
      // 模型据此知道这次调用没成功。not_found 时附可用技能清单，帮它自我纠正。
      const hint = r.available.length > 0 ? `\n可用技能：${r.available.join(", ")}` : "";
      throw new ToolError(`${r.message}${hint}`);
    }

    const body = readFileSync(join(r.meta.absPath, "SKILL.md"), "utf8");
    const files = listSkillFiles(r.meta.absPath).filter((f) => f !== "SKILL.md");

    const parts = [body.trimEnd()];
    parts.push("---");
    if (files.length > 0) {
      parts.push("附件（按需自行 read_file 或执行）：");
      for (const f of files) parts.push(`- ${f}`);
    } else {
      parts.push("附件：无");
    }
    parts.push(describeSource(ctx.cfg, r.meta, r.createdLink));
    return parts.join("\n");
  },
};
