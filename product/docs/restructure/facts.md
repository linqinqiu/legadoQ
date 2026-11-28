# 现场事实清单（facts）

> 单一事实源：本文件记录**带时间戳、带命令、带口径**的实测数字。
> 其他文档（`docs/STATUS.md`、`backend-layering.md`、`frontend-host.md`）里的规模数字写于各自 commit，
> 属于历史事实；与本文冲突时以本文为准，并重新跑一遍命令。
>
> 最近采集：**2026-11-28，见 §27**（启动及复用服务前的真实资源检查、30 项脚本测试与真实 jar 隔离验收；历史书源版本与 73 项隔离浏览器见 §26，手动 WebDAV 见 §25，含留档迁移与真实样本见 §24，冲突书源留档见 §23，传输修复见 §22，app 全量测试见 §20，搜索截止/取消受控实验见 §18。未重测的规模、核心模块、数据库与覆盖率数字仍按各历史节日期使用）。
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

## 15. 2026-11-25 前端 `SourceCatalog` 单一数据源

> 采集于 HEAD `42473cf` 之上的未提交工作树；本轮只改前端，没有提交或推送。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **前端源码规模** | **211 个 ts/tsx / 38,045 行** | `product/web/src` 递归统计 `.ts` / `.tsx`（含后续 `updateHint.ts`） |
| **前端测试实跑** | **1,156 项 / 149 文件 / 0 失败** | `npm --prefix product/web test`；含 `SourceCatalog` 6 项并发、缓存、失败与竞态判据，以及 `updateHint` 6 项节流/静默/通知判据 |
| **前端类型** | **通过** | `npm --prefix product/web run check` 与 `run check:test` |
| **生产构建** | **277 modules**；入口 JS **592.26 kB / gzip 176.79 kB**，CSS **241.93 kB / gzip 41.03 kB** | `npm --prefix product/web run build:fallback` |
| **dist 与体积门禁** | **11/11、6/6 通过** | `verify:dist`、`budget` |
| **真实浏览器验收** | **12/12 通过** | Playwright + 5174 新前端；首次清单 1 请求、本地筛选 0 新增、手动刷新 1 新增、跨页复用 0 新增、编辑器可打开、390px 无横向溢出、无未捕获运行时异常 |
| **数据安全** | **未写入真实书源数据** | 本机 `/api/sources` 实测为空；浏览器用只读 route 拦截的两条测试清单，不执行保存、启停、删除、导入或体检 |

`sourceCatalog` 的接口只有 `subscribe/getSnapshot/load/invalidate/replace`：全量请求合流、缓存、强制失效、generation 隔离旧响应和失败保留旧清单都在模块内部。`main.tsx`、`SourcesPage`、`SourceSwitchModal` 共同订阅同一快照；关键词与分组筛选完全在本地，拖拽排序通过 `replace` 先发布乐观清单，写盘失败再强制刷新回滚。书源页新增清单状态、刷新入口、失败重试与筛选空态，保持原有两栏布局和密度。

浏览器验收阻塞了开发态 Service Worker，避免 `/sw.js` 被 Vite 回退成 HTML 的既有 MIME 噪音；控制台仍有一条与本轮无关的 `/api/ui-prefs/reader-settings` 403（直接请求后端为 404），没有把它算成 `SourceCatalog` 的运行结果。

## 16. 2026-11-27 订阅同步后的共享书源清单刷新

> 采集于 HEAD `3c1c7d9` 之上的未提交工作树；本切点只修改前端页面接线，没有提交或推送。此前备份与品牌工作树改动保留原样。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **修复前回归** | **1,168 项 / 1,166 通过 / 2 失败** | `npm.cmd --prefix product/web test`；仅新增的页面通知/缓存刷新两条失败，退出码 1 |
| **修复后前端全量** | **1,168 项 / 0 失败 / 0 跳过** | 同一命令，16,623.9863 ms，退出码 0 |
| **应用与测试类型** | **均通过** | `npm.cmd --prefix product/web run check`、`npm.cmd --prefix product/web run check:test`，退出码均为 0 |
| **新增行为判据** | **2 项** | 真实路由/页面 props 将通知传给内存 `createSourceCatalog`；刷新发布新清单，刷新失败保留旧数据且后续加载可重试 |
| **版本、更新日志与差异格式** | **均通过** | `npm.cmd --prefix product run version:check`、`changelog:check`、`git diff --check`，退出码均为 0；版本 0.3.0 / build 56 未改 |
| **API 文档门禁** | **未通过，既有备份改动未同步文档** | `npm.cmd --prefix product run docs:api-check` 退出码 1；`agent-api.json` 的备份导出说明已含第六域 `sourceSub`，`docs/API-REFERENCE.md` 仍为五域，本切点未改这两个文件 |

修复仅将 `PageContext.refreshSources` 经 `RssPage` 传给 `SourceSubscriptionPanel`，复用宿主既有 `sourceCatalog.invalidate()`。单条与全部同步成功路径原本都调用该回调；原页面传空函数导致通知丢失。没有修改缓存并发语义、API 或导航结构。

本轮未执行浏览器端到端、真实订阅同步、后端测试、生产构建或桌面包验收；页面接线与模块测试不代表这些验证已完成。完整范围与后续建议见 `docs/research/研究-导航职责与订阅缓存一致性-2026-11-27.md` §6.1。

## 17. 2026-11-27 页面流式搜索健康排序与验证收尾

> 采集于分支 `refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本 **0.3.0 / build 56**。本切点新增 WS 排序接线和路由回归；既有备份、品牌与 §16 订阅刷新改动保留，没有提交或推送。以下是本轮实跑，不覆盖以前各节快照。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **搜索定向回归** | **40 项 / 6 suite / 0 失败 / 0 错误 / 0 跳过** | 在 `product` 执行 `./gradlew.bat :app:test --tests io.legado.SearchStreamHealthOrderTest --tests io.legado.SearchHealthOrderTest --tests io.legado.SearchSessionTest --tests io.legado.SearchRoutesTest --tests io.legado.SearchConcurrencyTest --tests io.legado.SearchDeadlineTest --no-daemon --max-workers=1`；`BUILD SUCCESSFUL in 2m 20s`；XML 求和 |
| **首次 app 全量** | **1,076 项 / 6 失败** | `./gradlew.bat :app:test --no-daemon --max-workers=1`；`BUILD FAILED in 6m`；六项均在第三方域名 DNS 安全校验处失败，见下文 |
| **测试夹具修正后定向** | **90 项 / 4 suite / 0 失败 / 0 错误 / 0 跳过** | 同一 Gradle 命令加 `--tests io.legado.ApiRoutesHttpTest --tests io.legado.NetworkSecurityTest --tests io.legado.RuleRunnerTest --tests io.legado.RuleUrlScriptsTest`；`BUILD SUCCESSFUL in 4m 9s` |
| **最终 app 后端全量** | **1,076 项 / 153 suite / 0 失败 / 0 错误 / 0 跳过** | `./gradlew.bat :app:test --no-daemon --max-workers=1`；`BUILD SUCCESSFUL in 6m 31s`；`app/build/test-results/test/TEST-*.xml` 求和；不含 `:core:data:test`，本轮未复跑核心模块测试 |
| **前端全量** | **1,168 项 / 151 文件 / 0 失败 / 0 取消 / 0 跳过** | `npm.cmd --prefix product/web test`；39,357.2817 ms；退出码 0，含 §16 两条订阅刷新回归 |
| **应用与测试类型** | **均通过** | `npm.cmd --prefix product/web run check`、`npm.cmd --prefix product/web run check:test`；退出码均为 0 |
| **版本门禁** | **通过，8 处 0.3.0 / build 56** | `npm.cmd --prefix product run version:check`；没有改版本或构建号 |
| **API 文档** | **通过，147 端点 / 19 组** | `npm.cmd --prefix product run docs:api` 后执行 `docs:api-check`；补同步既有备份第六域 `sourceSub` / `subscription` 描述，没有新增端点 |
| **更新日志与差异格式** | **通过** | `npm.cmd --prefix product run changelog:check`、`git diff --check`；退出码均为 0 |
| **现有能力相关回归** | **48 项全通过，已计入 app 全量，不另加总** | `rules.ScriptConvertTest` 6、`JsScriptConvertBridgeTest` 3、`AccessTokenGateTest` 10、`BackupImportTest` 16、`BackupExportRoundTripTest` 7、`BackupImportAtomicTest` 4、`BackupSnapshotsEndpointTest` 2；XML 读取核对 |

**修复内容与判据：** `SearchRoutes.kt` 的 WS 路径原来将数据库清单直接传入 `SearchSession`，普通 POST 则已有 `orderByHealth`。本轮只让 WS 复用同一排序。`SearchStreamHealthOrderTest` 用临时 SQLite、假 fetcher 和首波 latch 走真实 Ktor WS 路由；五组源每组填满配置的并发名额，首波应全为健康/高权重/低延迟组，解锁后五组全部返回。该新增测试修前首波为未体检组而失败，修后通过；没有过滤失败或未体检源。

**环境与测试独立性：** 本机 PowerShell `System.Net.Dns.GetHostAddresses` 实测 `example.com=198.18.1.99`、`fanqienovel.com=198.18.1.107`、`qyyuapi.com=198.18.1.108`，落在生产安全闸门拒绝的 `198.18/15` 段。未确认由哪个系统组件产生，未修改 DNS、代理或 `NetworkSecurity` 生产策略。四组只测订阅 CRUD、缓存和请求头构造的测试改用公网 IP 字面量，仍不发真实外网请求；保留原 SSRF、非法 URL、中文路径及 Referer 断言。缓存判据名称改为准确的“缓存已验证目标”，不把字面量测试冒充第三方 DNS 集成测试。

**文档修正：** 根 README 仍把 `java.t2s/s2t` 标为零实现，与沙箱绑定和本轮全绿的转换测试矛盾，已改为支持；备份表补明导出域与下次启动快照恢复。`product/docs/compatibility.md` 的“唯一写门、不设身份”改成同源写保护 + 可选非回环访问令牌的当前语义，明确无多用户或只读角色。研究报告区分远端 README、本地 HEAD 与未提交工作树。

**建议核对收尾：** 已实际读取九个生态项目的一手页面及远端 `linqinqiu/legadoQ` README；外部项目未部署、未固定 commit。新增备份冲突、简繁、WebView、漫画/TTS 与 token 核对见研究报告 §3.7–3.8。同步 `docs/STATUS.md` 的本轮测试口径、`docs/ARCHITECTURE.md` 的 WS/POST 截止差异和可选 token 描述、`product/README.md` 的导出/冲突边界；未改变架构或权限。文档收尾后复跑版本/API 文档/更新日志门禁与 `git diff --check`，均通过。

**验证边界：** 没有运行真实书源、真实浏览器、手机往返、WebDAV 服务、生产构建、桌面包或真实局域网令牌配置验收。未改并发数、超时或消息协议；WS 仍无整批总截止，协程取消与阻塞网络请求何时释放仍需独立受控实验。现有排序把未体检源排在有体检记录源之后，本轮未改变该规则。

## 18. 2026-11-27 搜索整批截止、取消与阻塞 HTTP 收尾

> 分支 `refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本 **0.3.0 / build 56**。本节是 §17 之后的搜索生命周期切点；保留既有备份、品牌与订阅刷新改动，未提交、推送或发版。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **搜索定向回归** | **49 项 / 8 suite / 0 失败 / 0 错误 / 0 跳过** | 在 `product/` 执行 `./gradlew.bat :app:test --no-daemon --max-workers=1 --tests io.legado.SearchConcurrencyTest --tests io.legado.SearchSessionTest --tests io.legado.SearchStreamLifecycleTest --tests io.legado.SearchHttpCancellationTest --tests io.legado.SearchStreamHealthOrderTest --tests io.legado.SearchDeadlineTest --tests io.legado.SearchRoutesTest --tests io.legado.SearchHealthOrderTest`；`BUILD SUCCESSFUL in 3m 2s`；XML 求和 |
| **app 后端全量** | **1,085 项 / 155 suite / 0 失败 / 0 错误 / 0 跳过** | `./gradlew.bat :app:test --no-daemon --max-workers=1`；`BUILD SUCCESSFUL in 7m 26s`；`app/build/test-results/test/TEST-*.xml` 求和。不含未复跑的核心模块测试，49 项定向测试已包含在内，不重复加总 |
| **前端全量** | **1,170 项 / 151 文件 / 0 失败 / 0 取消 / 0 跳过** | 后端结束后串行执行 `npm.cmd --prefix product/web test`；38,465.5842 ms；含截止提示、异常收尾刷新、旧 socket 隔离及停止后迟到结果回归 |
| **应用与测试类型** | **均通过，退出码 0** | 前端全量结束后依次执行 `npm.cmd --prefix product/web run check`（`tsc -b`）、`npm.cmd --prefix product/web run check:test` |
| **版本 / API 文档 / 更新日志 / 差异格式** | **通过** | `npm.cmd --prefix product run version:check`、`docs:api-check`、`changelog:check`、`git diff --check`；8 处 0.3.0 / build 56，147 端点 / 19 组 |

**实现与修前证据：**

- WS 复用 `AppConfig.searchTotalTimeoutMs`（默认仍为 60 秒），达到预算后取消子任务并发送 `done.truncated/message`；实际完成计数不冒充全量完成，保留已经回传的结果。源级默认预算仍为 30 秒，并发范围仍为 16–32，没有改成统一 3 秒。
- `SearchSession` 改为固定数量 worker 按排序索引领取任务。修前每源 launch 再竞争 Semaphore，首波实际启动顺序可能偏离健康排序；取消传播期间还需检查会话父级状态，避免启动排队源。真实 Ktor WS + 临时 SQLite + 受控假源回归覆盖首波排序、截止、cancel 帧和无 cancel 断连。
- `RuleIoCancellation` 为同步规则调用设置线程中断与响应体登记/关闭机制，`RuleRunner` 在抓取、重定向和重试前检查取消。受控本机 HTTP 实验表明单独线程中断不足以结束响应体阻塞读取；取消后才抵达的响应流也必须立即关闭。
- 补关闭流后，响应体测试仍曾失败：`outcome=SearchSourceOutcome(results=[], failed=true, timedOut=false)`，说明 IOException 抢先被当作源失败。修复为 worker 使用 supervisorScope，兜底前重新检查调用方协程状态，父级取消继续向上传播；没有弱化取消断言。
- 前端终态保存截止原因，异常断连先刷新末次进度并撤销 timer；新搜索隔离旧连接，停止后不接收迟到结果。空结果且未搜完时不再显示“搜完了”。

**验证边界：** HTTP 测试使用显式允许回环的专用客户端，生产 SSRF、鉴权与网络策略未放宽。测试确认规则调用线程退出和响应体关闭，尚未证明 `PinnedProxy` 上游连接或代理线程立即退出。忽略中断的第三方代码仍可能延迟收尾：WS 在结构化并发收尾后发送 done，预算不是任意代码的硬截止；POST 保留历史独立 scope 收集模型，到预算返回而不等待全部收尾。本轮没有运行真实书源、浏览器端到端、手机往返、WebDAV 服务、生产构建、桌面包或真实局域网令牌验收，也没有重新采集覆盖率比例。

**后续优先级：** 下一功能切点是备份预览与完整包按域导入，先锁住“只预览不写入”、冲突统计和既有进度保新/事务回滚，再独立验收手机格式往返与 WebDAV 传输。研究报告见 `docs/research/研究-Legado生态建议核对与执行顺序-2026-11-27.md`。

## 19. 2026-11-27 备份包只读预览与按模块确认导入

> 分支 `refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本 **0.3.0 / build 56**。本节是 §18 之后的备份切点；保留既有备份导出、品牌、订阅刷新与搜索生命周期改动，没有提交、推送或发版。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **app 后端全量** | **1,094 项 / 157 suite / 0 失败 / 0 错误 / 0 跳过** | 在 `product/` 执行 `./gradlew.bat :app:test --no-daemon --max-workers=1`；`BUILD SUCCESSFUL in 7m 59s`；`app/build/test-results/test/TEST-*.xml` 求和，含新增 8 项预览与 1 项 HTTP 回归。本轮未复跑 `:core:data:test`，`:core:model:test` 为 `NO-SOURCE`，均不加到 app 总数 |
| **最终备份定向回归** | **36 项 / 5 suite / 0 失败 / 0 错误 / 0 跳过** | 全量之后修正未选留档统计与缺时间戳策略说明，再执行 `./gradlew.bat :app:test --tests io.legado.BackupPreviewTest --tests io.legado.BackupPreviewHttpTest --tests io.legado.BackupImportTest --tests io.legado.BackupImportAtomicTest --tests io.legado.BackupExportRoundTripTest --no-daemon --max-workers=1`；`BUILD SUCCESSFUL in 5m 29s`；本次 5 份 XML 求和，不与全量加总 |
| **前端全量** | **1,173 项 / 151 文件 / 0 失败 / 0 取消 / 0 跳过** | 后端结束后执行 `npm.cmd --prefix product/web test`；首跑 1 项 UI 类名契约失败，补齐 `.backup-preview` 及子元素样式后全量复跑通过，56,407.5457 ms。新增 3 项覆盖默认选择、API 预览/确认请求与导入结果提示 |
| **应用与测试类型** | **均通过，退出码 0** | `npm.cmd --prefix product/web run check`（`tsc -b`）、`npm.cmd --prefix product/web run check:test`；类型检查后仅补 CSS，无后续 TypeScript 修改 |
| **版本 / API 文档 / 更新日志 / 差异格式** | **通过** | `npm.cmd --prefix product run docs:api` 生成后执行 `version:check`、`docs:api-check`、`changelog:check`、`git diff --check`；8 处 0.3.0 / build 56，147 端点 / 19 组。复用原导入端点，没有新增端点 |

**实现与判据：**

- `BackupImporter` 为 ZIP 与裸 JSON 共用准备模型；`preview` 只返回包内模块、可解析数量和既有合并策略，不调用提交步骤、不写业务库/凭据/留档。测试使用临时 SQLite、加密凭据与已有留档验证不变，并通过禁止调用提交 hook 防止空断言。上传包只作短期临时文件，路由在 `finally` 清理。
- `POST /api/backup/import?preview=true` 返回预览，原端点确认时 multipart `sections` 接收模块 ID 的 JSON 数组；支持 `sources/rules/groups/shelf/rss/subscriptions/cookies/kept`。省略时兼容旧客户端全量导入；确认时空数组或未知模块拒绝，拼错 `preview` 模式拒绝。真实 Ktor multipart 回归覆盖只读、确认只写选中模块、非法输入、外站 Origin 与旧调用兼容。
- 前端选文件后先预览，确认时复用同一 File 与预览时密码；改密码须重新预览。默认不勾选凭据，无选择时禁止确认，取消清除本次文件引用与选择。测试覆盖面板按钮与默认项、请求参数及结果播报，不等同浏览器完整交互验收。
- 书源订阅的原包扩展字段随 `subscriptions` 选择，不会由 `kept` 顺带恢复；主动没选的已承接留档不再报成“不支持”。仅分组、凭据或个性化留档导入也能播报成功；墓碑、凭据问题和条目错误另作提示。
- 保留既有事务、删除墓碑、已有书本机分组和书源本机启用状态；未选分组时新书不分组。书架元数据仍按包更新；阅读进度按时间比较，**缺少时间戳按本次导入时间处理**，不能笼统宣称任何旧包都不会覆盖本地进度。预览和文档明确披露这一区别。

**验证边界：** 预览数量是包内可解析数，不是数据库新增/更新/跳过预测；未增加可选的跳过/覆盖/保新冲突引擎或提交前数据库变化检查。先准备全包再按选项过滤，未选域的严重格式错误仍可能阻断整包。个性化留档在数据库事务成功后写，库与留档文件不是跨存储原子事务。本轮没有读取日常用户数据，也没有运行真实手机往返、WebDAV 服务、浏览器端到端、生产构建、桌面包、真实局域网令牌或新的覆盖率统计；测试中的同源与网络策略不放宽到生产。

**后续优先级：** 先定义缺失时间戳与书架元数据冲突策略，再用实际手机备份样本做格式往返验收并实现数据库差异预览；之后接手动 WebDAV 列目录/上传/拉取快照。连续双向同步需单独定义离线修改与删除冲突，不按“多一个配置页”处理。

## 20. 2026-11-27 书架/进度独立冲突策略与确认前变化检查

> 分支 `refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本仍为 **0.3.0 / build 56**。本节接续 §19；保留其历史执行结果，不把定向测试与全量结果相加。未提交、推送或发版，未读取日常用户数据库。

| 项 | 数值 | 命令/口径 |
|---|---|---|
| **app 后端最终全量** | **1,105 项 / 158 suite / 0 失败 / 0 错误 / 0 跳过** | 在 `product/` 执行 `./gradlew.bat :app:test --no-daemon --max-workers=1`；`BUILD SUCCESSFUL in 6m 31s`，退出码 0。修正测试断言后固定输入再跑，`app/build/test-results/test/TEST-*.xml` 求和；包含新增冲突策略与事务回滚用例。未复跑 `:core:data:test` 等核心模块独立测试 |
| **前端最终全量** | **1,176 项 / 151 文件 / 0 失败 / 0 取消 / 0 跳过** | 后端结束后执行 `npm.cmd --prefix product/web test`，退出码 0，23,843.8618 ms。新增 3 项覆盖策略变化、确认请求与 409 提示、全部按策略保留结果；没有把静态渲染和请求 mock 当成浏览器验收 |
| **应用与测试类型** | **均通过，退出码 0** | 前端全量结束后依次执行 `npm.cmd --prefix product/web run check`（`tsc -b`）、`npm.cmd --prefix product/web run check:test`；其后仅同步验证记录，没有修改 TypeScript 输入 |
| **版本 / API 文档 / 更新日志 / 差异格式** | **均通过，退出码 0** | `npm.cmd --prefix product run version:check`、`docs:api-check`、`changelog:check` 及 `git diff --check`。8 处版本一致 0.3.0 / build 56；147 端点 / 19 组；更新日志自查 6 条提交、边界 `d4ad7f7`。复用原备份端点，没有新增端点 |

**验证中的失败与修正：** 较早的 7 个备份 suite 定向回归共 48 项通过（8m09s），之后补强测试断言。首次 app 全量 1,105 项中 `BundledChangelogTest` 失败，是运行期间修改更新日志导致源文件与先前处理的资源副本不同；随后固定更新日志并重新处理资源，没有修改构建脚本或放宽判据。下一次编译发现新回滚断言漏导入 `getProgress`，补齐后再跑；再一次全量中 1 项测试把已导入书源的再次导入误认作新增，已改为校验新增与更新合计（该次 6m36s，1,105 项 / 1 失败）。上表最终全量在这些修正之后完成，定向与失败轮次不与最终用例数相加。

**本切点实现：**

- `BackupLibraryPolicy` 分开控制书架元数据与进度。新界面默认 `keep_local + newer`：保留已有名称/作者/目录/封面/完结状态，只采纳有效正时间且严格较新的进度；相等或无时间跳过，包括新书。可显式采用备份信息、不恢复进度或强制采用备份进度；强制模式可回退，无时间记录按导入时刻保存。不把阅读时间当作元数据修改时间。
- `data/LibraryRestoreDao.kt` 供预览和提交共用规划判据。只恢复明确携带的非负章节索引，第 0 章有效；采用进度后清除旧段落锚点/校验值并重置定位版本。所有策略尊重删除墓碑，已有书本机分组保留，新书分组按本次选中模块映射。同键重复记录取包内最后一条并计数；书架最近阅读时间不回退。
- 预览借读连接建立 SQL 快照，结束回滚并恢复连接状态，不借写连接、不执行写步骤、不写凭据或留档。`libraryDiff` 预测新增、按策略更新/保留、墓碑跳过、采用/跳过进度、未知时间和重复数；更新数表示策略选中已有记录，不是逐字段内容差异。其余模块仍只报告包内可解析数量。
- `previewToken` 绑定原文件 SHA-256、策略及相关书架/进度/墓碑完整行；同毫秒字段改动也能检出。确认在同一写事务、所有域写入前重新规划；相关变化返回 `409 backup_preview_changed`，整包不写。不相关书变化不误拒绝；未选择书架时仍校验文件与策略，但不因本机书架变化阻断其他模块。凭证不是鉴权，不替代同源/访问令牌。
- 前端预览可选择策略并显示预测；改策略、密码或确认失败后须重新预览，确认携带同一文件、策略及凭证，操作中禁止修改密码。按策略全部保留也正常报告完成。旧客户端同时省略策略与凭证时维持历史行为；非法策略或只传一个字段返回 400。
- 回归覆盖只读预览、严格时间比较、首章/缺进度字段、未知时间、重复记录、删除、文件/策略/数据库变化、无关修改、模块选域、分组映射、旧客户端和后续步骤失败回滚。测试使用临时 SQLite 与受控 HTTP multipart；没有将 mock 或本仓往返当作手机/浏览器验收。

**验证边界：** 数据库写入共用事务，个性化留档仍在提交后写文件，不是库与文件的跨存储原子事务。完整包先解析再选域，未选模块的严重格式损坏仍可能阻断整包。没有运行真实手机格式往返、WebDAV 服务、浏览器端到端、真实书源、生产构建、桌面包或局域网访问令牌验收，也没有重采覆盖率。本切点只修改 `app` 与 `:core:model` 的备份能力，未改 `:core:data` 引擎或表结构，未复跑其独立测试。

**后续切点：** 手机备份真实样本与浏览器预览/确认流程验收；书源治理继续按候选预览、可解释分类与可恢复动作推进。手动 WebDAV 列目录/上传/拉取快照在格式边界明确后单独实现，连续双向同步不在本次交付范围。

## 21. 2026-11-27 备份预览/确认真实浏览器验收

> 接续 §20，仍为 `refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本 **0.3.0 / build 56**。本切点新增可复跑的隔离浏览器门禁和 npm 入口，未改业务实现、版本号或构建号；未提交、推送、发版或重启日常服务。

| 项 | 结果 | 命令/口径 |
|---|---|---|
| 前端构建 | **备用路径成功** | `npm.cmd --prefix product/web run build:fallback`，退出码 0；Vite 6.3.5，280 modules，26.70s；PWA 24 precache entries。默认 `build` 因 esbuild 临时文件删除报 `Access is denied` 失败；提权及独立临时目录仍复现，未宣称默认构建已修好 |
| dist 完整性 | **11 项通过 / 0 失败** | `node product/tools/verify/dist-check.mjs`；主入口及引用资源存在 |
| 当前 fatJar | **构建成功** | 在 `product/` 执行 `./gradlew.bat :app:fatJar --no-daemon --max-workers=1`；`BUILD SUCCESSFUL in 1m 40s`；没有构建桌面发行包 |
| 实际浏览器流程 | **25 项通过 / 0 失败** | `npm.cmd --prefix product run verify:backup-preview-ui`，真实无头 Chrome。最终脚本又以 `node product/tools/verify/backup-preview-ui-check.mjs` 运行，包含关闭超时和清理检查；不把不同轮次项数相加 |
| 静态资源一致性 | **隔离实例 40 个文件逐一一致** | 新门禁从随机端口抓取每个文件并对 `web/dist` 的 SHA-256；原 `bundled-ui-check` 的 resources 与 fatJar 两项也逐一对齐 40 文件。原门禁还默认探测日常 1234，发现其部分资源 404，因而整体失败；该部署状态与隔离实例结果分开记录，没有隐去失败或重启用户服务 |
| 版本 / API / 更新日志 / 格式 | **通过** | `version:check`：8 处 0.3.0/build56；`docs:api-check`：147 端点/19 组；`changelog:check`：6 条提交/边界 `d4ad7f7`；`git diff --check`；`node --check` 新门禁 |

**真实交互覆盖：** 从主导航进入设置并打开备份浮层，通过实际文件输入上传生成的 ZIP；预览和取消后核对书源/书架/进度/留档均未变化；修改密码或策略会禁用确认，正确密码解出的登录凭据仍不预选。预览后经真实 HTTP 写入相关阅读进度，再从页面确认得到 `409 backup_preview_changed`，各模块未部分写入且必须重预览。重预览后只选书架，确认预测和结果一致，默认保留本机书名并采用明确较新进度；再选择覆盖信息/不恢复进度，确认名称更新而完整进度不变。最后确认所选书源和个性化模块才写入，凭据仍未导入。页面无未捕获脚本错误，截图人工查看了确认与失效状态。

**隔离与复现：** 脚本不接受外部服务地址，忽略 `LEGADO_BASE_URL`；随机回环端口，显式临时 SQLite、数据/home/next 目录和 Chromium profile。结束后关闭浏览器与该子服务，删除经绝对路径检查的 mkdtemp 目录；输出只保留在忽略目录 `product/tools/verify/out/backup-preview-ui/`：`result.json`、`service.log`、`ready-preview.png`、`stale-preview.png`、`completed.png`。结果记录健康信息、请求路径、断言清单与临时目录清理状态。原始 API 门禁不等于浏览器验收，本门禁不使用日常数据夹具。

**边界与下一步：** ZIP 和加密凭据由脚本生成，不是手机真实导出，也未在手机上恢复本产品导出的包。本切点没有新增业务代码，不重跑 §20 已通过的后端 1,105 项/前端 1,176 项全量，未重采覆盖率、未验桌面包、真实书源或 WebDAV。默认 esbuild 构建权限问题及日常实例静态资源 404 保留为可复现环境/部署问题；不能用本次备用构建或临时实例通过替代其验收。后续按真实格式样本和手动快照传输推进，连续双向同步仍需单独协议。

## 22. 2026-11-27 真实手机备份隔离验收与传输修复

> 采集于 2026-11-27 21:35（Asia/Shanghai）前后，分支 `refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本 **0.3.0 / build 56**。用户提供真实手机 ZIP；仅在临时空库与随机回环端口运行，没有导入日常数据库或重启 1234。既有工作树改动保留，未提交、推送、发版或调整构建号。

| 项 | 最终结果 | 命令/口径 |
|---|---|---|
| 后端定向回归与当前 fatJar | **18 项 / 4 suite / 0 失败 / 0 错误 / 0 跳过；构建成功** | 在 `product/` 执行 `./gradlew.bat :app:test --tests io.legado.BackupPreviewTest --tests io.legado.BackupPreviewHttpTest --tests io.legado.BackupExportRoundTripTest --tests io.legado.BundledChangelogTest :app:fatJar --no-daemon --max-workers=1`，`BUILD SUCCESSFUL in 4m 46s`；四份 XML 分别 9/1/7/1 项。未重跑 §20 的 app/前端全量，不与其加总 |
| 真实样本 HTTP 验收 | **34 项通过；两隔离实例均无未处理异常** | `node product/tools/verify/backup-real-sample-check.mjs '<用户提供的备份路径>'`，等价 npm 入口 `npm.cmd --prefix product run verify:backup-real-sample -- '<路径>'`。验证只读预览、确认、重复导入、导出后导入第二空库，再逐一比较六个原生域 |
| 最终产物浏览器验收 | **26 项通过 / 0 页面异常** | `node product/tools/verify/backup-preview-ui-check.mjs`；最终 fatJar，真实无头 Chrome。较 §21 增加约 1.5 MiB 非压缩生成 ZIP 上传和书源版本合并警告判据；隔离实例 40 个静态文件 SHA-256 与 dist 一致 |
| 版本 / API / 更新日志 / 脚本 / 格式 | **通过** | `version:check`：8 处 0.3.0/build56；`docs:api-check`：147 端点/19 组；`changelog:check`：6 条提交/边界 `d4ad7f7`；两个门禁的 `node --check` 与 `git diff --check` |

### 22.1 真实样本结果与边界

原 ZIP **7,160,414 字节**，验收前后 SHA-256 均为 `4ebe8748648cb114d5212e289081dd2cb4194ad04074959ac2aa673fd82740c8`。本记录仅包含数量与校验值，不包含原始私人路径、书名、地址或配置内容。

| 内容 | 结果 |
|---|---|
| 书源 | **7,441 个不同原始 URL → 5,571 个本机 ID，1,870 个版本合并**。现有身份规则移除 URL 的 `#` / `##` 注解，相同本机 ID 采用包内最后一条；预览现已在确认前明确警告。仅验证当前胜出版本的规则 JSON 保留，未改变身份协议，不能称作书源无损迁移 |
| 书架与进度 | **82 本 / 82 条**恢复；导出核对所支持的身份、元数据、进度与分组；同包再次导入不新增书架或书源，同时间进度不覆盖 |
| 净化规则 | **254 条**导入 |
| RSS | 原包 **176 条**，其中 **1 条空地址**明确报错，其余 **175 条**导入，导出 JSON 与有效原条目一致 |
| 分组 | 原包 **12 条**含 Android 内置分组；导入 **5 个正 ID 自定义分组** |
| 个性化留档 | **11 项**逐一下载并与原包字节 SHA-256 对比一致：`dictRule.json`、`highlightRule.json`、`httpTTS.json`、`keyboardAssists.json`、`readConfig.json`、`readRecord.json`、`readRecordDetail.json`、`rssStar.json`、`searchHistory.json`、`themeConfig.json`、`txtTocRule.json`。留档不等于本产品消费或应用了其设置 |
| 不支持条目 | `config.xml`、`runtimesourcecache.json`、`servers.json`、`videoconfig.xml` 按跳过边界报告 |

本机 `domain=all` 当前只导六个原生域：`bookSource.json`、`bookshelf.json`、`bookGroup.json`、`rssSources.json`、`replaceRule.json`、`sourceSub.json`；不包含上述个性化留档、图片或 Android 配置。两空库往返只证明本机支持域一致，**未在手机 App 恢复，不代表完整手机格式往返或全量迁移**。

### 22.2 复现问题、修复与隔离方式

- **大包上传阻塞：** 真实 7 MB 包预览曾两次等待 180 秒超时。线程栈定位到 Netty event loop 内的 `streamProvider()` / `readBounded` 阻塞读取；现迁到 `Dispatchers.IO`，保留 64 MiB 流式上限及 multipart dispose。最终真实包和浏览器大包均完成。
- **导出结束异常：** 最初数据检查虽通过，服务仍在 HTTP 200 后抛 `OutputStreamContent cannot be cast to kotlin.Unit`。用空临时库也能复现；仅在路由末尾追加 `Unit` 的首个尝试仍失败，未计为通过。最终在 `respondZip` 内完成流式响应的挂起收尾，定向测试和 fatJar 通过，再由真实样本门禁检查两服务无未处理异常；不能只凭 ZIP 可下载判定成功。
- **身份冲突可见性：** `BackupImporter.preview` 增加归一化合并数量和最后版本胜出警告；新增 3→2 的只读预览回归。当前只暴露已有行为，没有自动改写书源 ID、批量删除或尝试执行私人书源。
- **可复跑与隐私：** 样本门禁使用两个随机回环端口，显式独立 SQLite/data/home/next/cwd/JVM 临时目录；浏览器另建临时 profile。结果分别在忽略目录 `product/tools/verify/out/backup-real-sample/result.json` 与 `product/tools/verify/out/backup-preview-ui/`。真实样本只输出数量、哈希和安全异常帧，不保存原始服务日志；两门禁均记录临时目录已删除，子服务已关闭，原 ZIP 未变化。

**后续切点：** 先用冲突版本和书架关联定义可恢复的版本保留/迁移策略，再推进手动 WebDAV 快照传输。未运行 WebDAV、真实书源执行、手机 App 恢复或桌面发行包验收，未重采覆盖率。日常实例资源 404 和默认 esbuild 临时文件删除权限问题仍保留为独立待办。

## 23. 2026-11-27 冲突书源版本与原始书架引用留档

> 接续 §22，仍为 `refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本 **0.3.0 / build 56**。本切点保留原始恢复证据，不改可执行书源身份协议、数据库结构或前端生产代码；没有提交、推送、发版、导入日常数据库或重启日常 1234 服务。

| 项 | 最终结果 | 命令/口径 |
|---|---|---|
| 后端定向回归与 fatJar | **58 项 / 8 suite / 0 失败 / 0 错误 / 0 跳过；构建成功** | 在 `product/` 执行 `./gradlew.bat :app:test --tests io.legado.BackupSourceArchiveTest --tests io.legado.BackupPreviewTest --tests io.legado.BackupPreviewHttpTest --tests io.legado.BackupImportAtomicTest --tests io.legado.BackupImportTest --tests io.legado.BackupExportRoundTripTest --tests io.legado.SourceCodecTest --tests io.legado.BundledChangelogTest :app:fatJar --no-daemon --max-workers=1`；`BUILD SUCCESSFUL in 4m 56s`。八份 XML 分别 10/9/2/5/16/7/8/1 项；未重跑 §20 全量，不与历史轮次加总 |
| 真实样本隔离 HTTP 验收 | **43 项通过；两服务无未处理异常** | `node product/tools/verify/backup-real-sample-check.mjs '<用户提供的备份路径>'`；原有六原生域往返之外，核对留档内容、顺序、冲突索引、哈希和重复导入复用 |
| 最终产物浏览器验收 | **29 项通过 / 0 页面异常** | `node product/tools/verify/backup-preview-ui-check.mjs`；40 个静态文件 SHA-256 与现有 dist 一致。页面真实下载链接可取回留档 JSON；截图已人工查看，留档仅下载、没有套用入口 |
| 最终产物 | **39,038,837 字节** | `product/app/build/libs/legado-0.3.0-all.jar`，修改时间 `2026-11-27 22:09:55`（Asia/Shanghai）；更新日志已随本次构建打入资源 |
| 文档收尾门禁 | **均通过，退出码 0** | 两个验收脚本 `node --check`；`npm.cmd --prefix product run version:check`（8 处 0.3.0/build56）、`docs:api-check`（147 端点/19 组）、`changelog:check`（6 条提交/边界 `d4ad7f7`）及 `git diff --check`。仅更新状态文档后未重复构建或测试 |

### 23.1 行为与失败边界

- **保持身份兼容：** 可执行书源仍去除 URL 的 `#` / `##` 注解，同 ID 取包内最后一条。不全局修改书源 ID，也不自动改写书架、进度、登录态或缓存关联。
- **冲突强制留档：** 选择书源且存在归一化冲突时，生成 `source-variants-<内容SHA256>.json`，格式 `legadoq-source-variants-v1`。保存输入文件 `backupSha256`、全部原始 `bookSource` 与 `bookshelf` 对象及顺序，以及冲突分组的归一化 ID、零基索引和胜出索引；未选择书架仍保留包内原始书架引用。保留旧格式、扩展字段和 JSON 值，不承诺原始空白或字节一致。
- **只读预览与独立下载：** 预览不生成留档，提前告知合并数量、书架关联歧义和失败回滚。留档不受「个性化条目」勾选影响，复用现有 `/api/backup/kept` 列表与下载接口，`appliable=false`；内容可能含私密请求头或凭据，需按原备份同样保管。
- **失败不部分导入：** 留档在数据库事务内部、最终 SQLite COMMIT 之前写入。缺少存储目录、写入失败或已有文件校验失败均抛 `BackupArchiveException`，回滚全部数据库域，HTTP 返回 `500 backup_archive_failed`，不泄露本机路径。相同输入复用同一内容寻址文件，不同备份分别留存，损坏文件不覆盖。
- **不是跨存储原子事务：** 留档成功而最终 SQLite COMMIT 失败时，可能留下恢复证据，其存在不表示导入成功；不自动删除以免影响并发或历史证据。普通个性化文件仍在数据库提交后保存。
- **导出边界：** `domain=all` 仍仅含六个原生域，不含生成留档、个性化文件、图片或 Android 配置。留档需单独下载，原 ZIP 仍应保留；不宣称完整手机迁移或自动激活全部书源版本。

### 23.2 样本结果与验证范围

真实样本 **7,441 个原始书源 → 5,571 个可执行 ID**，共 **1,126 个冲突组 / 1,870 个合并版本**；此次留档保存全部 **7,441 个原始书源 + 82 个原始书架对象**。留档 **36,362,496 字节（约 34.7 MiB）**，SHA-256 为 `71425fd4fe0cd2d51f68627ee250e0fcd08035d48a1f1cdbc6cb751f9703716c`。82 本书及进度、254 条净化规则、175 条有效 RSS、5 个自定义分组和 11 个个性化文件仍按 §22 判据通过；六原生域导入第二空库后再次导出一致。原包 SHA-256 验收前后仍为 `4ebe8748648cb114d5212e289081dd2cb4194ad04074959ac2aa673fd82740c8`。

新增单元与 HTTP 回归覆盖 JSON/ZIP 的原始字段、顺序及引用、旧字段 `tag`、身份不变、重复复用、不同输入、无冲突/未选书源、不配置留档目录、目录阻塞、已有证据损坏、较早数据库失败及预览失效不写入。浏览器门禁一轮曾误用 Playwright 的 `getByRole`，与 Puppeteer 不兼容；已改为 `waitForFunction` / `evaluate`，上表为修正后完整通过结果，未放宽产品判据。

两门禁使用随机回环端口、空临时库与独立目录；均确认子服务关闭、临时目录删除、输入不变。报告仅含计数、哈希和安全判据，不记录私人书名、地址或配置。当前没有前端生产代码变动，未重跑前端全量、类型检查或构建；复用了 §21 的备用构建 dist，并以哈希核对。本轮未运行 WebDAV、私人书源规则、手机 App 恢复、桌面发行包或新覆盖率采集。

**后续切点：** 原始版本及书架引用的恢复证据已可留存下载；版本选择/激活、书架重新关联和手机完整迁移仍需独立协议及验收。手动 WebDAV 快照传输后续单独实现，不能把六域导出当作完整备份。日常实例资源 404 与默认 esbuild 临时文件权限问题仍待处理。

## 24. 2026-11-27 含留档的显式迁移包

> 接续 §23，`refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本 **0.3.0 / build 56**。最终后端回归和 fatJar 于 23:24（Asia/Shanghai）前完成。没有导入日常库、重启 1234、提交、推送、发版或更改构建号。

| 项 | 结果 | 命令/口径 |
|---|---|---|
| 后端定向回归与 fatJar | **68 项 / 9 suite / 0 失败 / 0 错误 / 0 跳过；构建成功** | 在 `product/` 执行 `./gradlew.bat :app:test --tests io.legado.BackupMigrationTest --tests io.legado.BackupSourceArchiveTest --tests io.legado.BackupPreviewTest --tests io.legado.BackupPreviewHttpTest --tests io.legado.BackupImportAtomicTest --tests io.legado.BackupImportTest --tests io.legado.BackupExportRoundTripTest --tests io.legado.SourceCodecTest --tests io.legado.BundledChangelogTest :app:fatJar --no-daemon --max-workers=1`；`BUILD SUCCESSFUL in 3m 43s`（内存修正后最终轮）。九份 XML 分别 9/10/9/3/5/16/7/8/1 项。未重跑 §20 app 全量，不与历史轮次加总 |
| 前端全量与类型检查 | **1,177 项 / 151 文件 / 0 失败；两项类型检查通过** | `npm.cmd --prefix product/web test`；`npm.cmd --prefix product/web run check` 和 `run check:test`。新增独立迁移入口及边界文案回归 |
| 前端构建与 dist 完整性 | **备用构建成功；11 项完整性检查通过** | 默认 `build` 仍因 esbuild 删除临时文件报 `Access is denied` 失败；`npm.cmd --prefix product/web run build:fallback` 成功，Vite 280 modules、1m 9s、PWA 24 entries；`node product/tools/verify/dist-check.mjs` 通过。不宣称默认构建权限问题已解决 |
| 当前 fatJar | **39,070,746 字节** | `product/app/build/libs/legado-0.3.0-all.jar`，修改时间 `2026-11-27 23:21:44`（Asia/Shanghai）；本轮 UI 和更新日志已打入，未构建桌面发行包 |
| 真实样本最终隔离验收 | **81 项通过；三服务无未处理异常** | `node product/tools/verify/backup-real-sample-check.mjs '<用户提供的备份路径>'`；结果时间 `2026-11-27 23:28:06`（Asia/Shanghai）。三个空临时库完成原包导入、六域往返、含留档迁移及重复迁移；原包未改，临时目录已清理 |
| 最终产物浏览器验收 | **32 项通过 / 0 页面异常** | `node product/tools/verify/backup-preview-ui-check.mjs`；结果时间 `2026-11-27 23:29:01`（Asia/Shanghai）。40 个静态文件 SHA-256 与 dist 一致；真实页面迁移按钮返回正确文件名和实际 ZIP 字节；截图已人工查看，临时目录已清理 |
| 契约与版本门禁 | **版本、API 文档、更新日志检查均通过** | `npm.cmd --prefix product run version:check`：8 处版本均为 0.3.0、build 56；`docs:api-check`：147 端点 / 19 组；`changelog:check`：6 条提交、边界 `d4ad7f7`。未修改版本或构建号 |

### 24.1 格式与恢复边界

- 独立按钮「导出含留档的迁移包」调用 `GET /api/backup/export?domain=recovery`；默认 `all` 仍只有六个原生域。新包根目录有六域 JSON 和 `legadoq-migration.json`，个性化文件和内容寻址源证据位于 `kept/<原名>`。格式 `legadoq-migration-v1`，清单逐一记录名称、实际字节数和 SHA-256。
- 预览/确认在解析原生域和任何写入前，检查路径、缺项、重复/大小写别名、清单、实际大小、留档哈希和源证据冲突索引。清单最多 1 MiB，留档最多 1,024 项，每项最多 64 MiB、总展开最多 256 MiB；导出完整暂存并检查压缩包不超过 64 MiB，再发送成功响应。非法格式返回 `400 invalid_backup`，导出失败返回不含服务端路径的 `500 backup_export_failed`。
- 根 `sourceSub.json` 是当前原生订阅，`kept/sourceSub.json` 是历史原文，两者不按 basename 混读，ZIP 顺序不影响结果。普通六域导入仍会按既有语义留存本次原生 `sourceSub.json`，这不表示携带了历史留档。
- 按模块确认，证据不会自动激活为可执行源，也不会自动套用设置或重关联书架。证据写入失败回滚数据库；普通文件仍提交后保存，不承诺跨存储原子性。不是 Android 原包、完整 SQLite 或同一时刻的全域一致快照；不含封面、本地书、缓存及独立登录态。哈希只检损坏，不认证来源。
- 读取留档的原始字节合计最多 256 MiB，字符串和证据解析对象还会增加峰值内存；不把输入字节上限等同于进程内存上限。

### 24.2 本轮发现与修正

HTTP 回归发现临时 ZIP 在响应流开始前被外层清理，导致 HTTP 200 但响应为空；现将清理放在响应流结束后，并在失败/取消路径清理。测试要求实际收到 ZIP 字节，不能只断言状态码。新 HTTP 测试的确认请求起初只带预览凭证，因缺少配套策略按约定返回 400；补齐请求后 68 项全部通过，没有放宽接口校验。

导出关闭 ZIP 时释放压缩器但保留调用方输出流。另补齐畸形 UTF-8、缺字段、超大清单、大小写别名与路径碰撞的拒绝判据。新增迁移单测包含空库往返、留档按模块、重复复用、源证据失败回滚，以及历史 `sourceSub` 排在 ZIP 首项仍不污染原生订阅。

真实样本首次新增断言错误地要求普通六域恢复没有留档；既有导入器本就会留存本次原生 `sourceSub.json`，现改为验证只有该文件且与本次导出逐字节一致，没有改变产品行为。随后真实迁移在 768 MiB 堆上触发 `OutOfMemoryError`，安全栈定位到源证据校验把整份约 35 MiB 留档重新序列化并解析；现改为仅重算紧凑冲突索引和合并数量，仍核对内容哈希。该失败不能计为迁移验收通过；最终结果单独记录如下。

### 24.3 真实样本迁移结果与后续边界

内存修正后，在相同 **768 MiB** 堆限制下最终 **81 项通过**。迁移包 **11,052,869 字节**，SHA-256 为 `ea36bff5d9b62c32550ba405a2723efbfcc4f6bd28479bcbbc3de26afea9b059`，包含六原生域及 **12 项留档**（11 项个性化文件、1 项原始书源与书架引用证据）。迁移到第三个空库后，12 项留档的实际字节哈希全部一致，六原生域与迁移前一致，重复迁移复用既有证据，没有额外激活历史书源。

原包 **7,160,414 字节**，验收前后 SHA-256 仍为 `4ebe8748648cb114d5212e289081dd2cb4194ad04074959ac2aa673fd82740c8`。三次隔离服务均无未处理异常，临时数据目录已清理。记录仅含数量和校验值，不含私人书名、地址、配置内容或原始路径；未导入日常库或重启 1234。可复跑脚本及其本地结果位于 `product/tools/verify/backup-real-sample-check.mjs`、`out/backup-real-sample/result.json` 和 `backup-preview-ui-check.mjs`、`out/backup-preview-ui/result.json`。

**后续切点：** 本轮完成可携带留档的显式迁移，不等于所有原始书源版本都可执行，也不等于手机完整备份恢复。版本选择/激活、书架重新关联、手机 App 恢复及手动 WebDAV 快照传输继续独立推进；连续双向同步另需冲突协议。未重跑后端全量、核心模块独立测试、覆盖率、桌面发行包或真实书源执行。默认 esbuild 权限问题与日常实例静态资源 404 仍是独立待办。

## 25. 2026-11-28 手动 WebDAV 迁移与回读校验

> 接续 §24，`refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本 **0.3.0 / build 56**。本切点增加手动远端传输；没有导入日常数据库、重启日常 1234、提交、推送、发版或修改构建号。真实样本的 **81 项**仍为 §24 的历史验收，本轮没有重跑，不与新测试相加。

### 25.1 实现与约束

- 新增同源 POST `/api/backup/webdav/list`、`upload`、`pull`；当前契约 **150 端点 / 19 组**。目录预先创建，PROPFIND 使用 Depth 1，只列本产品带时间、随机 ID 和 SHA-256 的直接子文件；远端 href 不直接成为请求目标。
- 上传由服务端生成六原生域及留档迁移包，使用唯一文件名与 `If-None-Match:*`；PUT 成功还须 GET 回读实际字节并核对大小、SHA-256，之后才返回 `verified=true`。失败可能已经留下远端文件，不自动删除或覆盖。
- 拉取先验证大小上限与文件名中的 SHA-256，然后在页面调用真实只读预览；必须继续选择模块、冲突策略并确认才恢复。远端列表变化不触发导入；预览失败不显示拉取成功。
- 生产只允许公网 HTTPS，复用既有 guarded/pinned 网络客户端，不跟随重定向、不放宽私网访问。账号密码仅存页面内存并用于当次请求，不写配置、浏览器持久存储或日志。迁移包可能包含私密留档，哈希只检损坏、不认证来源。
- 单 ZIP 最多 64 MiB；目录响应最多 2 MiB / 2,000 条 response。XML 禁用 DTD、外部实体与外部 schema；拒绝 URL 内嵌凭据、查询、片段、父级路径与编码路径分隔符。请求头等待和响应体读取分别设置截止；响应头已到后由定时关闭流限制正文停滞，不能仅依赖 `HttpRequest.timeout`。
- 页面传输期间禁用冲突操作；修改连接信息立即清空旧列表；清空操作同时清除凭据。未知文件大小可能被 JSON 的 `explicitNulls=false` 省略，前端同时处理缺字段和 null，显示「大小未知」。

### 25.2 后端验证口径

在 `product/` 执行以下定向回归，**102 项 / 15 suite / 0 失败 / 0 错误 / 0 跳过**，`BUILD SUCCESSFUL in 4m 54s`。数量为这 15 份 XML 的 tests/failures/errors/skipped 求和，未重跑 §20 app 全量、核心模块独立测试或覆盖率，不与历史轮次加总。

```powershell
.\gradlew.bat :app:test --tests io.legado.BackupWebDavTest --tests io.legado.BackupWebDavHttpTest --tests io.legado.BackupMigrationTest --tests io.legado.BackupSourceArchiveTest --tests io.legado.BackupPreviewTest --tests io.legado.BackupPreviewHttpTest --tests io.legado.BackupImportAtomicTest --tests io.legado.BackupImportTest --tests io.legado.BackupExportRoundTripTest --tests io.legado.SourceCodecTest --tests io.legado.BundledChangelogTest --tests io.legado.NetworkSecurityTest --tests io.legado.PinnedProxyTest --tests io.legado.ArchitectureBoundaryTest --tests io.legado.RouteMountTest --no-daemon --max-workers=1
```

其中 WebDAV 10 项覆盖真实受控 HTTP PUT/GET/PROPFIND、唯一名、不覆盖、哈希与流式大小限制、认证失败、重定向、恶意列表/XML/路径、正文停滞截止，以及路由实际 ZIP 字节、只读预览、同源与错误隐私。测试客户端显式允许自建回环模拟服务，生产策略没有相同开口；这不是公网供应商账号验收。

### 25.3 浏览器问题修正与验收边界

| 项 | 最终结果 | 命令/口径 |
|---|---|---|
| 前端全量 | **1,181 项 / 152 文件 / 0 失败、取消或跳过** | `npm.cmd --prefix product/web test`；23,687.9928 ms；退出码 0 |
| 应用与测试类型 | **两项通过** | `npm.cmd --prefix product/web run check`、`run check:test`；最终 UI 和可选字段修正后执行 |
| 前端备用构建 / dist | **构建成功 / 11 项通过** | `npm.cmd --prefix product/web run build:fallback`：281 modules，1m 3s，PWA 24 entries；`node product/tools/verify/dist-check.mjs`。默认 esbuild 权限问题不因备用路径通过而视作已修 |
| 最终 fatJar | **构建成功，39,140,371 字节** | 在 `product/` 执行 `./gradlew.bat :app:fatJar --no-daemon --max-workers=1`，1m 54s；`app/build/libs/legado-0.3.0-all.jar`，修改时间 `2026-11-28 00:40:14`（Asia/Shanghai），SHA-256 `70a52a8ecb7908cbabf0e848d5840a8026bc3b8b1a443ff48f9525e6db446991` |
| 最终产物浏览器 | **46 项通过 / 0 页面异常** | `node product/tools/verify/backup-preview-ui-check.mjs`；完成于 `2026-11-28 00:43:18`（Asia/Shanghai）。隔离实例 40 个静态文件 SHA-256 对齐；390px 下各层 scrollWidth 与 clientWidth 一致，面板和桌面截图已人工查看；临时服务退出、目录已清理；`generatedFixture=true`、`webDavUiResponsesMocked=true` |
| 版本 / 契约 / 更新日志 / 格式 | **通过** | `version:check`：8 处 0.3.0/build56；`docs:api-check`：150 端点/19 组；`changelog:check`：6 条提交，边界 `d4ad7f7`；门禁脚本 `node --check` 与 `git diff --check` |

门禁使用 Puppeteer，滚动后等待两次 animation frame，并验证按钮中心命中目标再原生点击，避免重排期间点错元素。最初 44 项通过后人工截图仍发现 390px 面板越界，因此该结果不作为最终通过。补充对备份页、弹窗及面板实际边界和 scrollWidth 的检查后，失败检查暴露了 grid 自动最小宽度及「待导入」长文件名的溢出；现使用可收缩列、局部 min-width 和提示文字断行修正，没有用隐藏溢出来掩盖内容。

浏览器中的 WebDAV 三接口使用合成响应；拉取后的 ZIP 则交给真实后端预览。网络协议和校验由上面的受控 HTTP 测试独立覆盖，浏览器通过不代表真实 WebDAV 账号已验。默认 esbuild 临时文件权限与日常实例资源 404 仍为独立待办；未验 NAS 私网、手机 App 恢复、真实书源、桌面发行包或连续双向同步。后续优先推进书源版本选择/激活与书架重新关联协议，保留当前默认身份和恢复证据；NAS 如要支持，须在网络守卫和 pinned proxy 两处设计限定 host/port 的能力，不能简单关闭 SSRF 检查。

## 26. 2026-11-28 历史书源版本启用与显式别名关联

> 接续 §25，`refactor/rebuild`、HEAD `3c1c7d9` 之上的未提交工作树，版本仍为 **0.3.0 / build 56**。本切点只处理原始冲突版本的查询、预览与启用；没有读取私人备份、导入日常数据库、重启日常 1234、提交、推送、发版或修改构建号。§24 真实样本与 §20 后端全量沿用原日期，不计入本轮结果。

### 26.1 实现边界

- 新增同源 POST `/api/backup/source-versions/list`、`preview`、`activate`，当前契约 **153 端点 / 19 组**，备份组 12 条。只接受内容寻址的版本留档名，拒绝目录/符号链接/损坏哈希或索引；严格 UTF-8、单留档最多 64 MiB。列表按 ID/名称筛选，每页 20 组，不直接返回规则或凭据。
- 查询与预览只读，不生成快照。确认重新校验留档，并重算绑定规则、选择与相关本机记录的令牌；变化返回 409，不凭前端旧预览继续写入。缓存正文只绑定键、时间和长度，不将全部正文载入指纹；相同长度/时间的正文替换不保证检出，正文也不会被覆盖。
- 执行身份仍是标准化 URL。启用历史规则会全局替换同 ID 的规则，影响全部关联书籍，不提供同 ID 多版本同时执行。保留本机启停、排序、正文/净化/目录缓存，以及该 ID 的登录/脚本状态；旧缓存可能继续旧结果，不自动联网重抓。清除旧体检结论和健康标签，需重新体检。
- 别名关联默认不选；只有留档中的真实原始别名、同一规范 ID、精确 bookUrl 且本机仍存在的书籍可以成为候选。显式选择后 UPDATE 原归属，保全书架/进度/笔记/日志/缓存/墓碑；目标任何相关行或墓碑冲突均拒绝，不使用会删除关联数据的换源路径。别名整源登录/脚本不迁移；规则仍可能内嵌凭据，只启用可信版本。
- 目录只按精确 bookUrl/tocUrl 复制并保留别名副本；同别名共享目录只复制一次，不同别名争用相同目标键在快照前拒绝。后台缓存目录请求虽尚未标记 caching、或已取消但 worker 未退出，均保持源级互斥；启用期间也不接收新的缓存任务。
- 单写锁内先强制生成、校验完整数据库快照，再在同一事务更新规则和全部所选书籍；快照失败不写，中途 SQL 失败整笔回滚。此次启用不修剪旧快照。成功后返回恢复点：须在启动快照区排定并重启，属于整库回滚，后续其他改动也会回退。原始版本留档字节不变。

### 26.2 已完成的编译、回归与构建

| 项 | 本轮结果 | 命令/口径 |
|---|---|---|
| 前端全量 | **1,188 项 / 153 文件 / 0 失败、取消或跳过** | `npm.cmd --prefix product/web test`，112,567.9037 ms；新增版本入口、SSR 状态、别名默认不选及三个 API 的 6 项回归 |
| 应用与测试类型 | **两项通过** | `npm.cmd --prefix product/web run check`、`run check:test`，最终退出码 0 |
| 后端定向回归 | **91 项 / 11 suite / 0 失败、错误或跳过** | 下列单 worker 命令，`BUILD SUCCESSFUL in 9m 6s`；11 份指定 XML 求和，不与旧轮或 app 全量相加 |
| 前端备用构建 / dist | **构建成功 / 11 项通过** | `npm.cmd --prefix product/web run build:fallback`：282 modules、Vite 1m 36s、PWA 24 entries；`node product/tools/verify/dist-check.mjs`。未修默认 esbuild 权限问题 |
| 版本 / 契约 / 更新日志 / 脚本 | **通过** | `version:check`：8 处 0.3.0/build56；`docs:api-check`：153/19；`changelog:check`：6 条提交、边界 `d4ad7f7`；浏览器脚本 `node --check` |

```powershell
.\gradlew.bat :app:test --tests io.legado.BackupSourceVersionsTest --tests io.legado.BackupSourceVersionsHttpTest --tests io.legado.BackupSourceArchiveTest --tests io.legado.BackupMigrationTest --tests io.legado.BackupPreviewTest --tests io.legado.BackupPreviewHttpTest --tests io.legado.BackupConflictTest --tests io.legado.BackupWebDavTest --tests io.legado.BackupWebDavHttpTest --tests io.legado.BookCacheServiceTest --tests io.legado.ArchitectureBoundaryTest --no-daemon --max-workers=1
```

版本服务 14 项、HTTP 5 项覆盖只读预览、规则/启停/缓存/凭据边界、逐列关联保全、关闭重开后真实整库恢复、令牌失效/重放、目标孤儿记录/墓碑冲突、目录共享、缓存任务尚未开始写入及取消未退出、中途 SQL 失败、快照目录阻塞、损坏证据和错误隐私。其余为原始留档 10、迁移 9、预览 9、预览 HTTP 3、冲突 9、WebDAV 8、WebDAV HTTP 2、缓存服务 14、架构边界 8 项。

首轮默认多 fork 测试 JVM 因原生内存分配失败中断，`BUILD FAILED in 11m 25s`，不能计为功能通过。编译成功后按上述 `--max-workers=1` 重跑，最终全部通过；未修改全局测试并发设置。最初契约文档门禁另发现三处旧计数，已更正当前文档并保留历史轮次原口径。

### 26.3 最终产物与浏览器验收

| 项 | 最终结果 | 命令/口径 |
|---|---|---|
| fatJar | **构建成功，39,251,493 字节** | 在 `product/` 执行 `./gradlew.bat :app:fatJar --no-daemon --max-workers=1`，`BUILD SUCCESSFUL in 3m 22s`；`app/build/libs/legado-0.3.0-all.jar`，修改时间 `2026-11-28 01:51:03`（Asia/Shanghai），SHA-256 `67058aaddbcda4fa135581f649b4bfb502dd0f6f290dc69977780ed6a53d9a02` |
| 最终产物隔离浏览器 | **73 项通过 / 0 页面异常** | `node product/tools/verify/backup-preview-ui-check.mjs`；本轮构建的 jar 启动临时空库、随机回环端口和独立 Chromium profile，40 个静态文件 SHA-256 与本次 dist 一致；结果记录 `tools/verify/out/backup-preview-ui/result.json`，`success=true`、`temporaryDirectoryRemoved=true` |
| 新增版本页面验收 | **真实页面、真实后端通过** | 列表→选择旧版→只读预览→确认启用；核对完整规则 JSON、规则版本递增、标准化 ID/启停/排序/书架/进度保留、完整快照 verified、留档字节不变、旧令牌重放 409 且不新增快照 |
| 窄屏与人工视觉核对 | **390px 无横向溢出，确认按钮未遮挡** | 检查版本面板/备份页/弹窗各层实际几何与 scrollWidth；滚动确认按钮至可视区并验证中心命中。已查看桌面预览/成功、窄屏顶部/确认区四类截图；长元素截图会混入弹窗外背景，因此改用实际可视窗口截图并重跑完整门禁 |

最终浏览器使用合成冲突版本、书架与进度，版本三个接口均请求真实后端；WebDAV 远端三接口仍为页面模拟响应，拉取 ZIP 交给真实后端预览。书籍别名逐列关联与关闭重开后整库恢复由上述服务测试覆盖，浏览器没有假称完成真实手机备份或供应商账号验收。初轮浏览器 72 项通过后补充窄屏按钮可达检查，最终轮 **73 项**独立通过，不与前轮相加。

没有读取或改动私人备份、日常库和日常 1234；没有执行历史版本里的真实书源脚本、手机 App 恢复、NAS 私网、桌面发行包、核心模块独立测试或 app 全量，也未重新采集覆盖率。默认 esbuild 权限与日常实例静态资源 404 仍未解决。下一切点优先处理构建/启动产物一致性，再独立推进真实源与 WebDAV 供应商验收，不把合成测试当作真实生态兼容结论。

## 27. 2026-11-28 上游交付参考与启动资源验收

基线 HEAD `3c1c7d9`，工作树保留既有搜索、备份、WebDAV、版本启用及品牌改动。研究报告：[`研究-上游资源交付与启动一致性-2026-11-28.md`](../../../docs/research/研究-上游资源交付与启动一致性-2026-11-28.md)。本轮只修改启动器与校验脚本，不重建 jar、不改后端或前端业务。

### 27.1 根因、上游证据与实现边界

- 只读调用 `node product/tools/verify/bundled-ui-check.mjs`：dist、processResources、fatJar 的 **40 个静态文件一致**；日常 1234 首页主 bundle 为 `index-BqCTvNc9.js`，但 **10 个 JS/CSS 返回 404**，另有 `brand-icon.png:timeout`。本轮没有停止或重启该服务，不能宣称现场已恢复。
- `StaticWeb.kt` 已记录运行中 jar 被覆盖时的 JDK 入口表与 Ktor 读取链路分裂。首页 bundle 名相同不足以证明资源可读。修复前新服务分支仅检查主 bundle 名，复用分支没有资源内容检查，网络失败还能继续打开浏览器。
- `kukume/legado-web@186cb64a63582a58e8d19547ea148608ea970b90` 的 Dockerfile、compose、Gradle 与静态路由支持“同次前端/jar 打包、运行镜像仅复制成品、单独挂载数据”的参考；未证明上游有启动 SHA-256 校验或构建前停旧服务。固定 URL、取证目录与未获取的 CI 文件见研究报告。旧本地参考目录不存在，没有沿用历史 SHA。
- 新增 `scripts/live-ui.mjs`，启动及复用前按**实际选中 jar** 检查首页和静态资源 SHA-256；四路有界并发、15 秒总时限包含响应体读取。缺失、内容不符、重定向和超时均失败。品牌 manifest 由服务端动态生成，只验证成功响应与基本 JSON 结构；其余资源仍逐字节核验。
- 首页先检；重定向采用 `redirect: 'manual'` 获取实际状态，确保门禁不会把首页 302 当作未运行而跳过。交付门禁保持首次不可达时 SKIP 的原语义；启动器对不可达返回失败。没有 dist 的安装包及显式回滚按选中 jar 校验。

### 27.2 验收命令与口径

| 项 | 最终结果 | 命令/口径 |
|---|---|---|
| 脚本全量 | **30 项通过 / 0 失败、取消或跳过** | `npm.cmd --prefix product run test:scripts`；4,513.3021 ms。含资源缺失、CSS/SW 内容变化、HTML fallback、资源与首页重定向、响应体挂起、不可达及动态 manifest 的 8 项新增回归；早一轮为 29 项，不相加 |
| 真实 jar 隔离验收 | **40 个资源、动态品牌、真实启动器复用通过** | `node product/tools/verify/start-ui-check.mjs`；复制 §26 的现有 jar 至 `os.tmpdir()/legado-start-ui-*`，临时空库、随机回环端口；实际执行 `start.mjs --no-build --no-open --port N`，资源检查后退出 0；结束后停止测试子进程并校验范围清理临时目录 |
| 版本 / API / 更新日志 / 交付契约 | **通过** | `npm.cmd --prefix product run version:check`、`docs:api-check`、`changelog:check`、`node product/tools/verify/delivery-check.mjs`；版本 0.3.0/build56、API 153 端点/19 组 |
| 语法 / diff | **通过** | 修改的启动及校验脚本 `node --check`；`git -c safe.directory=E:/legado diff --check` |

真实隔离验收覆盖 HTTP 检查及启动器的**复用分支**；没有声称跑过启动器全新拉起进程的端到端验收。Windows 查询进程信息不足时仍沿用现有 `unknown` 拒绝复用分支，本轮没有放宽这一判断。

本轮没有重跑 Kotlin/React 全量或重新采集覆盖率。日常 1234 的资源 404、默认 Vite/esbuild 临时文件权限问题仍未解决；新检查能报告失败，不能自动恢复旧 JVM，也不保证服务整个生命周期不会被覆盖。下一切点先处理标准构建环境，再评估独立版本目录运行产物及切换验收；真实源、WebDAV 供应商、手机恢复与桌面包继续独立验证。本轮未提交或推送。

## 28. 2026-11-28 Windows 标准前端构建临时目录修复

承接 §27，只推进构建入口，不修改前后端业务、不覆盖正在运行的 jar、不停止或重启日常 1234。保留所有既有未提交改动。

### 28.1 复现与实现

- 当前 `TEMP/TMP` 均为 `E:\Apps\Cache\tmp`。默认标准构建此前在沙箱内外均报 `[vite:esbuild-transpile] remove ... Access is denied`。失败文件为 Archive 属性，事后可独占读取，不能据此锁定占用程序。
- esbuild 0.25.12 的 `lib/main.js` 对 >1 MiB transform 输入使用临时文件。最小转换复现：共享缓存失败；`E:\legado\product\tmp` 连续两次失败；`E:\legado\tmp` 连续两次通过，根 tmp 的子目录也连续两次通过。
- 最初选择 `product/tmp/web-build-*` 的完整构建在沙箱内外均失败；最终改用仓库根 `tmp/web-build-*`。根 tmp 和 product/tmp 均观察到继承的 `Everyone Deny DeleteSubdirectoriesAndFiles`，共享缓存没有该条；这不足以单独解释差异，未修改 ACL、杀毒设置或全局环境变量，未声称确定了拒绝主体。
- 新增 `scripts/build-web.mjs`，Windows 每次创建独立目录，只通过子进程环境设置 TEMP/TMP。顺序执行本地 TypeScript 和 Vite，保留标准参数；非 Windows 保留原环境。退出时验证绝对目录边界，再有界重试清理；清理失败报告保留路径。`web/package.json` 的标准/备用构建均接入此入口，备用参数仍须显式选择。

### 28.2 最终验收

| 项 | 结果 | 命令与口径 |
|---|---|---|
| 标准前端构建 | **退出 0** | `npm.cmd --prefix product/web run build`，无手动 TEMP 覆盖或 fallback；282 modules，Vite 32.95s，PWA 24 entries；入口 `index-D_PSZVLP.js`，CSS `index-CWCgbB6h.css` |
| dist 完整性 | **11 项通过 / 0 失败** | `node product/tools/verify/dist-check.mjs` |
| 体积预算 | **6 项通过 / 0 失败** | `node product/tools/verify/bundle-budget-check.mjs`；入口 JS gzip 191,361 B，总 JS 611,516 B，CSS 41,292 B，均在现有预算内 |
| 脚本全量 | **33 项通过 / 0 失败、取消或跳过** | `npm.cmd --prefix product run test:scripts`，7,378.473 ms；新增 Windows 环境隔离/唯一目录/清理、类型失败中止、非 Windows/fallback 行为；补充根 tmp 位置断言后定向 3/3 通过 |
| 版本/API/更新日志/交付契约 | **通过** | `version:check`、`docs:api-check`、`changelog:check`、`node product/tools/verify/delivery-check.mjs`；0.3.0/build56，153 端点/19 组 |
| 语法与差异 | **通过** | 新增两个脚本 `node --check`、`git diff --check` |

最终构建临时目录为 `E:\legado\tmp\web-build-NTObb0`，构建退出后已删除。根 tmp 手动环境覆盖的早一轮标准构建也成功（Vite 30.84s），不与本轮计数合并。

本次只生成新的标准 dist，**未重新构建 fatJar**，因此不得沿用 §26 的“当前 dist 与 jar 一致”结论；该 40 文件一致性是当时备用构建的快照。下一切点应安排日常实例停服、重建完整包并验收重启，或先实现运行 jar 隔离；本轮未执行这些动作。未重跑 Kotlin/React 全量、真实供应商、手机恢复和桌面发行包，未提交或推送。

## 29. 2026-11-28 MD3 / Luoyacheng 对照与 CONNECT 首包修复

基线 HEAD `3c1c7d9`，保留此前所有未提交工作。只修改 `:core:ops/PinnedProxy.kt` 的 CONNECT 缓冲流传递、app 中对应回归及相关记录；不改构建号、不重打 fatJar、不重启日常 1234。

### 29.1 上游固定证据与本仓根因

- MD3：`HapeLee/legado-with-MD3@9409c9214d59116b67bccd1e4eb382f108111a1f`，main；`AnalyzeUrl.kt:570` 的 `getResponseAwait(onCall)` 暴露持续读取响应体所需的 Call 取消能力，`:622` 使用 OkHttp 客户端。本仓已有 `RuleIoCancellation`，后续需补代理活跃连接退出判据，不能说本仓从零缺失取消。
- Luoyacheng：历史入口已重定向为 `Luoyacheng/legado-E@8b87c5aba4df91c39a3a0939a68a1180b9f2ee1c`，main，提交时间 `2026-08-01T05:07:58Z`；`AnalyzeUrl.kt:346` 对完整参数 value 编码。本仓 `RuleUrlSupport.kt` 逐 Char 编码有非 BMP 代理对损坏候选，**仅静态分析，尚未运行确认**。
- 采集目录：`E:\legado\tmp\upstream-review-2026-11-28\{md3,luoyacheng}`；固定链接、片段与推荐见 [`研究-MD3与Luoyacheng网络边界核对-2026-11-28.md`](../../../docs/research/研究-MD3与Luoyacheng网络边界核对-2026-11-28.md)。本轮只查两仓已知路径，不作全分支审计结论。
- 本仓 CONNECT 原先用 `BufferedInputStream` 读头，却在隧道转发时重新读原始 socket 流，绕过预读首包。修复为把同一个 input 传入 tunnel 并继续 `copyTo`。上游使用 OkHttp，不能作为存在同一自建代理缺陷的证据。

### 29.2 修复前与修复后判据

新增真实回环 socket 测试：在代理开始 accept 前，客户端一次写入 CONNECT 头及 1,024 字节二进制首包；收到 200 后逐字节比对回显。保留原分块逐块到达、只解析一次、私网拒绝、明文 HTTP 改写与 body 透传等回归。

修复前在 `product/` 执行：

```powershell
.\gradlew.bat :core:ops:test :app:test --tests io.legado.PinnedProxyTest --no-daemon --max-workers=1
```

**9 项 / 1 失败**（原有八项通过），新增首包用例在 `readExactly` 抛出 `java.net.SocketTimeoutException: Read timed out`；`BUILD FAILED in 5m 5s`。XML 时间戳 `2026-11-28T08:11:08.923Z`，已保存到采集根目录 `connect-before-fix.xml`。

修复后命令：

```powershell
.\gradlew.bat :core:ops:test :app:test --tests io.legado.PinnedProxyTest --tests io.legado.NetworkSecurityTest --tests io.legado.SearchHttpCancellationTest --tests io.legado.GoldenRuleTest --tests io.legado.ArchitectureBoundaryTest --no-daemon --max-workers=1
```

修复后 **BUILD SUCCESSFUL in 5m 8s**，XML 实计 **26 项 / 4 suite / 0 失败、错误或跳过**：PinnedProxy 9、NetworkSecurity 6、SearchHttpCancellation 3、ArchitectureBoundary 8。新增首包用例与原分块逐块到达均通过。四份 XML 已复制至采集目录 `after-<测试类>.xml`，完成时间为 `2026-11-28 16:16:52`（Asia/Shanghai）。

核对结果发现命令中的 `io.legado.GoldenRuleTest` 已不存在，未计入通过。当前实际黄金测试为 `io.legado.compat.CompatGoldenTest`，补跑 `.\gradlew.bat :app:test --tests io.legado.compat.CompatGoldenTest --no-daemon --max-workers=1`，**6 项 / 0 失败、错误或跳过，BUILD SUCCESSFUL in 4m 7s**。XML 时间戳 `2026-11-28T08:22:50.907Z`，已另存 `after-CompatGoldenTest.xml`。修复后两个批次共 **32 项 / 5 suite**，不作为全量结果。

`:core:ops:test` 当前是 `NO-SOURCE`；代理测试由 app 的 friend paths 访问内部类，不将无源码任务计入通过用例数。最终 `git diff --check` 通过。

版本/API/更新日志检查均通过：`npm.cmd --prefix product run version:check`、`docs:api-check`、`changelog:check`；0.3.0/build56，153 条端点 / 19 组。`changelog:check` 按提交边界检查，未把本轮未提交内容当成完整发版验收。

### 29.3 尚未关闭的边界

`PinnedProxy.close()` 仍只关监听 socket；活跃连接、CONNECT half-close 后静默源站和明文 HTTP 取消回收未在本轮修复。下一步先增加资源退出与合法 half-close 尾响应测试，再实现活动连接管理。未执行 Kotlin/React 全量、真实 HTTPS 供应商、上游 Android 构建或桌面发行包；新代码尚未进入日常运行 jar。
