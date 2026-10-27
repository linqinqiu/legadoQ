# 当前结构与成果

> 版本 **0.0.5** ｜ 分支 `main` ｜ 远端 `linqinqiu/legadoQ`（私有，2026-10-26 重建，旧历史不推送） ｜ 后端 **626** 项测试 / Web **751** 项测试，全绿
> 本文只写**现在真实具备的能力**，规划中的东西放在最后「已知缺口」一节，且明确标注是缺口。

---

## 1. 两层仓库

| 层 | 路径 | 是什么 |
|---|---|---|
| 外层 | `E:\legado` | 文档壳：总览、API 参考、目录规划、研究笔记、版本号。无 remote。 |
| 内层 | `E:\legado\legado` | **唯一能跑的产品**：Kotlin/Ktor 后端 + 内置 Web UI。origin = `linqinqiu/legadoQ` |

外层只做「说明书 + 版本封条」，所有代码与测试都在内层。版本号真源是内层 `app/build.gradle`，外层 `VERSION` / `package.json` 是抄本，由 `npm run version:check` 钉住一致。

---

## 2. 后端结构（Kotlin / Ktor）

**规模**：86 个源文件、约 2.14 万行；81 个测试文件。

### 2.1 包职责

| 包 | 职责 |
|---|---|
| `http/` | 路由与 HTTP 边界：13 个 `*Routes.kt` 域模块 + `Routes.kt` 只做域声明；`Guard.kt`（同源写门）、`NetworkSecurity.kt`（出站 SSRF）、`RouteCatalog.kt`（端点目录）、`ProxyHeaders.kt` |
| `data/` | 表级 DAO，全部写成 `Database` 的扩展函数；建表与迁移集中在 `Database.kt` |
| `reading/` | 阅读域收口 `ReadingRepository`：进度 / 阅读记录 / 笔记划线书签 / 本书检索 / 章节窗口 |
| `ai/` | 进程内 AI 网关：能力清单、工具分发、外呼、内置工具集 |
| `rules/` | 书源规则引擎（JS 沙箱、正文/目录/搜索规则求值） |
| `source/` | 书源模型与登录链路（真浏览器登录、Cookie 罐） |
| `cache/` | 正文缓存、封面缓存、缓存任务调度 |
| `localbook/` | 本地书解析（TXT 分章 / EPUB） |
| `content/` | 正文净化与标题处理 |
| `subscription/` | 书源订阅、RSS |
| `tts/` | Edge TTS 与朗读会话 |
| `plugin/` | 插件框架骨架（默认不扫 jar） |
| `ops/` | 日志、更新检查、备份等运维面 |
| `backup/` | 备份包导入导出 |
| `model/` | 跨层数据模型（`@Serializable`） |

### 2.2 端点分布（142 条 / 19 组）

| 组 | 条数 | 组 | 条数 |
|---|---:|---|---:|
| 内置浏览器 | 17 | 书架 | 16 |
| 书源 | 12 | 登录与凭据 | 11 |
| 净化规则 | 10 | 进度与笔记 | 9 |
| 朗读 | 9 | 系统 | 8 |
| AI 自定义接入 | 8 | 分章规则 | 7 |
| RSS | 7 | 图片与媒体 | 6 |
| 阅读 | 5 | 书源订阅 | 5 |
| 备份 | 3 | 发现页 | 3 |
| 离线缓存 | 3 | 搜索 | 2 |
| 目录 | 1 | | |

契约由 `resources/agent-api.json` 描述，`web/test/ApiCatalog.test.ts` 与源码双向核对；`npm run docs:api-check` 校验文档一致。

### 2.3 数据层（SQLite，18 张表）

`source` `source_login_state` `cookie` `book_shelf` `book_group` `reading_progress` `reading_log` `book_note` `book_content_cache` `book_content_process` `book_cache_status` `book_toc_cache` `cover_cache` `replace_rule` `source_subscription` `rss_source` `log_entry` `source_health`

（分章规则不是独立表：`book_shelf.toc_rule` 记住这本书用哪条规则切的章。）

写入走**单写连接 + 全局锁**（WAL + `busy_timeout` + 失败重连），避免流式搜索与进度写入并发撞 `SQLITE_BUSY`。启动时按碎片率决定是否 `VACUUM`。

---

## 3. 前端结构（TypeScript / React）

**规模**：137 个 ts/tsx、约 2.76 万行。

| 目录 | 内容 |
|---|---|
| `pages/` | 11 个页面：书架、书源、发现、RSS、设置、备份、更新日志、阅读记录、关于等 |
| `reader/` | 40 个模块：阅读器主体 `ReaderScreen`、目录虚拟列表、笔记/标注、TTS 引擎与播放条、排版（`typeset/`：无 DOM 布局引擎 + Worker）、分页缓存（IndexedDB）、翻页动画、手势/快捷键 |
| `features/ai/` | AI 悬浮球、对话面板、多会话、连接管理 |
| `features/settings/` | 设置页分区贡献（如界面偏好） |
| `sources/` | 书源编辑器、字段表单、换源弹窗 |
| `settings/` | 设置分区表（数据权威源）与筛选 |
| `lib/` | API 客户端、品牌、导航、UI 上下文、离线存储等 |
| `plugins/` | 以「设置分区」形式贡献的内置页面（关于/备份/更新日志/阅读记录/书源体检） |
| `extensions/` | 前端扩展注册表 |

**阅读器三个地基的现状**：
- **逻辑位置模型**：`reading_progress` / `book_note` 存「章节 + 字符偏移 + 段落锚点 + 编码版本 + 内容校验值」，页码只作派生显示。
- **分页引擎**：按字体/字号/行距/边距/窗口尺寸精确分页，结果落 IndexedDB；计算在 Worker；改字号靠锚点原地重量，不跳回第一页。
- **章节窗口**：前端按「前接章 + 当前章 + 后接章」组窗口；后端 `chapterWindow()` 已实现（章号区间 + 缓存标记）。

---

## 4. 安全模型

这台服务**不设身份**（无账号、无 token、无会话），安全边界靠四条：

1. **只绑回环**：默认 `127.0.0.1:1234`，不对外监听。
2. **同源写门（全局 Ktor 插件）**：所有 `POST/PUT/PATCH/DELETE` 统一拦截，`Origin` 必须是服务自己；不带 `Origin` 的本机客户端放行。两类显式例外：只读 POST 白名单、书源登录 Cookie 同步（自己判来源）。
3. **出站 SSRF 闸门**：`NetworkSecurity` 对目标域名解析后逐 IP 判内网/回环/链路本地/CGNAT/组播/保留段；已覆盖书源抓取、封面、媒体代理、订阅、AI 外呼、登录页、自定义 TTS 重定向逐跳。
4. **两个默认关闭的开关**：AI 接内网/回环 baseURL 默认拒绝（`LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1` 才放行，且仍硬拒打回服务自己）；插件 jar 扫描默认关闭（`LEGADO_PLUGIN_JAR_SCAN=1` 才开）。

插件框架保留骨架与四个扩展点（工具注册表 / 生命周期钩子 / 模型提供方 / 连接选择策略），但**默认不从磁盘装载 jar**，也不投入插件市场/注册中心/签名流水线。

---

## 5. 质量门禁

| 门禁 | 命令 | 现状 |
|---|---|---|
| 后端测试 | `npm test`（`gradlew :app:test`） | **618 项 / 0 失败** |
| Web 测试 | `web: npm test` | **735 项 / 0 失败** |
| 类型检查 | `npm run check`（`tsc -b`） | 通过 |
| 端点文档一致 | `npm run docs:api-check` | 141 条 / 19 组，一致 |
| 更新日志 | `npm run changelog:check` | 无待记录（提交后钩子自动起草） |
| 版本单一来源 | `npm run version:check` | 4 处一致，0.0.0 |
| 真浏览器门禁 | `tools/verify/*.mjs` | 阅读排版、笔记、备份、缓存等多条 |

CI：`ci.yml`（后端测试 / 前端类型检查与构建 / 版本一致性）、`version-gate.yml`（PR 要求代码变更带 CHANGELOG 或版本、Tag 与版本一致）、`contract.yml`（契约）。

---

## 6. 本轮成果

### 6.1 提交（最近 10 笔）

```
7fd1366 chore(CI): 版本号单一来源校验 + Dependabot 只开 github-actions
677d615 feat(阅读): 章节窗口从 stub 变成真实现
3c95f30 docs(CHANGELOG): 补同源写门插件化的修复条目
11076c6 fix(安全): 同源写门收成全局插件，堵住 TTS 会话三条漏网写路由
ae5a048 docs(CHANGELOG): 补 AI 内容覆盖两条接口失效的修复条目
712f5be fix(阅读): 内容覆盖的两条写路由从别的处理器里挪出来
1b8cc16 chore: 更新日志与版本治理工具链、文档
7250d0e feat(web): 品牌自定义与设置分区整理
a0fe946 feat(server): 阅读域收口、品牌清单、书源体检与缓存修复
3a0c4f3 feat(reader): 排版分页、笔记标注与本书内检索
```

在此之前另有 6 笔主题提交，把积压的 125 个改动（约 +4100/−690 行）按 AI / Web-AI / 阅读器 / 服务端 / Web 外壳 / 工具链拆开落地。

### 6.2 修掉的三个真缺陷

1. **AI 内容覆盖的两条写路由从未注册**：`POST/DELETE /api/books/content-process` 被写进另一个 handler 的 lambda 里，启动后一律 404 —— AI 净化/润色的「保存」与「撤销」一直是坏的，而端点目录照样把它们算进 142 条（目录是扫源码文本的）。已挪成兄弟路由，并补了「真起服务打一发」的判据。
2. **TTS 会话三条写路由漏过同源写门**：任何网页都能替用户建朗读会话、追加音频、改播放状态。写门从 84 处手抄收成全局插件后默认覆盖。
3. **本书检索查了不存在的列**：`searchBookContent` 引用 `book_content_cache.chapter_index`，而该表没有这一列 —— 空库不报错、真缓存过正文就抛。已补列 + 老库按目录回填 + 判据。

另修：设置页搜索「超过 5 字不命中」的阈值（导致「替换净化规则」这类真词搜不到）。

### 6.3 新增能力

- **章节窗口**：`chapterWindow()` 从 `emptyList()` 变成真实现（章号区间、缓存标记、两端夹取）。
- **版本单一来源校验**：`scripts/version-check.mjs` + CI job，负向对照验过。
- **Dependabot 收口**：只留 `github-actions`，停止对 Gradle/npm 批量升级。

---

## 7. 已知缺口（按价值排）

| 缺口 | 现状 | 影响 |
|---|---|---|
| 全书搜索定位并高亮 | 只跳到命中章，不滚到命中处、不高亮 | 搜到还得自己找 |
| 大章节分块渲染（P2-T2） | 整章挂 DOM | 超大章节内存与首屏 |
| 漫画阅读模式 | 图片仅作正文内联，无双页/从右到左/页索引进度 | 漫画体验 |
| 批注锚点重定位（P3） | 字段已落库，锚点失效后无模糊重匹配；`anchor` 恒为 null | 改版后标注可能错位 |
| 可观测性（P4） | 分页/解析/规则求值无耗时与失败率指标；缓存命中率无日志 | 性能问题只能靠猜 |
| CI 性能基准 | 只有打开书与目录过滤有基准 | 回归无阈值 |
| 发布链路 | `build-jar.yml` 在 master 每次 push 发 Release；签名/Secrets 未做 | 发布不可控、产物未签名 |
| 插件 jar 装载 | 默认关闭、无沙箱 | 有意为之，不是缺陷 |

---

## 8. 一句话总结

后端是「单进程 + 单写 SQLite + 19 组 HTTP 端点」的本地阅读服务，前端是一个自研排版引擎的 Web 阅读器；阅读域已按 `Route → Repository → DAO` 分层收口，安全靠「只绑回环 + 同源写门 + 出站 SSRF 闸门」三道，质量靠 1381 项自动化测试（643 + 738）与六道命令门禁守着。当前最大的未完成项是**阅读器的跨章定位体验**（搜索定位、大章节分块）与**漫画模式**。
