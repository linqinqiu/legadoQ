# 现场事实清单（facts）

> 单一事实源：本文件记录**带时间戳、带命令、带口径**的实测数字。
> 其他文档（`docs/STATUS.md`、`backend-layering.md`、`frontend-host.md`）里的规模数字写于各自 commit，
> 属于历史事实；与本文冲突时以本文为准，并重新跑一遍命令。
>
> 最近采集：**2026-11-09 21:00–21:10（本地）**。工作树**干净**，HEAD 就是 tag `v0.2.37`。

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
| HEAD | `5344c39`（2026-11-09 20:46:19 +0800） | `git log -1 --format="%h %ad" --date=iso` |
| 版本 tag | `v0.2.37` | `git tag --points-at HEAD` |
| 版本 / 构建号 | **0.2.37 / 50** | `cat VERSION BUILD_NUMBER`；`/healthz` |
| 版本真源 | `product/app/build.gradle` 的 `version` | 其余 6 处为抄本，`npm run version:check` 钉住 |
| 代码修订 | `rev-<提交数>` + 短 sha | `/healthz` 的 `rev` / `sha` 字段（0.2.37 起） |

> `rev` 是打包时 `git rev-list --count HEAD` 写进 `meta/build-info.properties` 的值，`sha` 是
> `git rev-parse --short HEAD`。**没发版、只在本地改时，版本号不动，只有 rev 随提交递增** ——
> 判断"跑的是哪一版代码"看 rev，精确定位提交看 sha。

---

## 2. 源码规模（工作树，2026-11-09 21:00）

| 项 | 值 | 命令 | 口径 |
|---|---:|---|---|
| 后端 `.kt` | **134** | `find product/app/src/main/kotlin/io/legado -name '*.kt' \| wc -l` | 含全部包 |
| 后端行数 | **35,109** | `find … -exec cat {} + \| wc -l` | — |
| 后端 `@Test` | **1,091** | `grep -rho '@Test' product/app/src/test --include=*.kt \| wc -l` | 静态计数 |
| 后端测试文件 | **137** | `find product/app/src/test -name '*.kt' \| wc -l` | — |
| 前端 ts/tsx | **196** | `find product/web/src \( -name '*.ts' -o -name '*.tsx' \) \| wc -l` | — |
| 前端行数 | **37,695** | 同上 `-exec cat {} + \| wc -l` | — |
| 前端测试文件 | **129** | `ls product/web/test/*.test.ts \| wc -l` | — |

**跑起来的通过数（2026-11-09 22:05–22:07 复跑）**：后端 **1,090 / 1,090**（0 失败 0 错误），
前端 **1,019 / 1,019**。合计 **2,109**。

> 静态 1,091 与运行 1,090 的差额来自一条没被任何测试类执行的用例，不是失败。

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
| 代码建的表 | **24** |
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

## 5. 现场状态（瞬时，2026-11-09 22:15）

| 项 | 状态 |
|---|---|
| 工作树 | 本文提交后干净（此前有文档与代码改动） |
| 服务 | **未运行**；本轮验证用 `gradlew :app:test` 与 `npm test`，没有起 1234 |
| `/healthz` | 无应答（服务未启动）；修订号格式见 §1 的 `rev` / `sha` |
| 端点 | **161 条 / 19 组**（`docs:api-check` 实测） |
| 门禁 | `version:check` 7 处一致；`docs:api-check` 161/19 一致；`changelog:check` 无待记录 |
| CI | main：契约 / 真浏览器 / 覆盖率 / Test&Build 全 success；tag：三资产已发布 |

端点分组（实测，按条数降序）：AI 自定义接入 22、内置浏览器 17、登录与凭据 15、书架 14、
书源 12、净化规则 10、进度与笔记 9、朗读 9、系统 8、RSS 7、分章规则 7、阅读 6、
图片与媒体 6、书源订阅 5、备份 5、发现页 3、离线缓存 3、搜索 2、目录 1。

上述任一项都会随下一次 commit / 重启变化，**不要**把它们写进"项目常驻描述"。

### 5.1 续（2026-11-09 深夜，本地，`HEAD=7ae52d0`，领先 origin 20 提交）

> 自 §5 之后又做了阅读器拆分（4.1/4.2/4.3 第一步）。规模数字见 `研究-阅读器拆分续-下一步.md` §5。

| 项 | 状态 |
|---|---|
| 工作树 | 代码已提交（`7afd4ea` 外壳抽成 ReaderChrome + 撤掉界面构建号；`7ae52d0` 笔记状态搬进 useReaderNotes）；本轮收尾只剩文档改动 |
| 阅读器拆分 | `ReaderScreen.tsx` 3,200 → **2,436**；拆出 `ReaderBody`(227) / `ReaderOverlays`(226) / `ReaderChrome`(218) / `useReaderNotes`(200) 与 `useReaderChapterContent`(124) / `useReaderCacheStatus`(139) / `usePaginationMeasurement`(190) / `useReaderPageTurn`(77) / `useReadingLog`(46) |
| 前端判据 | **1,020 通过 / 0 失败**（`npm --prefix product/web test`） |
| 笔记拆分边界 | `useReaderNotes` 收了状态与增删改；`toggleBookmark`（依赖 `readLogicalPosition`，与 persist 共用逻辑位置）与 `renderNoteHighlights`/`jumpToNote`/`jumpToSearchHit`（依赖正文渲染路径与导航原语）仍留 `ReaderScreen`，经 `notesApi.*` 复用状态 |
| 门禁 | `check`(tsc -b) 通过；version/docs:api/changelog 未重跑（未改版本/接口/修复提交）。注：`check:test` 在 `test/PerformanceMonitor.test.ts` 有既有类型报错（上次动于 `c660963`），非本轮引入 |

---

## 6. 文档/记忆与实测的偏差

| 来源 | 说法 | 实测 | 处置 |
|---|---|---|---|
| `docs/STATUS.md`（0.2.14 版） | 927 / 900 测试、161 端点、20 张表 | 1,090 / 1,019、161、24 | 已按本文重写 |
| `backend-layering.md` | 123 / 32,153 / 935 | 134 / 35,109 / 1,091 | 写于旧 commit，数字以本文为准 |
| `frontend-host.md` | 177 / 110 | 188 / 129 | 同上 |
| `docs/ARCHITECTURE.md` §13 | `HttpClients` 零调用方 | 0.2.36 已删除该文件 | 该行已改为「已撤销」 |
| 旧记忆 | 0.2.17 / build 13 | 0.2.37 / build 50 | 已更新 |

**纪律**：不要把旧文档里的数字逐项改成新数字——那会让它们变成永远追不上 HEAD 的第二事实源。
正确做法是在文档头加一行"写于 `<commit>`，规模数字已过期，以 `facts.md` 为准"。
