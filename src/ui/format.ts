/**
 * ui/format.ts — 数量格式化共用的「档位纪律」（v0.4.16）。
 *
 * 背景：v0.4.13/14/15 连续三次修的是同一类缺陷 —— `toFixed` / `Math.round`
 * 把档内值进位到档边界（9_999 → "10.0k"、59_950ms → "60.0s"、1023.95K → "1024K"），
 * 输出既跨了档（宽度突然多 1~2 列，状态栏/`/last` 单行头抖动），
 * 又与下一档的写法撞值（"10.0k" vs "10k"、"60.0s" vs "1:00"）。
 * 三处各自修了一遍，纪律只写在注释里、没有共享实现 —— 本模块把它抽出来：
 *
 *  1. `fixed1`：一位小数档，进位到 10 时降级为整数（"10.0" → "10"）；
 *  2. `rounded`：整数档，进位到档宽时由调用方升档（返回数值，便于比较）；
 *  3. `clock`：秒数 → `m:ss` / `h:mm:ss`（status 与 toolLog 各有一份，合并到这里）。
 *
 * 纯函数、零依赖：tui/status、ui/toolLog、env/render 都依赖它，
 * 不能反向依赖 theme（否则 tui → ui/theme → ... 的层次被打乱）。
 */

/**
 * 一位小数档（token/bytes 口径）：`x.toFixed(1)`，但进位到 10.0 时降级为整数 "10"。
 *
 * 9.96 → "10"（不是 "10.0"）、9.95 → "9.9"（toFixed 的舍入到偶）、1.234 → "1.2"。
 * 调用方负责判断「降级后的值是否已到下一档」（如 9.96K → 10K 仍是 K 档，
 * 999.95K → 1000K 就该升 M 档，见 env/render.ts 的 formatBytes）。
 *
 * 注意这条「≥10 转整数」是 token/bytes 的档内规则，**不是**通用的一位小数格式：
 * 时长的秒档（12.3s / 59.9s）要一直保留一位小数，只有进位到 60 才升分钟档 ——
 * 那种场景用 `fixed1Raw`。
 */
export function fixed1(x: number): string {
  const one = Number(x.toFixed(1));
  return one >= 10 ? String(Math.round(x)) : one.toFixed(1);
}

/**
 * 纯一位小数：`x.toFixed(1)`，不做任何降级。
 * 供「一位小数一直保留到某个更大的阈值」的档位使用（如 formatDuration 的秒档，
 * 阈值是 60 而非 10）。升档判断由调用方对返回的字符串做。
 */
export function fixed1Raw(x: number): string {
  return x.toFixed(1);
}

/**
 * 整数档：`Math.round(x)`，返回数值而非字符串。
 * 调用方拿它跟档宽比较决定是否升档（如 999_500/1_000 → 1000 → 升 M）。
 */
export function rounded(x: number): number {
  return Math.round(x);
}

/**
 * 秒数 → 时钟串：<1h 用 `m:ss`，>=1h 用 `h:mm:ss`；负值/非有限值按 0。
 * 注意入参是**秒**（已由调用方取整），不是毫秒。
 */
export function clock(totalSeconds: number): string {
  const total = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}
