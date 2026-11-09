#!/bin/bash
# legadoQ 启动脚本 - 零依赖版本
# 自动检测 Java 环境，无需 Node.js

set -e

echo "========================================"
echo "  legadoQ - 本地小说阅读服务 v0.2.35"
echo "========================================"
echo ""

# 设置应用根目录
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_ROOT"

# 检查 Java 是否安装
if ! command -v java &> /dev/null; then
    echo "[错误] 未检测到 Java 运行环境！"
    echo ""
    echo "请先安装 Java 17+ :"
    echo "  - Ubuntu/Debian: sudo apt install openjdk-17-jdk"
    echo "  - macOS: brew install openjdk@17"
    echo "  - CentOS/RHEL: sudo yum install java-17-openjdk"
    echo ""
    exit 1
fi

echo "[OK] Java 环境已就绪：$(java -version 2>&1 | head -1)"
echo ""

# 编译项目（如果后端 jar 不存在）
if [ ! -f "backend/build/libs/legado-server.jar" ]; then
    echo "[提示] 首次启动，正在编译后端程序..."
    ./gradlew :product:app:build -x test
    if [ $? -ne 0 ]; then
        echo "[错误] 编译失败，请检查构建日志"
        exit 1
    fi
    echo "[完成] 后端编译成功"
    echo ""
fi

# 启动服务
echo "[启动] legacyQ 服务中..."
echo "[地址] http://127.0.0.1:1234"
echo "[停止] 双击 start.cmd 旁边的 stop.cmd"
echo ""

exec java -jar backend/build/libs/legado-server.jar --server.port=1234 --server.host=127.0.0.1
