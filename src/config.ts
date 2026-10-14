/**
 * 配置加载。
 * 优先级（从低到高）：settings.example.json 默认值 → ./settings.json → 环境变量 → CLI 覆盖。
 * 环境变量名：NEO_API_KEY / NEO_BASE_URL / NEO_MODEL。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  contextWindow: number;
  compactThreshold: number;
  maxToolIterations: number;
  toolOutputLimit: number;
  theme: string;
  showReasoning: boolean;
  thinking?: { type: "enabled" | "disabled" };
  cwd: string;
  settingsPath: string | null;
}

type Raw = Record<string, unknown>;

function readJson(path: string): Raw | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Raw;
  } catch (e) {
    throw new Error(`配置文件解析失败 ${path}: ${(e as Error).message}`);
  }
}

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function str(v: unknown, d: string): string {
  return typeof v === "string" && v.length > 0 ? v : d;
}

export function normalizeBaseUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const here = process.cwd();
  const pkgRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

  const candidates = [
    join(here, "settings.json"),
    join(pkgRoot, "settings.json"),
    join(homedir(), ".neo", "settings.json"),
  ];
  const found = candidates.find((p) => existsSync(p)) ?? null;
  const raw = found ? (readJson(found) ?? {}) : {};
  const dflt = readJson(join(pkgRoot, "settings.example.json")) ?? {};

  const env = process.env;
  const merged: Raw = { ...dflt, ...raw };

  const cfg: Config = {
    apiKey: str(env["NEO_API_KEY"], str(merged["api-key"], "")),
    baseUrl: normalizeBaseUrl(
      str(env["NEO_BASE_URL"], str(merged["OpenAI"], "https://api.openai.com/v1")),
    ),
    model: str(env["NEO_MODEL"], str(merged["model_name"], "gpt-4o-mini")),
    maxTokens: num(merged["max_tokens"], 8192),
    temperature: num(merged["temperature"], 0.6),
    contextWindow: num(merged["context_window"], 200_000),
    compactThreshold: num(merged["compact_threshold"], 0.75),
    maxToolIterations: num(merged["max_tool_iterations"], 40),
    toolOutputLimit: num(merged["tool_output_limit"], 30_000),
    theme: str(merged["theme"], "matrix"),
    showReasoning: bool(merged["show_reasoning"], true),
    cwd: here,
    settingsPath: found,
    ...overrides,
  };

  if (overrides.cwd && !isAbsolute(overrides.cwd)) cfg.cwd = resolve(here, overrides.cwd);
  return cfg;
}

/** 脱敏展示 key，只保留头尾。 */
export function maskKey(k: string): string {
  if (!k) return "<未设置>";
  if (k.length <= 12) return "*".repeat(k.length);
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
