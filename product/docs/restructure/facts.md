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
