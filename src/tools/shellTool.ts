/**
 * shell / shell_output 工具：前台或后台执行命令，并按 id 读取后台输出。
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ToolError, gateTool, notExecuted, type ToolImpl } from "./types.ts";
import { backgroundShells, shellStatusLabel } from "./backgroundShell.ts";
import { shellMarks } from "./shellMarks.ts";
import { getShell, prepareShellInvocation, shellErrorHint } from "../shell.ts";

export const shell: ToolImpl = {
  sensitive: true,
  kind: "capability",
  spec: {
    type: "function",
    function: {
      name: "shell",
      description:
        "在 shell 中执行命令并返回 stdout/stderr/退出码。用于运行构建、测试、git 等。默认 120 秒超时；" +
        "长跑命令（dev server / watch / 长测试）传 background:true 立刻返回 id，前台超时也会自动转后台而不是被杀。" +
        "执行前需用户批准。" +
        "shell 由当前平台自动选择（macOS/Linux 用 $SHELL 或 bash，Windows 用 PowerShell），命令需兼容系统提示词「## 环境」里声明的 shell。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令" },
          cwd: {
            type: "string",
            description:
              "命令工作目录（相对项目根或绝对路径）。只影响本次调用，不改变会话 cwd；默认项目根。",
          },
          timeout_ms: { type: "integer", description: "超时毫秒，默认 120000" },
          background: {
            type: "boolean",
            description:
              "true = 后台跑：立刻返回命令 id（sh-N），不阻塞会话（dev server / watch / 长测试）。" +
              "之后用 shell_output 按 id 读输出与退出码，用户可用 /ps 查看、/ps kill 停止。",
          },
        },
        required: ["command"],
      },
    },
  },
  async execute(args, ctx) {
    const command = String(args["command"] ?? "").trim();
    if (!command) throw new ToolError("command 为空");
    const timeout = Math.max(1000, Number(args["timeout_ms"] ?? 120_000) || 120_000);
    // v0.4.1 B4 / D2：每次调用可指定 cwd（实战里 56/66 条命令都在手写 cd）。
    const rawCwd = args["cwd"] === undefined ? null : String(args["cwd"]);
    let workdir = ctx.cfg.cwd;
    if (rawCwd && rawCwd.trim() !== "") {
      workdir = resolve(ctx.cfg.cwd, rawCwd);
      if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
        throw new ToolError(`cwd 不是目录: ${workdir}`);
      }
    }

    const denied = await gateTool(
      ctx,
      "shell",
      args,
      workdir === ctx.cfg.cwd ? `执行: ${command}` : `执行（cwd=${workdir}）: ${command}`,
    );
    if (denied !== null) notExecuted(denied);

    // v0.4.0 平台适配层：shell 由 resolveShell 探测（配置/环境变量/$SHELL/平台默认），
    // 登录 shell 会注入 PATH 保真前缀，避免「neo 能跑的 bun 在工具里 not found」。
    const spec = getShell(ctx.cfg);
    const invocation = prepareShellInvocation(spec, command, {
      ...process.env,
      NO_COLOR: process.env.NO_COLOR ?? "1",
    });
    // issue #28：统一交给后台管理器接管。前台 = 等它结束；超时不杀，转后台可回读。
    const started = (() => {
      try {
        return backgroundShells.start(invocation.argv, workdir, invocation.env, {
          command,
          cwd: workdir,
        });
      } catch (e) {
        throw new ToolError(`无法启动 shell：${shellErrorHint(e, spec)}`);
      }
    })();
    if (!started.ok) throw new ToolError(started.error);
    const id = started.id;

    if (args["background"] === true) {
      return (
        `后台命令已启动（id=${id}）。用 shell_output（id=${id}）读后续输出与退出码；` +
        `用户可用 /ps 查看、/ps kill ${id} 停止。`
      );
    }

    // 前台：ESC/Ctrl+C（ctx.signal）仍然要能打断正在跑的命令。
    const onAbort = (): void => {
      backgroundShells.kill(id);
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const waited = await backgroundShells.wait(id, timeout);
    ctx.signal?.removeEventListener("abort", onAbort);

    if (!waited.exited) {
      // 超时转后台：不杀进程，返回 id 让模型/用户继续观察（issue #28 验收 3）。
      return (
        `命令超过 ${timeout}ms 未结束，已转入后台（id=${id}）。` +
        `用 shell_output（id=${id}）读输出，/ps kill ${id} 停止。`
      );
    }

    const view = backgroundShells.view(id);
    const parts = [shellMarks.cmd(command)];
    if (view?.out.trim()) parts.push(view.out.trimEnd());
    if (view?.err.trim()) parts.push(`${shellMarks.stderr}${view.err.trimEnd()}`);
    parts.push(shellMarks.exit(waited.code ?? -1));
    backgroundShells.forget(id);
    return parts.join("\n");
  },
};

/* ------------------------------------------------------------------ */
/* shell_output：按 id 读后台命令                                      */
/* ------------------------------------------------------------------ */

export const shellOutput: ToolImpl = {
  sensitive: false,
  kind: "evidence",
  spec: {
    type: "function",
    function: {
      name: "shell_output",
      description:
        "读一条后台命令（shell background:true 启动、或前台超时被转入后台）的当前状态与输出。" +
        "id 形如 sh-1（shell 工具返回，也可用 /ps 查看）。只读，不改变进程。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "后台命令 id，如 sh-1" },
          tail_lines: { type: "integer", description: "只取末尾多少行（默认 200，上限 2000）" },
        },
        required: ["id"],
      },
    },
  },
  async execute(args, _ctx) {
    const id = String(args["id"] ?? "").trim();
    if (!id) throw new ToolError("id 为空");
    const view = backgroundShells.view(id);
    if (!view) throw new ToolError(`没有 id=${id} 的后台命令（用 /ps 查看当前列表）`);
    const tail = Math.max(1, Math.min(2_000, Number(args["tail_lines"] ?? 200) || 200));
    const full = backgroundShells.output(id) ?? "";
    const lines = full === "" ? [] : full.split("\n");
    const body = lines.length > tail ? lines.slice(-tail).join("\n") : full;
    const code = view.exitCode === null ? "" : `（exit ${view.exitCode}）`;
    const head = `$ ${view.command}\n状态：${shellStatusLabel(view.status)}${code} · 已跑 ${Math.round(view.elapsedMs / 1000)}s · cwd=${view.cwd}`;
    return body === "" ? `${head}\n（暂无输出）` : `${head}\n${body}`;
  },
};
