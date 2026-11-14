# legado — AI 省 token 协议（自动加载版）

> 完整纪律与「任务→精确位置」速查表见根 `AGENTS.md`；本文件是它的精简自动加载版，冲突以 `AGENTS.md` 为准。

你正在修改 legado（阅读器：后端 Kotlin + 前端 React/TS）。**首要目标：别疯狂读文件，token 消耗巨大。**

## 铁律（务必遵守）
1. 改任何功能前，先查 `AGENTS.md` 的「§8 任务→精确位置 速查表」。90% 的定位需求直接拿 `文件:符号`，不要全仓 grep、不要整读大文件。
2. 需要横向/探索性扫描时，**委派给一个在隔离上下文里运行的子代理**（你的工具若支持 subagent），让它只回 `file:line` + ≤8 行片段；若不支持子代理，则自己严格做到：先 `Grep`/`Glob` 拿位置，再定向 `Read` 相关 ≤150 行窗口，绝不「先读一堆再找」。
3. 大文档（`docs/ARCHITECTURE.md`、`product/CHANGELOG.md`）只在需要具体章节时用 `Grep` 定位行号再读那段，绝不每轮重读或全篇读。
4. 跨轮不重复读同一文件：要点记到计划/记忆里，下轮直接引 `file:line`。
5. 禁止「读一遍全仓再总结」式探索——那正是 token 爆炸根因。
6. **禁读区**：`docs/archive/**`、`product/data/**`（用户书库）、`**/build/**`、`node_modules/**`、`dist/**`、`*.jar`——只按关键词 grep 或列清单，绝不整读。
7. **版本纪律**：真源是 `product/app/build.gradle` 的 `version`；日常提交只涨 rev，**不要提前 bump `BUILD_NUMBER`**（`VersionTracks.test.ts` 钉住，平时 bump 必红）。

## 热点（最常改、最烧 token，按需 grep 段，别整读）
- 前端阅读器：`product/web/src/features/reader/` —— `ReaderScreen.tsx`(2346) 是状态中枢，**整读最烧 token**；跳转原语已抽到 `useReaderPositionJump.ts`，笔记状态在 `useReaderNotes.ts`，`toggleBookmark` 仍在 `ReaderScreen.tsx`。
- 后端规则引擎：`product/app/src/main/kotlin/io/legado/rules/RuleRunner.kt`(1679) 是最大文件，改规则逻辑时按需 grep 段，别整读。
- 行数会漂移：定位一律 `grep -n '<符号>'`，别把 `(NNNN)` 当精确行号；`/api/agent/*` 接入说明在 `product/docs/agent-api.md`（不自动加载）。
- 完整「任务→文件」映射、测试门禁、常见坑：见 `AGENTS.md`（CodeBuddy/Qoder 会自动读；其他工具请也读它）。

## 改完跑门禁
- 前端：`cd product/web && npm test`（node:test 自研 runner，项数随源文件浮动，以当次实跑为准）
- 后端：`cd product && ./gradlew :app:test --no-daemon`（GoldenRuleTest 逐字节守门）
