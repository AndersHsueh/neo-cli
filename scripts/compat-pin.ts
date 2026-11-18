/** One offline compat/v1 pin, not a package/version framework. No neighboring repo or network. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
const PACKAGE = "@neo/core-compat";
const ARCHIVE = "vendor/neo-core-compat-v1.tgz";
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function requirePin(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(`compat-pin: ${why}`);
}
/** Read the four ordinary members; never extract paths or execute payload during validation. */
function members(bytes: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(bytes);
  const files = new Map<string, Buffer>();
  for (let pos = 0; pos + 512 <= tar.length;) {
    const header = tar.subarray(pos, pos + 512); if (header.every((v) => v === 0)) break;
    const name = header.subarray(0,100).toString().replace(/\0.*$/s, "");
    const prefix = header.subarray(345,500).toString().replace(/\0.*$/s, "");
    const sizeText = header.subarray(124,136).toString().replace(/\0.*$/s, "").trim();
    requirePin(/^[0-7]+$/.test(sizeText), "invalid tar size");
    const size = parseInt(sizeText,8);
    requirePin(Number.isSafeInteger(size) && size >= 0 && pos + 512 + size <= tar.length, "truncated tar");
    requirePin(prefix === "" && (header[156] === 48 || header[156] === 0) && !files.has(name), "non-ordinary or duplicate member");
    files.set(name,tar.subarray(pos+512,pos+512+size)); pos += 512 + Math.ceil(size/512)*512;
  }
  requirePin([...files.keys()].sort().join(",") === "package/index.d.ts,package/index.js,package/package.json,package/provenance.json", "archive member allowlist");
  return files;
}
export function checkCompatPin(root: string): string {
  const pin = JSON.parse(readFileSync(join(root,"vendor/compat-pin.json"),"utf8"));
  requirePin(pin.schema === "neo-core-compat-pin@1" && pin.archive === ARCHIVE, "pin schema/archive path");
  requirePin(/^[0-9a-f]{64}$/.test(pin.sha256) && /^[0-9a-f]{40}$/.test(pin.coreCandidate), "malformed digest/candidate");
  const pkg = JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
  requirePin(pkg.dependencies?.[PACKAGE] === `file:${ARCHIVE}`, "dependency must use exact vendor archive");
  const bytes = readFileSync(join(root,ARCHIVE));
  requirePin(sha(bytes) === pin.sha256, "archive SHA256 mismatch");
  const files = members(bytes);
  const get = (name: string) => { const b = files.get(`package/${name}`); requirePin(b, `missing ${name}`); return b; };
  const prov = JSON.parse(get("provenance.json").toString());
  requirePin(prov.schema === "neo-core-compat/provenance@1", "provenance schema");
  requirePin(prov.core.candidate === pin.coreCandidate && prov.core.lockfileSha256 === pin.coreLockSha256, "core candidate/lock mismatch");
  requirePin(prov.core.entrySha256 === pin.entrySha256 && prov.core.dtsSha256 === pin.dtsSha256, "core input pin mismatch");
  requirePin(prov.bun.version === "1.3.0" && pin.toolchain?.bun === "1.3.0" && prov.bun.binarySha256 === pin.toolchain.sha256, "toolchain pin mismatch");
  requirePin(sha(get("index.js")) === pin.indexSha256 && pin.indexSha256 === prov.outputs["index.js"], "built JS digest mismatch");
  requirePin(sha(get("index.d.ts")) === pin.dtsSha256 && sha(get("package.json")) === prov.outputs["package.json"], "declaration/manifest digest mismatch");
  const manifest = JSON.parse(get("package.json").toString());
  requirePin(manifest.name === PACKAGE && manifest.version === "0.0.0-k01" && manifest.private === true && manifest.type === "module" && manifest.engines?.bun === ">=1.1.0", "restricted package identity");
  requirePin(Object.keys(manifest.exports ?? {}).join(",") === "./compat/v1" && manifest.exports["./compat/v1"].import === "./index.js" && manifest.exports["./compat/v1"].types === "./index.d.ts", "restricted export");
  requirePin(!manifest.dependencies && !manifest.scripts && !manifest.bin, "unexpected runtime dependency/install hook/bin");
  return pin.sha256;
}
if (import.meta.main) {
  try { console.log(`compat-pin: OK ${checkCompatPin(process.cwd())}`); }
  catch (err) { console.error(String(err)); process.exitCode = 1; }
}
