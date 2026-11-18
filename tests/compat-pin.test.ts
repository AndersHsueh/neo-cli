/** K01b: actual lifecycle install rejects tampered pins/payload, recovers after restore. */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "k01-pin-")); dirs.push(dir);
  mkdirSync(join(dir, "vendor")); mkdirSync(join(dir, "scripts"));
  for (const file of ["compat-pin.json", "neo-core-compat-v1.tgz"]) copyFileSync(join(ROOT, "vendor", file), join(dir, "vendor", file));
  if (existsSync(join(ROOT, "scripts/compat-pin.ts"))) copyFileSync(join(ROOT, "scripts/compat-pin.ts"), join(dir, "scripts/compat-pin.ts"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "k01-pin-fixture", private: true, type: "module", dependencies: { "@neo/core-compat": pkg.dependencies["@neo/core-compat"] }, scripts: { preinstall: pkg.scripts.preinstall } }));
  return dir;
}
function install(dir: string) {
  return spawnSync(process.execPath, ["install", "--no-cache"], { cwd: dir, encoding: "utf8", env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(dir, "cache"), npm_config_registry: "http://127.0.0.1:1" } });
}
function alterPin(dir: string, key: string, value: unknown) {
  const file = join(dir, "vendor/compat-pin.json"); const p = JSON.parse(readFileSync(file,"utf8")); p[key] = value; writeFileSync(file, JSON.stringify(p));
}
test("K01-P01 wrong digest is refused by real preinstall", () => {
  const dir = fixture(); alterPin(dir, "sha256", "0".repeat(64));
  const r = install(dir); if (r.status === 0) console.error(r.stdout + r.stderr);
  expect(r.status).not.toBe(0); expect(r.stdout + r.stderr).toContain("compat-pin");
});
test("K01-P02 modified archive is refused before consumption", () => {
  const dir = fixture(); const f = join(dir,"vendor/neo-core-compat-v1.tgz"); const b = readFileSync(f); b[4] = (b[4] ?? 0) ^ 1; writeFileSync(f,b);
  const r = install(dir); expect(r.status).not.toBe(0); expect(r.stdout + r.stderr).toContain("compat-pin");
});
test("K01-P03 wrong candidate, core lock and toolchain pins are refused", () => {
  for (const [key,value] of [["coreCandidate", "0".repeat(40)], ["coreLockSha256", "0".repeat(64)], ["toolchain", { bun: "1.3.0", sha256: "0".repeat(64) }]] as const) {
    const dir=fixture(); alterPin(dir,key,value); const r=install(dir); expect(r.status).not.toBe(0); expect(r.stdout+r.stderr).toContain("compat-pin");
  }
});
test("K01-P04 dependency redirect to existing other archive is refused", () => {
  const dir=fixture(); copyFileSync(join(dir,"vendor/neo-core-compat-v1.tgz"),join(dir,"vendor/other.tgz"));
  const f=join(dir,"package.json");const p=JSON.parse(readFileSync(f,"utf8"));p.dependencies["@neo/core-compat"]="file:vendor/other.tgz";writeFileSync(f,JSON.stringify(p));
  const r=install(dir);expect(r.status).not.toBe(0);expect(r.stdout+r.stderr).toContain("compat-pin");
});
test("K01-P05 restore exact pin after rejection and install/run succeeds", () => {
  const dir=fixture();const f=join(dir,"vendor/compat-pin.json");const old=readFileSync(f);alterPin(dir,"sha256","0".repeat(64));expect(install(dir).status).not.toBe(0);
  writeFileSync(f,old);const ok=install(dir);expect(ok.status).toBe(0);
  const run=spawnSync(process.execPath,["-e", "import {resolveContextWindow} from '@neo/core-compat/compat/v1'; if(resolveContextWindow(NaN,'unknown').source!=='default')throw Error('bad');"],{cwd:dir,encoding:"utf8"});expect(run.status).toBe(0);
});
