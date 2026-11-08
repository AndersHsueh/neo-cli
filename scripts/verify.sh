#!/usr/bin/env bash
# scripts/verify.sh — neo 全量验证闸门（v0.2.4 起；证据前缀自动取自 package.json）。
#
# 顺序：tsc 类型检查 → bun test 单测 → pty-e2e 真 PTY 端到端。
# 每个阶段的输出同时落到 docs/evidence/<EVIDENCE>-<stage>.txt：
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
# 证据前缀 = 发布真源 package.json 的 version（v0.4.9 起）。此前是手写常量，
# 每版都要记得改，漏改就会把新版本的证据写进旧前缀文件、覆盖旧证据。
# 解析失败直接失败退出，不退化成空前缀（否则会写出 "-tsc.txt" 这种文件）。
EVIDENCE_PREFIX="v$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"
if [ "$EVIDENCE_PREFIX" = "v" ]; then
  echo "FAILED: 无法从 package.json 解析 version（证据前缀）" >&2
  exit 1
fi
mkdir -p "$EVIDENCE_DIR"

STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S %z')"
echo "── neo verify ──"
echo "时间    $STARTED_AT"
echo "仓库    $ROOT"
echo "平台    $(uname -srm)"
echo "bun     $(bun --version)"
echo "证据    docs/evidence/${EVIDENCE_PREFIX}-{tsc,tests,pty}.txt"
echo

# run_stage <stage-name> <command...>
#
# 关键：整段（含组内错误输出）通过 tee 落盘；set -o pipefail 保证
# 阶段命令的失败不会被 tee 的 0 退出码掩盖。
run_stage() {
  local stage="$1"
  shift
  local out="$EVIDENCE_DIR/${EVIDENCE_PREFIX}-${stage}.txt"

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
    echo "  ✔ ${stage} 通过（证据：docs/evidence/${EVIDENCE_PREFIX}-${stage}.txt）"
    check_test_skips "$stage" "$out"
    echo
  else
    local code="${PIPESTATUS[0]}"
    echo "  ✖ ${stage} 失败（exit ${code}；证据：docs/evidence/${EVIDENCE_PREFIX}-${stage}.txt）" >&2
    echo "FAILED: ${stage}" >&2
    exit 1
  fi
}

# check_test_skips <stage> <evidence-file>
#
# 背景（issue #26 审计连带项，2026-11-08）：bun test 有 skip 时退出码仍是 0，
# run_stage 只看退出码 ⇒ ALL GREEN 不代表覆盖完整，静默跳过会随版本悄悄累积。
# 这里解析 bun test 输出里的 skip 数：
#   - skip > 0：默认只告警（列出条数与所在文件，闸门继续走）；
#     NEO_STRICT_SKIPS=1 时直接 fail（退出 1），用于要求零跳过的严格验收。
#   - skip = 0：不产生任何输出（默认路径下主仓 0 skip，仍 ALL GREEN）。
#   - 输出里没有 skip 汇总行（如 tsc/pty 阶段）：静默返回，不告警。
#   - 解析口径：bun test 的汇总行是行首两个空格 + 「N skip」；skip 明细行
#     以「(skip)」开头，其所属文件是上方最近的「tests/xxx.test.ts:」标题行。
check_test_skips() {
  local stage="$1"
  local file="$2"
  local skip_count
  skip_count="$(grep -E '^ +[0-9]+ skip$' "$file" | tail -n 1 | grep -oE '[0-9]+' || true)"
  # 无 skip 汇总行 = 0 skip（bun test 只在有 skip 时才打印该行）
  [ -z "$skip_count" ] && return 0
  # skip = 0：静默返回（默认路径下主仓 0 skip，不产生任何输出）
  [ "$skip_count" -eq 0 ] && return 0

  echo "  ⚠ ${stage}: 检测到 ${skip_count} 个 skip（静默跳过会随版本累积，闸门默认只告警）"
  # 列出 skip 所在文件：正文段里从 (skip) 行向上找最近的「…test.ts:」文件标题。
  # 注意 bun test 末尾有「N tests skipped:」回顾段，会原样重复明细行 —— awk 遇到
  # 该行即停，否则重复计数、且回顾段前最后一个文件头会把 skip 错记到别的文件名下。
  awk '
    /tests skipped:/ { exit }
    /\.test\.ts:$/ { cur = $0; sub(/:$/, "", cur) }
    /^\(skip\)/ { print "    - " cur "（第 " NR " 行）" }
  ' "$file"
  if [ "${NEO_STRICT_SKIPS:-0}" = "1" ]; then
    echo "  ✖ ${stage}: NEO_STRICT_SKIPS=1 且存在 skip，按严格口径判失败" >&2
    echo "FAILED: ${stage} (strict skips)" >&2
    exit 1
  fi
  echo "    （设 NEO_STRICT_SKIPS=1 可让 skip 直接 fail）"
}

# 1) 类型检查：零错误是后续所有阶段的前提。
run_stage tsc bun x tsc --noEmit

# 2) 单测：纯逻辑层（渲染/宽度/工具回看/回放等）的回归网。
run_stage tests bun test

# 3) 真 PTY 端到端：TTY-only 渲染行为只有真终端能测。
run_stage pty bun run scripts/pty-e2e.ts

echo "ALL GREEN"
