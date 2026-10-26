# legadoQ

本地小说 / 漫画阅读服务：Kotlin + Ktor 后端、SQLite、内置 Web UI，默认只监听 `127.0.0.1:1234`。

> 当前版本 **0.0.0**。实际运行版本以 `curl http://127.0.0.1:1234/healthz` 为准。
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

- 端点总数：**142**（19 组），分组与逐条说明见 [`docs/API-REFERENCE.md`](docs/API-REFERENCE.md)。
- 机器可读目录：`GET http://127.0.0.1:1234/api/catalog`。
- 接入说明：[`product/AGENTS.md`](product/AGENTS.md)。

安全模型：

- 只监听 `127.0.0.1`，没有身份认证；绑定地址就是唯一的门。
- `GET` / `HEAD` 直接放行；`POST` / `PUT` / `DELETE` 要求同源 `Origin`。
- 把 `LEGADO_HOST` 改成 `0.0.0.0` 等于把整库写权限交给局域网。

---

## 目录

```
（仓库根）
├── product/             # 产品本体：Ktor 后端 + 内置 UI + 数据
│   ├── app/             # 后端源码（Kotlin/Ktor）
│   ├── web/             # 内置 Web UI 源码
│   ├── docs/            # 后端文档（部署 / 兼容 / 插件框架 / 门禁 等）
│   ├── AGENTS.md        # AI / 脚本自定义接入面（`/api/agent/*`）
│   ├── CONTRIBUTING.md  # 中文协作约定（权威版见仓库根 .github/）
│   └── SECURITY.md      # 中文安全基线（权威版见仓库根 .github/）
├── docs/                # 架构示意、API 参考、目录规划、文档索引（archive/ 存历史归档）
├── scripts/             # start / stop 包装
├── .github/             # CI 与治理文件（CONTRIBUTING / SECURITY 英文权威版）
├── CHANGELOG.md         # 指向 product/CHANGELOG.md
├── LICENSE / NOTICE.md  # MIT（根）/ GPL-3.0（product）
└── VERSION
```

整体结构见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，目录职责与文件放置规则见 [`docs/STRUCTURE.md`](docs/STRUCTURE.md)。

---

## 许可

- 根目录代码与文档：**MIT**（见 `LICENSE`）。
- `legado/`：**GPL-3.0**（见 `legado/LICENSE`）。
- 分发包含后端的整合包时，必须遵守 GPL-3.0。详见 [`NOTICE.md`](NOTICE.md)。
