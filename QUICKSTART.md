# 快速启动指南

## 🎯 一句话安装（零依赖）

**Windows 用户**:
1. 从 https://t.me/legadoQ 下载 `legadoQ_便携版.zip`
2. 解压到任意文件夹（如 `D:\Books\legadoQ`）
3. 双击运行 `legadoQ_便携版.bat`
4. 打开浏览器访问 `http://127.0.0.1:1234`

**Linux/macOS 用户**:
```bash
curl -sL https://t.me/legadoQ | bash
./start.sh
# 访问 http://127.0.0.1:1234
```

---

## 🔍 验证是否成功

### 方式一：健康检查页面

在浏览器中打开项目根目录的 `health-check.html`:
```html
file:///E:/legado/health-check.html
```

### 方式二：API 健康检查

```bash
# Windows PowerShell
curl http://127.0.0.1:1234/healthz

# macOS/Linux
curl http://127.0.0.1:1234/healthz
```

期望返回类似：
```json
{
  "status": "RUNNING",
  "title": "legadoQ",
  "version": "0.2.34",
  "build": "47"
}
```

### 方式三：直接访问主界面

浏览器打开 `http://127.0.0.1:1234`,如果看到登录页面即表示成功。

---

## ⚡ 常用操作

### 启动服务

**方式一：使用启动脚本**
```bash
./start.sh        # Linux/macOS
start.cmd         # Windows
```

**方式二：手动启动（开发者）**
```bash
gradlew :product:app:build -x test
java -jar backend/build/libs/legado-server.jar
```

### 停止服务

**方式一：使用停止脚本**
```bash
./stop.sh         # Linux/macOS
stop.cmd          # Windows
```

**方式二：Ctrl+C**
在启动控制台中按 `Ctrl+C`

### 查看日志

```bash
# 实时日志
tail -f logs/application.log    # Linux/macOS
type logs\application.log       # Windows
```

---

## ❓ 常见问题

### Q1: 为什么无法启动？

**A**: 可能原因：

1. **未安装 Java**
   ```bash
   # 检查是否安装
   java -version
   
   # Windows 安装
   choco install temurin-jdk
   
   # Ubuntu/Debian 安装
   sudo apt install openjdk-17-jdk
   ```

2. **端口被占用**
   ```bash
   # Windows 查看端口占用
   netstat -ano | findstr :1234
   
   # Linux/macOS 查看端口占用
   lsof -i :1234
   ```

3. **权限不足**
   ```bash
   chmod +x start.sh  # Linux/macOS
   ```

### Q2: 首次启动很慢？

**A**: 首次编译需要时间（约 30-60 秒）。后续应秒级启动。

**优化方法**:
1. 增加 JVM 内存分配
   ```bash
   JAVA_OPTS="-Xmx512m -Xms256m"
   java $JAVA_OPTS -jar legado-server.jar
   ```

2. 清理构建缓存
   ```bash
   gradlew clean
   ```

### Q3: 如何备份数据？

**A**: 

1. **通过界面**: 设置 → 备份与恢复 → 导出
2. **手动拷贝**:
   - Windows: `%APPDATA%\legadoQ\data`
   - Linux: `~/.config/legadoQ/data`
   - macOS: `~/Library/Application Support/legadoQ/data`

### Q4: 如何升级版本？

**A**:

1. 下载新版本压缩包
2. 备份旧数据（可选）
3. 解压覆盖即可（配置文件保留）

---

## 📱 初次使用流程

### 1️⃣ 导入书源

**途径一：发现页浏览**
1. 点击左侧菜单「发现」
2. 选择感兴趣的分类
3. 点击书籍封面进入详情页

**途径二：手动导入**
1. 点击左侧菜单「书源」
2. 点击右上角「+」按钮
3. 粘贴 JSON 书源代码或上传 `.json` 文件

**获取书源来源**:
- Telegram 群组分享
- 开源社区推荐
- Legado 官方书源仓库

### 2️⃣ 搜索书籍

1. 点击左上角搜索图标
2. 输入书名关键词
3. 等待搜索结果返回（WebSocket 流式）
4. 点击喜欢的书籍封面

### 3️⃣ 添加到书架

1. 进入书籍详情页面
2. 点击「加入书架」按钮
3. 可选择分组管理

### 4️⃣ 开始阅读

1. 在书架中找到书籍
2. 点击封面打开阅读器
3. 调整阅读设置（字号、主题等）
4. 享受阅读体验

---

## 🎨 个性化设置

### 阅读器主题

- **白昼模式**: 经典黑白
- **夜间模式**: 深色护眼
- **护眼模式**: 暖色调降低蓝光
- **墨黑模式**: OLED 屏幕专用

### 字体大小

范围：8px - 72px  
推荐：16px - 20px（舒适阅读）

### 背景颜色

支持自定义 RGB/HSL 值，满足个人喜好。

---

## 🛠️ 高级配置

### 环境变量配置

创建 `.env` 文件在根目录：

```bash
# 服务器配置
LEGADO_HOST=127.0.0.1
LEGADO_PORT=1234
LEGADO_DATA_DIR=./data

# 性能优化
JAVA_OPTS="-Xmx512m -Xms256m"

# 日志级别
LOG_LEVEL=INFO
```

### 数据库优化

SQLite WAL 模式已默认启用，如需调整：

```properties
# 开启并行查询
pragmas.query.parallelism=true

# 增大 cache size
pragmas.cache_size=-20000  # 20MB
```

---

## 📞 获取更多帮助

### Telegram 群组

👉 **https://t.me/legadoQ**

**获得帮助**:
- 即时问题解答
- 功能需求讨论
- 新书源分享
- 最佳实践交流

### GitHub Issues

👉 **https://github.com/linqinqiu/legadoQ/issues**

**适合提交**:
- Bug 报告
- 功能建议
- 文档纠错

### 完整文档

👉 **[USER-GUIDE.md](USER-GUIDE.md)** - 用户完整指南

---

## ✅ 成功标志

如果看到以下内容，恭喜你已成功启动：

- ✅ 浏览器打开无错误提示
- ✅ API `/healthz` 返回 `{"status":"RUNNING"}`
- ✅ 主界面正常加载
- ✅ 可以搜索和添加书籍

**现在就开始你的阅读之旅吧！** 📚

---

**版本**: v0.2.34  
**最后更新**: 2026-11-08  
**Telegram**: https://t.me/legadoQ
