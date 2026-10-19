/**
 * clipboard.ts —— macOS 剪贴板图片读取（PRD docs/paste-enhancement-prd.md §5.2 D2）。
 *
 * P2 探针定案（2026-10-19，PRD §7）：
 *  - JXA run() 返回值永远被追加到 stdout（返回 0 → 尾部多 "0\n"），二进制直出必被污染；
 *  - 退出码不可控（return 2 → exit 0；$.exit(2) → exit 1 且 stderr 空）；
 *  - JXA 无 console.error；诊断走 NSFileHandle.fileHandleWithStandardError 实测可达。
 *
 * 因此协议为「临时文件 + stderr 诊断」：
 *  - JXA 把 PNG 写到 TS 传入的沙箱临时文件（writeToFileAtomically，实测逐字节一致）；
 *  - TS 以文件存在性为成功判据（退出码不可信）；
 *  - stderr 含 NO_IMAGE → 无图（C5：静默/info，不报错）；其他 stderr → 异常。
 *
 * C4：异步 spawn，不阻塞输入循环。C7：readClipboardImage 可注入，测试不碰真实剪贴板。
 * M3 将在此文件扩展 Windows/WSL（PowerShell 单次 spawn）与 Linux（wl-paste/xclip）分支。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 读取结果：图片字节 + MIME。null = 剪贴板无图（非错误）。 */
export interface ClipboardImage {
  data: Buffer;
  mime: string;
}

/** JXA 脚本：PNG flavor 直读 → TIFF flavor 转 PNG（截图场景）→ 无图 stderr NO_IMAGE。 */
const JXA_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  const pb = $.NSPasteboard.generalPasteboard;
  const png = pb.dataForType($.NSPasteboardTypePNG);
  const tiff = pb.dataForType($.NSPasteboardTypeTIFF);
  let data = (png && !png.isNil()) ? png : null;
  if (!data && tiff && !tiff.isNil()) {
    const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (rep && !rep.isNil()) data = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary);
  }
  if (!data) {
    const err = $.NSString.stringWithUTF8String('NO_IMAGE');
    $.NSFileHandle.fileHandleWithStandardError.writeData(err.dataUsingEncoding(4));
    return;
  }
  data.writeToFileAtomically('__TMP_PATH__', true);
  return;
}
`;

/** spawn osascript 并收集 stdout/stderr（C4：异步）。 */
function runJxa(script: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("osascript", ["-l", "JavaScript", "-e", script]);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", () => resolve({ stdout: "", stderr: "SPAWN_FAIL" }));
    p.on("close", () => resolve({ stdout, stderr }));
  });
}

/**
 * 读剪贴板图片。null = 无图（C5：调用方 info 一行即可，不报错）。
 * 抛错 = 真异常（spawn 失败 / 脚本崩溃），调用方 warn。
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const dir = mkdtempSync(join(tmpdir(), "neo-clip-"));
  const file = join(dir, "clip.png");
  try {
    const script = JXA_SCRIPT.replace("__TMP_PATH__", file);
    const { stderr } = await runJxa(script);

    if (!existsSync(file)) {
      if (stderr.includes("NO_IMAGE")) return null; // C5：无图不是错误
      throw new Error(`剪贴板读取失败：${stderr.trim() || "osascript 无输出"}`);
    }
    const data = readFileSync(file);
    if (data.length === 0) throw new Error("剪贴板图片为空");
    return { data, mime: "image/png" };
  } finally {
    rmSync(dir, { recursive: true, force: true }); // 用后即删（P2 协议）
  }
}
