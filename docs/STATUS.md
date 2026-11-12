# 当前结构与成果

> **规模数字采集于 2026-11-13 04:00（工作树干净）**（跑法见文末「数字口径」）；
> 更细的命令与时间戳见 `product/docs/restructure/facts.md`。facts.md 是**带日期的快照**，用于复现当时的数字；
> 当前版本 / 构建号以 `VERSION` / `BUILD_NUMBER` 与 `/healthz` 为准（本文第 6 行由 `npm run version:check` 钉住）。
>
> 版本 **0.2.42 / build 55** ｜ 分支 `main` ｜ 远端 `linqinqiu/legadoQ`（私有） ｜ Web **1,157** 项全绿；后端 **1,144** 项（0 跳过、0 失败；147 个 suite），详见 `facts.md` §2
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

版本号真源是 `product/app/build.gradle`；`product/package.json`、`product/web/package.json`、根 `package.json`、根 `README.md`、根 `VERSION`、`agent-api.json` 六处是抄本，由 `npm run version:check`（7 处含真源）钉住一致。

---

## 2. 后端结构（Kotlin / Ktor 3.4.3，JDK 17）

**规模**（2026-11-11 22:00，HEAD `9564e26` 实跑）：后端 139 个源文件 / 35,470 行，142 个测试文件 / 1,110 项 `@Test`（实跑 1,109 完成、6 跳过、0 失败）；前端 202 个 `.ts/.tsx` / 38,361 行，134 个测试文件 / 1,056 项测试。

### 2.1 包职责

| 包 | 职责 |
|---|---|
| `http/` | 路由与 HTTP 边界：15 个 `*Routes.kt` 域模块 + `Routes.kt` 只做域声明；系统域（目录/服务/日志/诊断/关于/更新日志）独立成 `http/system/SystemRoutes.kt`；`Guard.kt`（同源写门）、`NetworkSecurity.kt`（出站 SSRF）、`RouteCatalog.kt`（端点目录）、`ProxyHeaders.kt` |
| `data/` | 表级 DAO，全部写成 `Database` 的扩展函数；`Database.kt` 只是组合根（连接池 / 建表 / 迁移 / Cookie 工具四件事拆在 `data/db/`：`ConnectionPool` `Schema` `Migration` `CookieUtil`） |
| `reading/` | 阅读域收口 `ReadingRepository`：进度 / 阅读记录 / 笔记划线书签 / 本书检索 / 章节窗口 |
| `ai/` | 进程内 AI 网关：三种协议（OpenAI 兼容 / Responses / Anthropic）、流式 SSE、工具循环、连接与预设、技能库、内置工具与参数 schema、MCP 客户端（外部工具接入） |
| `rules/` | 书源规则引擎（Rhino 沙箱、正文/目录/搜索规则、loginUi V1/V2 渲染与动作）；`RuleProcessor` / `RuleContext` / `RuleDispatcher` 是**已接入的扩展点**（0.2.34：求值前先问处理器、没人认领再走内联），`rules/processor/demo/` 是两个可直接注册的示例 |
| `source/` | 书源模型与登录链路（真浏览器登录、跨域凭据抓取、Cookie 罐） |
| `cache/` | 正文缓存、封面缓存、缓存任务调度 |
| `localbook/` | 本地书解析（TXT 分章 / EPUB） |
| `content/` | 正文净化与标题处理 |
| `subscription/` | 书源订阅、RSS |
| `tts/` | Edge TTS 与朗读会话 |
| `ops/` | 日志、更新检查、备份等运维面 |
| `backup/` | 备份包导入导出（zip 与裸 JSON，兼容兄弟项目扩展条目） |
| `model/` | 跨层数据模型（`@Serializable`） |

桌面壳 `DesktopLauncher.kt` 负责窗口、启动画面、托盘与安装目录解析。插件装载机制已整体移除（代码里没有 `plugin/` 包），保留的是工具 / 协议 / 连接选择策略三类**运行时注册表**扩展点。

### 2.2 端点分布（165 条 / 19 组）

| 组 | 条数 | 组 | 条数 |
|---|---:|---|---:|
| AI 自定义接入 | 22 | 内置浏览器 | 17 |
| 登录与凭据 | 15 | 书架 | 14 |
| 书源 | 12 | 系统 | 11 |
| 净化规则 | 10 | 进度与笔记 | 9 |
| 朗读 | 9 | 分章规则 | 7 |
| RSS | 7 | 阅读 | 7 |
| 图片与媒体 | 6 | 书源订阅 | 5 |
| 备份 | 5 | 发现页 | 3 |
| 离线缓存 | 3 | 搜索 | 2 |
| 目录 | 1 | | |

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
| `features/reader/` | **75 个文件**（含 `settingsPanel/` `typeset/` `dict/` `content/` `dialogs/` `interaction/` `notes/` `tts/` 等子目录）：阅读器主体、目录虚拟列表、笔记/标注、TTS、排版（无 DOM 布局引擎 + Worker）、分页缓存、翻页动画、手势/快捷键 |
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

这台服务**不设身份**（无账号、无 token、无会话），安全边界靠四条：

1. **只绑回环**：默认 `127.0.0.1:1234`，不对外监听。
2. **同源写门（全局 Ktor 插件）**：所有 `POST/PUT/PATCH/DELETE` 统一拦截，`Origin` 必须是服务自己；不带 `Origin` 的本机客户端放行。两类显式例外：只读 POST 白名单、书源登录 Cookie 同步（自己判来源）。
3. **出站 SSRF 闸门**：`NetworkSecurity` 对目标域名解析后逐 IP 判内网/回环/链路本地/CGNAT/组播/保留段；已覆盖书源抓取、封面、媒体代理、订阅、AI 外呼、登录页、自定义 TTS 重定向逐跳。
4. **两个默认关闭的开关**：AI 接内网/回环 baseURL 默认拒绝（`LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1` 才放行，且仍硬拒打回服务自己）；插件 jar 扫描默认关闭（`LEGADO_PLUGIN_JAR_SCAN=1` 才开）。

---

## 5. 质量门禁

| 门禁 | 命令 | 现状（最近一次全量实测，HEAD `1d9e4ea`） |
|---|---|---|
| 后端测试 | `npm test`（`gradlew :app:test`） | **1,144 项 / 0 失败**（0 跳过；147 个 suite；HEAD `1d9e4ea`）。满负载并发下曾出现 2 个 AI HTTP 类共 12 例 coroutine 1m 超时，减载后定向重跑通过 → 负载假红，不是缺陷 |
| 路由组挂载 | `cd product && ./gradlew :app:test --tests '*RouteMountTest'` | 每个 `*Routes.kt` 的入口函数必须在 `Routes.kt` 的 `apiRoutes` 里挂载；反向也不许留没有文件的调用 |
| Web 测试 | `web: npm test` | **1,143 项 / 0 失败** |
| 类型检查 | `npm run check`（`tsc -b`） | 通过 |
| 覆盖率 | `:app:jacocoTestReport` / `web: test:coverage` | 最近一次实测（2026-11-09）：后端行 **70.04%**，前端行 **63.51%**；重跑 `npm run coverage` 取当次值 |
| 端点文档一致 | `npm run docs:api-check` | 165 条 / 19 组，一致 |
| 更新日志 | `npm run changelog:check` | 无待记录（提交后钩子自动起草；`fix`/`feat` 必须进日志，否则红） |
| 版本单一来源 | `npm run version:check` | 8 处版本 + build 号一致（含 `README.md` 顶部与本文第 6 行） |
| 真浏览器门禁 | `product/tools/verify/*-check.mjs` | **47** 个 `*-check.mjs`（该目录下共 79 个 `.mjs`，约 40 个要活服务 + 真浏览器）：阅读排版、笔记、备份、缓存、登录跨域抓取等多条 |

CI：`ci.yml`（后端测试 / 前端类型检查与构建 / 版本一致性）、`version-gate.yml`（PR 要求代码变更带 CHANGELOG 或版本、Tag 与版本一致）、`contract.yml`（契约 / 文档 / 结构）、`build-jar.yml`（打包与发布）、`gates.yml`（真浏览器门禁）、`coverage.yml`、`docker.yml`。

---

## 6. 近期交付

### 6.1 0.2.37（2026-11-09）

- **修：旧库的「需要登录」标记从来没被回填过。** `migrateSourceTable` 里的 `LIKE` 模式多写了反斜杠，
  SQLite 又不把 `\` 当转义符，三条分支一条都匹配不上 —— 只有「从旧版本升上来」的库受影响，
  新写入的源由 `saveSource` 直接算。模式改成 `%"loginUrl"%`。
- 补判据：`MigrationTest` 9 项（四张表补列、旧 cookie_jar 折叠、正文缓存章号回填）、`CookieUtilTest` 6 项。

### 6.2 0.2.36（2026-11-09）

- **新增：`/healthz` 与顶栏「我的」菜单显示代码修订号 `rev-xxxxxxx`。** 没发版、只在本地改时
  版本号不动，光看 `0.2.36` 分不清跑的是推上去那版还是刚编的这版；现在一条 curl 就能定性。
- 书源域的批量整理、体检编排、单源读写校验搬进 `data/SourceRepository.kt`，端点路径/数量/回包形状零改动。
- 删除 `http/HttpClients.kt`：零调用方，却写着「所有外部请求必须经过这里」。
- 界面外壳门禁 `ui-shell-check.mjs` 的 `SkinModal` 路径跟着文件搬家修正（此前一直 ENOENT 假绿）。

### 6.3 未发布（工作树已有，版本号仍 0.2.37）

- 阅读记录顶部可切「最近 30 / 90 / 365 天」，切了按新窗口重新取数，空态与汇总标签一起变。
- 弹窗内按 Tab 不再跑到背后页面：焦点陷阱按打开顺序分层，只有最上层接管 Tab，关闭后焦点回到原处。
- 前端网络请求收口到 `lib/api/client.ts`（`request` / `requestText` / `requestBlob` / `requestArrayBuffer`），裸 `fetch` 有静态判据挡着。
- 修订号改为 `rev-<提交数>`（`git rev-list --count HEAD`），短 sha 另存 `sha` 字段；
  版本号只在发版时动，日常改动只让 rev 递增。
- 前端性能采集器真正接线：统一 API 客户端走 `fetchWithMetrics`，分页测量记
  `pagination_measure`，控制台 `__legadoPerf.report()` 可查。
- 离线缓存状态搬进 `useReaderCacheStatus`；章节正文加载与预取搬进 `useReaderChapterContent`；
  阅读停留计时搬进 `useReadingLog`；翻页动画状态搬进 `useReaderPageTurn`；分页测量搬进
  `usePaginationMeasurement`；分页轨道与滚动续接的正文画布搬进 `ReaderBody`；换源 / TTS / 规则 /
  缓存等弹层搬进 `ReaderOverlays`，笔记状态与增删改搬进 `useReaderNotes`，划线高亮搬进纯函数 `NoteHighlights`（`ReaderScreen.tsx` 3,200 → 2,346 行）；
  `RuleRunner` 的列表取值段搬进 `RuleNodeSelection`。
- 顶栏「我的」菜单不再显示「构建」号（`BUILD_NUMBER`）：它只在发版时递增，日常区分版本看「修订」（`rev`）；
  后端 `AboutInfo.build` 与 `/healthz`、`/api/about` 仍照常上报，只是界面不显。

---

## 7. 已知缺口（按价值排）

| 缺口 | 现状 | 影响 |
|---|---|---|
| ReaderScreen 未拆完 | 已拆出 TTS、目录（`ReaderCatalog`）、设置（`settingsPanel/`）、缓存状态与章节加载、笔记状态（`useReaderNotes`）、划线高亮（`NoteHighlights`）、正文画布（`ReaderBody`）、分页测量（`usePaginationMeasurement`）与跳转原语（`useReaderPositionJump`）；`ReaderScreen.tsx` 仍有 **2,346 行**，剩下的是跨模块状态编排与交互接线（段落点击 / 划词 / 图片放大 / 翻页落点） | 剩下这块是交互核心，拆它要先补交互判据，否则改坏了静态测试看不见 |
| 后端覆盖率偏低的大包 | 2026-11-09 覆盖率快照：整体行覆盖 **70.04%**；最薄的是 `http`（2,388 行 49.3%）、`ai`（3,987 行 65.8%）、`tts`（601 行 56.6%） | `tts` 与 `data.db` 的纯逻辑部分已补到 56.6% / 89.8%；剩下的缺口几乎都在真网络与 WS 协议路径上，要覆盖得先改设计（把端点做成可注入），不是补测试能解决的 |
| 图标小尺寸清晰度 | 512 插画细分多，16–24px 仍糊；ICO 尺寸声明已修（按档渲染 16/24/32/48/64/128/256） | 任务栏/托盘辨识度（要根治得换扁平标记，待定） |
| 可观测性 | 解析/规则求值/出站抓取已有分阶段耗时与失败率（`GET /api/diagnostics` 的 `stages`，运行日志页可展开）；前端已接 `fetchWithMetrics` 与 `pagination_measure`，但只有控制台 `__legadoPerf.report()`，没有界面与持久化 | 界面卡顿能取到原始数据，但仍靠控制台手查，没形成产品化观测 |
| 发布链路 | 有打包脚本与手动发布，未做签名 | 产物未签名 |
| 插件 jar 装载 | 默认关闭、无沙箱 | 有意为之，不是缺陷 |

---

## 8. 一句话总结

后端是「单进程 + 单写 SQLite + 19 组 HTTP 端点」的本地阅读服务，前端是自研排版引擎的 Web 阅读器。到 0.2.37，AI 侧已是「多协议 + 流式 + 技能 + 提示词预设 + 内置工具 + MCP 外部工具」的完整闭环，阅读侧有正文刷新、兄弟备份导入、登录界面本地解析与逻辑位置模型。质量靠 **2,159 项自动化测试**（1,103 后端 + 1,056 前端）、8 条命令门禁与 47 个 `product/tools/verify/*-check.mjs` 脚本守着；覆盖率以最近一次 `npm run coverage` 为准。当前最大的未完成项仍是**阅读器交互层的拆分**与**把内联解析搬进处理器（把 RuleRunner 拆薄）**。

---

## 9. 数字口径

本文的规模与测试数字都在 **2026-11-11 工作树**（含未提交改动）上复测：

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
