#!/usr/bin/env bash
# scripts/verify.sh — neo 全量验证闸门（v0.2.4 及以后可复用）。
#
# 顺序：tsc 类型检查 → bun test 单测 → pty-e2e 真 PTY 端到端。
# 每个阶段的输出同时落到 docs/evidence/v0.2.4-<stage>.txt：
#   - 红态时这是「哪里红了」的原始证据；
#   - 绿态时这是发布前可复查的验收记录。
# （运行期写 docs/evidence/ 是脚本行为，不是手工改 docs；不要 git add 这些产物。）
#
# 用法：
#   bash scripts/verify.sh            # 无参数
#
# 任一阶段失败：打印 `FAILED: <stage>` 并以 1 退出（后续阶段不再执行）。
# 全部通过：打印 `ALL GREEN` 并以 0 退出。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EVIDENCE_DIR="$ROOT/docs/evidence"
mkdir -p "$EVIDENCE_DIR"

STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S %z')"
echo "── neo verify ──"
echo "时间    $STARTED_AT"
echo "仓库    $ROOT"
echo "平台    $(uname -srm)"
echo "bun     $(bun --version)"
echo "证据    docs/evidence/v0.2.4-{tsc,tests,pty}.txt"
echo

# run_stage <stage-name> <command...>
#
# 关键：整段（含组内错误输出）通过 tee 落盘；set -o pipefail 保证
# 阶段命令的失败不会被 tee 的 0 退出码掩盖。
run_stage() {
  local stage="$1"
  shift
  local out="$EVIDENCE_DIR/v0.2.4-${stage}.txt"

  echo "▶ [$stage] $*"
  if {
    echo "──── stage: ${stage} ────"
    echo "command: $*"
    echo "started: $(date '+%Y-%m-%d %H:%M:%S %z')"
    echo "repo:    $ROOT"
    echo "bun:     $(bun --version)"
    echo "──────────────────────────"
    "$@"
  } 2>&1 | tee "$out"; then
    echo "  ✔ ${stage} 通过（证据：docs/evidence/v0.2.4-${stage}.txt）"
    echo
  else
    local code="${PIPESTATUS[0]}"
    echo "  ✖ ${stage} 失败（exit ${code}；证据：docs/evidence/v0.2.4-${stage}.txt）" >&2
    echo "FAILED: ${stage}" >&2
    exit 1
  fi
}

# 1) 类型检查：零错误是后续所有阶段的前提。
run_stage tsc bunx tsc --noEmit

# 2) 单测：纯逻辑层（渲染/宽度/工具回看/回放等）的回归网。
run_stage tests bun test

# 3) 真 PTY 端到端：TTY-only 渲染行为只有真终端能测。
run_stage pty bun run scripts/pty-e2e.ts

echo "ALL GREEN"
