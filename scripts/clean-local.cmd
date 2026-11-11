@echo off
REM 安全清理本地「可再生产物」（全部已被 .gitignore 忽略）。
REM 用法：scripts\clean-local.cmd [--dry-run]
REM
REM 设计约束（对应 docs\STRUCTURE.md「禁止 git clean -fd」）：
REM   - 只删能由 npm start / gradle / CI 重建的产物；
REM   - 绝不碰用户数据：product\data（书库 DB）、legado-releases（含书库副本+发行包）、node_modules。
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set DRY=0
if /I "%~1"=="--dry-run" set DRY=1

echo == legado 本地清理 ==
echo 提示：删除构建产物前建议先运行 npm run stop（避免运行实例占用文件）。

for %%D in (product\dist product\build product\app\build product\web\dist product\coverage-report product\web\coverage product\tools\verify\out product\.gradle product\.kotlin product\.trash product\.tmp product\logs product\app\logs product\tmp product\examples\plugin-hello\build product\examples\plugin-hello\.gradle logs .dsh-ops) do (
  if exist "%%D" (
    if "!DRY!"=="1" (
      echo [dry] would remove %%D
    ) else (
      echo remove %%D
      rmdir /s /q "%%D"
    )
  )
)

if "!DRY!"=="0" (
  if exist "product\web\tsconfig.tsbuildinfo" del /q "product\web\tsconfig.tsbuildinfo"
  del /q product\hs_err_pid*.log product\replay_pid*.log product\app\hs_err_pid*.log product\app\replay_pid*.log product\server.log 2>nul
)

if "!DRY!"=="0" (
  where git >nul 2>nul && git worktree prune
)

echo == 受保护（未触碰）==
for %%P in (product\data legado-releases product\web\node_modules) do (
  if exist "%%P" echo keep %%P
)
echo done.
endlocal
