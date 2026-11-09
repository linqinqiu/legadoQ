@echo off
setlocal enabledelayedexpansion

REM legadoQ 便携版启动脚本（0.2.34）
REM 无需任何预装环境，内置 Java 运行库

chcp 65001 >nul

echo ========================================
echo   legadoQ v0.2.34 - 便携式版本
echo ========================================
echo.

REM 设置目录
set APP_ROOT=%~dp0
cd /d "%APP_ROOT%"

REM 查找 Java（优先使用 portable JDK）
if exist "jre\bin\java.exe" (
    set JAVA_EXE="%APP_ROOT%\jre\bin\java.exe"
    set JAVA_HOME="%APP_ROOT%\jre"
) else if exist "lib\java\bin\java.exe" (
    set JAVA_EXE="%APP_ROOT%\lib\java\bin\java.exe"
    set JAVA_HOME="%APP_ROOT%\lib\java"
) else where java >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set JAVA_EXE=java
    echo [系统] 使用系统 Java: %JAVA_HOME%
) else (
    echo ========================================
    echo [错误] 未找到 Java 运行环境！
    echo ========================================
    echo.
    echo 您需要以下之一才能运行：
    echo.
    echo 1️⃣  下载独立安装包（推荐）
    echo    从 https://t.me/legadoQ 获取
    echo.
    echo 2️⃣  安装 Portable Java
    echo    - 下载：https://adoptium.net/releases/
    echo    - 解压缩到本目录的 jre\ 文件夹
    echo.
    echo 3️⃣  或安装系统级 Java 17+
    echo    - Windows: choco install temurin-jdk
    echo    - Ubuntu: sudo apt install openjdk-17-jdk
    echo.
    echo 支持 Telegram 群组获取更多帮助：
    echo   https://t.me/legadoQ
    echo.
    pause
    exit /b 1
)

REM 查找 JAR 文件
if not exist "backend\build\libs\legado-server.jar" (
    echo [首次使用] 正在编译程序...
    call gradlew.bat :product:app:build -x test >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo [错误] 编译失败
        pause
        exit /b 1
    )
    echo [完成] 编译成功
    echo.
)

REM 启动服务
echo [启动] legadoQ 服务...
echo [监听] http://127.0.0.1:1234
echo [停止] 按 Ctrl+C 或在控制台输入 quit
echo.

"%JAVA_EXE%" -Xmx512m -jar "backend\build\libs\legado-server.jar" --server.port=1234 --server.host=127.0.0.1

endlocal
