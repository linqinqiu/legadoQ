# AGENTS.md — 给 AI 的仓库导航与省 token 协议

## 0. 先读这里（省 token 规则，务必遵守）
- **禁读区**（历史/产物，整读纯浪费）：`docs/archive/**`、`legado-releases/**`、`product/data/**`、`**/build/**`、`node_modules/**`、`dist/**`、`*.jar`。需要历史时只按关键词 `grep`，不整读。
- **事实优先看 `product/docs/restructure/facts.md`**（带时间戳/命令/口径的实测数字）。不要自己 `find` 全仓重数规模。
- **不整读大文件**（>1000 行，已实测）：`ReaderScreen`2402 · `RuleRunner`2333 · `JsSandbox`2066 · `JavaPackages`1361 · `ShelfPage`1219 · `Models`1112 · `Agent`1013 · `SourcesPage`933 · `types.ts`932 · `AgentRoutes`923 · `SourcesRoutes`824 · `WebViewProxy`817 · `BuiltinTools`804 · `RuleValue`802。用 `grep -n` 定位，再 `Read(offset,limit)` 只读 40–120 行窗口。
- **token 预算**：一次会话只推进一个切点；验证跑一次全量 `npm --prefix product/web test`（~1020 项），不逐文件试；能 `grep` 回答的别 `Read`。
- **文档事实源优先级**：`product/CHANGELOG.md` > `docs/{ARCHITECTURE,STRUCTURE,API-REFERENCE}.md` > `product/docs/restructure/facts.md`；根 `CHANGELOG.md` 只是一行指针，别当第二事实源。
- **动手前先 `git status`**（可能有并行 agent 的半成品，未提交改动未必是你的）。
- **「某功能/代码在哪」先查 §8 速查表**：90% 的定位需求直接拿 `文件:符号`，不要探索、不要全仓 `grep`。表中没有再委派 `code-explorer` 子代理（§9）。

## 1. 仓库形态
- 单一 git 仓；`product/` 是唯一产品（Kotlin/Ktor 后端 + React/Vite 前端 + 数据）。
- 顶层：`product/`（产品）· `docs/`（总览/API/架构/研究）· `scripts/`（发版与校验）· `legado-releases/`（本地历史产物）。
- 版本真源：`product/app/build.gradle` 的 `version`；`/healthz` 返回 `version`/`rev`/`sha`。日常提交只涨 `rev`（提交数），**不要提前 bump `BUILD_NUMBER`**（`VersionTracks.test.ts` 钉住）。

## 2. 常用命令（别乱试，跑这些）
- 启动：`npm start`（→ `product/start.mjs`，端口 1234）
- 前端测试（**node:test 自研 runner，不是 vitest**）：`npm --prefix product/web test`（全量约 1,020 项，~17s）。别用 `npx vitest`（扫不到 `web/test/**`）。
- 前端类型：`npm --prefix product/web run check`（`tsc -b`）
- 覆盖率真源：`npm --prefix product run coverage`
- 后端测试：`cd product && ./gradlew :app:test --no-daemon`（偶发 worker 崩溃：`./gradlew --stop` 后重跑；别与前端测试并发跑）
- 门禁三条：`npm --prefix product run version:check` / `docs:api-check` / `changelog:check`

## 3. 阅读器子系统索引（前端最热区 `product/web/src/features/reader/`）
- `ReaderScreen.tsx` **2,344 行** = 状态中枢（正文渲染/分页/TTS/漫画/导航）。**整读最烧 token**，按需 grep 段。
- 展示组件：`ReaderBody`(227 正文本体) / `ReaderOverlays`(226 弹层) / `ReaderChrome`(218 外壳) / `ReaderCatalog`(目录) / `ReaderHeader` / `Md3Chrome`
- 状态 hook：`useReaderChapterContent`(124) / `useReaderCacheStatus`(139) / `usePaginationMeasurement`(190) / `useReaderPageTurn`(77) / `useReadingLog`(46) / `useReaderNotes`(200，笔记状态+增删改) / `useReaderPositionJump`(120，导航原语：`jumpToNote`/`jumpToSearchHit`/`jumpToNotePosition`+跨章落点 effect)
- 纯函数目录：`interaction/`（tapZones/readerFlow/pageTurn/shortcuts）· `content/`（readerFlow/logicalPosition/chunkedRender/mangaPages）· `notes/`（bookmark/reanchor）· `tts/` · `settingsPanel/`
- 跳转原语定位：要找 `jumpToNote` / `jumpToSearchHit` / `jumpToNotePosition`，**直接看 `useReaderPositionJump.ts`**，不要回 `ReaderScreen.tsx`。`toggleBookmark` 仍在 `ReaderScreen.tsx`（本轮留原地降风险）。

## 4. 后端要点
- `product/app/src/main/kotlin/io/legado/`：`http/`（路由）· `data/`（Repository，**一律放 data/**，放 `source/` 会撞 `ArchitectureBoundaryTest`）· `rules/`（`RuleRunner` + `RuleProcessor` 扩展点）· `ai/` · `tts/`。
- 端点 **161 条 / 19 组**；改接口后必须重跑 `npm --prefix product run docs:api`（文档首行带版本号）。

## 5. 常见坑（详见 facts.md / 研究文档）
- 池里只有一条写连接：DAO 的 `write{}` 不能被外层 `write{}` 包（内层退出复位 autoCommit → commit 抛错）。
- 发版：`npm run release -- --no-push` 后 `git push origin main vX.Y.Z`（tag 与 main 同批推，避免 main CI 先红）。
- 发行三资产必须齐：`legado.jar` / `legado-dist.zip` / `legadoq-desktop-<版本>.zip`。

## 6. 研究 / 历史文档
- 当前 frontier：`docs/research/研究-阅读器拆分续-下一步.md`、`docs/research/研究-0.2.37-成果核查与下一步.md`
- 实测事实源：`product/docs/restructure/facts.md`；按日会话记录：`docs/sessions/`；归档：`docs/archive/`
- 统一索引入口：`docs/README.md`。研究文档是**当时快照**，数字不随代码更新；现行数字只看 facts.md。

## 7. 大文件拆分路线图（每拆一刀，后续 AI 改造成本永久下降）
按「先低风险、后高耦合」排，每步单独提交、先补判据：
1. **`ReaderScreen`(2344)**：已拆 6 hook + 3 展示组件；`useReaderPositionJump`(导航原语) 已抽出 ✅；`NoteHighlights`/`renderNoteHighlights` 此前已迁出 ✅；剩 `toggleBookmark` 留原地。
2. **`RuleRunner`(2333)**：取值段已在 `RuleNodeSelection`、响应解码/字符集/限读已在 `ResponseBody` → 下一步 HTTP 段（1426–2094，先抽窄接口避开 `JsSandbox(this)`）；靠 `GoldenRuleTest` 逐字节比对。
3. **`JsSandbox`(2066) / `JavaPackages`(1361)**：Java 桥，动前先跑 `GoldenRuleTest` + 真库抽样。
4. 前端 **`ShelfPage`(1219) / `SourcesPage`(933)**：按子功能拆 hook。
纪律：删/拆文件时同步缩 `tools/verify/depth-check.mjs` 的 `KNOWN_DEEP` 基线（只许单调缩小）。

## 8. 任务→精确位置 速查表（绝大多数「在哪」直接查这里，别探索）
> 路径前缀：后端 `product/app/src/main/kotlin/io/legado/`，前端 `product/web/src/`。

### 8.1 后端 · 路由（全在 `http/`）
| 改什么 | 文件 |
|--------|------|
| 路由装配 / 端点清单 | `http/Routes.kt` · `http/RouteCatalog.kt` |
| AI 对话端点 | `http/AgentApiRoutes.kt` |
| 书源 CRUD/批量/体检 | `http/SourcesRoutes.kt`(824) |
| 书架/分组 | `http/ShelfRoutes.kt` |
| 搜索 | `http/SearchRoutes.kt` · `http/SearchSession.kt` |
| 目录规则 | `http/TocRulesRoutes.kt` |
| 阅读/正文/分页 | `http/ReadersRoutes.kt` · `http/ReadingRoutes.kt` |
| 媒体/图片/封面 | `http/MediaRoutes.kt` |
| 备份导入导出 | `http/BackupRoutes.kt` |
| 替换规则 | `http/ReplaceRulesRoutes.kt` |
| 订阅 | `http/SubscriptionsRoutes.kt`(74) |
| RSS | `http/RssRoutes.kt` |
| TTS | `http/TtsRoutes.kt` |
| 守卫/鉴权 | `http/Guard.kt` |

### 8.2 后端 · AI 子系统（`ai/`）
| 改什么 | 文件 |
|--------|------|
| AI 对话核心逻辑 | `ai/Agent.kt`(1013) |
| AI 端点 | `ai/AgentRoutes.kt`(923) |
| 内置工具实现 | `ai/BuiltinTools.kt`(804) |
| 工具注册/选择 | `ai/ToolRegistry.kt` · `ai/ToolSelection.kt` |
| 工具钩子/护栏 | `ai/ToolHooks.kt` · `ai/Guardrails.kt` |
| 提示词/Profile | `ai/AgentPromptStore.kt` · `ai/AgentProfileStore.kt` · `ai/ProfileOptions.kt` |
| 连接选择 | `ai/ConnectionSelector.kt` · `ai/AgentConnection.kt` |
| LLM Provider | `ai/OpenAiCompatibleProvider.kt` · `ai/OpenAiResponsesProvider.kt` · `ai/AnthropicProvider.kt` · `ai/LlmProvider.kt` · `ai/ProviderHttp.kt` |
| MCP 客户端/桥/配置 | `ai/McpClient.kt` · `ai/McpBridge.kt` · `ai/McpServerStore.kt` |
| 装配(ApiCatalog) | `ai/AgentModule.kt` · `ai/AgentCatalog.kt` |

### 8.3 后端 · 规则引擎 / 脚本（`rules/`）
| 改什么 | 文件 |
|--------|------|
| 规则主流程 | `rules/RuleRunner.kt`(2333) |
| 扩展点调度 | `rules/RuleProcessor.kt`（含 `RuleDispatcher`，认领即拥有） |
| 列表取值 | `rules/RuleNodeSelection.kt` |
| 值/拆分/搜索流 | `rules/RuleValue.kt` · `rules/RuleSplit.kt` · `rules/SearchFlow.kt` |
| 响应解码/限读 | `rules/ResponseBody.kt` |
| JS 沙箱（最重） | `rules/JsSandbox.kt`(2066) · `rules/JavaPackages.kt`(1361) |
| 脚本缓存/加密/HTML | `rules/ScriptCache.kt` · `rules/ScriptCrypto.kt` · `rules/ScriptHtml.kt` |
| JS 守卫/映射 | `rules/JsGuard.kt` · `rules/JsMapObject.kt` · `rules/JsoupBridge.kt` |

### 8.4 后端 · 数据 / 书源 / 其他
| 改什么 | 文件 |
|--------|------|
| 书源仓储（CRUD/批量/体检编排） | `data/SourceRepository.kt`（**一律放 data/**，别放 source/） |
| 书源 DAO / 体检 | `data/SourcesDao.kt` · `data/SourceHealthDao.kt` |
| 书架仓储 / DAO | `data/BookshelfRepository.kt`(563) · `data/ShelfDao.kt` |
| 连接池（只一条写连接） | `data/Database.kt` · `data/db/` |
| Cookie/登录/会话 | `data/CookieDao.kt`(714) · `data/LoginDao.kt` · `data/SessionCookies.kt` |
| 阅读/缓存/RSS/替换/脚本缓存 DAO | `data/ReadingDao.kt` · `data/CacheDao.kt` · `data/RssDao.kt` · `data/ReplaceRuleDao.kt` · `data/ScriptCacheDao.kt` |
| 书源 WebView 代理 | `source/WebViewProxy.kt`(817) |
| 模型/估算（Mp3DurationEstimator） | `model/Models.kt`(1112) |
| TTS 会话 | `tts/TtsSessionService.kt` |
| 入口/healthz/版本 | `Application.kt` · `BuildInfo.kt` · `BrandStore.kt` · `DesktopLauncher.kt`(607) |

### 8.5 前端（`product/web/src/`）
| 改什么 | 文件 |
|--------|------|
| 阅读器（状态中枢） | `features/reader/ReaderScreen.tsx`(2344) |
| 阅读器 hook/展示 | `features/reader/` 下 `useReader*`(`useReaderPositionJump`=跳转原语：`jumpToNote`/`jumpToSearchHit`/`jumpToNotePosition`) · `ReaderBody`/`ReaderOverlays`/`ReaderChrome`/`ReaderCatalog` |
| 书架页 | `features/bookshelf/ShelfPage.tsx`(1219) · `LibraryPage.tsx` |
| 书源编辑器 | `features/source-editor/SourcesPage.tsx`(933) · `SourceLoginModal/UiPanel` · `SourceEditorPanel` · `SourceHealthModal` |
| AI 连接/悬浮球 | `features/ai/AiConnectionsModal.tsx` · `AiFloatingBall.tsx` |
| 通用模态 | `components/ReplaceRulesModal` · `SourceSwitchModal` · `BookDetailModal` |
| 设置/Cookie | `features/settings/CookieSection.tsx` · `app/AppHeader.tsx` |
| 统一 API 客户端（fetchWithMetrics） | `lib/api/client.ts` · `lib/performance.ts` |
| 书源分组词表（前后端两份） | `lib/sourceGrouping.ts` 的 `HEALTH_TAGS` |
| RSS | `features/rss/RssPanel.tsx` |
| 备份插件页 | `plugins/backup/BackupPage.tsx` |
| 入口 | `main.tsx`(733) |

### 8.6 测试（改完先跑对应门禁）
- 后端：`app/src/test/kotlin/io/legado/`（137 个）——`RuleRunnerTest`(1439) · `ApiRoutesHttpTest`(756) · `E2EScenariosTest`(607) · `DatabaseTest` · `BackupImportTest` · `SourceLoginTest`
- 前端：`web/test/`（136 个，node:test runner）——`ReleaseNotes`/`HealthTagVocabulary`/`VersionTracks`/`ArchitectureBoundary`
- 跑法见 §2，勿逐文件试。

## 9. 探索纪律（防止「疯狂读文件撑爆上下文」，工具无关）
> 本仓库同时被多种 AI 工具使用（CodeBuddy / Qoder / Codex·Claude / Cursor / Gemini）。协议已在 `CLAUDE.md`·`.cursorrules`·`GEMINI.md`·`AGENTS.md` 各放一份自包含精简版，无论哪个工具加载都会先读到「别乱读」这条铁律。下面是对所有工具通用的纪律：
1. **定位用 §8 表，不用探索**。表里给出的文件/符号直接 `Read(offset,limit)` 读相关窗口（≤150 行），不要整篇读。
2. **探索性/横向扫描一律委派到隔离上下文**：工具若支持 subagent（CodeBuddy 有 `.codebuddy/agents/code-explorer.md`，Codex/Claude/Cursor 也有各自 subagent 机制），就让它**在隔离上下文**里读，只回 `file:line` 引用 + ≤8 行片段，绝不把整文件灌进主上下文；不支持 subagent 时，自己严格做到第 3 条。主上下文保持精简 = 不重复读、不累积。
3. **绝不「先读一堆再找」**：先 `Grep`/`Glob` 拿到符号位置，再定向 `Read`。能 `grep` 回答的别 `Read`。
4. **重文档只懒加载**：`docs/ARCHITECTURE`(760 行)/`product/CHANGELOG`(684 行)/`API-REFERENCE`(294 行) 只在需要具体章节时用 `Grep` 定位行号再读那段；不要每轮重读，也不要全篇读。
5. **跨轮不重复读同一文件**：已读要点记到计划/记忆里，下轮直接引 `file:line`。
6. **禁用全仓「读一遍总结」式探索**（含子代理）：那会把全仓内容搬进上下文，正是 token 爆炸根因。
