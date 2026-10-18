/**
 * /tier 命令回归测试。
 *
 * 运行：bun test tests/tier-command.test.ts
 *
 * ============================================================================
 * 【为什么必须用子进程，不能直接 import handleCommand】
 * ============================================================================
 * 同 skills-command.test.ts：src/index.ts 顶层自执行 main() 并 process.exit，
 * handleCommand 也未导出。只有交互模式读到以 `/` 开头的行才走命令分支。
 *
 * ============================================================================
 * 【回归背景】
 * ============================================================================
 * 旧代码 `const target = cmd === "deep" ? "deep_reasoning" : cmd;` 永远拿
 * 命令名当档位名，/tier 的参数从未被读取。后果：
 *   /fast /balanced /deep 碰巧能用（命令名即档位名）；
 *   /tier <任何参数> 全部报「未知档位 "tier"」—— 包括拼写完全正确的 /tier default。
 *
 * 测试沙箱用 127.0.0.1:9（discard 端口，必然拒绝连接）作 base_url：
 * applyTier 只改内存配置不发请求，所以切档断言不依赖网络；
 * 沙箱 provider 全部走 openai 协议（已接入），不会触发降级分支。
 * ============================================================================
 */
import { describe, expect, test, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "src", "index.ts");
const made: string[] = [];

/** 建一个带最小 openai provider 配置的工作目录，返回 cwd。 */
function makeProject(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "neo-tier-cmd-")));
  // 假 home：src/session.ts 把会话写进 join(homedir(), ".neo", "sessions")，
  // 不隔离 HOME 会污染用户真实目录（同 skills-command.test.ts 的处理）。
  mkdirSync(join(cwd, "fakehome"), { recursive: true });
  writeFileSync(
    join(cwd, "settings.json"),
    JSON.stringify({
      providers: [
        {
          provider_name: "test",
          provider_type: "openai",
          base_url: "http://127.0.0.1:9/v1",
          api_key: "sk-test",
          default_model_name: "m-default",
          deep_reasoning_model_name: "m-deep",
          balanced_model_name: "m-balanced",
          fast_model_name: "m-fast",
        },
      ],
    }),
    "utf8",
  );
  made.push(cwd);
  return cwd;
}

/** 在 cwd 下跑一串斜杠命令，返回合并后的 stdout+stderr。 */
function runCommands(cwd: string, cmds: string[]): string {
  return execFileSync(process.execPath, [ENTRY], {
    cwd,
    input: `${cmds.join("\n")}\n/exit\n`,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: join(cwd, "fakehome"),
      USERPROFILE: join(cwd, "fakehome"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("/tier 命令", () => {
  test("R1 /tier <name> 按参数切档，而不是把命令名当档位", () => {
    const out = runCommands(makeProject(), ["/tier fast"]);
    expect(out).toContain("档位 → fast");
    expect(out).toContain("m-fast");
    expect(out).not.toContain('未知档位 "tier"');
  });

  test("R2 /tier default 能切回 default 档（原始 bug 现场）", () => {
    const out = runCommands(makeProject(), ["/tier fast", "/tier default"]);
    expect(out).toContain("档位 → fast");
    expect(out).toContain("档位 → default");
    expect(out).toContain("m-default");
  });

  test("R3 /tier 不带参数是查询：列出全部档位路由", () => {
    const out = runCommands(makeProject(), ["/tier"]);
    expect(out).toContain("当前档位");
    expect(out).toContain("生效路由");
    expect(out).toContain("用 /tier <name> 切换");
    expect(out).toContain("deep_reasoning");
  });

  test("R4 /tier 尾随空格仍视为查询，不报未知档位", () => {
    const out = runCommands(makeProject(), ["/tier "]);
    expect(out).toContain("当前档位");
    expect(out).not.toContain('未知档位 ""');
  });

  test("R5 拼错的档位名报错，错误信息引用参数本身", () => {
    const out = runCommands(makeProject(), ["/tier defualt"]);
    expect(out).toContain('未知档位 "defualt"');
    expect(out).toContain("default, deep_reasoning, balanced, fast");
  });

  test("R6 /fast 快捷命令不受本次修复影响", () => {
    const out = runCommands(makeProject(), ["/fast"]);
    expect(out).toContain("档位 → fast");
    expect(out).toContain("m-fast");
  });
});
