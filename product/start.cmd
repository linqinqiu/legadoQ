@echo off
rem QingYue launcher (double-click this). start.mjs runs the service; this .cmd decides:
rem "start the service if it is not up, wait until /healthz answers, then open the UI".
rem Why (2026-10-09): the desktop "QingYue" icon is a Chrome PWA shortcut - it does NOT
rem start the local service, so clicking it while the server is down leaves the UI
rem waiting on /healthz until the 60s give-up. This launcher closes that gap.
setlocal
cd /d "%~dp0"
set "PORT=1234"
if exist "port.txt" for /f "usebackq delims=" %%p in ("port.txt") do set "PORT=%%p"
set "URL=http://127.0.0.1:%PORT%/"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found - the launcher needs Node. You can also use the bundled start.bat.
  pause
  exit /b 1
)

rem 1) already running -> just open the UI
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try{ if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 '%URL%healthz').StatusCode -eq 200){ exit 0 } }catch{}; exit 1"
if not errorlevel 1 (
  start "" "%URL%"
  exit /b 0
)

rem 2) not running -> start it in the background, wait for /healthz, then open the UI
echo Starting QingYue service... (first launch takes about ten seconds)
start "QingYue" /min cmd /c "node start.mjs --no-open --port %PORT%"
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; for($i=0;$i -lt 240;$i++){ try{ if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%URL%healthz').StatusCode -eq 200){ exit 0 } }catch{}; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo.
  echo Service did not come up. See log: %~dp0server.log
  pause
  exit /b 1
)
start "" "%URL%"
