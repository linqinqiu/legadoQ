@echo off
setlocal
cd /d "%~dp0.."
call npm --prefix product start
