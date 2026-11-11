# legadoQ

本地小说 / 漫画阅读服务：Kotlin + Ktor 后端、SQLite、内置 Web UI，默认只监听 `127.0.0.1:1234`。

> 当前版本 **0.2.38**。实际运行版本以 `curl http://127.0.0.1:1234/healthz` 为准。
> 整个目录可整体移动或改名：启动脚本、数据目录、日志都按安装根相对解析，不依赖盘符。

---

## 能做什么

以下功能均以当前 1234 的 `/api/catalog` 与内置 UI 为准。

| 功能面 | 能力 |
|---|---|
| **书架** | 书籍增删、分组、拖动排序、阅读进度、批量操作 |
| **阅读** | TXT / EPUB；滚动与分页两种模式；字号、行距、字体、配色、简繁切换；目录；划线笔记；阅读记录 |
| **搜索** | 多书源并发搜索，WebSocket 流式返回，可中途停止 |
| **发现** | 按书源 `exploreUrl` 分栏浏览 |
| **书源** | JSON 文本 / 文件 / URL 导入；编辑；逐阶段调试；体检；分组与排序；书源订阅 |
| **登录与凭据** | Cookie 管理、登录动作、内置浏览器完成登录 |
| **离线缓存** | 服务端按章节缓存；浏览器 IndexedDB 下载到本设备 |
| **分章规则** | 内置 TXT 分章规则，可新建、编辑、按文件自动匹配 |
| **净化规则** | 替换规则增删改、导入导出、预览 |
| **图片与媒体** | 漫画逐图、音频、视频、文件直链 |
| **朗读** | Edge TTS、自定义 HTTP 音频接口、浏览器语音；跨章连播、定时 |
| **RSS** | 订阅源与文章读取 |
| **备份** | Legado 备份包导入与导出 |
| **系统** | 服务端口、运行日志等 |
| **PWA** | 可安装到桌面，支持离线壳 |

## 边界

不内置任何书源、订阅源或作品内容；书源与内容由使用者自行导入。

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

## 快速开始

前置：Node.js 20+、Java 17+。

```bash
npm start
# 打开 http://127.0.0.1:1234

npm run stop
```

Windows 也可以双击 `scripts\start.cmd`；Linux/macOS 用 `scripts/start.sh`。

首次使用：打开界面 → 书源管理 → 导入书源 JSON → 搜索或从发现页开书。

---

## API

- 端点总数：**161**（19 组），分组与逐条说明见 [`docs/API-REFERENCE.md`](docs/API-REFERENCE.md)。
- 机器可读目录：`GET http://127.0.0.1:1234/api/catalog`。
- 接入说明：[`product/docs/agent-api.md`](product/docs/agent-api.md)。

安全模型：

- 只监听 `127.0.0.1`，没有身份认证；绑定地址就是唯一的门。
- `GET` / `HEAD` 直接放行；`POST` / `PUT` / `DELETE` 要求同源 `Origin`。
- 把 `LEGADO_HOST` 改成 `0.0.0.0` 等于把整库写权限交给局域网。启动脚本会拒绝非回环地址，确认要暴露才加 `--allow-external-bind`。

---

## 目录

```
（仓库根）
├── product/             # 产品本体：Ktor 后端 + 内置 UI + 数据
│   ├── app/             # 后端源码（Kotlin/Ktor）
│   ├── web/             # 内置 Web UI 源码
│   ├── docs/            # 产品手册（部署 / 兼容 / 插件框架 / 门禁 / AI 接入 agent-api.md 等）
│   ├── CONTRIBUTING.md  # 中文协作约定（权威版见仓库根 .github/）
│   └── SECURITY.md      # 中文安全基线（权威版见仓库根 .github/）
├── docs/                # 唯一索引 + 架构/API/规划 + research/ 研究快照 + sessions/ 工程日志
├── scripts/             # 版本 / 发布工具（start、stop 在 product/）
├── .github/             # CI 与治理文件（CONTRIBUTING / SECURITY 英文权威版）
├── BUILD_NUMBER         # 内部构建号（与对外版本解耦）
├── RELEASES.md          # 对外版本 ← 构建号 ← commit 的发布记录
├── RELEASING.md         # 发布流程与清单
├── CHANGELOG.md         # 指向 product/CHANGELOG.md
├── LICENSE / NOTICE.md  # MIT（根）/ GPL-3.0（product）
└── VERSION
```

整体结构见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，目录职责与文件放置规则见 [`docs/STRUCTURE.md`](docs/STRUCTURE.md)。

---

## 许可

- 根目录代码与文档：**MIT**（见 `LICENSE`）。
- `product/`：**GPL-3.0**（见 `product/LICENSE`）。
- 分发包含后端的整合包时，必须遵守 GPL-3.0。详见 [`NOTICE.md`](NOTICE.md)。
