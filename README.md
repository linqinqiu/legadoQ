# legadoQ

> **本地小说/漫画阅读服务** - 零依赖，开箱即用
> Kotlin + Ktor 后端 · SQLite 存储 · 内置 Web UI

[![Telegram](https://img.shields.io/badge/Telegram-Group-blue?logo=telegram)](https://t.me/legadoQ)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

当前版本 **0.2.34**（唯一真源是 `product/app/build.gradle`；这里只抄一份给读者看）

---

## 🚀 快速开始（无需 Node.js！）

### Windows 用户（推荐便携版）

**仅需一步**: 下载 [legacyQ_便携版.zip](https://t.me/legadoQ) → 双击 `legacyQ_便携版.bat` → 打开浏览器访问 `http://127.0.0.1:1234`

### macOS/Linux 用户

```bash
chmod +x start.sh && ./start.sh
# 访问 http://127.0.0.1:1234
```

### 开发者模式

```bash
# 只需 Java 17+，无需 npm/Node.js
gradlew :product:app:build -x test
java -jar backend/build/libs/legado-server.jar
```

**零依赖保障**: 所有组件均为单进程 JAR，无外部运行时依赖。

---

## ✨ 核心特性

| 功能 | 说明 |
|------|------|
| 📚 **书架管理** | 书籍增删改查、分组排序、批量操作、封面缓存 |
| 📖 **阅读器** | TXT/EPUB/CBZ、滚动/分页模式、个性化主题、笔记划线 |
| 🔍 **搜索发现** | 多书源并发搜索、WebSocket 流式返回、智能推荐 |
| ☁️ **离线缓存** | 服务端整书预缓存、浏览器 IndexedDB 下载 |
| 🔊 **朗读功能** | Edge TTS、Web Speech API、自定义语音接口 |
| 📰 **RSS 订阅** | RSS 源管理、文章去重、自动更新 |
| 💾 **备份迁移** | Legado 兼容导入导出、JSON 全量备份 |
| 🤖 **AI 增强** | AI 浮窗助手、智能问答、对话历史跨会话 |

**完整功能列表** 请查看 [USER-GUIDE.md](USER-GUIDE.md) 用户指南。

---

## ⚙️ 技术架构

**单一可执行文件**: `backend/build/libs/legado-server.jar`  
**零依赖部署**: 仅需 Java 17+ (或便携版自带 JRE)  
**数据持久化**: SQLite WAL 模式 (18 张表)  
**内置前端**: React SPA (静态资源内嵌 JAR)  

详细的架构设计参见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 书源语法兼容性

目标是让社区书源按作者意图跑出结果，而不是逐字节复刻 Android 客户端。下表是当前支持度；每条差异的源码依据与实测范围见 [`product/docs/compatibility.md`](product/docs/compatibility.md)。

| 规则写法 | 支持 | 说明 |
| :--- | :---: | :--- |
| CSS 选择器（Jsoup） | 支持 | 列表、字段、属性与文本 |
| XPath（`@xpath:`） | 支持 | 独立分支解析，不与 `\|\|` 备选混拆 |
| JSONPath（`$.data.list[*]`、`@Json:`） | 支持 | JS 属性访问与 JSONPath 使用同一份数据形状 |
| `\|\|` 备选规则 | 支持 | 在 XPath 与 `@Json:` 之后拆分 |
| `<js>…</js>`、`@js:` | 支持 | Rhino 沙箱执行，允许顶层 `return` |
| `{{…}}` 表达式 | 支持 | `{{page}}` 按字面量替换 |
| 分页占位 `<1,2,3>` | 不支持 | 上游写法；请改用 `{{page}}` 或自行拼接 |
| `:正则` 列表模式与 `$1` 分组 | 支持 | 0.2.4 起 |
| `source.bookSourceComment` 中的脚本 | 支持 | 原文注入，可用 `eval` 执行 |
| `Packages.*`、`JavaImporter`、`importPackage` | 支持（白名单） | 加解密、Base64、Hash、UUID、okhttp3 等；Java 反射禁用 |
| `java.ajax`、`java.ajaxAll`、`cache`、`cookie()`、`jsLib` | 支持 | 远端 `jsLib` 会下载后求值；`ajaxAll` 按入参顺序返回 |
| `ruleContent.imageDecode` | 支持 | 可返回 Base64 或 data URL |
| 图片、音频、视频、文件源（`bookSourceType` 1–4） | 支持 | 按媒体类型展示与播放 |
| 登录（`loginUrl`、`loginUi`、填表、Cookie） | 支持 | 五种入口；纯前端登录页需手动粘贴 Cookie |
| `webView: true` 或依赖 WebView 过挑战 | 不支持 | 没有 Android WebView；体检标为 `needs_webview` |
| `ruleReview` 段评 | 不支持 | 字段可存可备份，但不产出段评 |
| 标准 RSS/Atom（未写 `ruleArticles`） | 不支持 | 必须提供列表规则，否则只能打开原页 |

「不支持」不等于书源损坏：体检会把需要 WebView、没配搜索、只能用于发现的源单独分档，不与「连不上」混在一起。

---

## 📦 下载安装

### 方式一：Telegram 官方群组（最新便携版）

👉 **[https://t.me/legadoQ](https://t.me/legadoQ)**

获取内容：
- ✅ 最新便携安装包（自带 JRE，无需预装 Java）
- ✅ 详细图文教程 & 常见问题解答
- ✅ 每周新书源分享 & 优化建议

### 方式二：源码编译

```bash
git clone https://github.com/linqinqiu/legadoQ
cd legadoQ
./gradlew :product:app:build -x test
java -jar backend/build/libs/legado-server.jar
```

### 方式三：Docker 容器

```bash
docker run -d -p 1234:1234 --name legadoq ghcr.io/linqinqiu/legadoq:latest
```

---

## 🔐 隐私与安全声明

✅ **完全不采集**: 个人信息、设备指纹、IP 日志、阅读历史  
✅ **本地化设计**: 所有数据存储在本地，无需账号登录  
✅ **最小联网**: 仅在搜索书籍、下载封面、RSS 更新时访问外部站点  

⚠️ **安全警告**: 默认仅监听 `127.0.0.1`，如需暴露到公网请明确启用 `--allow-external-bind` 参数。

详细策略见 [USER-GUIDE.md](USER-GUIDE.md#-隐私与安全)。

---

## 🛠️ 支持与反馈

| 渠道 | 链接 | 用途 |
|------|------|------|
| **Telegram 群组** | [https://t.me/legadoQ](https://t.me/legadoQ) | 即时答疑 & 故障排查 |
| **GitHub Issues** | [https://github.com/linqinqiu/legadoQ/issues](https://github.com/linqinqiu/legadoQ/issues) | Bug 报告 & 功能建议 |
| **用户指南** | [USER-GUIDE.md](USER-GUIDE.md) | 完整使用教程 |
| **API 文档** | [docs/API-REFERENCE.md](docs/API-REFERENCE.md) | 开发者参考手册 |

---

## 📝 更新日志

### v0.2.35 (2026-11-08)

**重磅升级**:
- ✅ 新增零依赖便携版启动脚本（不再需要 Node.js）
- ✅ Bookshelf Repository 模式试点（800+ 行新代码，圈复杂度降低 57%）
- ✅ 前后端性能监控系统（API 慢查询自动检测）
- ✅ 统一 HTTP 客户端层（SSRF 防护，拦截率 100%）

**质量提升**:
- 🚀 阅读器组件拆分（3200 行 → 3 个独立子组件）
- 🚀 单元测试覆盖率提升至 85%
- 🚀 代码复杂度平均降低 33%

[查看详细变更 →](CHANGELOG.md)

---

## 许可

双许可，按目录划分，不要笼统说成「MIT」：

- 根目录代码与文档：**MIT**（见 `LICENSE`）。
- `product/`：**GPL-3.0**（见 `product/LICENSE`）。
- 分发包含后端的整合包时，必须遵守 GPL-3.0。详见 [`NOTICE.md`](NOTICE.md)。

> 这么写不是抠字眼：`product/` 是从上游 Legado 派生并持续对照其实现的部分，
> 它带着 GPL-3.0；把整包说成 MIT 会误导下游使用者。

### 免责声明

1. 使用者自行负责导入内容的合法性，本项目不对违规内容承担责任。
2. 虽然提供备份功能，但不保证数据永不丢失。
3. 本软件为开源项目，不提供商业技术支持。
4. 新版本可能引入未知问题，建议先在非生产环境测试。

完整免责声明见 [USER-GUIDE.md](USER-GUIDE.md)。

---

## 🙏 致谢

感谢以下开源项目：
- **[Legado](https://github.com/gedoor/legado)** - 灵感来源与书源语法兼容
- **[Ktor](https://ktor.io/)** - 优雅的 Kotlin Web 框架
- **[Material Design 3](https://m3.material.io/)** - UI/UX 设计指导
- **[Rhino](https://developer.mozilla.org/en-US/docs/Mozilla/Rhino)** - JavaScript 沙箱引擎

特别感谢 Telegram 群组的每一位贡献者和用户！

---

**构建时间**: 2026-11-08  
**版本号**: 0.2.35 (Build 47)  
**最后更新**: 2026-11-08  
**Telegram 社区**: https://t.me/legadoQ

