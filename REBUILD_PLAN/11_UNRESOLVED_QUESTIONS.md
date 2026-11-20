# 11 未决问题与需人工决策事项

> 本册分三类：
> **A. 必须由项目负责人决策的产品/方向问题**（我给了建议，但决定权不在我）；
> **B. 技术未确认事项**（本轮只读审计没能证实，逐条给了验证方法）；
> **C. 本次审计本身的边界**（明确说清哪些结论不是实测出来的，避免被当成过度解读）。
>
> 路径一律相对 `E:\legadoQ-archive\`（HEAD `771b311`）。

---

## A. 需要项目负责人决策的 12 件事

> [!NOTE]
> **决策状态（2026-11-20）**：Q-1~Q-5 沿用负责人 2026-11-17 决策（见 `README.md` §已明确的决策）；
> Q-6~Q-12 已于 2026-11-20 逐题确认。结果：**Q-6/7/8/9/12 采纳建议**；
> **Q-10 负责人选「继续多工具并行」**（偏离建议的单工具）、**Q-11 负责人选「Win+macOS+Linux」**（偏离建议的只 Windows）。
> 下方表格的「我的建议」列是审计当时的原始建议，保留不改；最终决定以 `README.md` 的 2026-11-20 补充表为准。

| # | 问题 | 现状事实 | 选项 | 我的建议 | 不决策的后果 |
|---|---|---|---|---|---|
| **Q-1** | **AI 子系统（54 文件 / 13,334 行）去留** | 2026-11-17 整体移出编译与打包（`54ee9cb`/`a105588`/`150949a`），`/api/agent` 下线并记为破坏性变更（`a0b8e16`）；代码一行未删；上线仅 12 天 | ①恢复进主树 ②独立成仓 ③归档出库 | **③ 归档出库**。它在主树里每天干扰全仓检索与文档口径，且没人能回答"它解决谁的什么问题" | 主树长期挂着一个不参与编译的巨型目录；每次审计都要重新解释它 |
| **Q-2** | **导出范围要不要覆盖笔记/书签** | 导出 5 域（书源/替换规则/分组/RSS/书架+进度）；`book_note`（笔记+书签）**零导出入口**，导入侧也不认 | ①补第 6 域 ②维持现状 | **① 必须补**。否则用户换设备即永久丢失，且导出时没有任何提示 | 重建后用户数据仍无备份出口，风险等级等同 P0 |
| **Q-3** | **规则扩展点 `RuleProcessor` 留不留** | 机制真实接入热路径（`RuleValue.kt:52`、`RuleNodeSelection.kt:45`），但产品内**零自定义处理器**，只剩 2 个 demo；包外 `import` = 0 | ①做一个真处理器 ②砍掉扩展点 | **①**：把"正文净化/繁简转换/排版后处理"做成真处理器（现在写在 `RuleRunner` 里） | 继续"可用但空转"，多一层间接且没人验证 |
| **Q-4** | **外观配置（自定义皮肤/阅读背景）是否跨端同步** | 前端 3 处注释称"只存 localStorage、不上传服务端"，但 `saveReaderSettings` 实际把含 `customSkins[].css` 的整份设置 `pushUiPref` 到 `/api/ui-prefs/reader-settings`（`readerSettings.ts:76/91/166` vs `:758-764`） | ①真同步（改注释）②真本地（删上传） | **①**（注释是错的，代码是对的——跨设备同步是合理需求） | 注释与实现继续互相矛盾，下一个 AI 会照着注释改坏 |
| **Q-5** | **是否接受"手写 SQL + 自研路由"这个不够现代的选择** | 21 表全部手写 SQL、无 ORM；路由无 router 库（`hash` + `PAGES` 数据表） | ①保留 ②引入 ORM/router 库 | **① 保留**（见 `08` §5） | 若期望"现代化"，`08` 的 40% 工作量估算失效，需重估 |
| **Q-6** | **"点恢复后要重启才生效"是否可接受** | `POST /backup/snapshots/restore` 只写标记文件，真正落库在下次启动（`DbSnapshot.kt:68-75`）；期间的新写入会随覆盖消失 | ①维持 + 前端强制提示 ②改成热恢复 | **① + 提示**。设计本身是对的（不碰正在使用的库），缺的是 UI 强制提示 | 用户点完继续在旧库上操作，再次启动时那段时间的写入全丢 |
| **Q-7** | **`cookie_jar` 被置空的老库要不要抢救** | 迁移 `Migration.kt:100` 会 `update source_login_state set cookie_jar = null`，**不可逆**；`:76` 解析失败还静默 `return@forEach` | ①保留原值 + 标记 ②照旧清空 | **①**：先备份原值到新列，运行期再决定是否使用 | 用户书源登录态被静默清空，需重新登录（且无从申诉） |
| **Q-8** | **书源体检：前端还是后端说了算** | 前端 `lib/sourceInspector.ts`（456 行）自己判 VIP/正文/阈值；后端已有 `/api/sources/health-check`（`SourcesRoutes.kt:250`） | ①后端权威 ②前端权威 | **① 后端权威**，前端只展示（`04` B9） | 两套判定长期不一致，用户看到的结果取决于点哪个按钮 |
| **Q-9** | **兼容性金标准要不要扩样本** | 现有 6 类 golden；**未覆盖**：纯 XPath、JS 列表规则、正则列表（AllInOne `:` 前缀）、多页目录翻页、图片解密（02a §4） | ①扩到 8–10 类 ②维持 6 类 | **①**：这 4 类补成 golden 是**成本最低的回归保险** | 重建后这些写法静默退化，只能等用户报 bug |
| **Q-10** | **重建期是否继续"多 AI 工具并行同仓"** | 仓库同时被 CodeBuddy/Qoder/Codex/Cursor/Gemini 使用（`AGENTS.md` §9），`.agents`/`.codebuddy` 目录在库内 | ①重建期单工具 ②继续并行 | **①**：重建期的判据严格性经不起多工具并行 | 冲突 diff 混入判据提交，失败无法归因 |
| **Q-11** | **目标平台是否只有 Windows** | 桌面包是 jpackage + `.ico` 多尺寸（`product/scripts/package-desktop.mjs`）；`stop.mjs` 已补 POSIX 分支 | ①只 Windows ②Win+macOS+Linux | **①**（仓库既有事实），但要在文档里写死 | 产品化阶段反复为不存在的平台付成本 |
| **Q-12** | **"单用户、无鉴权"的产品假设是否长期成立** | 明确产品决策：无账号/无 token（`http/Guard.kt:15-20` 引用负责人原话）；Docker 却默认绑 `0.0.0.0`（`product/Dockerfile:50`） | ①维持单用户 ②引入最简 token | **① + 绑定非回环时强制 token**（`08` S3） | Docker 用户把明文 Cookie 的书源服务暴露到公网（07 分册 P0-1） |

---

## B. 技术未确认事项（34 条，按主题归并）

> 全部是本轮静态审计**没能证实**的；每条给出验证方法。**凡标注「影响重建决策」的，建议在阶段 1 结束前补齐。**

### B-1 数据库与迁移（6 条）

| # | 未确认 | 为什么要紧 | 怎么确认 |
|---|---|---|---|
| T-01 | `LogDao.kt:97 ensureLogTable()` 里是否还有 `create table` | 若有，则"21 张表"口径不完整——`book_mark` 孤儿表就是这么来的 | `grep -rn "create table" product/app/src/main` 全仓扫 |
| T-02 | `deleteBookGroup`（`ShelfDao.kt:125`）删组后是否重置 `book_shelf.group_id` | 决定分组悬空是 P2 还是更低 | 读 `ShelfDao.kt:125-160` |
| T-03 | `CookieDao`(714 行) 的凭据读写边界；`app_meta` 的 `cookie_mentions_*` 两键谁写 | 决定"凭据域"是否还有第二处权威（与前端 4 份 Cookie 解析同型） | 读 `CookieDao.kt` 全文 + `grep -rn "cookie_mentions"` |
| T-04 | `book_mark` 那 1 行真实书签属于哪本书、是否有旧代码曾试图搬运 | 决定它是"可人工救回"还是"已无从对应" | 只读查询 `book_mark` 的 `book_url`/`chapter` 字段（**不要 dump 笔记正文**）+ `git log -S book_mark` |
| T-05 | `BackupImporter.MAX_TOTAL_BYTES` 具体数值 | 只影响"大包被拒"边界 | `grep -n MAX_TOTAL_BYTES product/app/src/main/kotlin/io/legado/backup/BackupImporter.kt` |
| T-06 | `book_shelf_tombstone` 不进导出包是有意还是遗漏 | 同设备"导入自己旧包"时墓碑仍生效，行为可能反直觉 | 读 `BackupExporter.kt` 域清单 + 找注释 |

### B-2 规则引擎与网络（7 条）

| # | 未确认 | 为什么要紧 | 怎么确认 |
|---|---|---|---|
| T-07 | **XPath 求值代码本体在哪** | 只确认了前缀分发（`RuleNodeSelection.kt:36-43`），重建时必须知道实现位置 | `grep -rn "JsoupXpath\|XPath" product/app/src/main` |
| T-08 | 其余 5 处裸 `HttpClient` 的重定向策略 | 主链路已确认「手写跟随 + 每跳重校验」，但裸客户端未必 | 逐个读：`EdgeTtsService.kt:28`、`ExternalBrowserLogin.kt:99`、`WebViewProxy.kt:60`、`UpdateCheck.kt:42`、`DesktopLauncher.kt:313,323` |
| T-09 | 是否有用户可配置的出站代理 | `ops.PinnedProxy` 是内网闸门、不是 SOCKS/HTTP 代理；`AppConfig.kt`（277 行）未读 | 读 `AppConfig.kt` 全文 + `grep -rn "proxy" --include=*.kt` |
| T-10 | `DesktopLauncher.kt:313/323` 裸客户端用途 | 像是本机自探活，但若它是**唯一**豁免，判据 G3 需要写豁免条款 | 读 `DesktopLauncher.kt:300-340` |
| T-11 | **纯 JS 堆分配是否绕过 64MB 宿主预算**（【未确认，需人工验证】） | 若成立，沙箱可被脚本用纯 JS 数组先于墙钟 OOM 打死宿主 | 设预算为 0 后跑 `JsSandboxHostBudgetTest` 同类脚本，或 `-Xmx256m` 复现（07 §2 已给方法） |
| T-12 | TTS 断网的降级行为 | `EdgeTtsService` 依赖在线 Edge 服务 | 断网手测 + 读异常分支 |
| T-13 | `WebViewProxy`（817 行）的并发/资源上限 | 登录代理是最宽的出站入口（且绕过 SSRF 闸门） | 读 `WebViewProxy.kt` 连接与超时相关段 |

### B-3 端点与契约（4 条）

| # | 未确认 | 为什么要紧 | 怎么确认 |
|---|---|---|---|
| T-14 | 68 条端点的响应 DTO 未做静态定名（经 `respondMedia`/`respondBytes` 等辅助通道回包） | 类型生成（`08` D-4）需要完整 DTO 面 | 在 `api/` 分层落地时逐条标注；或运行时录制响应 schema |
| T-15 | **`POST /api/sources/{id}/browser/submit` 的「403 后仍执行」**是读代码推断 | 若成立是真实安全缺陷（表单已发出才二次 respond） | 起服务后构造跨源 Origin 请求实测（依赖 Ktor `onCall` 不阻断 pipeline 这一前提） |
| T-16 | `agent-api.json` 的 `write` 标志与代码是否逐条一致 | 决定「同源写门」覆盖面口径 | 逐条复核 144 个 `write` 值（现只复核了"哪些处理器没有写门"一侧，52 处） |
| T-17 | 23 条参数化端点是否有前端入口 | 判据"端点↔客户端方法"映射缺失 | 补一份映射测试（治本），或后端路由反查 `domains/*` |

### B-4 前端（6 条）

| # | 未确认 | 为什么要紧 | 怎么确认 |
|---|---|---|---|
| T-18 | `bookSourceFields.ts`（693 行）与后端 `SourceModels.kt` 字段集是否一致 | 书源编辑器字段缺失/多余会直接导致用户配不了源 | `grep -o '"[a-zA-Z]*":'` 两侧取集合做 diff |
| T-19 | 前端 `ttsEngine.ts` 与后端 `TtsSessionService.kt` 的职责边界 | 中文断句在前端、会话在后端，边界不清会重写错 | 读 `TtsRoutes.kt` + `TtsSessionService.kt` 会话生命周期 |
| T-20 | 换源后「当前书」身份与书架条目如何对齐 | "当前书"有 3 份状态（`main.tsx:161`、`ReaderScreen.tsx:70`、`ShelfPage` items），`setCurrentBook` 会改写 | grep `setCurrentBook` 全部分支 + 后端 `saveProgress` 的 `bookUrl` 语义 |
| T-21 | `styles.css` 的硬编码色值规模 | 决定"令牌化"的真实工作量 | `grep -oE "#[0-9a-fA-F]{3,8}" styles.css \| sort \| uniq -c \| sort -rn \| head` |
| T-22 | `plugins/` 的 Extension/Slot 机制是否有真实使用者 | 若只有 1 处引用，它就是第二个"空转扩展点" | `grep -rn "registerExtension(\|attach(" product/web/src` |
| T-23 | `ContentPipeline.kt`(37 行) 是否已取代 `ContentProcessor.kt`(184 行) | 两者关系不明，重建时可能搬错一个 | 读两个文件全篇（都很小） |

### B-5 依赖与边界判据（4 条）

| # | 未确认 | 为什么要紧 | 怎么确认 |
|---|---|---|---|
| T-24 | `@types/node@^26` 与 `engines.node>=20` 是否匹配 | 类型面可能要求更高 Node | 看 `@types/node` 的 changelog / 直接 `tsc -b` 是否报类型错 |
| T-25 | `ktor-server-sessions` 实际用量 | 若只是常量而非 session，可删依赖 | `grep -rn "install(Sessions)\|call.sessions" product/app/src/main` |
| T-26 | `ArchitectureBoundaryTest` 判据 5 把 `port/` 当哪一层 | 判据 6 只查 2-环、判据 3 正则只认大写类名——**判据本身有盲区** | 读 `ArchitectureBoundaryTest.kt:44` 附近的包常量定义 |
| T-27 | `SearchRoutes.kt:289` 的"独立 supervisor scope"注释与实现是否一致 | 搜索是本项目最容易泄漏协程的地方 | 读 `SearchRoutes.kt:280-340` + `collectWithDeadline(:331)` |

### B-6 流程与运行态（7 条）

| # | 未确认 | 为什么要紧 | 怎么确认 |
|---|---|---|---|
| T-28 | `importLibraryOn` 是否在事务内碰文件系统 | `Database.kt:132-134` 明文禁止事务内 IO（单写连接被独占） | 读 `ImportDao.kt:153` 起的函数体 |
| T-29 | `port/` 端口化的"53 处调用点"是否仍成立 | `PortBundle.kt:15` 的描述与现签名不符 | `grep -rc` 统计实际调用点 |
| T-30 | 实库计数（21/22 表、5 行进/4 孤儿）是否为瞬时快照 | 库可能正被运行中的服务写（有 4MB WAL） | 停机后重数一次 |
| T-31 | 前端是否有"恢复需重启"的强制提示 | 决定 Q-6 的实际破坏力 | grep 备份页相关文案 |
| T-32 | e2e 三脚本实际能跑通否 | 审计禁止运行 | 在主控环境实跑 |
| T-33 | 是否有未提交/并行 agent 的半成品 | 本轮只读，未执行 `git status`（归档时已确认干净） | 重建前每轮先 `git status` |
| T-34 | **任何测试都未实际运行** | 所有"测试存在/覆盖"结论都基于源码，不等于当前全绿 | 阶段 2 第一件事：`npm test` + `npm --prefix product/web test` 采集真实基线 |

---

## C. 本次审计的边界（必须知道，否则会误用本目录）

### C.1 做了什么

- **只读**：读源码、`grep`、`git log/show`、`ls`、`wc`、只读 `sqlite3`（`mode=ro`）。
- **未改动归档**：`E:\legadoQ-archive` 在工作区外，全程未写入；未执行任何 git 写操作。
- **未运行**：没有构建、没有启动服务、没有跑测试、没有发任何 HTTP 请求、没有执行任何书源脚本。

### C.2 各分册覆盖率（各子审计自报，不做美化）

| 分册 | 覆盖率 | 最大空白 |
|---|---|---|
| 02a 后端清单 | 主源码 **35.8%**（44/123 文件读过内容窗口）+ 结构巡检 100%；测试细读 6.5% | `rules/` 内核（`RuleRunner`/`JsSandbox`/`JavaPackages`）正文约 5% |
| 02b 前端清单 | 结构级 **100%**（199/199）；内容窗口 **21%**；整篇读取 0 | `main.tsx`/`pages.tsx`/`ShelfPage`/`SourcesPage`/7 个 reader hook/`bookSourceFields.ts`/`plugins/**` 零覆盖 |
| 03 依赖与调用链 | 后端 import 统计 **123/123**；7 条调用链 7/7 | `rules/` 内核约 5%；前端 `ReaderScreen` 约 1% |
| 05 数据库 | DDL/索引/触发器/迁移/**实库 schema** 100%；**DAO 实现体 17%**（1,042/6,292 行） | DAO 业务函数体；9 条未确认集中在低覆盖区 |
| 06 API | 端点 **146/146 = 100%** 逐条清点；78 条 DTO 静态确认 | 68 条响应 DTO 靠目录宣称；测试覆盖仅静态计数 |
| 07 安全与债务 | 后端走读量 **≈32%**，其中**安全相关代码 ≈75%** | 前端仅 6 个 XSS 关键词全量 grep（≈8%）；未动态渗透、未查 CVE 库 |

### C.3 结论的可信度分级（怎么用这些文档）

| 可信度 | 结论类型 | 用法 |
|---|---|---|
| **高** | 附 `文件:行号` 且是**直接读到**的内容（规模数字、表结构、端点注册、依赖 import、git 历史） | 可直接作为重建依据 |
| **中** | 附 `文件:行号` 但基于**结构/命名/签名**推断（多数功能级"完整实现"判定是"端点+业务函数+测试三者在位"的三角验证） | 重建前按 §B 的索引把实现读透再用 |
| **低** | 标【推断】【未确认】的，尤其是：安全绕过可能性、性能拐点、方言兼容性细节 | **不要当结论引用**；按 §B 给出的方法先验证 |

### C.4 一条给下一个审计员的提醒

本项目的 `AGENTS.md` 明确要求「别整篇读大文件、用 grep 定位窗口」。本次 6 个并行子审计都遵守了这条，结果就是 **`rules/` 内核与 `ReaderScreen` 的覆盖率只有 1–5%**——这恰恰是重建最需要读透的两块。

**建议下一轮（如果需要补充审计）单独立两个"深读轮"**：
1. `rules/` 深读轮：`RuleRunner`(1,758) + `JsSandbox`(2,100) + `JavaPackages`(1,415) + `RuleValue`(802)，目标是能画出**每一条规则语法的求值路径**；
2. `ReaderScreen` + 7 个 reader hook 深读轮：目标是列出**每一类交互的状态迁移**（这也是 `09` 阶段 5.4 的前置条件）。
