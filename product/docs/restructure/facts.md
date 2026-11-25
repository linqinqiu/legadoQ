# 现场事实清单（facts）

> 单一事实源：本文件记录**带时间戳、带命令、带口径**的实测数字。
> 其他文档（`docs/STATUS.md`、`backend-layering.md`、`frontend-host.md`）里的规模数字写于各自 commit，
> 属于历史事实；与本文冲突时以本文为准，并重新跑一遍命令。
>
> 最近采集：**2026-11-11 晚**（规模与测试数按工作树复测，含未提交 `RuleHttp` 抽取；构建产物 / 数据库 / 覆盖率仍是 2026-11-09 的值）。
>
> **分工**：本文=规模/测试/覆盖率等数字的**唯一真源**；现行全景架构→[`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md)；外部报告审计→[`architecture-audit.md`](../architecture-audit.md)。

---

## 0. 口径约定（读数字前先看）

1. **区分 HEAD 与工作树**：有未提交改动时，文件数/行数会变。每条都标注口径。
2. **`@Test` 计数 ≠ 测试通过数**：`grep -rho "@Test"` 只是静态计数，没有运行。
3. **计数用 `grep -o`，不用 `grep -c`**：后者是"包含该 token 的行数"，不是出现次数。
4. **运行态 ≠ 源码**：服务跑的是某个 jar；源码改过但没重建时，两者不一致。
5. **瞬时状态单列**（§5），不要当成"项目一直如此"。

---

## 1. 锚点

| 项 | 值 | 取证 |
|---|---|---|
| 仓库 | `E:\legado` | — |
| 采集时 HEAD | `9564e26`（2026-11-11 22:00，270 提交） | `git log -1 --format="%h %ad" --date=iso`；HEAD 随后续提交前移，锚点只作复现用 |
| 版本 tag | `v0.2.37` → `43ea5562`（peel `5344c39`）；采集时 HEAD 无 tag | `git tag --points-at HEAD`（空）；`git rev-parse v0.2.37^{commit}` |
| 版本 / 构建号 | **0.2.39 / 52**（2026-11-12 发版并推送，tag `v0.2.39` → `91b6d5a`；C-01 RSS/Atom 直解 + C-02 分页占位收口） | `cat VERSION BUILD_NUMBER`；`/healthz` |
| 版本真源 | `product/app/build.gradle` 的 `version` | 其余 6 处为抄本，`npm run version:check` 钉住 |
| 代码修订 | `rev-<提交数>` + 短 sha | `/healthz` 的 `rev` / `sha` 字段（0.2.37 起） |

> `rev` 是打包时 `git rev-list --count HEAD` 写进 `meta/build-info.properties` 的值，`sha` 是
> `git rev-parse --short HEAD`。**没发版、只在本地改时，版本号不动，只有 rev 随提交递增** ——
> 判断"跑的是哪一版代码"看 rev，精确定位提交看 sha。

---

## 2. 源码规模（HEAD `9564e26`，2026-11-11 22:00，工作树干净）

| 项 | 值 | 命令 | 口径 |
|---|---:|---|---|
| 后端 `.kt` | **139** | `find product/app/src/main/kotlin/io/legado -name '*.kt' \| wc -l` | 含全部包 |
| 后端行数 | **35,470** | `find … -exec cat {} + \| wc -l` | — |
| 后端 `@Test` | **1,110** | `grep -rho '@Test' product/app/src/test --include=*.kt \| wc -l` | 静态计数 |
| 后端测试文件 | **142** | `find product/app/src/test -name '*.kt' \| wc -l` | — |
| 前端 ts/tsx | **202** | `find product/web/src \( -name '*.ts' -o -name '*.tsx' \) \| wc -l` | 2026-11-11 |
| 前端行数 | **38,361** | 同上 `-exec cat {} + \| wc -l` | 同日 |
| 前端测试文件 | **134** | `ls product/web/test/*.test.ts \| wc -l` | 同日 |

**跑起来的通过数**：

- **HEAD `9564e26`（2026-11-11 22:00，工作树干净）**：后端 **1,109 完成 / 0 失败 / 6 跳过**（静态 `@Test` 1,110），前端 **1,056 / 1,056** 全绿（`tsc -b` 通过）；合计 **2,165**。
- **满负载复跑（同机并行 4 个审计任务）**：后端 1,109 完成 / **12 失败** / 6 跳过。12 例全在 `io.legado.AgentRoutesHttpTest`(8) 与 `AgentErrorClassHttpTest`(4)，失败信息统一是 `UncompletedCoroutinesError: After waiting for 1m, the test body did not run to completion`；减载后只重跑这两个类 `BUILD SUCCESSFUL`（1m16s）→ 判定为并发负载假红，不是代码缺陷。
- 旧记录（HEAD `e9ed196` 的 1,103/1,103、工作树 `RuleHttp` WIP 3 红）已过期：`RuleHttp.kt` 已在 HEAD，唯一相关 import 是 `io.legado.port.logNetwork`，`ArchitectureBoundaryTest` 全绿。

> 静态 1,110 与实跑 1,109 的差 1 是历史现象（有一条用例没有被任何测试类执行），不是失败。

**覆盖率（jacoco / c8，2026-11-09 22:11 同一次 `npm run coverage`）**：后端行 **70.04%**
（13,209 / 18,860），前端行 **63.51%**（15,070 / 23,726），前后端合计 **66.4%**。

按包看后端，最薄的四块：

| 包 | 行数 | 行覆盖 |
|---|---:|---:|
| `io.legado`（根，含启动与配置） | 912 | 44.6% |
| `io.legado.tts` | 601 | 56.6% |
| `io.legado.http` | 2,388 | 49.3% |
| `io.legado.source` | 963 | 60.5% |

最厚的两块：`rules` 4,399 行 78.8%、`ai` 3,987 行 65.8%。

---

## 3. 构建产物

| 项 | 值 | 备注 |
|---|---|---|
| fat jar | `legado-0.2.37-all.jar`，**35,008,270 B** | 2026-11-09 20:46 |
| web/dist | **19 个文件，3.3 MB** | 与 jar 内嵌 `static/` 逐字节一致 |
| 运行 UI 指纹 | `index-CbOLdce1.js` | dist / jar / `/healthz` 三处一致 |
| 桌面 zip | `legadoq-desktop-0.2.37.zip`，56.4 MB | CI 的 `desktop` job 打，本地不留 |
| Release 资产 | `legado.jar` 33.4 MB / `legado-dist.zip` 32.1 MB / desktop 56.4 MB | GitHub Release `v0.2.37`，2026-11-09 12:52Z |

> `build/libs` 里只该有当前版本的 jar。历史 `-all.jar` 留着会让 `tools/verify/version-check.mjs`
> 的门禁红（"留着只会让下一步挑错包"），也会让启动器挑错包。

---

## 4. 数据库（`product/data/legado.sqlite`，21:00 运行态快照）

| 指标 | 值 |
|---|---:|
| 库文件 | 66 MB（WAL 69 MB，SHM 32 KB） |
| 代码建的表 | **20**（`data/db/Schema.kt`） |
| 磁盘上的表 | **24**（20 + 遗留 `book_mark` + `sqlite_sequence` / `sqlite_stat1` / `sqlite_stat4`） |
| 书源总数 / 启用 | 5,600 / 5,600 |
| RSS 源 | 178 |
| 书架书 / 分组 | 0 / 4 |
| 正文缓存 | 715 行 |
| 目录缓存 | 514 |
| Cookie 桶 | 588 |

查询方式（只读，不碰 WAL）：

```bash
sqlite3 "file:product/data/legado.sqlite?mode=ro" "select count(*) from source;"
sqlite3 "file:product/data/legado.sqlite?mode=ro" "select count(*) from sqlite_master where type='table';"
```

> **WAL 比主库还大**（69 MB vs 66 MB）说明 checkpoint 落后于写入；正常关闭会合并，
> 强杀进程时才会留下这么大的 WAL。数表数量要用 `sqlite_master` 实测，别数建表语句 ——
> 老库里可能留着已删功能的遗留表。

---

## 5. 现场状态（瞬时，2026-11-11 22:00）

| 项 | 状态 |
|---|---|
| 工作树 | **干净**（`git status --short` 空）；HEAD `9564e26`，本地 `origin/main` 引用同为 `9564e26`（远端最新无法 fetch 验证：代理 127.0.0.1:6480 无服务） |
| 服务 | **未运行**；本轮验证用 `gradlew :app:test` 与 `npm test`，没有起 1234 |
| `/healthz` | 无应答（服务未启动）；修订号格式见 §1 的 `rev` / `sha` |
| 端点 | **161 条 / 19 组**（`docs:api-check` 实测） |
| 门禁 | `version:check` 7 处一致；`docs:api-check` 161/19 一致；`changelog:check` 无待记录 |
| CI | main：契约 / 真浏览器 / 覆盖率 / Test&Build 全 success；tag：三资产已发布 |

端点分组（实测，按条数降序）：AI 自定义接入 22、内置浏览器 17、登录与凭据 15、书架 14、
书源 12、净化规则 10、进度与笔记 9、朗读 9、系统 8、RSS 7、分章规则 7、阅读 6、
图片与媒体 6、书源订阅 5、备份 5、发现页 3、离线缓存 3、搜索 2、目录 1。

上述任一项都会随下一次 commit / 重启变化，**不要**把它们写进"项目常驻描述"。

### 5.1 续（2026-11-09 深夜 → 2026-11-10，本地，领先 origin 28 提交）

> 自 §5 之后又做了阅读器拆分（4.1/4.2/4.3 第一步）。规模数字见 `研究-阅读器拆分续-下一步.md` §5。

| 项 | 状态 |
|---|---|
| 工作树 | 代码已提交（`7afd4ea` 外壳抽成 ReaderChrome + 撤掉界面构建号；`7ae52d0` 笔记状态搬进 useReaderNotes）；本轮收尾只剩文档改动 |
| 阅读器拆分 | `ReaderScreen.tsx` 3,200 → **2,344**；拆出 `ReaderBody`(227) / `ReaderOverlays`(226) / `ReaderChrome`(218) / `useReaderNotes`(200) / `useReaderPositionJump`(120) / `NoteHighlights`(47) 与 `useReaderChapterContent`(124) / `useReaderCacheStatus`(139) / `usePaginationMeasurement`(190) / `useReaderPageTurn`(77) / `useReadingLog`(46) |
| 后端拆分 | `RuleRunner` 2,419 → **2,333**；响应解码/字符集/限读（`decodeBody`/`resolveBodyCharset`/`metaCharset`/`readAll`/`readLimited` + `MAX_BODY_BYTES`/`META_CHARSET`）抽进同包 `ResponseBody`(112)，`resolveBodyCharset` 留一行委托保 `ResponseCharsetTest` |
| 前端判据 | **1,022 通过 / 0 失败**（`npm --prefix product/web test`，2026-11-10 复跑） |
| 笔记拆分边界 | `useReaderNotes` 收了状态与增删改；`useReaderPositionJump` 收了 `jumpToNote`/`jumpToSearchHit`/`jumpToNotePosition`/跨章落点 effect；`toggleBookmark`（依赖 `readLogicalPosition`，与 persist 共用逻辑位置）仍留 `ReaderScreen`，经 `notesApi.*` 复用状态 |
| 门禁 | `check`(tsc -b) 通过；version/docs:api/changelog 未重跑（未改版本/接口/修复提交）。注：`check:test` 当时在 `test/PerformanceMonitor.test.ts` 有类型报错（上次动于 `c660963`），非该轮引入；**2026-11-10 复查：该报错已随 fetch mock 修补消除，`check:test` 现已通过** |

---

### 5.2 续（2026-11-10 下午，本地，审计与优化轮）

> 这一轮没加端点、没动数据格式：后端行为修复 + 前端统一超时/统一传输层/焦点陷阱 + 阅读记录汇总与范围切换（借 MD3）。
> 逐条证据与判据见 `docs/research/研究-审计与优化-2026-11-10.md`。

| 项 | 状态 |
|---|---|
| 后端判据 | **1,103 通过 / 0 失败 / 0 错误**（`./gradlew :app:test --no-daemon`，2026-11-10 复跑；`ResponseBody.kt` 改动后重跑仍全绿） |
| 前端判据 | **1,041 通过 / 0 失败**（`npm --prefix product/web test`，2026-11-10 第五轮）；`tsc -b` 与 `tsc -p tsconfig.test.json` 均通过 |
| 端点 | 161 条 / 19 组不变（未加接口；阅读记录是纯前端聚合） |
| 后端修复 | 脚本缓存回填丢 deadline（P0，`ScriptCacheTtlTest`）；响应超限改抛规则异常（`ResponseBody`）；AI 循环每轮复查上下文预算（`AgentPromptContextTest`）；停用工具的执行期护栏（`ToolPolicy`/`runTool`，`ToolSelectionTest` + `AgentToolCallingTest`）；删死代码 `getBatchBooks` |
| 前端 | `fetchWithMetrics(url, init, timeoutMs)` 统一超时（调用方 signal 优先）；AI 实测 20 秒上限 + 失败原因；阅读记录加汇总卡片、按书统计与 30/90/365 切换；正文失败可「重新加载」（`ReaderReload.test.ts`）；裸 `fetch` 收口到 `lib/api/client.ts` 的 text/blob/arraybuffer 助手（`BareFetch.test.ts` 守卫）；三处弹层接 `useFocusTrap`（`FocusTrap.test.ts`，嵌套栈） |
| 未修 | 见 `研究-审计与优化-2026-11-10.md` §3（后端 1 条 / 前端 5 条，按 ROI 排列） |
| 文档归拢 | 8 份研究 + 14 份会话记录（另各自 README）已迁入 `docs/research/` / `docs/sessions/`，`docs/README.md` 是唯一索引；77 份 Markdown、116 条相对链接全部可达（2026-11-10 脚本核查） |
| 复跑 | 文档改完后后端 `:app:test` **1,103 通过 / 0 失败**、前端 `npm --prefix product/web test` **1,041 通过 / 0 失败**；`check`、`check:test`、`vite build` 与 version/docs:api/changelog 三条门禁均通过 |

> **本机跑后端全量必须设 `LEGADO_TEST_TMP`**：系统临时目录（`<系统临时目录>`）里的 sqlite
> 会被杀软扫到锁住，`E2EScenariosTest` 在清理阶段报"另一个程序正在使用此文件"的假失败。
> 用 `LEGADO_TEST_TMP='<仓库>/product/build/testtmp'`；那条测试的清理也已统一走重试助手。

---

## 6. 文档/记忆与实测的偏差

| 来源 | 说法 | 实测 | 处置 |
|---|---|---|---|
| `docs/STATUS.md`（0.2.14 版） | 927 / 900 测试、161 端点、20 张表 | 1,103 / 1,041、161、20（代码建表） | 已按本文重写 |
| `backend-layering.md` | 123 / 32,153 / 935 | 136 / 35,404 / 1,104 | 写于旧 commit，数字以本文为准 |
| `frontend-host.md` | 177 / 110 | 200 / 132 | 同上 |
| `docs/ARCHITECTURE.md` §13 | `HttpClients` 零调用方 | 0.2.36 已删除该文件 | 该行已改为「已撤销」 |
| 旧记忆 | 0.2.17 / build 13 | 0.2.37 / build 50 | 已更新 |

**纪律**：不要把旧文档里的数字逐项改成新数字——那会让它们变成永远追不上 HEAD 的第二事实源。
正确做法是在文档头加一行"写于 `<commit>`，规模数字已过期，以 `facts.md` 为准"。

---

## 7. 2026-11-14 采集（目录与文件资产审计轮）

> 采集时点 HEAD `91aa457`（其后为文档整改提交，代码未动）。旧节数字不回改，现行数字以本节为准。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| 对外版本 / 构建号 | 0.2.42 / 55 | `cat VERSION BUILD_NUMBER`；真源 `product/app/build.gradle` |
| HTTP 端点 | 165 条 / 19 组 | `node -e "console.log(require('./product/app/src/main/resources/agent-api.json').count)"` |
| 代码建表 | 21 张 | `grep -c 'create table if not exists' product/app/src/main/kotlin/io/legado/data/db/Schema.kt` |
| Dao 文件 | **13 个**（data/ 顶层 19 文件含 Database/2 Repository/SessionCookies/DbSnapshot/StoreAdapters） | `ls product/app/src/main/kotlin/io/legado/data/*Dao*.kt \| wc -l`；「13→19 漂移」系误判，见 `docs/engineering/audit/directory/03-DOCUMENTATION-AUDIT.md` D-1 |
| 后端测试 | 1,194 项 / 157 suite / 0 失败 | `product/app/build/test-results/test/*.xml` 求和（最新 2026-11-14T06:33Z，P0-2 交付时点 d503cf6） |
| 前端测试 | 1,157 项 / 0 失败（约 24s） | `npm --prefix product/web test` 实跑（2026-11-14，6892d03 时点） |
| 被跟踪文件 | 989 | `git ls-files \| wc -l`（含本轮新增审计 11 份） |
| ops/ 包 | 9 文件（NetworkSecurity/PinnedProxy/GuardedHttpClient/ProxyHeaders/ServerIdentity/LogService/UpdateCheck/Metrics/UiPrefsStore） | `ls product/app/src/main/kotlin/io/legado/ops/` |

本轮整改交付（代码侧，详见 `docs/engineering/audit/PHASE2_PREFLIGHT_REPORT.md` §10）：P0-4 AI 写闸（e534d8c）、P0-1 备份导入原子性（36140b5/9b6902d/772ade2）、P0-2 出站连接级 IP 固定（d503cf6）、备份 group/durChapterPos 字段修复（dfa1313）。P0-3 schema version 未开始。

---

## 8. 2026-11-14 21:10 复跑（卫生线阶段 C 收口后，HEAD `3a3d5d9`，工作树干净）

> 上一节采集于 `91aa457`；本节是当前 HEAD 的实测，旧节不回改。**现行数字以本节为准。**

| 项 | 数值 | 命令/口径 |
|---|---|---|
| HEAD / rev | `3a3d5d9` / **324** | `git rev-parse --short HEAD`；`git rev-list --count HEAD` |
| 对外版本 / 构建号 | 0.2.42 / 55 | `cat VERSION BUILD_NUMBER` |
| 最近 tag | `v0.2.42` | `git tag --sort=-creatordate \| head -1` |
| 后端源码 | **150 文件 / 36,812 行** | `find product/app/src/main/kotlin -name '*.kt'` + 行数求和（排除 build） |
| 后端测试源码 | 160 文件 / 29,340 行 | `product/app/src/test/kotlin` |
| 前端源码 | **218 文件 / 40,863 行** | `find product/web/src \( -name '*.ts' -o -name '*.tsx' \)` |
| 前端测试文件 | 148 个（`web/test/*.test.ts`） | `ls product/web/test/*.test.ts \| wc -l` |
| **后端测试实跑** | **1,217 项 / 160 suite / 0 失败 / 0 跳过** | `java -Xmx1g -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain :app:test --no-daemon --max-workers=2`，`BUILD SUCCESSFUL in 5m 59s`（第 5 项补测落地后重跑）；`test-results/test/*.xml` 求和 |
| **前端测试实跑** | **1,173 项 / 0 失败**（约 16s）+ `tsc -b` 通过 | `npm --prefix product/web test`（段评浮层落地后） |
| HTTP 端点 | 165 条 / 19 组（`docs:api-check` 一致） | `npm --prefix product run docs:api-check` |
| 三条门禁 | `version:check`（8 处一致 0.2.42/55）、`docs:api-check`、`changelog:check` 全绿 | `npm --prefix product run …` |
| 库版本号 | **`user_version = 1`**（基线），由 `data/db/SchemaVersion.kt` 管理 | `pragma user_version`；判据 `SchemaVersionTest` 8 项 |
| 沙箱暴露面 | **43 个类 / 98 个静态入口 / 13 个仅构造类** | `JavaPackagesEntryBaselineTest` 反射枚举；增删都要改基线 |
| 被跟踪文件 | 988 | `git ls-files \| wc -l` |

**本机跑法提醒**：`./gradlew` 直接跑会 `ClassNotFoundException: org.gradle.wrapper.GradleWrapperMain`，必须走上面的 `java -classpath gradle/wrapper/gradle-wrapper.jar` 形式；后端全量必须设 `LEGADO_TEST_TMP=<仓库>/product/build/testtmp`。

---

## 9. 2026-11-15 23:25 复跑（typeset 分页簇删除 + SchemaVersion 扁平化 + 环境清理后）

> 上一节采集于 `3a3d5d9`；本节是当前工作树（HEAD `98aed29`）的实测，旧节不回改。**现行数字以本节为准。**

| 项 | 数值 | 命令/口径 |
|---|---|---|
| HEAD / rev | `98aed29` / **336** | `git rev-parse --short HEAD`；`git rev-list --count HEAD` |
| 对外版本 / 构建号 | 0.2.42 / 55 | `cat VERSION BUILD_NUMBER` |
| 后端源码 | **150 文件 / 36,812 行** | `find product/app/src/main/kotlin -name '*.kt'` + 行数求和（排除 build） |
| 前端源码 | **214 文件 / 40,553 行**（typeset 簇删除后，原 218 / 40,863） | `find product/web/src \( -name '*.ts' -o -name '*.tsx' \)` |
| 前端测试文件 | **146 个**（原 148，删 `LayoutEngine.test.ts` / `PaginationCache.test.ts`） | `find product/web/test -name '*.test.ts*' \| wc -l` |
| **后端测试实跑** | **1,217 项 / 160 suite / 0 失败 / 0 跳过** | `./gradlew :app:test --no-daemon --max-workers=2`；`test-results/test/*.xml` 求和 |
| **前端测试实跑** | **1,157 项 / 0 失败**（约 50s）+ `tsc -b` 通过 | `npm --prefix product/web test` |
| 目录深度门禁 | **OK：无新的过深文件（基线内 7 个）** | `cd product && node tools/verify/depth-check.mjs` |
| HTTP 端点 | 165 条 / 19 组（`docs:api-check` 一致） | `npm --prefix product run docs:api-check` |
| 三条门禁 + 协议 | `version:check`（8 处一致 0.2.42/55）、`docs:api-check`、`changelog:check`、`protocol:check` 全绿 | `npm --prefix product run …` / `npm run protocol:check` |
| 库版本号 | **`user_version = 1`**（基线），由 `data/SchemaVersion.kt` 管理（**本轮由 `data/db/` 扁平化上来**） | `pragma user_version`；判据 `SchemaVersionTest` 8 项（同步迁到 `data/`） |
| 阅读器文件数 | **`features/reader/` 72 个**（原 75，删 `typeset/` 3 个） | `find product/web/src/features/reader -type f \| wc -l` |
| 被跟踪文件 | 990（原 997，删 7 个：3 源 + 缓存 + 2 判据 + 旧 SchemaVersion） | `git ls-files \| wc -l` |
| **前端产物指纹** | **`index-Bn5aJX-q.js`（删除前后逐字节相同）** | `ls product/web/dist/assets/`；删除 typeset 簇后重新 `npm run build`，bundle hash 没变 —— 反证那 443 行确实零贡献 |

**本轮删除**：N-1 typeset 分页簇整簇删除（`features/reader/typeset/` 3 文件 + `content/paginationCache.ts` + 2 份判据），决策记录见 `docs/research/研究-typeset分页簇去留-2026-11-15.md`。

**本轮环境清理**（"工作环境干净可靠"）：

| 项 | 清理前 | 清理后 | 影响 |
|---|---|---|---|
| `app/build/libs/` 旧版本 jar | 0.2.37–0.2.42 共 12 个 | 只留 0.2.42 两个 | `version-check` 那条「旧版本 all.jar 残留」从红转绿（留着会让打包挑错包） |
| git stash | 7 个（2026-11-05～11-11） | 0 | 全部是已合进 main 的快照或 CHANGELOG 草稿，纯污染 |
| git worktree | 1 + 1 临时基线 | 1 | 基线 worktree 已删 |
| 库里自检临时书源 | 1 个 `ui-check.example.com` | 0 | 门禁自己清不干净（找不到删除按钮），手工走 `/api/sources/batch` 删掉 |
| `web/.bench-math.ts` | 1 个一次性基准脚本 | 0 | 未跟踪的 scratch |

**门禁修的真 bug**：`source-editor-check.mjs` 读 `web/src/sources/SourceHealthModal.tsx`，而书源编辑器早搬到 `web/src/features/source-editor/` —— 这条门禁不是红，是**崩**（ENOENT 带崩整个脚本）。已改指真实路径。

**全量测试注意**：`--max-workers` 不设时默认并行会让 `AgentRoutesHttpTest` / `AgentErrorClassHttpTest` / `McpClientTest` 出现 1 分钟协程超时假失败（单跑全绿）；用 `--max-workers=2` 复跑稳定全绿。

**浏览器门禁注意**（47 条，实测 34/47 通过）：失败的 13 条**与本轮改动无关** —— 前端 bundle 逐字节相同即可证明。其中：
- 一类是**状态污染**：门禁之间共用服务端 ui-prefs，前一条点过「同意协议」后 `agreement-check` 就找不到弹层。跑全量前先 `DELETE /api/ui-prefs/<key>`。
- 一类是**本机书源规模**（5,604 条）下的真实 UI 问题（手机档书源页撑破父容器等），属另一条整改线。
- `source-editor-check` 的清理段找不到「删除书源」按钮，也是既有 UI 问题，与本轮改动无关。

---

## 10. 2026-11-22 复跑（0.3.0 / build 56，产物门禁加固 + 自定义 TTS 签发点）

> 上一节采集于 `98aed29`；本节是当前工作树（基于 `cf64f88`，rev **438**）的实测，旧节不回改。**现行数字以本节为准。**
> 产物门禁/文档改动已提交为 `cf64f88`；TTS 切片（Edge WSS 与自定义 TTS 分成两个 client，新增 `ops/CustomTtsClient.kt` 与 3 条策略测试）随本节一并提交，后端数字按含该切片的源码实跑。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| 对外版本 / 构建号 | 0.3.0 / 56 | `npm --prefix product run version:check` |
| **前端测试实跑** | **1,118 项 / 0 失败** | `npm --prefix product/web test`；`ChallengerEmpiricalStress` 曾在并行负载下触发一次计时基准红，单文件与第二次全量均通过 |
| 前端类型检查 | 通过 | `npm --prefix product/web run check`（`tsc -b`） |
| **后端测试实跑** | **1,028 项 / 145 suite / 0 失败 / 0 跳过** | `./gradlew :app:test --no-daemon --max-workers=2`，`BUILD SUCCESSFUL in 6m 12s`；`test-results/test/*.xml` 求和。`E2EScenariosTest` 的 1500ms/300ms/2500ms 墙钟阈值已移除，改为请求面与完整性判据（选中书源恰好 4 次请求、5000 章首尾完整），耗时只打印；自定义 TTS 请求头端到端判据落地（`Authorization` 转发、CRLF 注入头与 `Host` 丢弃） |
| **前端产物指纹** | **`index-Bl62g_P0.js`**（911,135 B） | `product/web/dist/index.html`；`build:fallback` 产出 |
| 产物完整性门禁 | **11/11 通过** | `node product/tools/verify/dist-check.mjs`（新增：校验 index.html 引用资源真实存在） |
| jar / dist / 活服务一致性 | **5/5 通过**（含活服务 `/assets/*.js → 200`） | `node product/tools/verify/bundled-ui-check.mjs`（启动 `product/start.mjs --no-open` 后实跑） |
| 四步构建链（兜底分支） | **4/4 完成，`BUILD SUCCESSFUL in 4m 10s`** | `cd product; $env:LEGADO_WEB_BUILD='fallback'; npm run build` |
| HTTP 端点 | 147 条 / 19 组（`docs:api-check` 一致） | `npm --prefix product run docs:api-check` |

**架构边界回归的处置（本轮已修）**：首次全量（默认并行度）暴露 2 项失败：

1. `ArchitectureBoundaryTest > engine 不得依赖 infra` —— `d34af81` 让 `source/ExternalBrowserLogin.kt` 新增 `io.legado.ops.LocalControlClient` 依赖，却没有进 `ENGINE_TO_INFRA_BASELINE`。处置不是扩基线（违反「只许单调缩小」），而是新增 `port/LocalControl.kt` 端口，`ops.LocalControlClient` 实现它，`http/Routes.kt` 组合根注入。方向由 `engine → infra` 改为 `engine → port`；G3 签发点仍是 `LocalControlClient.kt`。
2. `E2EScenariosTest > scenario 1` 的「Instant book open < 300ms」—— 默认并行度下的计时抖动，单类复跑与 `--max-workers=2` 全量均通过，与 2026-11-11 满负载假红同性质。

**构建环境事实**：本机 Node **v24.18.0**（`product/.nvmrc` 要求 22，本机无 nvm），esbuild **0.25.12**。默认 `vite build` 在 transform 输入 >1 MiB 时会写临时文件，删除报 `Access is denied`，表现为 `[vite:esbuild-transpile] remove ... Access is denied`；提权、改 `TEMP/TMP` 均无效。`vite build --target esnext --minify terser` 可稳定出包（仅跳过语法降级，仍压缩），故 `web:build:fallback` 与 `LEGADO_WEB_BUILD=fallback` 作为本机兜底；CI/发布仍用默认 `build`。

---

## 11. 2026-11-23 复跑（自定义 TTS 路由层判据 + 出站健壮性）

> 本节采集于 `c28895a` 之上未提交的路由层测试与出站健壮性改动（同日第二次复跑）。**现行数字以本节为准**；§10 的 1,028 项是更早的快照，不回改。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **后端测试实跑** | **1,031 项 / 145 suite / 0 失败 / 0 跳过** | `./gradlew :app:test --no-daemon --max-workers=2`，`BUILD SUCCESSFUL in 6m 16s`；`test-results/test/*.xml` 求和 |
| **后端行覆盖率** | **74.17%**（11,362/15,318）；`tts` **74.66%**（607/813） | 同一次全量运行的 `app/build/reports/jacoco/test/jacocoTestReport.xml`；2026-11-09 旧快照是整体 70.04%、`tts` 56.6% |

`EdgeTtsTest` 新增 `speak route serves custom tts audio and blocks metadata targets`：真实 `testApplication` + 本机 `HttpServer`，从 `/api/tts/speak` 入口验证 `engine=custom` 分支——`Authorization` 附加头转发、`{{speakText}}` 替换、上游 `Content-Type` 透传、字节流原样返回；同一入口对 `169.254.169.254` 在发请求前拒绝并返回 400 `tts_invalid_request`。此前这条链路只有 `EdgeTtsService` 服务层单测，路由层没有判据。

同日第二条 `custom tts reports upstream errors and caps response size while reading` 与路由错误语义调整一并落地：

- 一次性 `/api/tts/speak` 的自定义分支此前**不检查上游状态码**，401/500 的错误 JSON 会被当音频回 200（用户侧表现为“合成成功但没声音”）；现在非 2xx 一律报错。
- 8MB 上限改为**边读边判**（`BodyHandlers.ofInputStream()` + 16KB 缓冲），不再先 `ofByteArray()` 读完再判——超大响应不会先把内存吃满。
- 错误语义向 `MediaRoutes`/`SearchRoutes` 的既有约定对齐：调用方输入问题（地址策略拒绝、响应超限）→ **400** `tts_invalid_request`；上游失败 → **502** `tts_failed`；不再是所有异常统一 500。

第三条 `custom tts allows three redirect hops and rejects the fourth` 修掉重定向判据的 off-by-one：上限是“最多跟 3 跳”，原实现用 `while (... && hops < MAX)` 再配 `require(hops < MAX)`，导致**恰好 3 跳**在成功后仍被判超限；现改为循环内“还有下一跳且已到上限才拒绝”，第 3 跳允许、第 4 跳拒绝，报错前也关闭当前跳的响应体。

## 12. 2026-11-23 复跑（跨源跳转凭据 + 打包产物活服务冒烟）

> 本节采集于 `d88b2ed` 之上的未提交改动（跨源重定向不再重放自定义头）。**现行数字以本节为准**；§11 的 1,031 项是更早的快照，不回改。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **后端测试实跑** | **1,048 项 / 148 suite / 0 失败 / 0 跳过** | `./gradlew :app:test --no-daemon --max-workers=2`，`BUILD SUCCESSFUL in 3m 56s`（2026-11-23 全量复跑，含请求体上限 7 项新判据）；`test-results/test/*.xml` 求和。更早一轮曾 2 项环境级失败（`BookCacheServiceTest` / `CrossFeatureBackendTest` 在 `finally` 删临时库时撞 Windows 文件占用），单跑两个 suite 均通过、重跑全量转绿 |
| **后端行覆盖率** | **74.35%**（11,441/15,388）；`tts` **75.81%**（630/831）、`ops` **82.47%**（560/679） | 同一次全量运行的 `app/build/reports/jacoco/test/jacocoTestReport.xml`；不要用 CSV 求和（内部类行会被内外层重复计）。13:35 复跑比 12:28 那轮少 2 行（`tts` 632→630），差额来自当时已删的临时探针，不是代码回退 |
| **EdgeTtsTest** | **12/12 通过** | 跨源/同源跳转 + 跳转方法语义判据 |

跨源凭据修复：`followCustomTtsRedirects` 的 `rebuild` 改为接收 `(from, to)` 两个 URI，调用方按 `scheme / host / 端口`（默认端口归一化）判同源——**跨源时不再重放用户配置的附加请求头**，同源跳转保留。此前每跳都无条件重加全部自定义头，上游一个 302 就能把 `Authorization` / `Cookie` / `X-Api-Key` 送到用户没配置过的主机。判据：

- `custom tts drops configured headers on cross-origin redirects`：两台本机 `HttpServer`（端口不同即跨源），起点收到 `Authorization`，302 目标收到空 `Authorization`/`Cookie`/`X-Api-Key`，音频仍原样返回。
- `custom tts keeps configured headers across same-origin redirects`：同端口 `/start → /audio`，目标仍收到 `Authorization`。

跳转方法语义（同一条 follow 链路）：`rebuild` 现在还收到 `status`，按 RFC 9110 §15.4 决定跟跳方法——`303` 一律 GET，`301`/`302` 把 POST 降为 GET 且不带 body，`307`/`308` 保留方法与 body。原实现每跳重发 POST，上游 302/303 到静态文件或 CDN 时会 405 或重复合成。判据 `custom tts applies rfc redirect method semantics` 用一台本机 `HttpServer` 覆盖 301/302/303/307/308：前三个目标端收到 `GET`+空 body，307/308 收到 `POST`+`payload`。

打包产物活服务冒烟（重打 `:app:fatJar` 后，`node product/start.mjs --port 18089 --no-open`，临时库）：

| 断言 | 结果 |
|---|---|
| `/healthz` | `version=0.3.0` / `build=56` / `rev=rev-447` / `sha=97ea109` / `ui=index-Bl62g_P0.js`（jar 与 HEAD 一致） |
| 直连 custom TTS（带 `Authorization`） | **200** `audio/mpeg`，字节 `SMOKE-AUDIO-A` |
| 跨源 302（A:59605 → B:59606） | **200** `audio/mpeg` 字节 `SMOKE-AUDIO-B`；起点收到 `Bearer cross-key`/`sid=9`/`key-9`，目标三项全空 |
| 同源 302（`/same → /tts`） | **200** `audio/mpeg`；目标仍收到 `Bearer same-key` |
| `http://169.254.169.254/latest/meta-data/` | **400** `tts_invalid_request`（“拒绝访问链路本地/元数据/保留地址”） |
| POST 经 303（`/see → /tts`） | **200**；目标端收到 `GET` + 空 body |
| POST 经 307（`/keep → /tts`） | **200**；目标端收到 `POST` + `payload` |

门禁同轮全绿：`version:check`（8 处 0.3.0 / build 56）、`docs:api-check`（145 端点 / 18 组）、`changelog:check`（64 条提交，边界 `771b311`）、`architecture-check` G1–G8、`depth-check`（过深 5 个基线内）、`dist-check` 11/11、`bundled-ui-check` 4/4（运行实例一项因已停服 SKIP）。

## 13. 2026-11-25 第 0 阶段与 AppContainer 第一刀

> 采集于 HEAD `42473cf` 之上的未提交工作树；本节是第 0 阶段快照，现行数字见 §14，§12 保留为更早历史。本轮未提交、未推送。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **后端测试实跑** | **1,074 项 / 152 suite / 0 失败 / 0 错误 / 0 跳过** | `cd product && ./gradlew :app:test --no-daemon`，`BUILD SUCCESSFUL in 3m 27s`；`test-results/test/*.xml` 求和 |
| **AppContainer 生命周期** | **2/2 通过** | `AppContainerTest`：组合根构造不新增 HTTP selector 线程；构造失败时关闭已创建的数据库与后台资源 |
| **前端测试实跑** | **1,143 项 / 147 个文件 / 0 失败** | `npm --prefix product/web test`（Node 内置 runner）；含 PWA 忙碌刷新、API 写请求忙碌源与匿名反馈判据 |
| **前端类型** | **通过** | `npm --prefix product/web run check`（`tsc -b`），并随最终 fallback 生产构建再跑一次 |
| **工具脚本用例** | **22/22 通过** | `node --test product/scripts/*.test.mjs` |
| **交付契约自测** | **30/30 通过** | `node product/tools/verify/delivery-check.mjs`；覆盖 Docker 上下文、quality → build → desktop → release DAG、PR 发布守卫与吞错表达式 |
| **结构门禁** | **G1–G8、depth 全绿** | `architecture-check`：`styles.css` 6,750 行 ≤ 6,760；关于页反馈样式已迁入独立 CSS |
| **最终生产包** | **276 modules / 40 个 static 文件** | `LEGADO_WEB_BUILD=fallback npm --prefix product run build`；`dist-check` 11/11、`bundled-ui-check` 4/4，dist / resources / fatJar 全量 SHA-256 一致 |
| **运行 UI 指纹** | `index-hUi9qrsS.js` | 1299 隔离实例启动后，运行页面与磁盘 `web/dist/index.html` 一致 |
| **体积预算** | **入口 JS 176,532 B / 200,000；全部 JS 586,703 B / 640,000；CSS 40,750 B / 48,000** | `node product/tools/verify/bundle-budget-check.mjs`：6/0，含三条反向自测 |
| **随包浏览器验收** | **22/22 通过** | 生产静态包 + mock API，固定 `http://127.0.0.1:1299`；覆盖白名单字段、SHA-256 token、30 秒冷却、本人建议、GitHub 回退、按需拆包与零运行时异常 |

本轮先复现并修掉两类真实问题：一次性构造组合根会新增 8 个 HTTP selector 线程（六类默认客户端改为 lazy 后归零）；构造中途失败会遗留已打开的 SQLite 文件（增加分段 cleanup 后通过）。PWA 刷新保护由命名忙碌源引用计数与单一待刷新状态机承担，阅读页和所有写请求忙碌时延迟刷新，空闲后只刷新一次。

环境限制如实记录：

- 本机标准 Vite 构建在删除 esbuild 临时文件时被 Windows 拒绝（`remove ... Access is denied`），不是 TypeScript 或源码错误；最终包走仓库既有 `build:fallback`。CI 仍保留标准构建，未用 fallback 掩盖 CI 错误。
- 本机 `docker --version` 返回 `docker: command not found`，因此 Dockerfile 已补 `core/` 上下文并通过静态交付契约，**真实镜像构建尚未实跑**。
- Supabase 仍需在项目侧执行 `docs/feedback-supabase.sql` 并配置 `LEGADO_SUPABASE_URL` / `LEGADO_SUPABASE_ANON_KEY`；本轮浏览器验收使用 mock API，不冒充真实 Supabase 连通性验证。

## 14. 2026-11-25 `:core:data` 第一刀

> 采集于 HEAD `42473cf` 之上的未提交工作树；**现行测试与构建数字以本节为准**。本轮未提交、未推送。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **核心数据测试** | **10 项 / 2 suite / 0 失败** | `./gradlew :core:data:test`；`DatabaseEngineTest` 3 项 + `DbSnapshotTest` 7 项 |
| **app 后端测试** | **1,068 项 / 151 suite / 0 失败 / 0 错误 / 0 跳过** | `./gradlew test --no-daemon --max-workers=1`；XML 求和 |
| **后端合计** | **1,078 项 / 153 suite / 0 失败** | `:core:data` 10 + `:app` 1,068；`:core:model` / `:core:ops` 暂无测试源 |
| **前端回归** | **1,143 项 / 147 文件 / 0 失败** | `npm --prefix product/web test`；`SchemaTableCount.test.ts` 已改读 `core/data` 新路径 |
| **前端类型** | **通过** | `npm --prefix product/web run check`，生产 fallback 构建内再次执行 |
| **工具脚本** | **22/22 通过** | `npm --prefix product run test:scripts` |
| **交付契约** | **静态检查 PASS；反向自测 30/30** | `node tools/verify/delivery-check.mjs` 与 `--self-test` |
| **结构与文档门禁** | **全绿** | architecture G1–G8、depth（后端 117 + core:data 4，过深基线 3）、protocol、version、docs:api、changelog、`git diff --check` |
| **生产包** | **276 modules / 40 static 文件** | `LEGADO_WEB_BUILD=fallback LEGADO_SKIP_LIVE_UI_CHECK=1 npm --prefix product run build`；dist 11/11、bundled UI 4/0（live 项按自动构建契约 SKIP） |
| **jar 模块指纹** | **核心类齐、旧类无残留** | zip 清单实测 `DatabaseEngine` / `ConnectionPool` / `Schema` / `DbSnapshot` / `org.sqlite.JDBC` 均在；旧 `data/DbSnapshot` 与 `data/db/{ConnectionPool,Schema}` 均不在 |
| **隔离运行冒烟** | **通过** | 新 fatJar + 临时数据目录 + 随机回环端口；`/healthz` 正常、`user_version=1`、核心表存在、生成 1 份快照、首页引用新 bundle；结束后删临时目录 |
| **体积预算** | **入口 JS 176,532 B / 200,000；全部 JS 586,703 B / 640,000；CSS 40,750 B / 48,000** | `bundle-budget-check` 6/0；UI 主包仍为 `index-hUi9qrsS.js` |

本轮的 seam 是 `DatabaseEngine`：连接池、单写连接、嵌套事务、建表、启动快照、碎片回收和关闭语义留在核心模块；`app` 通过 `initialize { SchemaVersion.migrate(it) }` 注入业务迁移，13 个 DAO 与端口适配不搬。`ArchitectureBoundaryTest` 新增 `core:data` 反向依赖扫描，`depth-check.mjs` 把新模块纳入扫描并删掉两条过期基线。

第一次定向回归因本机 JVM native memory allocation（`mmap` / `malloc`）失败，未产生用例结论；改为 `--max-workers=1`、Gradle 堆 1g 后，定向 60 项、核心 10 项及后续全量均通过。标准 Vite 构建的 Windows esbuild 删除权限限制、Docker CLI 缺失、Supabase 实连待办仍与 §13 相同，本轮没有把静态检查或 mock 验收冒充外部实连。
