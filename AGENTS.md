# AGENTS.md — 给 AI 的仓库导航与省 token 协议

## 0. 先读这里（省 token 规则，务必遵守）
- **禁读区**（历史/产物，整读纯浪费）：`docs/archive/**`、`legado-releases/**`、`product/data/**`、`**/build/**`、`node_modules/**`、`dist/**`、`*.jar`。需要历史时只按关键词 `grep`，不整读。
- **事实优先看 `product/docs/restructure/facts.md`**（带时间戳/命令/口径的实测数字）。不要自己 `find` 全仓重数规模。
- **不整读大文件**（>1000 行，已实测）：`ReaderScreen`2402 · `RuleRunner`2333 · `JsSandbox`2066 · `JavaPackages`1361 · `ShelfPage`1219 · `Models`1112 · `Agent`1013 · `SourcesPage`933 · `types.ts`932 · `AgentRoutes`923 · `SourcesRoutes`824 · `WebViewProxy`817 · `BuiltinTools`804 · `RuleValue`802。用 `grep -n` 定位，再 `Read(offset,limit)` 只读 40–120 行窗口。
- **token 预算**：一次会话只推进一个切点；验证跑一次全量 `npm --prefix product/web test`（~1020 项），不逐文件试；能 `grep` 回答的别 `Read`。
- **文档事实源优先级**：`product/CHANGELOG.md` > `docs/{ARCHITECTURE,STRUCTURE,API-REFERENCE}.md` > `product/docs/restructure/facts.md`；根 `CHANGELOG.md` 只是一行指针，别当第二事实源。
- **动手前先 `git status`**（可能有并行 agent 的半成品，未提交改动未必是你的）。

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
- `ReaderScreen.tsx` **2,436 行** = 状态中枢（正文渲染/分页/TTS/漫画/导航）。**整读最烧 token**，按需 grep 段。
- 展示组件：`ReaderBody`(227 正文本体) / `ReaderOverlays`(226 弹层) / `ReaderChrome`(218 外壳) / `ReaderCatalog`(目录) / `ReaderHeader` / `Md3Chrome`
- 状态 hook：`useReaderChapterContent`(124) / `useReaderCacheStatus`(139) / `usePaginationMeasurement`(190) / `useReaderPageTurn`(77) / `useReadingLog`(46) / `useReaderNotes`(200，笔记状态+增删改)
- 纯函数目录：`interaction/`（tapZones/readerFlow/pageTurn/shortcuts）· `content/`（readerFlow/logicalPosition/chunkedRender/mangaPages）· `notes/`（bookmark/reanchor）· `tts/` · `settingsPanel/`
- **尚未抽**（下轮，见 `product/docs/研究-阅读器拆分续-下一步.md`）：`toggleBookmark`、`renderNoteHighlights`、`jumpToNote`/`jumpToSearchHit`（与导航原语/渲染路径耦合）

## 4. 后端要点
- `product/app/src/main/kotlin/io/legado/`：`http/`（路由）· `data/`（Repository，**一律放 data/**，放 `source/` 会撞 `ArchitectureBoundaryTest`）· `rules/`（`RuleRunner` + `RuleProcessor` 扩展点）· `ai/` · `tts/`。
- 端点 **161 条 / 19 组**；改接口后必须重跑 `npm --prefix product run docs:api`（文档首行带版本号）。

## 5. 常见坑（详见 facts.md / 研究文档）
- 池里只有一条写连接：DAO 的 `write{}` 不能被外层 `write{}` 包（内层退出复位 autoCommit → commit 抛错）。
- 发版：`npm run release -- --no-push` 后 `git push origin main vX.Y.Z`（tag 与 main 同批推，避免 main CI 先红）。
- 发行三资产必须齐：`legado.jar` / `legado-dist.zip` / `legadoq-desktop-<版本>.zip`。

## 6. 研究 / 历史文档（`product/docs/`）
- 当前 frontier：`研究-阅读器拆分续-下一步.md`、`研究-0.2.37-成果核查与下一步.md`
- 实测事实源：`restructure/facts.md`；按日会话记录：`sessions/`

## 7. 大文件拆分路线图（每拆一刀，后续 AI 改造成本永久下降）
按「先低风险、后高耦合」排，每步单独提交、先补判据：
1. **`ReaderScreen`(2436)**：已拆 6 hook + 3 展示组件；下一步 `useReaderPositionJump`（导航原语）→ `NoteHighlights`（把 `notes` 赶出渲染路径）。
2. **`RuleRunner`(2333)**：取值段已在 `RuleNodeSelection`、响应解码/字符集/限读已在 `ResponseBody` → 下一步 HTTP 段（1426–2094，先抽窄接口避开 `JsSandbox(this)`）；靠 `GoldenRuleTest` 逐字节比对。
3. **`JsSandbox`(2066) / `JavaPackages`(1361)**：Java 桥，动前先跑 `GoldenRuleTest` + 真库抽样。
4. 前端 **`ShelfPage`(1219) / `SourcesPage`(933)**：按子功能拆 hook。
纪律：删/拆文件时同步缩 `tools/verify/depth-check.mjs` 的 `KNOWN_DEEP` 基线（只许单调缩小）。
