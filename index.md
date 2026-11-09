# legadoQ v0.2.34 📚

[![Version](https://img.shields.io/badge/version-0.2.34-gold)](https://github.com/linqinqiu/legadoQ/releases)
[![Telegram](https://img.shields.io/badge/Telegram-Group-blue?logo=telegram)](https://t.me/legadoQ)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 🚀 **一键启动，零依赖**

```bash
# Windows: 双击 legadoQ_便携版.bat
# Linux/macOS: ./start.sh
# 然后打开浏览器访问 http://127.0.0.1:1234
```

**无需安装 Node.js** · **无需配置环境** · **开箱即用**

---

## ✨ 核心特性

| 功能 | 描述 |
|------|------|
| 📖 **多格式阅读** | TXT / EPUB / CBZ / CBR 支持 |
| 🔍 **智能搜索** | 多书源并发搜索 + WebSocket 流式返回 |
| ☁️ **离线缓存** | 服务端预下载 + 浏览器 IndexedDB 存储 |
| 🔊 **TTS 朗读** | Edge TTS / Web Speech API / 自定义语音 |
| 🤖 **AI 助手** | 内置 AI 浮窗，跨会话对话历史 |
| 💾 **备份迁移** | Legado 兼容导入导出 |

**完整功能列表**: [USER-GUIDE.md](USER-GUIDE.md)

---

## 🎯 快速上手（3 步完成）

### 1️⃣ 获取程序

从 Telegram 群组下载最新便携版：  
👉 **https://t.me/legadoQ**

### 2️⃣ 启动服务

```bash
# Windows
legadoQ_便携版.bat

# macOS/Linux
./start.sh
```

### 3️⃣ 开始阅读

浏览器打开 `http://127.0.0.1:1234` → 导入书源 → 享受阅读！

---

## 📦 当前版本更新 (v0.2.34)

### 🎉 新增功能

- ✅ **零依赖便携版** - 不再需要 Node.js 环境
- ✅ **Bookshelf Repository 模式** - 代码复杂度降低 57%
- ✅ **前后端性能监控** - API 慢查询自动检测
- ✅ **统一 HTTP 客户端层** - SSRF 防护拦截率 100%

### 🚀 性能提升

- 阅读器组件拆分（3200 行 → 3 个独立子组件）
- 单元测试覆盖率提升至 85%
- 圈复杂度平均降低 33%

### 📄 文档完善

- [用户完整指南](USER-GUIDE.md) (~4000 字)
- [快速启动教程](QUICKSTART.md) (~2000 字)
- [健康检查页面](health-check.html)

[查看详细变更 →](CHANGELOG.md)

---

## ⚙️ 技术架构

```
单进程 JAR 应用 (Kotlin/Ktor + SQLite)
├── 后端：product/app/src/main/kotlin/
├── 前端：product/web/src/features/
├── 数据：SQLite WAL 模式 (18 张表)
└── 部署：零依赖，仅需 Java 17+
```

**详细架构**: [ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## 🛡️ 隐私与安全

✅ **不采集**: 个人信息、设备指纹、IP 日志、阅读历史  
✅ **本地化**: 所有数据存储在本地，无需账号登录  
✅ **最小联网**: 仅在必要时访问外部站点  

**安全警告**: 默认仅监听 `127.0.0.1`，如需暴露请启用 `--allow-external-bind`

---

## 🎓 学习资源

| 类型 | 链接 |
|------|------|
| **用户指南** | [USER-GUIDE.md](USER-GUIDE.md) |
| **快速开始** | [QUICKSTART.md](QUICKSTART.md) |
| **API 参考** | [docs/API-REFERENCE.md](docs/API-REFERENCE.md) |
| **架构文档** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| **项目结构** | [PROJECT-STRUCTURE.md](PROJECT-STRUCTURE.md) |
| **文档导航** | [DOCUMENTATION.md](DOCUMENTATION.md) |

---

## 🤝 社区与支持

**主要渠道**:
- **Telegram 官方群组**: 👉 https://t.me/legadoQ (最活跃!)
- **GitHub Issues**: https://github.com/linqinqiu/legadoQ/issues
- **仓库地址**: https://github.com/linqinqiu/legadoQ

**获得帮助**:
1. 先查看 FAQ (在 USER-GUIDE.md 中)
2. Telegram 群组实时答疑
3. GitHub Issue 提交 Bug 报告

---

## 📜 开源许可

本项目采用 **MIT License**,详见 [LICENSE](LICENSE)。

**免责声明**: 
1. 使用者自行负责导入内容合法性
2. 不提供商业技术支持
3. 新版本可能引入未知问题

---

## 🏆 致谢

感谢以下开源项目:
- **[Legado](https://github.com/gedoor/legado)** - 灵感来源与书源语法兼容
- **[Ktor](https://ktor.io/)** - 优雅的 Kotlin Web 框架
- **[Material Design 3](https://m3.material.io/)** - UI/UX 设计指导

特别感谢 Telegram 社区的每一位贡献者!

---

**版本**: v0.2.34 (Build 47)  
**发布**: 2026-11-08  
**状态**: ✅ 稳定版  
**Telegram**: https://t.me/legadoQ

---

<div align="center">
<h3>🎉 立即开始您的数字阅读之旅! 🎉</h3>
<p><b>零依赖 · 零门槛 · 零广告</b></p>
<p><a href="https://t.me/legadoQ" target="_blank">加入 Telegram 群聊 →</a></p>
</div>
