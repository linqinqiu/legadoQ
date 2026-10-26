<div align="center">

<img src="./web/public/favicon.svg" width="96" height="96" alt="青阅 Logo" />

# 青阅

把 [Legado（开源阅读）](https://github.com/gedoor/legado) 的书源规则搬到服务端跑：一个 JVM 进程 + 一个浏览器界面，书架、发现、订阅、朗读、离线缓存都在自己机器上。

[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

</div>

---

## 这个仓库里有什么 / 没有什么

**有**：书源规则的解析执行器（`@xpath:` / `@json:` / `@js:` / `@regex:` 这些取值语法）、书架与阅读进度、发现页、订阅源、正文净化规则、离线缓存、朗读、手机备份包导入，以及配套的 Web 界面。

**没有**：任何书源、订阅源、发现源地址，也不内置作品。规则和站点由使用者自己导入。

服务默认只监听 `127.0.0.1`，数据放在你自己的目录里。没有账号、密码、登录页和会话。

## Windows 桌面程序

桌面程序这一档**当前不在 Releases 上**（Releases 上现在只有 `legado.jar`、`legado-dist.zip` 与按版本号打的整合包 `qingyue-<版本>.zip`）。要桌面版就自己打一次：

```bash
node scripts/package-desktop.mjs   # 需要 JAVA_HOME 指向带 jpackage/jlink 的 JDK（Temurin 17 即可）
```

产出 `dist/qingyue-desktop-<版本>.zip`，解压后双击 `qingyue.exe`：

- 自带精简 JRE，**不要求装 Java**；
- 起来后开一个**独立的应用窗口**（无地址栏、无标签页，任务栏里是青阅自己的图标），地址仍是 `http://127.0.0.1:<端口>`；
  找不到可用的 Edge / Chrome 时才退回系统默认浏览器开标签页。**关掉这个窗口就是退出青阅**（服务干净停止、端口释放）；
  想让服务常驻而不要窗口，用 `qingyue.exe --no-open` 起，托盘里的「打开 / 退出」照常在；
  浏览器可执行文件不按机器默认找的顺序时，用 `.env` 写 `LEGADO_BROWSER_PATH=<路径>` 指定；
- 数据默认放在 exe 旁边的 `data/`；想用已有的书架，在 exe 旁放一个 `.env` 写 `LEGADO_DATA_DIR=<你的数据目录>`；
- 端口上已经是青阅在跑 → 不再起第二个进程，只把界面打开；端口被**别的程序**占了 → 从下一个端口起顺延找一个空闲的（往后 20 个内），并用它写回 `port.txt`，下次启动仍稳定在那个端口（界面上「设置 → 服务 → 服务端口」看到的也是它）。

## 技术栈

Kotlin JVM 17 + Ktor 3.4 + SQLite（WAL）。前端 React 19 + TypeScript + Vite，构建产物打进同一个 jar，可当 PWA 装到桌面。规则里的 `@js:` 段跑在 Rhino 沙箱里，HTML / XML / JSON 取值分别用 Jsoup、JsoupXpath、JsonPath。

## 能力

- **搜索**：WebSocket 流式返回（`/api/search/stream`），各书源并发检索，边搜边出，中途可停。开书只请求主书源，候选源按需再取。
- **书架**：按分组整理、批量删除 / 标已读 / 移到分组，卡片可以拖着排自己的顺序（也可一键回到"从没拖过"），封面下方那条进度按读到哪一章画。
- **发现**：读每个书源的 `exploreUrl` 分栏列出推荐书籍；聚合源动辄四十多个重名分栏，所以同名分栏会带上源名区分，并按分组筛要看的源。
- **阅读**：连续滚动与平移分页两种模式，分页在宽屏排多栏，章末自动补齐到整页（否则下一章的第一栏正好是上一页的右半格，同一页会被看两遍）。字号、行距、段距、首行缩进、左右边距、版心宽度可调；内置七种字体（宋 / 黑 / 楷 / 仿宋 / 圆体 / 系统 / 等宽），也可以填本机装着的任意字体名；七套内置配色再加一套**自定义皮肤库**（自己写 CSS 变量覆盖，可以存多套、各有基档），阅读区还能另设背景色、背景图与压暗比例。正文可以在简繁之间整体切换（原文 / 简 → 繁 / 繁 → 简，只换字形不换词，章名目录朗读一起走）。目录栏宽度可拖。点哪儿算什么由你定：正文可以按任意行列划成格子，每格挑一个动作（上一页 / 下一页 / 呼出工具栏 / 目录 / 设置 / 不响应），四套预设整套换，翻页与滚动各存一张表。进度自动记录。选中正文可以划线、加备注（也能删），这本书的所有划线列在目录那一栏里，点一条跳到那一章。右上角那排按钮显示哪些、按什么顺序，也能在设置里改（至少留一个，全隐藏不合法）。读过的时间按天汇总，入口在「我的 → 阅读记录」。
- **目录**：虚拟列表渲染，几千章的目录只挂视口内的行。
- **非文本内容**：漫画（逐张图片，支持离线缓存带图）、有声书 / 音频（内嵌播放器）、视频、文件直链，阅读器按书源类型自动分流。
- **离线**：按「后 50 章 / 后 100 章 / 全本 / 自定义区间」缓存到服务端，已缓存的章节跳过，任务可中断可续。另有「下载到本设备」把正文写进浏览器 IndexedDB，断网可读；「设置 → 管理离线缓存」按书列出本机占用的空间，可以单本清除，数据只从这台设备的浏览器里读。
- **朗读**：三种引擎 —— 浏览器自己的语音、服务端内置的微软 Edge-TTS 连续音频流、自建 HTTP 音频接口（填地址、发音人标识与附加请求头，第三方服务基本都要一个 key）；支持跨章连播、点击段落选播、睡眠定时（15 / 30 / 45 / 60 分钟或读完本章即停）；播放条可长按挪位置，位置记在本机。
- **键盘**：阅读器里 `← →` 跨章、`Page Up / Down / 空格` 翻屏、`Home / End` 章首章末、`+ / -` 字号、`Ctrl + 滚轮` 直接调字号、`T` 换配色、`D` 目录、`S` 阅读设置、`M` 朗读、`F` 全屏、`Esc` 收层；全局 `1`–`6` 切一级页、`/` 与 `Ctrl + F` 聚焦当前页的搜索框、`Alt + ← / →` 循环切页、`L` 运行日志、`?` 就地查这张表。按键表与处理逻辑同源一份，界面上查到的就是按下去做的。
- **书源管理**：JSON 文本 / 文件 / URL 三种导入，按分组与关键字筛选，批量启停与打标签，长按拖动排序；体检带关键词实跑一次搜索再分档 —— 只有「连不上 / 证书问题 / 规则失效 / 结构错误」这四类算坏，会被「一键停用 / 一键删除」圈走；没配搜索地址的源单独一档「未配搜索」，它一次请求都没发过，所以不算连不上。
- **订阅**：RSS 源与文章都由服务端取。库里几百条订阅源里往往只有一部分配了取文章的规则，因此列表默认「只看能读的」，其余收在开关后面，不混在一起显示成"读不出"。
- **本地书**：TXT / EPUB 导入，26 条分章规则可选、可新建、可编辑，也能让程序读文件头打分自动挑一条；已经在读的那本可以换规则重切目录。
- **手机备份包**：见下面单独一节。
- **写操作保护**：浏览器发出的跨站写请求一定带 `Origin`，与本机 Host 不一致就 403。抓取侧对重定向后的地址复验，拒绝内网与链路本地目标；正文进界面前做净化，图片走代理。
- **AI 接入**：程序内部的 AI 网关（8 个端点，`GET /api/agent/manifest` 可查能力清单）。**要先登记一个外部模型**（任何 openai-compatible 的地址：本机 Ollama、各家 API、自建网关都行）才能用；没登记就是明确报「未连接」，不会拿本地规则拼一段话冒充模型回答。接上之后它能做两类事，见下面单独一节。

## AI 能帮你做什么

先说清楚它**是什么**：一个**进程内**的 AI 网关，不是外挂的聊天框。
它拿到的服务和界面用的是同一批 —— 所以它知道你在哪一页、在看哪本书、读到第几章，
也能调用程序自己的 54 个能力（查书源、搜书、改净化规则、读正文……）。

**用法**：设置 → 接入与扩展 → AI 接入 → 登记一个 openai-compatible 连接。
登记完输入框才可用；面板顶部有两个状态，别混：「已连接」说的是**配没配**，
「实测可达」说的是**此刻通不通** —— 只有实测 ok 才代表真能对话。

### 能做的事（都是真的，不是设想）

| 你想问的 | 它会怎么做 |
|---|---|
| 「这本书讲了什么」 | 从界面上下文知道是哪本书，用工具去取目录与正文，再回答 —— 不是凭空猜 |
| 「这个书源为什么搜不出书」 | 调 `source.debug` 逐阶段跑（结构/搜索/详情/目录/正文），告诉你坏在哪一步 |
| 「帮我看看哪些书源已经废了」 | 调 `source.health` 实跑体检，按结果分档 |
| 「把正文里那些广告行去掉」 | 调 `replace.list` / `replace.save` 直接改净化规则，改完你可以在设置里看到 |
| 「搜一下《×××》」 | 调 `search.run` 真去各书源搜，把结果带回来 |

它**不会**做的事：不联网查资料、不生成图片、不碰书架之外的文件。
所有写操作都过护栏（批量删除要显式确认），失败时明确报错而不是编一个结果。

### 没有外部模型时

AI 面板显示「未连接外部模型，AI 不可用」，输入框禁用。
**这是设计如此**：0.8.3 删掉了「本地关键词抽取兜底」——
拿正则抽出来的东西冒充模型回答，会让人分不清哪句是真模型说的。宁可明确说不可用。

### 接别的模型 / 给 AI 加能力

- 想接 Anthropic、Ollama、自建服务：实现 `LlmProvider` 注册进 `providerRegistry`，见 [`docs/plugin-framework.md`](docs/plugin-framework.md)。
- 想给 AI 加自己的工具：往 `ToolRegistry` 注册，AI 立刻能调 —— 不用改框架。
- 多连接时默认只走**第一个**，不自动顺延（这是已确认的行为，不是 bug）。
- 完整接入说明见 [`AGENTS.md`](AGENTS.md)。

## 环境要求

| | 版本 | 说明 |
| --- | --- | --- |
| JDK | **17+** | `app/build.gradle` 的 toolchain 锁 17；CI 用 Temurin 21 也能编。只有「直接跑 jar / 从源码跑」需要，整合包与桌面版自带运行时 |
| Node | **20+**（CI 用 22，见 `.nvmrc`） | 构建或跑前端时需要 |
| Gradle | 用仓库自带的 `./gradlew` | 不用另装 |

## 怎么跑起来

### Windows 桌面程序（免 Java）

见上一节：`node scripts/package-desktop.mjs` 打出 `dist/qingyue-desktop-<版本>.zip`，解压双击 `qingyue.exe`。这一档还没上传到 Releases，所以只能自己打（或者在 Issues 里问维护者要一份）。

### 整合包 jar（免 Java）

Releases 下载 `qingyue-<版本>.zip`，解压后运行 `start.bat`（默认端口 1234，可用 `start.bat 1235` 换）。

### 直接跑 jar（需要 Java 17+）

```bash
java -jar legado-<版本>-all.jar
```

（Releases 上那份被流水线改名成了 `legado.jar`，内容同一件东西。）浏览器打开 `http://127.0.0.1:8080`。数据落在当前目录的 `data/`。换端口或数据目录：

```bash
LEGADO_PORT=9000 LEGADO_DATA_DIR=/srv/qingyue/data java -jar legado-<版本>-all.jar
```

自己构建：

```bash
npm --prefix web run build
./gradlew :app:fatJar      # → app/build/libs/legado-<版本>-all.jar
node tools/make-cds.mjs       # 可选：生成 CDS 归档，冷启动 ~8.3s → ~5.3s；过期时 start.mjs 会自动重建
```

### Docker

镜像需本地构建（CI 的镜像发布还没通）：

```bash
docker build -f Dockerfile -t qingyue .
docker run -d --name qingyue --restart unless-stopped \
  -p 8080:8080 -v ./ls_data:/data qingyue
```

容器内要把 `LEGADO_HOST` 设成 `0.0.0.0` 才接得住宿主机映射（Dockerfile 里已经这么设）。仓库带了一份 `compose.yml`。

### 从源码跑

```bash
cd web && npm install && npm run dev     # 前端开发服务器（热重载）
./gradlew :app:run                    # 服务端
```

## 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `LEGADO_HOST` | `127.0.0.1` | 绑定地址。改成 `0.0.0.0` 就局域网可达，见下一节 |
| `LEGADO_PORT` | `8080`（裸 jar）；启动脚本 / 桌面版 `1234` | HTTP 与 WebSocket 端口 |
| `LEGADO_DATA_DIR` | `data` | 数据根目录，封面缓存与本地书都从它下面派生 |
| `LEGADO_DATABASE` | `$LEGADO_DATA_DIR/legado.sqlite` | 单独指定库文件位置 |
| `LEGADO_LOG_FILE` | `<安装根>/server.log` | 运行日志 |
| `LEGADO_TMP_DIR` | `<安装根>/tmp` | JVM 临时目录。不指定的话 SQLite 的原生库每次启动都往系统盘 `Temp` 解一份 |
| `LEGADO_HOME` | 当前目录 | 安装根：`port.txt`、`server.log`、`tmp/` 都从它下面派生。由启动器传入（`scripts/runtime.mjs`），裸跑 jar 一般不用管 |
| `LEGADO_REPO` | `linqinqiu/qingyue` | `owner/repo` 形状，供「关于」页检查更新；默认本项目自己的仓库，换 fork 时改它 |

`start.mjs` / `stop.mjs` 是可选封装（后台拉起、按端口停进程），以脚本自己所在目录为安装根，整个文件夹可以改名或搬盘。`start.mjs` 支持 `--port 1235` 换端口、`--host 0.0.0.0` 换绑定地址、`--no-open` 只起服务不开浏览器（默认起来后自动打开浏览器）。端口也可以**在界面上改**（设置 → 服务 → 服务端口，重启后生效，写的是安装根下的 `port.txt`）；优先级 `--port` > `port.txt` > `.env` / 环境变量 > 1234。同目录的 `start.cmd` 是给双击用的门面：服务没跑就起、等就绪再开界面；已经在跑就直接开界面。

## 想给手机用之前

这个服务不设身份，绑定地址就是唯一的门。默认只绑回环，所以手机连不上是设计如此。要跨设备用，设 `LEGADO_HOST=0.0.0.0` 重启 —— 同时清楚这意味着同一张网里任何人都能读改这个库（书源、书架、登录凭据）。要认真做就在前面放一层带鉴权的反向代理，或者走隧道，别把服务直接暴露出去。

## 手机备份包

手机上「我的 → 备份与恢复 → 备份到本地」产出的 zip，选进「备份」页（`#backup`）即可导入，全程只在本机与这个服务之间传输。

| 项目 | 说明 |
| --- | --- |
| 接口 | `POST /api/backup/import`（multipart：`file` + 可选 `password`） |
| 恢复内容 | 书源 / 替换净化规则 / 书架与阅读进度 / RSS 订阅源 / 分组 / 登录凭据 |
| 启用位 | 已存在的书源保留本机启用/停用状态，只更新规则内容；新入库的按包内值启用 |
| 分组 | 包内 `bookGroup.json` 的组号按组名映射到本机现有组，同名只留一个 |
| 加密条目 | 包内 `cookies.json` 用备份密码加密（口径同上游：`AES(MD5(password)[:16])`），填密码才解得开 |
| 原样收下 | 包里没有原生归宿的个性化条目（TXT 分章规则、搜索历史、阅读样式、朗读引擎……）不会让整包被拒收：条目原样存在数据目录里，界面按条列出名字与大小、可下载，其中阅读样式、朗读引擎与分章规则能一步套到本机 |
| 临时文件 | 读完即删，不留在数据目录；日志里只有文件名与条数 |
| 承接不了的条目 | 条目名会在导入结果里念出来，不静默丢弃 |

## 目录结构

```text
app/                        Ktor 服务端（Kotlin JVM，按职责拆包；Gradle 模块）
  src/main/kotlin/io/legado/
    Application.kt          启动入口与 Ktor 特性装配
    ServerConfig.kt · AppConfig.kt   环境变量到默认值
    StaticWeb.kt            界面静态资源挂载（同端口的 `/` 与 `/next`）
    BuildInfo.kt · DesktopLauncher.kt  版本清单 · 桌面壳（探端口、开浏览器、托盘退出）
    http/                   Guard.kt 写操作同源闸门 · NetworkSecurity.kt · Routes.kt 装配点 + 按面拆组的 <面>Routes.kt（REST 与 WebSocket）· RouteCatalog.kt 端点契约（与 /api/catalog 双向核对）
    rules/                  RuleRunner.kt 规则执行（Rhino + Jsoup + JsonPath + XPath）· JsSandbox.kt · JsGuard.kt · RuleSplit.kt · RuleValue.kt · PagingRule.kt
    data/                   Database.kt 连接与建表 · <面>Dao.kt 各数据面（同包扩展）
    source/                 SourceCodec.kt 书源编解码 · SourceHealth.kt 体检分档 · SourceDebugger.kt 分阶段调试 · WebViewProxy.kt 整站反代 · ExternalBrowserLogin.kt
    content/                ContentPipeline.kt · ContentProcessor.kt 正文净化 · LooseJson.kt 宽松 JSON
    cache/                  BookCacheService.kt 离线缓存调度 · CoverCache.kt 封面与防盗链代理
    localbook/              LocalBookParser.kt TXT/EPUB 解析入库 · TxtTocRule.kt 分章规则表与打分
    tts/                    EdgeTtsService.kt · TtsSessionService.kt 会话级连续音频流
    backup/                 BackupImporter.kt · BackupStore.kt · LegacyBackup.kt
    subscription/           SubscriptionService.kt 订阅同步
    ops/                    LogService.kt · UpdateCheck.kt
    model/                  Models.kt 全部请求 / 响应体
    ai/                     进程内 AI 网关：Agent.kt · AgentConnection.kt 句柄 · AgentRoutes.kt 薄收口 · LlmProvider.kt / ToolRegistry.kt / ConnectionSelector.kt 扩展点 · Guardrails.kt · BuiltinTools.kt · AgentCatalog.kt 契约
    plugin/                 EventBus.kt · AppEvents.kt · Plugin.kt · PluginManager.kt 进程内插件框架
  src/main/resources/       agent-api.json（`/api/agent/*` 组 8 条端点契约）· assets/txtTocRule.json
web/                        前端（React 19 + TS + Vite，构建产物进同一个 jar）
  src/main.tsx              应用外壳 + hash 路由 + 全局快捷键
  src/app/                  destinations.ts 路由登记 · pageMeta.ts 页头元信息 · pages.tsx 页面装配
  src/reader/               阅读器与朗读：翻页与滚动几何、点击分区、分句、悬浮条位置、设置读写
                             VirtualChapterList.tsx 目录虚拟列表 · useReaderTts.ts 朗读集群 · contentImages.ts 图片预热 · paragraphs.ts 正文切段 · openBook.ts 传书合同

  src/sources/              书源：结构化字段表、编辑、体检、换源、登录五条路、内置反代浏览器、批量
  src/lib/                  api 端点表、流式搜索 store、IndexedDB 离线库、结果清洗、报错翻译
  src/components/           浮层一档、下拉 / Toast / 右键菜单、日志、订阅 RSS、PWA 更新、皮肤、书源候选列表与书籍详情弹窗
  src/pages/                关于、更新日志、备份、发现、阅读记录、设置、订阅 RSS，与书库 / 书架 / 书源三个主页面
  src/shelf/                封面、空态引导、书架布局与拖动排序
  src/settings/             settingsSections.ts 设置分组登记
  src/features/             按业务面分的功能块（AI 接入面板、设置分区等）
  src/plugins/              内置插件实装：about · backup · changelog · plugin-intro · reading-log · source-health
  src/extensions/           扩展契约（registry.ts）：前端插件的接口面
  src/icons.tsx · styles.css  全站单色图标 · 样式与皮肤令牌
  test/                     单元与静态判据，入口是 test/run-all.ts（它扫目录登记，新加测试文件不用改清单）

tools/verify/               在真实浏览器和真实服务上跑的门禁脚本
scripts/                    tasks.mjs（build / package / dev 单一入口）· runtime.mjs 启动运行时 · package-desktop.mjs 桌面打包 · coverage-report.mjs 覆盖率汇总
docs/                       见下面「文档」一节
compose.yml          Docker Compose 编排
Dockerfile           多阶段构建（前端 + 服务端）
```

## 文档

| 想知道什么 | 看哪份 |
| :--- | :--- |
| 我的书源能不能跑、哪些字段真被执行、和上游 App 差在哪 | [`docs/compatibility.md`](docs/compatibility.md) |
| 整体架构与模块边界 | [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) |
| 部署（jar / Docker / Compose / 桌面程序） | [`docs/deploy.md`](docs/deploy.md) |
| 让 AI 或脚本接进来（管书源、批量整理、走登录） | [`AGENTS.md`](AGENTS.md) · 机器可读的那份是 `GET /api/catalog` |
| **AI 具体能干什么、怎么接一个模型、怎么给它加能力** | [`AGENTS.md`](AGENTS.md) |
| 自定义接入面 `/api/agent/*`（外接模型、书源新建/校验、阅读理解） | [`AGENTS.md`](./AGENTS.md) |
| 插件 / 前端扩展契约 | [docs/plugin-framework.md](docs/plugin-framework.md) |
| **写一个插件**（加工具 / 协议 / 选择策略 / 钩子） | [docs/plugin-development-guide.md](docs/plugin-development-guide.md) |
| **反代书源**（自有中转服务访问目标站） | [docs/reverse-proxy-source-guide.md](docs/reverse-proxy-source-guide.md) |
| 前端命名与文件组织规范 | [docs/frontend-conventions.md](docs/frontend-conventions.md) |
| 门禁怎么跑、CI 里跑哪些 | [docs/gates-guide.md](docs/gates-guide.md) |
| **覆盖率怎么看、先补哪里** | [docs/coverage-guide.md](docs/coverage-guide.md) |
| 对外接口的完整清单 | [`../docs/API-REFERENCE.md`](../docs/API-REFERENCE.md) 或 `GET /api/catalog` |
| 改完端点怎么同步文档 | `npm run docs:api` 重新生成；`npm run docs:api-check` 只比对（CI 会跑） |
| 某个改动当初为什么那样定、量到了什么 | [docs/sessions/](docs/sessions/) 工程日志（一版一份，命名与骨架见其 README） |


## 测试

```bash
./gradlew :app:test             # 服务端：规则解析、数据库生命周期、缓存并发、端到端链路
npm --prefix web test              # 前端：静态判据 + 组件渲染，一条命令跑全部
node tools/verify/selfcheck.mjs    # 对着跑着的服务过一遍：搜索 → 详情 → 目录 → 正文 → 净化
npm run docs:api-check            # 接口文档与 agent-api.json 是否一致（CI 同款）
```

覆盖率一条命令出总报告：`npm run coverage`（前端 c8 + 后端 JaCoCo 合并），见 [`docs/coverage-guide.md`](docs/coverage-guide.md)。

`tools/verify/` 下还有按功能划分的门禁（`toc-rule-check`、`source-health-check`、`shelf-layout-check`、`reader-flow-check`、`version-check` 等），都是开真浏览器量，不打桩。判据口径以 `web/test/` 与 `tools/verify/` 的现有实现为准。

## 青阅到底是什么

三句话：

1. 它是一个**网页版阅读器**：搜索、读书、听书都在浏览器里完成，但程序和数据全部在**你自己的机器上**，不经过任何第三方服务。
2. 它执行的是 **Legado 的书源规则**：去哪里找书、怎么解析页面，由你自己导入书源决定；本项目负责把这些规则在服务端跑起来。
3. 它**不内置任何书源和内容**。它也不是 Legado 的官方产品，而是一个独立实现——不是 fork，代码全部自写，GPL-3.0。

### 与参照项目的关系

| 参照对象 | 关系 | 协议 |
| --- | --- | --- |
| [gedoor/legado](https://github.com/gedoor/legado) | 书源规则 DSL 求值语义、`checkKeyWord` 体检、书源编辑字段分组的参照基准；未拷贝代码，按 Kotlin 逐条自实现。**2026-10 实测它默认分支只剩 `README.md` 与一张图**，要读现行 Android 实现看仍在维护的延续仓 [LegadoTeam/legado](https://github.com/LegadoTeam/legado) | GPL-3.0 |
| [hectorqin/reader](https://github.com/hectorqin/reader) | 仅交互与信息架构参考；**其代码不得引入本仓库**（AGPL-3.0 网络服务条款与本项目 GPL-3.0 不等价）。**2026-10 实测它已换骨**：`master` 只剩一行 `deleted`，`main` 是 Node/TS 重写，已经没有书源 / RSS / 发现这套模型 —— 接口设计可看，数据模型不能当 legado 兼容的依据 | AGPL-3.0 |

后续贡献同样适用：可以参考交互，实现必须自己写。

## 许可

GPL-3.0，见 [LICENSE](LICENSE)。
