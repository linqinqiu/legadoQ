#!/usr/bin/env bash
# 安全清理本地「可再生产物」（全部已被 .gitignore 忽略）。
# 用法：bash scripts/clean-local.sh [--dry-run]
#
# 设计约束（对应 docs/STRUCTURE.md「禁止 git clean -fd」）：
#   - 只删能由 `npm start` / gradle / CI 重建的产物；
#   - 绝不碰用户数据：product/data（书库 DB）、legado-releases（含书库副本+发行包）、node_modules；
#   - 过期 git worktree 只删工作目录，保留分支 ref（提交不丢）。
set -euo pipefail
cd "$(dirname "$0")/.."   # 仓库根

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# 可再生、可安全删除（全部 gitignored）
TARGETS=(
  product/dist
  product/build
  product/app/build
  product/web/dist
  product/coverage-report
  product/tools/verify/out
  product/.gradle
  product/logs
  logs
  .dsh-ops
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

# 移除「已注册但过期」的 git worktree 工作目录（保留分支 ref，提交不丢）
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  first=1
  while IFS= read -r wt; do
    [ -z "$wt" ] && continue
    if [ "$first" = 1 ]; then first=0; continue; fi   # 跳过主工作树
    if [ -d "$wt" ]; then
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
