/**
 * 写文件检查点（P0-4）。
 *
 * 目标：neo 自己的 write_file / edit_file 在落盘前留一份快照，误改可 `/undo` 恢复。
 * 明确边界（不做过度承诺）：
 *  - 只覆盖工具写路径；shell / 外部进程的修改不在恢复范围（文档与 HELP 都写明）；
 *  - 只快照工作目录内的文件；目录外路径不记录（避免 /undo 写到仓库外）；
 *  - 单文件 > 2MB 只记 manifest、不复制内容（避免备份目录失控）；
 *  - 每个会话保留最近 100 条，超出删最老（含快照文件）。
 *
 * manifest 用 JSONL 追加写：崩溃时最多丢最后半行，读取时跳过坏行。
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const MANIFEST = "manifest.jsonl";
const DEFAULT_MAX_ENTRIES = 100;
const MAX_SNAPSHOT_BYTES = 2_000_000;

export interface CheckpointEntry {
  seq: number;
  /** 工具名：write_file / edit_file。 */
  op: string;
  /** 相对工作目录的路径。 */
  rel: string;
  /** 绝对路径（undo 用）。 */
  path: string;
  /** 写操作前文件是否存在。 */
  existed: boolean;
  /** 操作前文件大小（字节）。 */
  size: number;
  /** ISO 时间戳。 */
  at: string;
  /** 备份文件名（相对备份目录）；null = 未复制（文件过大或无需）。 */
  snapshot: string | null;
  /** 未复制/异常时的说明。 */
  note?: string;
}

export interface UndoResult {
  entry: CheckpointEntry;
  /** content = 还原为快照内容；deleted = 删除新建文件；skipped = 无法恢复。 */
  restored: "content" | "deleted" | "skipped";
  reason?: string;
}

export interface CheckpointOptions {
  cwd: string;
  sessionId: string;
  /** 备份根目录覆盖（测试/迁移用）；默认 <cwd>/.neo/backups/<sessionId>。 */
  dir?: string;
  maxEntries?: number;
}

/** 工具层只需要这一个能力，避免 tools 反向依赖 checkpoint 模块。 */
export interface CheckpointSink {
  beforeWrite(path: string, op: string): unknown;
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "file";
}

export class CheckpointStore implements CheckpointSink {
  readonly dir: string;
  private readonly cwd: string;
  private readonly maxEntries: number;
  private nextSeq: number | null = null;

  constructor(opts: CheckpointOptions) {
    this.cwd = resolve(opts.cwd);
    this.dir = opts.dir ?? join(opts.cwd, ".neo", "backups", opts.sessionId);
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  /**
   * 写盘前记录一条检查点。返回 null 表示该路径不在工作目录内、不参与恢复。
   * 任何异常都不应阻止写入 —— 检查点是增强项，失败只告警（调用方决定是否提示）。
   */
  beforeWrite(absPath: string, op: string): CheckpointEntry | null {
    const path = resolve(absPath);
    const rel = relative(this.cwd, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;

    let existed = false;
    let size = 0;
    try {
      const st = statSync(path);
      existed = st.isFile();
      size = existed ? st.size : 0;
    } catch {
      existed = false;
    }

    mkdirSync(this.dir, { recursive: true });
    const seq = this.allocSeq();
    let snapshot: string | null = null;
    let note: string | undefined;
    if (existed) {
      if (size > MAX_SNAPSHOT_BYTES) {
        note = `文件 ${size}B 超过快照上限（${MAX_SNAPSHOT_BYTES}B），未复制内容`;
      } else {
        snapshot = `${seq}-${sanitize(basename(path))}`;
        try {
          copyFileSync(path, join(this.dir, snapshot));
        } catch (e) {
          snapshot = null;
          note = `快照复制失败：${(e as Error).message}`;
        }
      }
    }

    const entry: CheckpointEntry = {
      seq,
      op,
      rel: rel.split("\\").join("/"),
      path,
      existed,
      size,
      at: new Date().toISOString(),
      snapshot,
      ...(note ? { note } : {}),
    };
    try {
      appendFileSync(join(this.dir, MANIFEST), `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // manifest 写失败仍返回 entry（快照文件已在），undo 读不到该条而已
    }
    this.pruneIfNeeded();
    return entry;
  }

  /** 最近 N 条（时间正序）。 */
  list(limit = 20): CheckpointEntry[] {
    const entries = this.readEntries();
    return entries.slice(Math.max(0, entries.length - Math.max(1, limit)));
  }

  /** 恢复最近 count 条写操作（逆序执行）。 */
  undo(count = 1): UndoResult[] {
    const entries = this.readEntries();
    const targets = entries.slice(-Math.max(1, count)).reverse();
    const results: UndoResult[] = [];
    const consumed = new Set<number>();

    for (const entry of targets) {
      try {
        if (!entry.existed) {
          rmSync(entry.path, { force: true });
          results.push({ entry, restored: "deleted" });
          consumed.add(entry.seq);
          continue;
        }
        if (!entry.snapshot) {
          results.push({ entry, restored: "skipped", reason: "没有内容快照（超过大小上限或复制失败）" });
          continue;
        }
        const src = join(this.dir, entry.snapshot);
        if (!existsSync(src)) {
          results.push({ entry, restored: "skipped", reason: "快照文件缺失" });
          continue;
        }
        mkdirSync(dirname(entry.path), { recursive: true });
        copyFileSync(src, entry.path);
        results.push({ entry, restored: "content" });
        consumed.add(entry.seq);
        rmSync(src, { force: true });
      } catch (e) {
        results.push({ entry, restored: "skipped", reason: (e as Error).message });
      }
    }

    if (consumed.size > 0) {
      this.writeManifest(entries.filter((e) => !consumed.has(e.seq)));
    }
    return results;
  }

  private readEntries(): CheckpointEntry[] {
    const file = join(this.dir, MANIFEST);
    if (!existsSync(file)) return [];
    const out: CheckpointEntry[] = [];
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as CheckpointEntry;
        if (typeof e.seq === "number" && typeof e.path === "string") out.push(e);
      } catch {
        // 崩溃可能留下半行：跳过坏行，其余记录仍可用
      }
    }
    return out;
  }

  private writeManifest(entries: CheckpointEntry[]): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        join(this.dir, MANIFEST),
        entries.map((e) => `${JSON.stringify(e)}\n`).join(""),
        "utf8",
      );
    } catch {
      // 写失败不阻塞主流程
    }
  }

  private allocSeq(): number {
    if (this.nextSeq === null) {
      const entries = this.readEntries();
      this.nextSeq = entries.reduce((m, e) => Math.max(m, e.seq), 0);
    }
    this.nextSeq += 1;
    return this.nextSeq;
  }

  private pruneIfNeeded(): void {
    const entries = this.readEntries();
    if (entries.length <= this.maxEntries) return;
    const drop = entries.slice(0, entries.length - this.maxEntries);
    for (const e of drop) {
      if (e.snapshot) rmSync(join(this.dir, e.snapshot), { force: true });
    }
    this.writeManifest(entries.slice(entries.length - this.maxEntries));
  }
}
