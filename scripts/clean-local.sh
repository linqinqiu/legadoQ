#!/usr/bin/env bash
# 安全清理本地「可再生产物」（全部已被 .gitignore 忽略）。
# 用法：bash scripts/clean-local.sh [--dry-run] [--force]
#
# 设计约束（对应 docs/STRUCTURE.md「禁止 git clean -fd」）：
#   - 只删能由 `npm start` / gradle / CI 重建的产物；
#   - 绝不碰用户数据：product/data（书库 DB）、legado-releases（含书库副本+发行包）、node_modules；
#   - git worktree 只删工作目录，保留分支 ref（提交不丢）；**有未提交改动（含未跟踪文件）
#     的 worktree 默认跳过**——并行 agent 的半成品不毁，除非显式 --force。
set -euo pipefail
cd "$(dirname "$0")/.."   # 仓库根

DRY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
  esac
done

# 可再生、可安全删除（全部 gitignored）
TARGETS=(
  product/dist
  product/build
  product/app/build
  product/web/dist
  product/coverage-report
  product/web/coverage
  product/tools/verify/out
  product/.gradle
  product/.kotlin
  product/.trash
  product/.tmp
  product/logs
  product/app/logs
  product/tmp
  product/examples/plugin-hello/build
  product/examples/plugin-hello/.gradle
  logs
  .dsh-ops
)
# 单文件产物（rm -rf 也安全）
FILES=(
  product/web/tsconfig.tsbuildinfo
)
# 绝不删除
PROTECTED=(
  product/data
  legado-releases
  product/web/node_modules
  node_modules
)

echo "== legado 本地清理 =="
echo "提示：删除构建产物前建议先 \`npm run stop\`（避免运行实例占用文件）。"

for t in "${TARGETS[@]}"; do
  if [ -e "$t" ]; then
    sz=$(du -sh "$t" 2>/dev/null | cut -f1 || echo "?")
    if [ "$DRY" = 1 ]; then
      echo "[dry] would remove $t ($sz)"
    else
      echo "remove $t ($sz)"
      rm -rf -- "$t"
    fi
  fi
done

# 单文件产物
for f in "${FILES[@]}"; do
  [ -e "$f" ] || continue
  if [ "$DRY" = 1 ]; then echo "[dry] would remove $f"; else echo "remove $f"; rm -f -- "$f"; fi
done

# JVM 崩溃转储与运行日志（散落在 product/ 与 product/app/）
for f in product/hs_err_pid*.log product/replay_pid*.log product/app/hs_err_pid*.log product/app/replay_pid*.log product/server*.log; do
  [ -e "$f" ] || continue
  if [ "$DRY" = 1 ]; then echo "[dry] would remove $f"; else echo "remove $f"; rm -f -- "$f"; fi
done

# 移除「已注册且干净」的 git worktree 工作目录（保留分支 ref，提交不丢）。
# 脏 worktree（有未提交改动或未跟踪文件）默认跳过：并行 agent 的半成品可能是未跟踪文件，
# 分支 ref 保不住它们。--force 显式声明才强删。
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  first=1
  while IFS= read -r wt; do
    [ -z "$wt" ] && continue
    if [ "$first" = 1 ]; then first=0; continue; fi   # 跳过主工作树
    if [ -d "$wt" ]; then
      if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ] && [ "$FORCE" != 1 ]; then
        echo "skip worktree $wt（有未提交改动/未跟踪文件；要强删加 --force）"
        continue
      fi
      if [ "$DRY" = 1 ]; then
        echo "[dry] would remove worktree $wt"
      else
        echo "remove worktree $wt"
        git worktree remove --force "$wt" 2>/dev/null || rm -rf -- "$wt"
      fi
    fi
  done < <(git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /,"");print}')
  [ "$DRY" = 1 ] || git worktree prune 2>/dev/null || true
fi

echo "== 受保护（未触碰）=="
for p in "${PROTECTED[@]}"; do
  [ -e "$p" ] && echo "keep $p"
done
echo "done."
