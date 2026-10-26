/**
 * clipboard.ts —— 剪贴板图片读取（v0.4.0 平台适配层）。
 *
 * 平台矩阵（PRD docs/neo-platform-adaptation-prd.md §3.6）：
 *  - macOS：JXA + NSPasteboard（原实现，M2 探针定案，见 docs/paste-enhancement-prd[done].md §7）；
 *  - Windows：PowerShell + System.Windows.Forms.Clipboard（**实验性，未实机验证，PD-1**）；
 *  - Linux：暂不支持，直接返回 null（PD-2 计划 wl-paste/xclip）。
 *
 * 协议统一为「临时文件 + stderr 诊断」：
 *  - 桥接脚本把 PNG 写到 TS 传入的沙箱临时文件；
 *  - TS 以文件存在性为成功判据（桥接层退出码不可信）；
 *  - stderr 含 NO_IMAGE → 无图（静默，不报错）；其他 stderr → 异常。
 *
 * C4：异步 spawn，不阻塞输入循环。C7：readClipboardImage 可注入，测试不碰真实剪贴板。
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

export type ClipboardPlatform = "macos" | "windows" | "unsupported";

/** 当前平台的剪贴板图片能力。Linux = unsupported（PD-2）。 */
export function clipboardImagePlatform(platform: NodeJS.Platform = process.platform): ClipboardPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "unsupported";
}

/* ------------------------------------------------------------------ */
/* macOS：JXA                                                          */
/* ------------------------------------------------------------------ */

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

/** spawn 命令并收集 stdout/stderr（C4：异步）。spawn 失败以 spawnFailed 标记返回。 */
function runCommand(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; spawnFailed: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { stdout: string; stderr: string; spawnFailed: boolean }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(cmd, args);
    } catch {
      done({ stdout: "", stderr: "SPAWN_FAIL", spawnFailed: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", () => done({ stdout: "", stderr: "SPAWN_FAIL", spawnFailed: true }));
    p.on("close", () => done({ stdout, stderr, spawnFailed: false }));
  });
}

async function readMacClipboardImage(file: string): Promise<ClipboardImage | null | "SPAWN_FAIL"> {
  const script = JXA_SCRIPT.replace("__TMP_PATH__", file);
  const { stdout, stderr, spawnFailed } = await runCommand("osascript", ["-l", "JavaScript", "-e", script]);
  if (spawnFailed) return "SPAWN_FAIL";
  if (!existsSync(file)) {
    if (stderr.includes("NO_IMAGE")) return null; // C5：无图不是错误
    throw new Error(`剪贴板读取失败：${stderr.trim() || stdout.trim() || "osascript 无输出"}`);
  }
  const data = readFileSync(file);
  if (data.length === 0) throw new Error("剪贴板图片为空");
  return { data, mime: "image/png" };
}

/* ------------------------------------------------------------------ */
/* Windows：PowerShell（实验性）                                       */
/* ------------------------------------------------------------------ */

/**
 * PowerShell 脚本：GetImage → PNG 落临时文件；无图 stderr NO_IMAGE。
 *
 * 注意：`System.Windows.Forms.Clipboard` 需要 STA 线程，Windows PowerShell 5.1
 * 用 `-STA` 满足；pwsh 7 无 `-STA` 开关（MTA 下 GetImage 可能为 null）。
 * 因此优先 powershell.exe，失败再退 pwsh —— 实机行为待 PD-1 验证。
 */
const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$img = [System.Windows.Forms.Clipboard]::GetImage();
if ($img -eq $null) { [Console]::Error.Write('NO_IMAGE'); exit 0 }
$img.Save('__TMP_PATH__', [System.Drawing.Imaging.ImageFormat]::Png);
`;

async function readWindowsClipboardImage(file: string): Promise<ClipboardImage | null | "SPAWN_FAIL"> {
  const script = PS_SCRIPT.replace(/__TMP_PATH__/g, file.replace(/'/g, "''"));
  // 优先 Windows PowerShell（-STA），其缺失时退 pwsh 7。
  let res = await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
  if (res.spawnFailed) {
    res = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script]);
  }
  if (res.spawnFailed) return "SPAWN_FAIL";
  if (!existsSync(file)) {
    if (res.stderr.includes("NO_IMAGE")) return null;
    throw new Error(`剪贴板读取失败：${res.stderr.trim() || "PowerShell 无输出"}`);
  }
  const data = readFileSync(file);
  if (data.length === 0) throw new Error("剪贴板图片为空");
  return { data, mime: "image/png" };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 读剪贴板图片。null = 无图 / 平台不支持（调用方 info 一行即可，不报错）。
 * 抛错 = 真异常（桥接脚本崩溃等），调用方 warn。
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const kind = clipboardImagePlatform();
  if (kind === "unsupported") return null; // Linux：PD-2 前静默降级，UI 层给一次性提示

  const dir = mkdtempSync(join(tmpdir(), "neo-clip-"));
  const file = join(dir, "clip.png");
  try {
    if (kind === "windows") {
      const r = await readWindowsClipboardImage(file);
      if (r === "SPAWN_FAIL") throw new Error("剪贴板读取失败：找不到 PowerShell（Windows 支持为实验性，见 PD-1）");
      return r;
    }
    const r = await readMacClipboardImage(file);
    if (r === "SPAWN_FAIL") throw new Error("剪贴板读取失败：osascript 启动失败");
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true }); // 用后即删（P2 协议）
  }
}
