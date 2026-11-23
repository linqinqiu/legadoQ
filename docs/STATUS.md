# 当前结构与成果

> 规模数字采集于 **2026-11-13 04:00**，是当时干净工作树的快照；本轮模型拆分后源码文件数已变化，测试状态见下方质量门禁。
> 更细的命令与时间戳见 `product/docs/restructure/facts.md`。facts.md 是**带日期的快照**，用于复现当时的数字；
> 当前版本 / 构建号以 `product/app/build.gradle` 与 `/healthz` 为准；版本门禁从 `product/` 执行 `npm run version:check`。
>
> 当前发布版本 **0.3.0 / build 56** ｜ 活跃分支 `refactor/rebuild` ｜ 远端 `linqinqiu/legadoQ`（私有） ｜ **2026-11-22 实测**：前端 **1,118 项全绿**，`tsc -b` 通过；**2026-11-23 实测**：后端 **1,048 项全绿**（148 个 suite，`--max-workers=2`）。04:00 的规模与旧测试统计仅作快照，不代表当前工作树；实测口径见 `product/docs/restructure/facts.md` §12。
> 本文只写**现在真实具备的能力**，规划中的东西放在最后「已知缺口」一节，且明确标注是缺口。

---

## 1. 仓库形态

`E:\legado` 本身就是 git 仓库（origin = `linqinqiu/legadoQ`），不再分内外两层：

| 路径 | 是什么 |
|---|---|
| `product/` | **唯一能跑的产品**：Kotlin/Ktor 后端 + 内置 Web UI + 桌面壳 + 打包脚本 |
| `docs/` | 总览、API 参考、目录规划、研究笔记与实测记录 |
| `VERSION` / `package.json` | 安装根版本封条与 npm 入口（`npm start` → `product/start.mjs`） |
| `E:\legado-out\legado-releases/`（仓库外） | 历史发行产物（2026-11-11 移出仓库，符合 STRUCTURE「产物出库」） |

版本号真源是 `product/app/build.gradle`；其余版本抄本由 `cd product && npm run version:check` 钉住一致。

---

## 2. 后端结构（Kotlin / Ktor 3.4.3，JDK 17）

**规模**（2026-11-11 22:00，HEAD `9564e26` 实跑）：后端 139 个源文件 / 35,470 行，142 个测试文件 / 1,110 项 `@Test`（实跑 1,109 完成、6 跳过、0 失败）；前端 202 个 `.ts/.tsx` / 38,361 行，134 个测试文件 / 1,056 项测试。

### 2.1 包职责

| 包 | 职责 |
|---|---|
| `http/` | 路由与 HTTP 边界：15 个 `*Routes.kt` 域模块 + `Routes.kt` 只做域声明；系统域（目录/服务/日志/诊断/关于/更新日志）独立成 `http/system/SystemRoutes.kt`；`Guard.kt`（同源写门）、`RouteCatalog.kt`（端点目录） |
| `data/` | 表级 DAO，全部写成 `Database` 的扩展函数；`Database.kt` 只是组合根（连接池 / 建表 / 迁移 / Cookie 工具四件事拆在 `data/db/`：`ConnectionPool` `Schema` `SchemaVersion` `Migration` `CookieUtil`） |
| `reading/` | 阅读域收口 `ReadingRepository`：进度 / 阅读记录 / 笔记划线书签 / 本书检索 / 章节窗口 |
| `experimental/ai/` | AI 网关（**不参与编译/打包**，`/api/agent` 不注册）：2026-11-17 从 `app/src/main/kotlin/io/legado/ai/` 移到 `product/experimental/ai/`，恢复方式见该目录 README |
| `rules/` | 书源规则引擎（Rhino 沙箱、正文/目录/搜索规则、loginUi V1/V2 渲染与动作）；`RuleProcessor` / `RuleContext` / `RuleDispatcher` 是**已接入的扩展点**（0.2.34：求值前先问处理器、没人认领再走内联），`rules/processor/demo/` 是两个可直接注册的示例 |
| `source/` | 书源模型与登录链路（真浏览器登录、跨域凭据抓取、Cookie 罐） |
| `cache/` | 正文缓存、封面缓存、缓存任务调度 |
| `localbook/` | 本地书解析（TXT 分章 / EPUB） |
| `content/` | 正文净化与标题处理 |
| `subscription/` | 书源订阅、RSS |
| `tts/` | Edge TTS 与朗读会话 |
| `ops/` | 运维与出站面：`NetworkSecurity.kt`（出站 SSRF 闸门）、`PinnedProxy.kt`（连接级 IP 固定）、`GuardedHttpClient.kt`、`ProxyHeaders.kt`（反代头）、`ServerIdentity.kt`、`LogService.kt`、`UpdateCheck.kt`、`Metrics.kt`、`UiPrefsStore.kt` |
| `backup/` | 备份包导入（zip 与裸 JSON，兼容兄弟项目扩展条目）；导出尚未支持 |
| `model/` | 纯请求 / 响应 DTO，按系统、书源、发现、阅读、书架、替换规则、备份、日志、凭据、本地书拆为十个同包文件；不依赖其他领域实现（G5 已零基线） |

桌面壳 `DesktopLauncher.kt` 负责窗口、启动画面、托盘与安装目录解析。插件装载机制已整体移除（代码里没有 `plugin/` 包），保留的是工具 / 协议 / 连接选择策略三类**运行时注册表**扩展点。

### 2.2 端点分布（145 条 / 18 组）

| 组 | 条数 | 组 | 条数 |
|---|---:|---|---:|
| 内置浏览器 | 17 | 登录与凭据 | 15 |
| 书架 | 14 | 书源 | 12 |
| 系统 | 11 | 净化规则 | 10 |
| 进度与笔记 | 9 | 朗读 | 9 |
| 分章规则 | 7 | 阅读 | 7 |
| RSS | 7 | 备份 | 6 |
| 图片与媒体 | 6 | 书源订阅 | 5 |
| 发现页 | 3 | 离线缓存 | 3 |
| 搜索 | 2 | 目录 | 1 |

契约由 `resources/agent-api.json` 描述，`FrameworkContractTest`、`web/test/ApiCatalog.test.ts` 与源码双向核对；`npm run docs:api-check` 校验 `docs/API-REFERENCE.md` 一致。

### 2.3 数据层（SQLite，代码建 21 张表）

`source` `source_login_state` `cookie` `book_shelf` `book_shelf_tombstone` `book_group` `reading_progress` `reading_log` `book_note` `book_content_cache` `book_content_process` `book_cache_status` `book_toc_cache` `cover_cache` `replace_rule` `source_subscription` `rss_source` `log_entry` `source_health` `script_cache` `app_meta`

（分章规则不是独立表：`book_shelf.toc_rule` 记住这本书用哪条规则切的章。AI 连接、会话与技能走文件存储，不进库。**代码建的表 ≠ 磁盘上的表**：2026-11-09 实测这台机器 24 张 = 代码建 20 + 遗留 `book_mark`（0.6.12 移除书签后没删表）+ `sqlite_sequence` / `sqlite_stat1` / `sqlite_stat4` 三张内部表。数表数量要用 `sqlite_master` 实测。）

写入走**单写连接 + 全局锁**（WAL + `busy_timeout` + 失败重连），避免流式搜索与进度写入并发撞 `SQLITE_BUSY`。启动时按碎片率决定是否 `VACUUM`。

---

## 3. 前端结构（TypeScript / React 19）

**规模**：202 个 ts/tsx / 38,361 行（`src/`，2026-11-11 实测），134 个测试文件 / 1,056 项。

| 目录 | 内容 |
|---|---|
| `app/` | 应用外壳：`AppHeader`（顶栏、版本芯片、功能菜单）、`pages.tsx`（页面注册表） |
| `features/reader/` | **72 个文件**（含 `settingsPanel/` `dict/` `content/` `dialogs/` `interaction/` `notes/` `tts/` 等子目录）：阅读器主体、目录虚拟列表、笔记/标注、TTS、分页（CSS 分栏 + DOM 量栏）、翻页动画、手势/快捷键 |
| `features/bookshelf/` | 书架页（`ShelfPage`）与书库页（`LibraryPage`）+ 封面、空态引导、拖拽排序、布局与自定义顺序 |
| `features/explore/` | 发现页：按书源 `exploreUrl` 分栏浏览 |
| `features/source-editor/` | 书源页 + 编辑器面板、字段表单、健康体检、登录浮层、换源弹窗、订阅面板 |
| `features/settings/` | 设置页 + 分区表（数据权威源 `settingsSections.ts`）、AI 工具、Cookie、壁纸分区 |
| `features/ai/` | AI 悬浮球、对话面板（流式）、多会话、连接管理、技能库 |
| `features/rss/` | RSS 页与文章阅读 |
| `plugins/` | 页面级插件：`about` `backup` `changelog` `reading-log` `source-health`，以及 Slot/Extension 外壳（`slotRegistry`、`extensionRegistry`、`attachmentStore`、`ExtensionSlot`） |
| `lib/api/` | 按域拆分的 API 客户端：`client.ts` + `types.ts` + `domains/*`；`lib/api.ts` 保留旧 `api` 对象形状作兼容层 |
| `lib/` 其余 | 品牌 store、导航、离线存储、拖拽排序、字号/字体库、AI 会话 store 等 |
| `components/` | 通用弹层与控件（ContextMenu、Select、Toast、各类 Modal），22 个文件 |

**页面与业务的边界**：**没有 `pages/` 目录了** —— 路由级页面直接住在它自己的域里
（`features/bookshelf/ShelfPage.tsx`、`plugins/about/AboutPage.tsx`），注册表是 `app/pages.tsx`；
业务实现在同域的其余文件里。`lib/api.ts` 是兼容层，新代码按域引用
（`lib/api/domains/*` 或 `lib/api` 的类型），旧的 `api.xxx` 写法继续可用。

**阅读器三个地基**：逻辑位置模型（章节 + 字符偏移 + 段落锚点 + 校验值，页码只作派生显示）；分页引擎（字体/字号/行距/边距/窗口精确分页，Worker 计算，IndexedDB 缓存，改字号靠锚点原地重量）；章节窗口（前接章 + 当前章 + 后接章，后端 `chapterWindow()` 已实现）。

---

## 4. 安全模型

这台服务**不设身份**（无账号、无 token、无会话），安全边界靠六条：

1. **只绑回环**：默认 `127.0.0.1:1234`，不对外监听。
2. **同源写门（全局 Ktor 插件）**：所有 `POST/PUT/PATCH/DELETE` 统一拦截，`Origin` 必须是服务自己；不带 `Origin` 的本机客户端放行。两类显式例外：只读 POST 白名单、书源登录 Cookie 同步（自己判来源）。
3. **出站 SSRF 闸门**：`NetworkSecurity` 对目标域名解析后逐 IP 判内网/回环/链路本地/CGNAT/组播/保留段；已覆盖书源抓取、封面、媒体代理、订阅、AI 外呼、登录页。自定义 TTS 走独立签发点 `CustomTtsClient`：有意放行本机/RFC1918/ULA，但逐跳拦截链路本地、云元数据、CGNAT、组播/保留段；跳转同源判定按 `scheme/host/端口`，**跨源不再重放用户自定义头**（`Authorization`/`Cookie`/`X-Api-Key` 等），且跟跳方法按 RFC 9110 归一（`303` 与 `301/302` 的 POST 降为 GET，`307/308` 保留方法与 body）。
4. **一个默认关闭的开关**：AI 接内网/回环 baseURL 默认拒绝（`LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1` 才放行，且仍硬拒打回服务自己）。
   （历史上还有一个 `LEGADO_PLUGIN_JAR_SCAN` 开关控制插件 jar 装载 —— **插件装载机制已整体移除**，该环境变量在代码里已不存在，不要再按它配置。）

5. **日志出口脱敏**：`ops/LogRedaction` 在 `LogService` 落库/写文件/打 stdout **之前**按敏感键名擦除凭据——查询串里的 `token`/`key`/`sign`/`password`/`session`/`code` 等、`Authorization`/`Cookie`/`X-Api-Key` 头、裸 `Bearer`/`Basic`、URL 里的 `user:pass@`；`GET /api/logs` 读到的也是擦过的版本，`host`/`path`/`page` 等排障字段原样保留。
6. **请求体上限（两道闸）**：`http/BodyLimits` 是单一真源（JSON 8MB / 备份 64MB / 图标 5MB）。全局插件 `RequestBodyLimit` 在 `onCall` 阶段按 `Content-Length` 拦写请求（POST/PUT/PATCH），超限抛 `PayloadTooLargeException` → `StatusPages` 转 413（`body_too_large`/`backup_too_large`/`icon_too_large`），body 一个字节都不读；multipart 的备份导入与品牌图标上传另走 `readBounded` 边读边判，超限在读取过程中即中止并 dispose，不留临时文件。chunked（无声明长度）由流式闸兜底；纯 `Transfer-Encoding: chunked` 的 JSON 端点暂未覆盖（S2c 未实施）。

---

## 5. 质量门禁

| 门禁 | 命令 | 现状 |
|---|---|---|
| 后端测试 | `npm test`（`gradlew :app:test`） | **1,048 项 / 0 失败 / 0 跳过**（148 个 suite；2026-11-23 `--max-workers=2` 全量实测）。`ArchitectureBoundaryTest` 此前因 `d34af81` 的 `source/ExternalBrowserLogin.kt → io.legado.ops` 未进基线而红，本轮新增 `port/LocalControl` 端口、由 `Routes.kt` 注入实现后转绿；`E2EScenariosTest` 的墙钟断言已移除，改为“只碰选中书源 + 恰好 4 次请求 / 5000 章完整性”的确定性判据，耗时只打印；自定义 TTS 判据覆盖到路由层：`/api/tts/speak` 的 `Authorization` 转发、`{{speakText}}` 替换、`Content-Type` 透传、字节流原样返回，元数据地址发送前拒绝（400 `tts_invalid_request`），上游 401/500 不再被当音频回 200（502 `tts_failed`），8MB 上限边读边判，重定向上限改为“3 跳允许、第 4 跳拒绝”，跨源重定向不再重放自定义头（同源跳转保留），跟跳方法按 RFC 9110 归一（`303`/`301`/`302` 的 POST 降为 GET、不带 body，`307`/`308` 保留方法与 body）；服务层另有 CRLF 注入头与 `Host` 丢弃判据 |
| 路由组挂载 | `cd product && ./gradlew :app:test --tests '*RouteMountTest'` | 每个 `*Routes.kt` 的入口函数必须在 `Routes.kt` 的 `apiRoutes` 里挂载；反向也不许留没有文件的调用 |
| Web 测试 | `web: npm test` | **1,118 项 / 0 失败**（2026-11-22 全量实测；`ChallengerEmpiricalStress` 曾因并行负载触发一次计时基准红，单文件与第二次全量均通过） |
| 类型检查 | `npm run check`（`tsc -b`） | 通过（2026-11-22 本轮实测，随 `build:fallback` 一起跑） |
| 覆盖率 | `:app:jacocoTestReport` / `web: test:coverage` | 后端行 **74.35%**（11,441/15,388；2026-11-23 随全量 `:app:test` 产出的 `jacocoTestReport`，其中 `tts` 75.81% = 630/831、`ops` 82.47% = 560/679）；前端行 **63.51%**（2026-11-09 快照，本轮未重跑 `npm run coverage`） |
| 端点文档一致 | `cd product && npm run docs:api-check` | 通过：145 条端点、18 个分组与文档一致（并核对本文与 ARCHITECTURE/ROADMAP 里手写的端点数） |
| 更新日志 | `cd product && npm run changelog:check` | 通过：无待记录改动（自查至边界 `771b311`） |
| 版本单一来源 | `cd product && npm run version:check` | 通过：8 处版本均为 **0.3.0**，build **56** |
| 真浏览器门禁 | `product/tools/verify/*-check.mjs` | **51** 个 `*-check.mjs`（该目录下共 78 个 `.mjs`，其中约 40 个要活服务 + 真浏览器）：阅读排版、笔记、备份、缓存、登录跨域抓取等多条 |

CI：`ci.yml`（后端测试 / 前端类型检查与构建 / 版本一致性）、`version-gate.yml`（PR 要求代码变更带 CHANGELOG 或版本、Tag 与版本一致）、`contract.yml`（契约 / 文档 / 结构）、`build-jar.yml`（打包与发布）、`gates.yml`（真浏览器门禁）、`coverage.yml`、`docker.yml`。

---

## 6. 近期交付

### 6.1 0.2.37（2026-11-09，历史交付）

- **修：旧库的「需要登录」标记从来没被回填过。** `migrateSourceTable` 里的 `LIKE` 模式多写了反斜杠，
  SQLite 又不把 `\` 当转义符，三条分支一条都匹配不上 —— 只有「从旧版本升上来」的库受影响，
  新写入的源由 `saveSource` 直接算。模式改成 `%"loginUrl"%`。
- 补判据：`MigrationTest` 9 项（四张表补列、旧 cookie_jar 折叠、正文缓存章号回填）、`CookieUtilTest` 6 项。

### 6.2 0.2.36（2026-11-09，历史交付）

- **新增：`/healthz` 与顶栏「我的」菜单显示代码修订号 `rev-xxxxxxx`。** 没发版、只在本地改时
  版本号不动，光看 `0.2.36` 分不清跑的是推上去那版还是刚编的这版；现在一条 curl 就能定性。
- 书源域的批量整理、体检编排、单源读写校验搬进 `data/SourceRepository.kt`，端点路径/数量/回包形状零改动。
- 删除 `http/HttpClients.kt`：零调用方，却写着「所有外部请求必须经过这里」。
- 界面外壳门禁 `ui-shell-check.mjs` 的 `SkinModal` 路径跟着文件搬家修正（此前一直 ENOENT 假绿）。

### 6.3 当前工作树整理（2026-11-13；仓库版本仍为 0.2.42 / build 55）

- 后端 DTO 从单一 `Models.kt` 按系统、书源、发现、阅读、书架、替换规则、备份拆为七个同包文件；133 个声明逐项对账，包名、类型名和调用接口保持不变。
- 更新模型导航、架构索引、产品目录说明、研究索引与 AI 协作速查；三项依赖旧源码路径的前端测试已改为读取领域文件。
- 本轮后端全量测试 1,165 项全绿（152 个 suite，0 失败 0 跳过）；前端 1,157 项全绿（146 个文件）；`tsc -b` 类型检查通过。此前一轮的 SQLite 临时文件占用与 Node `ENOMEM` 均为临时环境问题，复跑未再现。
- 更早的阅读记录窗口、焦点陷阱、请求客户端、性能采集器与阅读器拆分等条目来自 0.2.37 时期工作树记录；因当前提交和版本归属未在本轮逐项核实，不再列作当前未发布交付。
### 6.4 库版本号与有序迁移（2026-11-14；仓库版本仍为 0.2.42 / build 55）

- **新增：库有了版本号。** 此前 21 张表靠 `create table if not exists` 加六段幂等补列凑出来，没有版本号就无法回答「这个库是哪一版」，也没法安全地加一步不可幂等的迁移。现在版本存 `pragma user_version`（`data/SchemaVersion.kt`），`BASELINE = TARGET = 1`。
- **升级路径**：存量库与全新库都从 v0 出发 → 基线迁移把六段历史补列各跑一遍 → 回填 v1。老用户升级就是一次普通启动，不需要人工介入。
- **失败即阻启**：迁移动作与版本号在同一笔事务里，任一步抛错整步回滚、版本不变、启动失败并给出「停在 vN、已回滚、可重试」的错误；库版本高于程序支持的版本时直接拒绝启动（防程序降级后按旧代码解释新库）。
- **判据**：`data/SchemaVersionTest.kt` 8 项，按五类库逐个钉（全新 / 已最新 / 旧库逐级 / 中途失败可重试 / 万级数据），另加「版本超前拒启」与「基线一步补齐六段形状」。`MigrationTest` 原 9 项零回归。
- 详见 `docs/engineering/audit/PHASE2_PREFLIGHT_REPORT.md` §10.6；迁移策略段落已重写为现行实现（`docs/ARCHITECTURE.md` §5）。

### 6.5 沙箱与网络边界补测（2026-11-14；仓库版本仍为 0.2.42 / build 55）

- **只补判据，不改行为。** 第二阶段第 5 项的目标是「把已经防住的东西钉住」，所以这一轮生产代码一行没动。
- **沙箱宿主预算收口（审计 E 项）**：累计预算与单次预算本来就在实现里（`BoundedJs.chargeHostBytes` / `JsSandbox(hostByteBudget=…)`），缺的是审计要求的前置判据 —— 现在用 `JavaPackagesEntryBaselineTest` 反射枚举出 `JavaPackages` 真正暴露的东西（43 个类 / 98 个静态入口 / 13 个只能 new 的类），与基线精确比对。以后加一个入口却忘了记账，判据会先红。
- **网络边界负向判据**：`HttpSurfaceNegativeTest` 10 项 —— 书源登录 Cookie 同步的那个跨站口子必须只有一条路径宽（兄弟路由 `login-header` 跨站照样 403）；备份条目名 / 快照恢复名 / 封面 key / 本地书内嵌资源名这四类由客户端给的文件名都穿不出目录；错误响应里不许出现堆栈、异常类名与绝对路径。
- 判据有效性做过**变异验证**：临时去掉 `BackupStore.read` 的路径剥离、去掉 `CoverCache.file` 的 64 位 hex 校验，对应用例各红一次，改回后复绿（说明它们不是摆设）。
- 详见 `docs/engineering/audit/PHASE2_PREFLIGHT_REPORT.md` §10.7；判据清单见 `product/docs/rules-sandbox-audit.md` §4。

### 6.6 段评浮层（第三阶段「半成品收口」第一刀，2026-11-14）

- **阅读器里能看段评了（只读详情层）。** 入口两个：选中正文后浮层上的「段评」，以及正文右键菜单的「段评」；浮层列出这一章的段评条目（头像/昵称/徽章/正文/配图/音频/赞/回复数），取满一整页时给「再取一页」。
- **地址取的是书源的段评规则**：`ruleReview.reviewDetailUrl`（只配了 `reviewSummaryUrl` 的源退用它），不是当前章节地址——段评页往往跟章节页不是一个 URL。没配规则的源平静提示「这个书源没有段评」，**不当报错**：那是没有这个能力。
- **只做详情层**：统计层（段落徽章数）、回复层（子评论）与一切写操作（发帖/点赞/删除）明确不做，界面上也不摆对应按钮。
- **判据**：`web/test/ChapterReviews.test.ts` 12 项——错因收成人话（不念类名/JSON/堆栈）、分页推进（第 1 页替换后续追加、只认「取满一整页才可能还有」、失败不清空已读）、四种形态渲染（加载/失败可重试/空态平静/有数据含图文音）、选中浮层仍是 5 个动作 + 关闭、取数走既有 `POST /api/books/reviews`。
- 顺带把书源导入告警里那句「阅读器尚无段评浮层」改掉（`SourceCodec`），并同步 `product/docs/compatibility.md` 两处措辞。
- 验证：前端 1,169 项全绿 + `tsc -b`；`npm run build` 出包后重启，`/healthz` 的 ui 指纹与 `web/dist/index.html` 一致（index-DExmuwcc.js）；后端 `SourceValidateWarningsTest` / `ChapterReviewTest` / `ApiRoutesHttpTest` 定向全绿。

### 6.7 书源体检：补上「批量启停」里缺的「启」（第三阶段，2026-11-14）

- 核对结果是：状态过滤（关键字 + 六个分档 tab）、分档、逐条详细错误（`statusCode` / 耗时 / 失败原因）**早就有了**；缺的是批量动作的另一半 —— 只能「一键停用/删除连不上的」，**没法把体检通过但被停用的源一次打开**。真实场景恰恰是「以前一刀切停过一批，体检完发现大半其实好好的」。
- 新增「一键启用体检通过的 (N)」：只认 **`ok`（valid / slow）+ 当前停用 + 清单里查得到** 三条同时成立；待确认（零结果 / 受限 / 需登录 / 需渲染）与未配搜索那些一个都不碰，清单没刷新到位时也不猜。
- **停用现在也要确认**：可逆不等于可以随手点 —— 一次关掉几十上百个源会立刻收窄搜索面，确认框里给出数量与前三个名字（与删除那条同一套措辞，只是把结论写成「停用只是不参与搜索，之后可以再启用」）。
- 窄屏兜底：三个批量按钮在 `.health-actions-right` 里加了 `flex-wrap`，否则第三颗会被挤出可视区（看起来像没这功能）。
- 判据：`web/test/SourceHealthBatch.test.ts` 3 项 —— `previewNames` 措辞（三个名字 + 等共 N 个）、`healthyDisabledOf` 的三条边界（通过/停用/清单可查，逐个反例都验）、三种极端输入不抛不乱认。

### 6.8 README 定位强化：核过一遍，只改了两处（第三阶段，2026-11-14）

- **先核数字再看措辞**：AI 22 个端点 / 55 个内置工具 · 分章规则 26 条 · 字体 7 种 · 内置皮肤 7 套 · `tools/verify` 门禁 47 个 · 一级页 6 个（数字键 `1`–`6`）· 端点 165 条 —— 全部与代码一致，一个都不用改。
- **改的两处**：① 点击分区原来写「正文可以按任意行列划成格子」，那是旧形态；实测是**可拖的分隔虚线**模型（横竖线各最多 5 条，四套预设整套换，翻页与滚动各存一张表）。② 体检那段只说了「四类算坏 + 未配搜索」，补上「零结果 / 受限 / 需登录 / 需渲染是待确认档，不参与批量停删」与「体检通过但被停用的源可一键启用」。
- **顺带补的**：根 `README.md` 的功能表两行补上真实新增能力（阅读行：段评；书源行：体检分档 + 一键启停）。
- **链接**：`product/README.md` 与 `docs/README.md` 的相对链接用脚本逐条核过，无坏链。

### 6.9 「改过的设置不许回默认」补全：可自定义项全部跨端口留存（2026-11-14）

- **起因是一类错误，不是某个 bug**：localStorage 按 **origin（协议+主机+端口）** 隔离，界面里改一次端口就等于换了个站点 —— 之前存的一切都读不到。2026-11-12 已经为「壁纸 / 免责声明 / 阅读设置」建了服务端镜像（`/api/ui-prefs`），但**只覆盖了 3 个键**，其余用户改过的东西仍然会静默回到默认。
- **本轮把清单补全（非 AI）**：书架布局、搜索结果形态、书架排序、书源页左栏宽度、朗读条位置、书库搜索历史、「装到桌面」提示条已关 —— 七项全部纳入 `UI_PREF_STORAGE` 并在各自保存处调 `pushUiPref`。书架与搜索结果**各用各的键**（在书架上习惯看封面，不代表搜索时也想先看封面）。
- **刻意不收**：离线的正文与书架快照（设备态）、随书变化的动态主题（`ui/theme`，不是用户偏好）、AI 悬浮球与对话（属于 AI 模块，按用户口径先不动）。
- **新增一条防半途而废的判据**：「表里每个 key 都有人在保存时 push」—— 在表里加一行却忘了调 `pushUiPref`，表面上"已支持跨端口"，实际永远只有默认值。这条机器检查比注释可靠。
- 判据：`UiPrefs.test.ts` 从 5 项扩到 7 项（键表逐字一致扩到 10 个键 + 新增 push 反查）。

---

## 7. 已知缺口（按价值排）

| 缺口 | 现状 | 影响 |
|---|---|---|
| ReaderScreen 未拆完 | 已拆出 TTS、目录（`ReaderCatalog`）、设置（`settingsPanel/`）、缓存状态与章节加载、笔记状态（`useReaderNotes`）、划线高亮（`NoteHighlights`）、正文画布（`ReaderBody`）、分页测量（`usePaginationMeasurement`）与跳转原语（`useReaderPositionJump`）；`ReaderScreen.tsx` 仍有 **2,346 行**，剩下的是跨模块状态编排与交互接线（段落点击 / 划词 / 图片放大 / 翻页落点） | 剩下这块是交互核心，拆它要先补交互判据，否则改坏了静态测试看不见 |
| 后端覆盖率偏低的大包 | 2026-11-23 覆盖率快照（随全量 `:app:test`）：整体行覆盖 **74.35%**，`tts` 已从 2026-11-09 的 **56.6%**（601 行）升到 **75.81%**（831 行）；`http` / `ai` 仍是最薄的两块（旧快照 49.3% / 65.8%，本轮未单独复核） | `tts` 的纯逻辑与路由层已补判据；剩下的缺口几乎都在真网络与 WS 协议路径上，要覆盖得先改设计（把端点做成可注入），不是补测试能解决的 |
| 书源宿主 API 与字段缺口 | `java.t2s`/`s2t` **已实现**（2026-11-16，`rules/ScriptConvert.kt` + `/dict/opencc.txt`，与前端「简繁转换」同一份 OpenCC 表；判据 `ScriptConvertTest` 6 项 + `JsScriptConvertBridgeTest` 3 项）；`preUpdateJs` 36 / `formatJs` 6 / `concurrentRate` 42 / `webJs` 8 条非空但零执行，现已在校验里逐项告警。（`globalThis.environment` 已实现，2cdf9d8） | 受影响的是具体源，不是整条链路；排序与证据见 `docs/research/研究-书源JS与字段缺口实测-2026-11-13.md` |
| 图标小尺寸清晰度 | 512 插画细分多，16–24px 仍糊；ICO 尺寸声明已修（按档渲染 16/24/32/48/64/128/256） | 任务栏/托盘辨识度（要根治得换扁平标记，待定） |
| 可观测性 | 解析/规则求值/出站抓取已有分阶段耗时与失败率（`GET /api/diagnostics` 的 `stages`，运行日志页可展开）；前端已接 `fetchWithMetrics` 与 `pagination_measure`，但只有控制台 `__legadoPerf.report()`，没有界面与持久化 | 界面卡顿能取到原始数据，但仍靠控制台手查，没形成产品化观测 |
| 发布链路 | 有打包脚本与手动发布，未做签名 | 产物未签名 |
| 插件 jar 装载 | 默认关闭、无沙箱 | 有意为之，不是缺陷 |

---

## 8. 一句话总结

后端是单进程、本地 SQLite 阅读服务，前端是 React 阅读器，端点契约由源码、测试与 API 文档共同校验。当前版本为 **0.3.0 / build 56**；前端全量 **1,118 项通过**（2026-11-22）、后端全量 **1,048 项全绿**（2026-11-23 实测）。历史规模和覆盖率数字以各自日期快照理解，不与当前混淆。当前 ReaderScreen 交互编排仍较集中，详见已知缺口；`RuleRunner` 拆分状态应以当前源码核实后再列入行动项。

---
## 9. 数字口径

本文保留的规模、覆盖率和旧测试数字来自 **2026-11-11 工作树**（含未提交改动），并在 2026-11-13 04:00 状态快照中沿用。以下命令记录该历史统计口径；本轮 2026-11-13 模型拆分后的运行结果以 §5 门禁表与 `docs/sessions/2026-11-13-models-and-workspace.md` 为准，不与旧统计混用：

```bash
# 后端源文件 / 行数
find product/app/src/main/kotlin/io/legado -name '*.kt' | wc -l
find product/app/src/main/kotlin/io/legado -name '*.kt' -exec cat {} + | wc -l

# 后端测试：静态计数与实际运行
grep -rho '@Test' product/app/src/test --include=*.kt | wc -l
cd product && ./gradlew :app:test --no-daemon

# 前端源文件 / 行数 / 测试文件
find product/web/src \( -name '*.ts' -o -name '*.tsx' \) | wc -l
find product/web/src \( -name '*.ts' -o -name '*.tsx' \) -exec cat {} + | wc -l
ls product/web/test/*.test.ts | wc -l
npm --prefix product/web test

# 真浏览器门禁脚本
ls product/tools/verify/*-check.mjs | wc -l
```

后端「实跑 1,109」取自 `product/app/build/test-results/test/*.xml` 的 `<testsuite tests="…">` 求和（6 跳过、0 失败）；静态 `@Test` 1,110 与实跑的差 1 是历史现象（有一条用例没有被任何测试类执行），不是失败。
