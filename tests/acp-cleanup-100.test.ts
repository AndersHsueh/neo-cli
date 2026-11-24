/**
 * issue #100：ACP 会话释放走 cleanupEphemeral，并按 (a) 隐藏 monitor。
 *
 * 覆盖已签切面：
 *  1. 进程组回收：在 ACP 会话内用 sessionMonitors.start 拉起「组长可先退、
 *     子进程仍在同一 pgid」的监视；dispose 前先断言组内仍有非僵尸成员，
 *     dispose 后断言组内不再有活动子进程（不得只等组长 exit / dispose 返回）。
 *  2. 隐藏口径：ACP 的 toolSpecsFor 与系统提示都不含 monitor；dispatch 被拒
 *     且不拉起进程。CLI 默认仍暴露 monitor。
 *
 * 形态：同进程调用 createAcpSession（测试直接往监视表里塞任务，符合切面）；
 * 不另起一套 ACP 进程脚手架。禁止 mock.module，不触网，不读真实 ~/.neo。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAcpSession } from "../src/acp/session.ts";
import { Agent } from "../src/agent.ts";
import type { AgentOptions } from "../src/agent/types.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { resetMonitors, sessionMonitors } from "../src/monitors.ts";
import { PromptManager, type PromptManagerOptions } from "../src/prompt/manager.ts";
import { groupAlive, groupHasNonZombie } from "../src/processGroup.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import { dispatch } from "../src/tools/index.ts";
import { Console } from "../src/ui/console.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-acp-100-")));
const sessionsDir = join(SANDBOX, "sessions");
const homeDir = join(SANDBOX, "home");
mkdirSync(join(homeDir, ".neo"), { recursive: true });

const ISOLATED_ENV: Record<string, string> = {
  HOME: homeDir,
  NEO_SESSIONS_DIR: sessionsDir,
  NEO_MAILBOX_DIR: join(SANDBOX, "mailbox"),
  NEO_MEMORY_DIR: join(SANDBOX, "memory"),
  NEO_USER_WIKI_DIR: join(SANDBOX, "wiki"),
  NEO_MEMORY_JOURNAL_DIR: join(SANDBOX, "journal"),
  NEO_TMP_DIR: join(SANDBOX, "tmp"),
  NEO_MEMORY_DISABLE: "1",
};

const savedEnv: Record<string, string | undefined> = {};
for (const key of Object.keys(ISOLATED_ENV)) savedEnv[key] = process.env[key];
for (const key of ["NEO_API_KEY", "NEO_BASE_URL", "NEO_PROVIDER", "NEO_MODEL", "NEO_TIER"]) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}
Object.assign(process.env, ISOLATED_ENV);

let caseSeq = 0;

afterEach(() => {
  resetMonitors();
});

afterAll(() => {
  resetMonitors();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

function writeSettings(dir: string): void {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(
      {
        default_provider: "fake",
        default_model_tier: "default",
        classifier_provider: "fake",
        classifier_model_name: "fake-model",
        providers: [
          {
            provider_name: "fake",
            provider_type: "openai",
            base_url: "http://127.0.0.1:9/v1",
            api_key: "test",
            default_model_name: "fake-model",
            deep_reasoning_model_name: "fake-model",
            balanced_model_name: "fake-model",
            fast_model_name: "fake-model",
            max_tokens: 64,
            temperature: 0,
            context_window: 100_000,
          },
        ],
        retry: { max_attempts: 1, base_delay_ms: 1, connect_timeout_ms: 1_000, stream_idle_timeout_ms: 1_000 },
        memory: {
          enabled: false,
          user_level_dir: join(SANDBOX, "memory"),
          user_wiki_dir: join(SANDBOX, "wiki"),
          journal_dir: join(SANDBOX, "journal"),
        },
        env: { enabled: false, prompt: false, wiki_page: false },
        skills_store: join(SANDBOX, "skills"),
        agents_store: join(SANDBOX, "agents"),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function project(): string {
  const dir = join(SANDBOX, `p${caseSeq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir);
  return dir;
}

function loadIsolatedConfig(cwd: string): Config {
  const cfg = loadConfig({ cwd }, { settingsDir: cwd });
  cfg.cwd = cwd;
  cfg.memory.enabled = false;
  if (cfg.env) {
    cfg.env.enabled = false;
    cfg.env.prompt = false;
    cfg.env.wikiPage = false;
  }
  return cfg;
}

function silentConsole(): Console {
  return new Console(false, false, {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    write: () => undefined,
  });
}

function makeAgent(cfg: Config, over: Partial<AgentOptions> = {}): Agent {
  return new Agent({
    cfg,
    console: silentConsole(),
    mode: "ask",
    systemPrompt: "sys",
    approve: async () => true,
    ...over,
  });
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(20);
  }
  return pred();
}

function readPid(file: string): number | null {
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

function toolNamesOf(prompt: string): string[] {
  const line = prompt.split("\n").find((l) => l.startsWith("可用工具："));
  if (!line) return [];
  return line
    .slice("可用工具：".length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function monitorOrphanCommand(dir: string): { command: string; childFile: string; pgidFile: string; leaderFile: string } {
  const childFile = join(dir, "child.pid");
  const pgidFile = join(dir, "pgid");
  const leaderFile = join(dir, "leader.pid");
  // 监视启动时已经用 shell + detached 拉起，这段就是组长的脚本：
  // 写下 pid/pgid，后台挂起 sleep，然后立刻 exit。sleep 仍留在同一进程组。
  const command =
    `printf "%s\\n" "$$" > ${JSON.stringify(leaderFile)}; ` +
    `printf "%s\\n" "$(ps -o pgid= -p $$ | tr -d " ")" > ${JSON.stringify(pgidFile)}; ` +
    `sleep 300 & printf "%s\\n" "$!" > ${JSON.stringify(childFile)}; exit 0`;
  return { command, childFile, pgidFile, leaderFile };
}

describe("#100 ACP 隐藏 monitor 口径", () => {
  test("#100 ACP PromptManager（monitor: false）系统提示不含 monitor 行与 /monitor", () => {
    const cwd = project();
    const cfg = loadIsolatedConfig(cwd);
    const pm = new PromptManager({
      mailbox: false,
      askUser: false,
      nonInteractive: true,
      monitor: false,
    } as PromptManagerOptions);
    const text = pm.render(cfg).text;
    expect(text).not.toContain("monitor：");
    expect(text).not.toContain("用户也可用 /monitor");
    expect(toolNamesOf(text)).not.toContain("monitor");
  });

  test("#100 CLI 默认系统提示仍暴露 monitor（不回退）", () => {
    const cwd = project();
    const cfg = loadIsolatedConfig(cwd);
    const pm = new PromptManager({ mailbox: false, askUser: false });
    const text = pm.render(cfg).text;
    expect(text).toContain("monitor：");
    expect(text).toContain("用户也可用 /monitor");
    expect(toolNamesOf(text)).toContain("monitor");
    const raw = buildSystemPrompt(cfg, { mailbox: false, askUser: false });
    expect(raw).toContain("monitor：");
    expect(toolNamesOf(raw)).toContain("monitor");
  });

  test("#100 ACP Agent.excludeTools 使 toolSpecsFor 不含 monitor，dispatch 被拒且不拉起进程", async () => {
    const cwd = project();
    const cfg = loadIsolatedConfig(cwd);
    const agent = makeAgent(cfg, { excludeTools: ["monitor"], nonInteractive: true } as Partial<AgentOptions>);
    expect(agent.toolSpecsFor().map((s) => s.function.name)).not.toContain("monitor");

    const before = sessionMonitors.runningCount();
    const ctx = agent.makeCtx(new AbortController().signal);
    const result = await dispatch("monitor", JSON.stringify({ command: "sleep 300", action: "start" }), ctx);
    expect(result.ok).toBe(false);
    expect(result.executed).toBe(false);
    expect(result.output.startsWith("未知工具")).toBe(true);
    expect(sessionMonitors.runningCount()).toBe(before);
  });

  test("#100 CLI Agent 默认 toolSpecsFor 仍含 monitor（不回退）", () => {
    const cwd = project();
    const cfg = loadIsolatedConfig(cwd);
    const agent = makeAgent(cfg);
    expect(agent.toolSpecsFor().map((s) => s.function.name)).toContain("monitor");
  });
});

describe("#100 ACP 会话装配与 dispose 回收监视进程组", () => {
  test("#100 createAcpSession 隐藏 monitor，且 dispose 回收组长已退的进程组子进程", async () => {
    const cwd = project();
    const cfg = loadIsolatedConfig(cwd);
    const orphan = monitorOrphanCommand(cwd);
    const session = await createAcpSession({
      cfg,
      cwd,
      onText: () => undefined,
    });
    let pgid: number | null = null;
    let child: number | null = null;
    try {
      // 先把隐藏口径记下来，但不中途 throw，这样进程组对照在红态也能跑到。
      const hideProblems: string[] = [];
      const names = session.agent.toolSpecsFor().map((s) => s.function.name);
      if (names.includes("monitor")) hideProblems.push("toolSpecsFor 仍含 monitor");
      const system = session.agent.messages[0]?.content;
      const text = typeof system === "string" ? system : "";
      if (typeof system !== "string") hideProblems.push("系统提示不是字符串");
      if (text.includes("monitor：")) hideProblems.push("系统提示仍含 monitor：行");
      if (text.includes("用户也可用 /monitor")) hideProblems.push("系统提示仍含「用户也可用 /monitor」");
      if (toolNamesOf(text).includes("monitor")) hideProblems.push("可用工具行仍含 monitor");

      const before = sessionMonitors.runningCount();
      const denied = await dispatch(
        "monitor",
        JSON.stringify({ command: "sleep 300", action: "start" }),
        session.agent.makeCtx(new AbortController().signal),
      );
      if (denied.ok || denied.executed !== false || !denied.output.startsWith("未知工具")) {
        hideProblems.push(`dispatch 未按未知工具拒绝：ok=${denied.ok} executed=${denied.executed} output=${denied.output}`);
      }
      if (sessionMonitors.runningCount() !== before) {
        hideProblems.push("dispatch 后监视表多了任务（不该拉起进程）");
      }

      const started = sessionMonitors.start({
        command: orphan.command,
        cwd,
        timeoutMs: 10 * 60_000,
      });
      expect(started.ok).toBe(true);

      expect(await waitFor(() => readPid(orphan.childFile) !== null && readPid(orphan.pgidFile) !== null, 5_000)).toBe(true);
      child = readPid(orphan.childFile);
      pgid = readPid(orphan.pgidFile);
      expect(child).not.toBeNull();
      expect(pgid).not.toBeNull();
      const groupId = pgid as number;
      const childPid = child as number;

      // 等组长先退，但子进程必须还在同一组里（评论里的对照）。
      const leader = readPid(orphan.leaderFile);
      expect(await waitFor(() => leader !== null && !isPidAlive(leader as number), 5_000)).toBe(true);
      await Bun.sleep(50);

      // dispose 之前：组内仍有非僵尸成员（就是那个 sleep 子进程），且它活着。
      expect(groupHasNonZombie(groupId)).toBe(true);
      expect(groupAlive(groupId)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);

      session.dispose();

      // 不得只等 dispose 返回：再轮询组内活动子进程是否消失。
      const reaped = await waitFor(
        () => !groupHasNonZombie(groupId) && !groupAlive(groupId) && !isPidAlive(childPid),
        5_000,
      );
      // 两项一起断言，避免隐藏口径先失败时看不到进程组回收的红点。
      expect({ hideProblems, reaped, groupHasNonZombie: groupHasNonZombie(groupId), groupAlive: groupAlive(groupId), childAlive: isPidAlive(childPid) }).toEqual({
        hideProblems: [],
        reaped: true,
        groupHasNonZombie: false,
        groupAlive: false,
        childAlive: false,
      });
    } finally {
      try {
        session.dispose();
      } catch {
        /* 幂等 */
      }
      if (pgid !== null) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          /* 组已空 */
        }
      }
      killPid(child);
      resetMonitors();
    }
  }, 30_000);
});
