/**
 * 工具输出落盘目录（v0.4.1 B4/D1，安全修正）。
 *
 * 不放项目工作区：完整工具输出可能含 .env/密钥，落进用户仓库会有被
 * `git add -A` 带走的真实风险。统一放 ~/.neo/tmp（0600），
 * NEO_TMP_DIR 可覆盖（测试隔离）。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function toolTmpDir(): string {
  const override = process.env["NEO_TMP_DIR"];
  if (override && override.trim() !== "") return override;
  return join(homedir(), ".neo", "tmp");
}
