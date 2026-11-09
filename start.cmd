@echo off
setlocal enabledelayedexpansion

REM legacyQ 启动脚本 - 零依赖版本
REM 自动检测 Java 环境，无需 Node.js

echo ========================================
echo   legadoQ - 本地小说阅读服务 v0.2.35
echo ========================================
echo.

REM 设置应用根目录
set APP_ROOT=%~dp0
cd /d "%APP_ROOT%"

REM 检查 Java 是否安装
where java >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未检测到 Java 运行环境！
    echo.
    echo 请先安装 Java 17+ :
    echo   - Windows: 从 https://adoptium.net/releases/ 下载
    echo   - 或运行：choco install temurin-jdk
    echo.
    pause
    exit /b 1
)

echo [OK] Java 环境已就绪：%JAVA_HOME%\bin\java
echo.

REM 编译项目（如果后端 jar 不存在）
if not exist "backend/build/libs/legado-server.jar" (
    echo [提示] 首次启动，正在编译后端程序...
    call gradlew.bat :product:app:build -x test
    if %ERRORLEVEL% NEQ 0 (
        echo [错误] 编译失败，请检查构建日志
        pause
        exit /b 1
    )
    echo [完成] 后端编译成功
    echo.
)

REM 启动服务
echo [启动] legacyQ 服务中...
echo [地址] http://127.0.0.1:1234
echo [停止] 双击 start.cmd 旁边的 stop.cmd
echo.

java -jar backend/build/libs/legado-server.jar --server.port=1234 --server.host=127.0.0.1

endlocal
