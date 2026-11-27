/**
 * 会话内文件指纹（issue #94）：记录完整读取 / 完整写入的内容哈希，
 * 供 write_file 在覆盖前判断磁盘是否在本会话之后被改过。
 *
 * 状态挂在 WeakMap 上，以 Agent 实例为键：新会话、不同 Agent（含子代理）
 * 各用各的表，不写盘、不跨会话恢复。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { MAX_READ } from "./fsPaths.ts";
import type { FileFreshnessTracker, StaleFileKind } from "./types.ts";

function sha256Utf8(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function tooLargeToRead(path: string): boolean {
  try {
    return statSync(path).size > MAX_READ;
  } catch {
    return false;
  }
}

class Tracker implements FileFreshnessTracker {
  private readonly hashes = new Map<string, string>();

  recordCompleteRead(path: string, content: string): void {
    this.hashes.set(path, sha256Utf8(content));
  }

  recordCompleteWrite(path: string, content: string): void {
    this.hashes.set(path, sha256Utf8(content));
  }

  staleKind(path: string): StaleFileKind | null {
    const expected = this.hashes.get(path);
    if (expected === undefined) return null;
    // 磁盘上已无此文件：没有需要保护的中间改动，允许 write_file 重建。
    if (!existsSync(path)) return null;
    let current: string;
    try {
      current = sha256Utf8(readFileSync(path, "utf8"));
    } catch {
      return tooLargeToRead(path) ? "stale-too-large" : "stale";
    }
    if (current === expected) return null;
    return tooLargeToRead(path) ? "stale-too-large" : "stale";
  }

  clear(): void {
    this.hashes.clear();
  }
}

const trackers = new WeakMap<object, Tracker>();

/** 取（或新建）挂在该 Agent 实例上的指纹表。 */
export function fileFreshnessFor(owner: object): FileFreshnessTracker {
  let t = trackers.get(owner);
  if (!t) {
    t = new Tracker();
    trackers.set(owner, t);
  }
  return t;
}

/**
 * 清空该 Agent 已有的指纹表（若尚无表则什么也不做）。
 *
 * 给 reset() / /clear 预留：清空必须作用在已发出的 tracker 对象上，
 * 只从 WeakMap 删掉条目不够，因为 makeCtx 已经把同一引用交给 ToolCtx。
 * 本单不能改 Agent.reset() 所在的 loop.ts，调用点见交卷报告。
 */
export function clearFileFreshness(owner: object): void {
  trackers.get(owner)?.clear();
}

export function staleWriteModelReason(path: string, kind: StaleFileKind): string {
  if (kind === "stale-too-large") {
    return `write_file 已拒绝：文件 ${path} 在上次完整读取或写入之后已被修改，未改动磁盘。该文件超过读取上限，无法完整读取。`;
  }
  return `write_file 已拒绝：文件 ${path} 在上次完整读取或写入之后已被修改，未改动磁盘。请先用 read_file 完整读取该文件，再基于最新内容重试。`;
}

export function staleWriteUserNotice(path: string): string {
  return `已拒绝覆盖 ${path}：该文件在 agent 读过或写过之后又被改过，磁盘未改动。请让它先重读再写。`;
}
