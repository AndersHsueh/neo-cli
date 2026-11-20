/**
 * 初次使用向导（issue #88）。
 *
 * 只在交互 TTY 启动且候选路径都没有 settings.json 时进入：请用户输入一份
 * 至少能用的 default provider，复用现有 /models 探测与连通测试，成功后写入
 * ~/.neo/settings.json，再继续正常启动。不改 loadConfig 搜索顺序，不覆盖已有文件。
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

import { DEFAULT_RETRY_CONFIG, normalizeBaseUrl, type Config, type ProviderType } from "../config.ts";
import { userSettingsPath } from "../config/settingsPath.ts";
import { isEndpointAbsent, modelsRequests, chatStream } from "../llm.ts";
import { DEFAULT_MODELS_PROBE_TIMEOUT_MS, outputFromModelEntry } from "../env/modelWindows.ts";
import { c } from "../ui/theme.ts";

export const MISSING_SETTINGS_MESSAGE =
  "尚未找到 settings.json。请先在终端交互运行一次 neo，完成初次配置；或参考 settings.example.json 自行撰写。";

export const DEFAULT_ONBOARD_MAX_TOKENS = 8192;
export const FIRST_USE_PROVIDER_NAME = "default";

export function shouldEnterFirstUseOnboard(input: {
  settingsPath: string | null;
  print: string | null;
  isAcp: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): boolean {
  return (
    input.settingsPath == null &&
    input.print === null &&
    !input.isAcp &&
    input.stdinIsTTY &&
    input.stdoutIsTTY
  );
}

export function shouldFailForMissingSettings(input: {
  settingsPath: string | null;
  print: string | null;
  isAcp: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): boolean {
  return input.settingsPath == null && !shouldEnterFirstUseOnboard(input);
}

export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

export function buildDefaultProviderSettings(input: {
  baseUrl: string;
  apiKey: string;
  apiType: "openai" | "anthropic";
  defaultModel: string;
  balancedModel: string;
  fastModel: string;
  deepModel: string;
  maxOutputTokens: number;
}): Record<string, unknown> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const name = FIRST_USE_PROVIDER_NAME;
  return {
    default_provider: name,
    default_model_tier: "default",
    classifier_provider: name,
    classifier_model_name: input.fastModel,
    providers: [
      {
        provider_name: name,
        api_type: input.apiType,
        base_url: baseUrl,
        api_key: input.apiKey,
        default_model_name: input.defaultModel,
        balanced_model_name: input.balancedModel,
        fast_model_name: input.fastModel,
        deep_reasoning_model_name: input.deepModel,
        max_tokens: DEFAULT_ONBOARD_MAX_TOKENS,
        max_output_tokens: input.maxOutputTokens,
      },
    ],
    model_routes: {
      default: { provider: name, model: input.defaultModel },
      balanced: { provider: name, model: input.balancedModel },
      fast: { provider: name, model: input.fastModel },
      deep_reasoning: { provider: name, model: input.deepModel },
    },
  };
}

export function writeFirstUseSettings(path: string, raw: Record<string, unknown>): void {
  if (existsSync(path)) {
    throw new Error("目标 settings.json 已存在，拒绝覆盖");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface FirstUseChoice<T> {
  label: string;
  value: T;
}

export interface FirstUseIo {
  write(text: string): void;
  writeErr(text: string): void;
  ask(prompt: string): Promise<string>;
  askSecret(prompt: string): Promise<string>;
  choose<T>(question: string, options: FirstUseChoice<T>[]): Promise<T | null>;
  confirmRetry(question: string): Promise<boolean>;
}

export interface ProbeModelsInput {
  baseUrl: string;
  apiKey: string;
  apiType: ProviderType;
}

export interface ProbeModelsResult {
  models: string[];
  maxOutputTokens: Record<string, number>;
}

export interface TestConnectivityInput extends ProbeModelsInput {
  model: string;
}

export interface FirstUseServices {
  probeModels(input: ProbeModelsInput): Promise<ProbeModelsResult>;
  testConnectivity(input: TestConnectivityInput): Promise<{ ok: true } | { ok: false; error: string }>;
  settingsPath(): string;
  writeSettings(path: string, raw: Record<string, unknown>): void;
}

export type FirstUseResult =
  | { ok: true; path: string }
  | { ok: false; exitCode: 2; reason: "cancelled" | "declined" | "exists" };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function makeProbeConfig(input: TestConnectivityInput & { maxTokens?: number }): Config {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  return {
    providerName: FIRST_USE_PROVIDER_NAME,
    providerType: input.apiType,
    apiKey: input.apiKey,
    baseUrl,
    model: input.model,
    maxTokens: input.maxTokens ?? 16,
    temperature: 0,
    retry: { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1, connectTimeoutMs: 15_000, streamIdleTimeoutMs: 15_000 },
    providers: [
      {
        name: FIRST_USE_PROVIDER_NAME,
        type: input.apiType,
        apiTypes: [input.apiType],
        baseUrl,
        apiKey: input.apiKey,
        models: {
          default: input.model,
          balanced: input.model,
          fast: input.model,
          deep_reasoning: input.model,
        },
        maxTokens: input.maxTokens ?? 16,
        temperature: 0,
        contextWindow: null,
      },
    ],
  } as unknown as Config;
}

/** 复用 modelsRequests 的 /models 路径与头，加上与能力探测相同的超时。 */
export async function probeOnboardModels(input: ProbeModelsInput): Promise<ProbeModelsResult> {
  const cfg = makeProbeConfig({ ...input, model: "onboard-probe" });
  const reqs = modelsRequests(cfg);
  let lastErr: unknown;
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i]!;
    try {
      const res = await fetch(r.url, {
        headers: r.headers,
        signal: AbortSignal.timeout(DEFAULT_MODELS_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const detail = body.trim() ? `: ${body.trim().slice(0, 200)}` : "";
        throw new Error(`HTTP ${res.status}${detail}`);
      }
      const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
      const data = Array.isArray(json.data) ? json.data : [];
      const models: string[] = [];
      const maxOutputTokens: Record<string, number> = {};
      for (const entry of data) {
        const id = typeof entry["id"] === "string" ? entry["id"] : "";
        if (!id) continue;
        models.push(id);
        const cap = outputFromModelEntry(entry);
        if (cap != null) maxOutputTokens[id] = cap;
      }
      return { models, maxOutputTokens };
    } catch (e) {
      lastErr = e;
      if (i < reqs.length - 1 && isEndpointAbsent(e)) continue;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "探测失败"));
}

export async function testOnboardConnectivity(
  input: TestConnectivityInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await chatStream(makeProbeConfig({ ...input, maxTokens: 16 }), [{ role: "user", content: "ping" }], []);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: redactSecret(errMsg(e), input.apiKey) };
  }
}

async function askRequired(io: FirstUseIo, prompt: string, secret = false): Promise<string> {
  for (;;) {
    const raw = secret ? await io.askSecret(prompt) : await io.ask(prompt);
    const value = raw.trim();
    if (value) return value;
    io.writeErr("✖ 不能为空，请重新输入。\n");
  }
}

async function pickModel(
  io: FirstUseIo,
  shortName: string,
  options: FirstUseChoice<string>[],
): Promise<string | null> {
  return io.choose(`请为 ${shortName} 选择模型：`, options);
}

async function askMaxOutputTokens(io: FirstUseIo, suggested: number | undefined): Promise<number> {
  const hint = suggested != null ? `[${suggested}]` : "";
  const prompt = `请确认 max_output_tokens（模型能力上限，不是请求预算 max_tokens）${hint}：`;
  for (;;) {
    const raw = (await io.ask(prompt)).trim();
    if (!raw && suggested != null) return suggested;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    io.writeErr("✖ 请输入一个正整数。\n");
  }
}

function restoreStdinAfterOnboard(): void {
  // readline / raw-mode 问句结束后 stdin 可能仍处于 paused，
  // 不恢复的话后面的 TUI composer 画得出提示符却收不到 /exit。
  try {
    if (stdin.isTTY) stdin.setRawMode(false);
  } catch {
    /* 非 TTY 或已关闭 */
  }
  stdin.resume();
}

export async function runFirstUseOnboard(opts?: {
  io?: FirstUseIo;
  services?: Partial<FirstUseServices>;
}): Promise<FirstUseResult> {
  const usingDefaultIo = opts?.io === undefined;
  const io = opts?.io ?? createDefaultIo();
  const services: FirstUseServices = {
    probeModels: probeOnboardModels,
    testConnectivity: testOnboardConnectivity,
    settingsPath: userSettingsPath,
    writeSettings: writeFirstUseSettings,
    ...opts?.services,
  };

  io.write(
    `${c.bold("初次使用")}：候选路径都没有 settings.json。下面会引导配置一个可用的 default provider，测通后写入 ~/.neo/settings.json。\n`,
  );

  const finish = (result: FirstUseResult): FirstUseResult => {
    if (usingDefaultIo) restoreStdinAfterOnboard();
    return result;
  };

  for (;;) {
    const baseUrl = await askRequired(io, "请输入 base_url：");
    const apiKey = await askRequired(io, "请输入 api_key（输入只回显 *）：", true);
    const apiType = await io.choose("请选择协议：", [
      { label: "OpenAI", value: "openai" as const },
      { label: "Anthropic", value: "anthropic" as const },
    ]);
    if (apiType == null) return finish({ ok: false, exitCode: 2, reason: "cancelled" });

    io.write("正在探测可用模型…\n");
    let probed: ProbeModelsResult;
    try {
      probed = await services.probeModels({ baseUrl, apiKey, apiType });
    } catch (e) {
      io.writeErr(`✖ 探测失败：${redactSecret(errMsg(e), apiKey)}\n`);
      if (await io.confirmRetry("重试或退出？[r/q] ")) continue;
      return finish({ ok: false, exitCode: 2, reason: "declined" });
    }
    if (probed.models.length === 0) {
      io.writeErr("✖ 探测成功但可用模型列表为空，未写入配置。\n");
      if (await io.confirmRetry("重试或退出？[r/q] ")) continue;
      return finish({ ok: false, exitCode: 2, reason: "declined" });
    }

    const modelOptions = probed.models.map((id) => ({ label: id, value: id }));
    const defaultModel = await pickModel(io, "default", modelOptions);
    if (defaultModel == null) return finish({ ok: false, exitCode: 2, reason: "cancelled" });
    const balancedModel = await pickModel(io, "balance", modelOptions);
    if (balancedModel == null) return finish({ ok: false, exitCode: 2, reason: "cancelled" });
    const fastModel = await pickModel(io, "fast", modelOptions);
    if (fastModel == null) return finish({ ok: false, exitCode: 2, reason: "cancelled" });
    const deepModel = await pickModel(io, "deep", modelOptions);
    if (deepModel == null) return finish({ ok: false, exitCode: 2, reason: "cancelled" });

    const maxOutputTokens = await askMaxOutputTokens(io, probed.maxOutputTokens[defaultModel]);

    io.write(`正在对 default 模型做连通测试…\n`);
    const conn = await services.testConnectivity({ baseUrl, apiKey, apiType, model: defaultModel });
    if (!conn.ok) {
      io.writeErr(`✖ 连通测试失败：${redactSecret(conn.error, apiKey)}\n`);
      if (await io.confirmRetry("重试或退出？[r/q] ")) continue;
      return finish({ ok: false, exitCode: 2, reason: "declined" });
    }

    const raw = buildDefaultProviderSettings({
      baseUrl,
      apiKey,
      apiType,
      defaultModel,
      balancedModel,
      fastModel,
      deepModel,
      maxOutputTokens,
    });
    const path = services.settingsPath();
    try {
      services.writeSettings(path, raw);
    } catch (e) {
      io.writeErr(`✖ 无法写入配置：${redactSecret(errMsg(e), apiKey)}\n`);
      return finish({ ok: false, exitCode: 2, reason: "exists" });
    }
    io.write(`已写入 ~/.neo/settings.json（权限 0600），开始正常启动。\n`);
    return finish({ ok: true, path });
  }
}

function createDefaultIo(): FirstUseIo {
  return {
    write: (text) => {
      stdout.write(text);
    },
    writeErr: (text) => {
      stderr.write(text);
    },
    ask: defaultAsk,
    askSecret: defaultAskSecret,
    choose: defaultChoose,
    confirmRetry: defaultConfirmRetry,
  };
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function defaultAskSecret(prompt: string): Promise<string> {
  stdout.write(prompt);
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer | string) => {
        const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (let i = 0; i < s.length; i++) {
          const ch = s[i]!;
          if (ch === "\r" || ch === "\n") {
            stdout.write("\n");
            cleanup();
            resolve(value);
            return;
          }
          if (ch === "\x03") {
            cleanup();
            reject(new Error("cancelled"));
            return;
          }
          if (ch === "\x7f" || ch === "\b") {
            if (value.length > 0) {
              value = value.slice(0, -1);
              stdout.write("\b \b");
            }
            continue;
          }
          if (ch === "\x1b") {
            // 跳过 CSI / 方向键序列，避免把转义字面写进密钥。
            if (s[i + 1] === "[") {
              i += 2;
              while (i < s.length && !/[A-Za-z~]/.test(s[i]!)) i += 1;
            }
            continue;
          }
          if (ch < " ") continue;
          value += ch;
          stdout.write("*");
        }
      };
      const cleanup = (): void => {
        stdin.off("data", onData);
      };
      stdin.on("data", onData);
    });
  } finally {
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
  }
}

async function defaultChoose<T>(question: string, options: FirstUseChoice<T>[]): Promise<T | null> {
  if (options.length === 0) return null;
  stdout.write(`${question}\n`);
  options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o.label}\n`));
  for (;;) {
    const raw = (await defaultAsk("❯ ")).trim();
    if (raw === "") return options[0]!.value;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
    stderr.write("✖ 请输入列表中的编号。\n");
  }
}

async function defaultConfirmRetry(question: string): Promise<boolean> {
  const raw = (await defaultAsk(question)).trim().toLowerCase();
  if (raw === "" || raw === "r" || raw === "y" || raw === "yes" || raw === "是" || raw === "retry") return true;
  return false;
}
