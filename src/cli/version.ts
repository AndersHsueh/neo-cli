/**
 * 版本号的唯一运行时来源。
 *
 * `package.json` 是发布真源。入口不再手写一份常量，避免两处漏改。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  if (!parsed.version) throw new Error("package.json 缺少 version");
  return parsed.version;
})();
