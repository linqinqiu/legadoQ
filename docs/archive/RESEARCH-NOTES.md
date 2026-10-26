# 研究纪要 · 青阅 (QingYue) 仓库

> 本文件由目录研究得出，供后续会话快速建立上下文。非设计稿、非对外文档，内容来自静态代码核对（本会话 `pwsh` 沙箱不可用、localhost 不可探测，未真机验证运行态）。
> 最后整理：2026-10-21（补修文档漂移；见 §2 的两张对照表）

---

## 1. 这是什么

**青阅 (QingYue)** —— 本地小说 / 漫画阅读服务。

- 单 JVM 进程：Kotlin + Ktor CIO 引擎。
- 内置 React 19 + Vite 6 阅读器 UI，打包进 jar。
- 默认只监听 `127.0.0.1:1234`，**无账号、无 token**（绑定的回环地址本身就是唯一身份闸门）。
- 数据：SQLite（`legado/data/legado.sqlite`，WAL 模式，约 227MB、约 5574 条书源）。

### 双许可证（见 `NOTICE.md`）

| 层 | 许可证 | 范围 |
|---|---|---|
| 根层 | **MIT** | `README` / `VERSION` / 根 `package.json` / `docs/` / `scripts/` / `LICENSE` |
| `legado/` | **GPL-3.0-or-later** | 产品本体：后端 + 内置 UI + 数据 |

> 改根层文档（MIT）与改 `legado/`（GPL）要遵守各自许可证边界；新增代码进 `legado/` 即受 GPL 约束。

---

## 2. 版本号的唯一真相源

**权威版本 = `legado/app/build.gradle` 里的 `version`**（0.8.3 起目录由 `server/` 改名 `app/`）。

> **2026-10-23 校准**：端点总数已从 139 改为 **142 / 19 组**（`阅读` +2、`进度与笔记` +1；`agent-api.json` 与 `/api/catalog` 实测一致）。下方 §2 各表里的 139 是 2026-10-20/21 的历史记录，保留原样；**当前真值以 142 为准**。
>
> 同日校准**工具数**：`GET /api/agent/manifest` 实测 **54 个内置工具 / 16 个前缀组**（source 14、replace 6、shelf 6、note 4、rss 4、ai 3、subscription 3、backup 2、explore 2、progress 2、readingLog 2、tts 2、book 1、chapters 1、content 1、search 1）。`legado/docs/agent-guide.md` 与 `ai-framework.md` 里旧的 39 / 43 已改 54；`docs/research/` 与 `reader-redesign-plan.md` 里的 39/42 是当时的实测快照，保留不改。**端点数 ≠ 工具数**，两者别混。
>
> 同轮补正两处易错语义：① `MAX_TOOL_ROUNDS` 默认 **6**、可用 `LEGADO_AI_MAX_TOOL_ROUNDS` 调到 1–20（不是 32，32 会被 `coerceIn` 夹到 20）；② AI **出站**闸门（`assertPublicBaseUrl` → `NetworkSecurity`）**连回环也拒**，`baseUrl` 填 `127.0.0.1` 会得到 `400 invalid_request`；「只许回环」是**入站**的 `Guardrails.refuseExternalBind`，方向相反。

一致性链（以 **0.8.5 / 2026-10-23** 为准）：
- `legado/app/build.gradle` → `version = '0.8.5'`（唯一真相源）
- `legado/package.json` / `legado/web/package.json` → `0.8.5`
- 父仓库 `package.json` 与 `VERSION` → `0.8.5`
- `legado/CHANGELOG.md` → 含 `[0.8.5] - 2026-10-23`
- `legado/app/src/main/resources/agent-api.json` → `version: "0.8.5"`
- `BuildInfo` → 读 jar manifest 的 `Implementation-Version`；开发态 `:app:run` 跑 classes 目录（无 manifest），显示 `version=dev`（正常现象，不是 bug）。

> 0.8.5 是 0.8.4 之后的小更新（PWA 图标/语言/快捷方式 + AI 悬浮球交互 + 目录加书架 + 密钥掩码 + `/api/catalog` 地址跟随实际端口），不含破坏性变更。

> 版本交叉核对有判据盯着：`web/test/ApiCatalog.test.ts` 会比对 `agent-api.json` 的 `version`
> 与 `app/build.gradle` 的 `version`，不一致就红。所以改版本时这两处必须一起动。

### ⚠️ 已知历史文档漂移（已于 2026-10-20 修复）

| 文件 | 原状 | 现已改为 |
|---|---|---|
| `VERSION`（根） | `0.8.2` | `0.8.3` |
| 根 `package.json` | `0.8.2` | `0.8.3` |
| 根 `README.md` L5 | "当前版本 **0.8.2**" | 0.8.3 |
| `docs/README.md` L6 | "**138** 条端点" | 139 |
| `docs/ARCHITECTURE.md` | "0.8.2 / 138 个端点 / 19 组 / 系统 7" | 0.8.3 / 139 / 系统 8 |
| `legado/docs/AI-AGENT.md` | 0.8.2 / 138 条 | 0.8.3 / 139 条 |
| `legado/docs/ai-framework.md` | 138 个端点 | 139 个端点 |
| `legado/docs/plugin-framework.md` | "端点计数恒定（138 条）" | 139 条 |

> 这些是"给人看的散文文档"过期；权威契约 `agent-api.json` / `docs/API-REFERENCE.md` 一直是 139 / 19 组（自动生成），对外调用不受影响。各处"0.8.2 结构重排""v0.8.2 发行包"是历史语境，非漂移，已保留。

### 2026-10-21 补修（本轮，静态核对 `Database.kt` / 目录实读）

| 文件 | 原状 | 现已改为 | 依据 |
|---|---|---|---|
| `legado/docs/architecture.md`（图 + §3） | "17 张表" | 代码建 16 张表 | `data/Database.kt` 里 16 条 `create table if not exists` |
| `legado/docs/architecture.md` §3 阅读标记 | 写着 `book_mark`、`book_note` | 只有 `book_note`，另加"代码建的表 ≠ 磁盘上的表"一段 | 全仓 `.kt` grep 无 `book_mark`；`CHANGELOG` 0.6.12 记「书签功能整体删掉」。**但** `data/legado.sqlite` 里仍有 `CREATE TABLE book_mark` —— 代码只建不删，老库会留旧表 |
| `docs/ARCHITECTURE.md`（全景图 + §4 表） | "17 张表" | "代码建 16 张表（老库可能还有已停用的旧表）" | 同上 |
| `docs/README.md` §后端文档 | "`legado/docs/` 仅保留……4 份" | 6 份（补 `ai-framework.md`、`plugin-framework.md`） | 该目录实读 6 个 `.md` |
| 本文件 §3 | "139/20 自洽" | 139 / 19 组 | `agent-api.json` 的 group 只有 19 种 |
| 本文件 §4 | "目录 / 系统两组的 8 端点" | 9 端点（目录 1 + 系统 8） | `Routes.kt` 装配点实读 |
| 本文件 §7 | 孤立的 `3. **运行态留痕**` 列表项（没有 1、2） | 改成独立小节 | 排版修复 |

> 附带说明：§7 的标题原本也叫"已知历史文档漂移（已于 2026-10-20 修复）"，与 §2 那张表重名且内容只是指回 §2，
> 已改名为「文档漂移的收口位置」，避免两处同名小节各自漂。
>
> 以上都是"散文文档与代码对不上"，判据测试（`ApiCatalog.test.ts` / `FrameworkHasNoContent.test.ts`）不管这些，所以只能靠读源码核。本轮**无法跑构建与测试**（见 §9 末条：本机 `pwsh` 在本工作区一律报 `workspace preparation failed`），全部结论来自静态读码。

### 2026-10-21 第二轮：坏链与「文档说反了」

这一轮把 27 个 markdown 的链接、反引号路径、以及"文档断言 vs 源码"逐条核了一遍。四条真问题：

| 位置 | 原状 | 现已改为 | 依据 |
|---|---|---|---|
| `legado/AGENTS.md` 开头安全模型 | "写接口**缺 Origin 会被拒**" | 写清：**不带 Origin 直接放行**；只有带了 Origin 才检查同源，带了跨站才 403 | `Guard.kt:38` `origin ?: return true`；`SameOriginGuardTest` 有一条专门叫「写操作在没有 Origin 时放行」。原说法会把本机脚本吓住，且与 `docs/API-REFERENCE.md`、`docs/ARCHITECTURE.md` 直接矛盾 |
| `legado/CONTRIBUTING.md` | 链接 `web/AGENTS.md`（**该文件不存在**） | 改指 `web/test/` 现有用例 + `docs/plugin-framework.md` §6「验证」 | 全仓 `**/AGENTS.md` 只有 `legado/AGENTS.md` 一份 |
| `legado/CONTRIBUTING.md` | "`version-check.mjs` 会判**六处**" | 五处（gradle / jar 清单 / `/healthz` / 顶栏 / CHANGELOG） | 脚本头注释明写"五个位置"，且逐条 `check()` 就是这五处 |
| `docs/ARCHITECTURE.md` §5 端口优先级 | `--port` → `.env` → `LEGADO_PORT` → `1234`（**漏了 `port.txt`**） | `--port` → `port.txt` → `.env` / `LEGADO_PORT` → `1234`，并补一句：服务端兜底是 `8080`，`1234` 是启动器给的 | `scripts/runtime.mjs:34-37`：`portFromFile ?? pick('LEGADO_PORT','1234')`，注释明说 `port.txt` 排在 `.env` 前面；`ServerConfig.kt:39` 裸跑默认 `8080` |

另外顺手把 `legado/AGENTS.md` 里写死的 `E:\legado\...` 路径改成相对路径 / `<仓库外>` 占位
（该文件 §6 的 `cd E:\legado\legado\web`、§10 的发行目录与 junction 目标）—— 仓库自己的
`docs/STRUCTURE.md` 第一条原则就是"不依赖盘符"，文档却反着来。

**核对过、确认没问题、不用改的**（省得下次重查）：

- 142 条端点 / 19 组：`agent-api.json` 里 `"group"` 确实 19 种、`"path"` 确实 142 条。
- 16 张表：`Database.kt` 的 `create table if not exists` 恰 16 条。
- 26 条随包 TXT 分章规则：`assets/txtTocRule.json` 恰 26 个 `"name"`。
- `legado/docs/` 恰 6 个 `.md`，与 `docs/README.md` 一致。
- 其余相对链接（根 README、docs/README、docs/ARCHITECTURE、legado/docs/* 的互链）全部可达。
- `.env.example` 的 `8080` 是对的（那是 `ServerConfig.kt` 的裸跑默认），不是笔误。

### 2026-10-21 第三轮：shell 恢复后真跑，挖出 4 个「编译不过」

前三轮只能静态读码。这一轮 `pwsh` 恢复后**第一次真跑**，立刻暴露出一批
「文档/代码看着都对，其实整个后端编译不过」的问题 —— 都来自**嵌套仓库里那批未提交的 0.8.3 改动**：

| # | 位置 | 症状 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | `ai/BuiltinTools.kt` | `Unresolved reference 'confirm'` | `confirm` 是 `all()` 的**局部变量**，却被 `object` 属性 `val sourceBatch` 引用（作用域外） | 把 `sourceBatch` 改成 `private fun sourceBatchTool(confirm)`，在 `all()` 里以 `sourceBatchTool(confirm)` 注入。**语义不变**（仍然按注入的策略问确认） |
| 2 | `http/Routes.kt:101` | `No value passed for parameter 'selectors'` | `PluginStatusDto` 新增了必填 `selectors: Int`，但「插件框架未接线」那条兜底分支没跟着改 | 兜底分支补 `selectors = 0` |
| 3 | `ConnectionSelectorTest.kt`、`FrameworkContractTest.kt`、`PluginFrameworkHasNoContentTest.kt` | 几十条 `Unresolved reference 'jupiter'` | 这 3 个新测试用 **JUnit 5**，但仓库只依赖 `junit:junit:4.13.2`（JUnit 4），且**本机无法联网**下载 jupiter | 全部改写成 **JUnit 4**（`org.junit.Test` + `org.junit.Assert`），断言的消息参数挪到第一位；`app/build.gradle` 的 `verifyFramework` 去掉 `useJUnitPlatform/includeTags`，改纯类过滤 |
| 4 | `FrameworkContractTest.kt` | 语法错误 `Unexpected tokens`（多余右括号）；测试名含 `.` / `/` 非法 | 原文件 `findServerSourceDir()` 里多一个 `)`；JUnit/Kotlin 测试名不允许这些字符 | 补全括号；测试名改成中文顿号 |

**另外 1 个真 bug（不是编译错，是测试写错）**：`ConnectionSelectorTest` 用
`object : ConnectionSelector {}` 匿名对象注册策略，但注册表按 `selector::class.simpleName` 取 id
（`ConnectionSelector.kt:62`），**匿名对象的 simpleName 是 null** ⇒ `register` 直接返回 false。
改成具名类（`SecondSelector` / `NullSelector`），并**新增一条用例专门钉住这个约束**：
「匿名对象不能注册，因为 simpleName 为空」。这是文档里"外部策略用命名类"的实际含义。

#### 真跑结果（本轮实测）

| 项 | 结果 |
|---|---|
| `npx tsx test/ApiCatalog.test.ts` | **3/3 PASS**（139 端点 / 19 组，与 `agent-api.json` 双向一致） |
| `npm test`（前端） | **639 / 639 PASS** |
| `./gradlew :app:test`（后端，当时写作 `:server:test`） | **472 条，1 失败**；失败项 `E2EScenariosTest > scenario 2` **在既有基线 `server-test-failures-47.txt` 里** ⇒ **零回归**（基线 47 条中有 46 条本次直接通过，正是 `LEGADO_TEST_TMP` 把临时库挪出系统盘的效果，`app/build.gradle:18-21` 早就写明） |
| `./gradlew :server:verifyFramework` | **6/6 PASS**（`FrameworkContractTest` 5 + `PluginFrameworkHasNoContentTest` 1） |
| `./gradlew :server:fatJar` | 成功，`legado-server-0.8.3-all.jar` 32.2 MB |
| 探针实例（1399） | `/healthz` → `{青阅, 0.8.3, ok}`；`/api/catalog` count=139 / 19 组；`/api/plugins` → tools=39 providers=1 selectors=1 failures=0；`/api/sources` 5596；`/api/bookshelf` 1 本 |
| AI 接入面 | `manifest` enabled=false、connections 空；`chat` 无连接 → **409 no_connection**；注册不可达连接后 `chat` → **502 upstream_unreachable**（两条与 AGENTS.md §4 逐字一致） |
| 同源写门 | 跨站 `Origin` → **403 cross_origin**；同源 Origin / 不带 Origin → 放行（**印证了本轮修掉的那条文档错误**：不带 Origin 是放行，不是拒绝） |
| 离线链路 | 书架那本书已缓存 **2095 章**，`POST /api/books/content` 从缓存取到「第26章 莫要心慈手软」2200 字正文（**不依赖外网**） |
| 前端产物 | jar 内 SPA 引用 `assets/index-B48lGmB6.js`，与 `web/dist/assets/` 实文件一致 |

**本轮唯一没验成的**：真实联网搜索。`Invoke-WebRequest https://www.00xiaoshuo.net/` 报
`The SSL connection could not be established` —— 本机出站 HTTPS 被环境挡住（与产品无关）。
所以「搜索 → 详情 → 目录 → 正文」这条**联网**链路没跑通，只跑通了**离线/缓存**那半段。
下次换有网环境先补这一条。

### 2026-10-21 第四轮：把 0.8.3 那批未提交改动研究了一遍

`legado/` 里有 **77 项未提交改动**（65 改 + 3 改名 + 1 删 + 12 新增，约 +839/−867 行），
是 0.8.3 的主体工作（不是本会话产物）。研究结论分三块。

#### A. 这批改动到底在做什么（4 条主线）

1. **删掉"本地兜底"，让 AI 结果不再真假难辨**。删除 `ai/LocalComprehension.kt`（133 行），
   `Agent.comprehend` / `Agent.chat` 在"没连接"和"外呼失败"时**不再伪造一段本地文本**，
   改为返回 `error` 码，由 HTTP 层映射成明确状态码。`ChatOutcome` / `ComprehendOutcome`
   的 `fallback` 字段整个删掉。理由写在注释里："拿本地关键词抽取冒充模型结果，会让调用方分不清真假"。
2. **"连哪个连接"做成可插拔**。新增 `ai/ConnectionSelector.kt`（`ConnectionSelector` 接口 +
   `FirstProfileSelector` 默认实现 + `ConnectionSelectorRegistry`），`Agent` 通过
   `selectorRegistry` 选连接；`Plugin` 新增 `connectionSelectors()`，插件可贡献策略。
   默认仍取第一个 ⇒ **行为零变化**（AGENTS.md §4 的"不自动顺延"继续成立）。
3. **前端三层分家**：`lab/`=容器、`extensions/`=契约、`plugins/`=插件、`features/`=随包功能。
   AI 接入从 `plugins/aiPanel.tsx` 挪到 `features/ai/labEntry.tsx` —— **AI 是功能不是插件**。
   同时删掉契约里 `pages` / `commands` 两类（宿主没实现，留着是空承诺）。
4. **PWA 更新策略换成 autoUpdate**：删掉"发现新版本 → 点立即更新"的 toast（与自动刷新打架），
   改为新 SW 接管后**等页面空闲再刷新**；注册收敛成单例 `lib/swRegistration.ts`。

#### B. 我在研究里挖到并修掉的 1 个真实缺陷（数据丢失）

`AgentProfileStore.ProfileKind` 把 `builtin-stub` 枚举**删了**（0.8.2 及更早的内置本地连接类型），
但 `readPersisted()` 是**整份** `decodeFromString` + `getOrDefault(emptyList())`。
后果：老用户配置里只要还有一条 `"kind": "builtin-stub"`，**整份文件解析失败 ⇒ 所有外部连接一起消失**，
界面只显示"未连接外部模型"，且没有任何报错提示 —— 人根本想不到是一条老记录把整份配置带崩了。

**实测复现**（构造老配置 + 新 jar，端口 1397）：

| 配置内容 | 修复前 | 修复后 |
|---|---|---|
| `[builtin-stub "local", openai-compatible "my-gw"]` | `[]`（**两条全丢**，enabled=false） | `[my-gw]`（只丢坏的，好的保留） |
| `[openai-compatible "my-gw"]` | `[my-gw]` | `[my-gw]` |

修法：`readPersisted()` 改成 `parseToJsonElement` 后**逐条** `decodeFromJsonElement`，
坏的那条跳过并在 stderr 留一行说明（含 id 与"老版本 builtin-stub 可安全删除"），其余照常恢复。

#### C. 这批改动的质量评估

**做得好的**（都实测过）：
- 删能力删得干净：`LocalComprehension` / `toLocalOutcome` / `fallback` / `needRefresh` /
  `pwa-update-toast` / `SKIP_WAITING` / `PluginPage` / `PluginCommand` 全仓 grep **零残留**。
- 错误码与 HTTP 状态码**逐条对齐**：`no_connection`→409、`upstream_unreachable`/`tool_rounds_exhausted`→502、
  `empty_messages`→400，且每个都有中文 message。
- 判据跟着改：`FrameworkHasNoContent.test.ts` 升级成守三层依赖方向，并新增
  「AI 是功能不是插件」「内置插件清单不含 AI」两条。**我构造了一个违规文件实测，判据确实会红**（不是摆设）。
- 插件卸载时同步注销新增的 `selectors`（漏了会撞 id）—— 这条最容易漏，作者补上了。
- `agent-api.json` 契约同步更新（仍是 139 条 / 19 组），`ApiCatalog.test.ts` 3/3 绿。

**需要注意的**（未改动，留给人决定）：
- `agent-profiles.json`（运行时配置，当前内容 `{"profiles": []}`）**未被 .gitignore 忽略**，
  以未跟踪状态挂在仓库根。现在内容无害，但一旦有人往里填了 `apiKey`，`git add .` 就会把密钥提交进去。
  建议加进 `.gitignore`（与 `.env` 同级待遇）。
- `web/vite.config.ts` 有改动但 diff 很小（`injectRegister: null`），已由 `PwaUpdateStrategy.test.ts` 钉住。

#### D. 本轮回归结果

| 项 | 结果 |
|---|---|
| 前端 `npm test` | **639 / 639 PASS** |
| 前端 `npm run check`（tsc） | 通过，无输出 |
| 后端 `:server:test` | **472 条，1 失败**，失败项在既有基线内 ⇒ **零回归**（含我加的迁移修复） |
| `ApiCatalog.test.ts` | **3/3 PASS** |
| `FrameworkHasNoContent.test.ts` | **6 过 1 红**（红的那个是我故意构造的违规探针，删掉即恢复绿） |

---

## 3. 对外契约与一致性闸门（关键设计）

**机器可读契约 = `GET /api/catalog`**（即 `legado/app/src/main/resources/agent-api.json`）。

- 真实计数：**142 端点 / 19 组**（= 18 个业务/功能分组 + 目录组；系统组 8 条含 `GET /api/plugins`）。
- 生成：`scripts/gen-api-reference.mjs`（实际在 `legado/scripts/`）从运行实例拉 `/api/catalog` 生成 `docs/API-REFERENCE.md`（已生成：142 / 0.8.4 / 2026-10-23）。

### 双向核对闸门：`web/test/ApiCatalog.test.ts`

它**只守 JSON ↔ 代码**，不守散文文档：
- 扫 `http/` 整目录所有 `*Routes.kt`，按缩进还原嵌套路由；
- 识别 `for (verb in listOf(...)) { method(verb) {…} }` 这类动态方法注册（内置浏览器子资源代理正是此处）；
- write 门看处理器自身有没有 `requireSameOriginWrite()` / `sameOriginCall(...)`，不靠 HTTP 方法猜；
- 与 `agent-api.json` 全量比对：路径 / 组 / write 标志 / response / purpose 任一漂移即判红。

> 后果：线上 API 契约是锁死的（142 / 19 组自洽），照着 catalog 调用的外部程序不会踩坑。**散文文档**（`docs/ARCHITECTURE.md`、`legado/docs/*`）才会过期——见 §7。

---

## 4. 代码结构速查

### 后端 Kotlin（`legado/app/src/main/kotlin/io/legado/`）

| 包 / 文件 | 职责 |
|---|---|
| `Application.kt` | CIO 引擎装配；`callGroupSize=64`（默认=核数）防"停读客户端阻塞写"拖死搜索；`main` 与 `DesktopLauncher` 共用 `createLegadoEngine` |
| `Routes.kt` | 装配点，只留「目录 / 系统」两组共 9 端点（目录 1 + 系统 8）+ 13 个组挂载 |
| `http/*.kt` | 13 个 `<组>Routes.kt` → 合成 142 端点；`Guard.kt`（同源闸）、`NetworkSecurity.kt`（SSRF 出站闸门）、`StaticWeb.kt` |
| `ai/` | `AgentConnection`（进程内句柄）、`Agent`、`ToolRegistry`、`ToolHooks`、`Guardrails`、`AgentContext`、`BuiltinTools`、`AgentProfileStore`、`OpenAiCompatibleProvider` / `LlmProvider`（LLM 协议可插拔） |
| `plugin/` | `PluginManager`（三路径发现）、`Plugin`、`EventBus`、`AppEvents` |
| `data/` | `Database.kt`（WAL、连接池、迁移）+ 11 个 `<面>Dao.kt` |
| `rules/` `content/` `source/` `localbook/` `tts/` `cache/` `backup/` `subscription/` `ops/` | 规则引擎、内容管线、书源、本地书、朗读、缓存、备份、订阅、运维 |

### 前端 TS/TSX（`legado/web/src/`，约 128 文件）

- `app/`（壳：`pages.tsx`、`destinations.ts`）、`reader/`（阅读器内核）、`shelf/`、`sources/`、`pages/`
- **LAB 框架**：`lab/Lab.tsx` + `lab/FloatingWindow.tsx`（悬浮容器：位置/钉住/最小化/记忆）
- `plugins/`：**纯登记面**（about/backup/changelog/sourceHealth/readingLog/windowPrefs 面板 + `labHost.tsx` 装配点 + `pluginIntro.tsx`）—— 框架只做框架，无自身内容
- `features/`：实验条目（含 `features/ai/labEntry.tsx` 对话助手）

---

## 5. 两大扩展面（0.8.3 重点）

### A. AI 自定义接入 `/api/agent/*`（8 端点）

- 不是第二套 HTTP 服务，是进程内 `AgentConnection` 网关的薄收口：`/api/agent/chat`、`comprehend` 直接委派 `Agent`。
- 外部模型仅 `openai-compatible`（或插件提供的 `LlmProvider`），**无本地兜底**：无连接 `409 no_connection`，外呼失败 `502 upstream_unreachable`。
- 多连接只走 `agent-profiles.json` 里**第一个**，不自动 failover。
- `AgentConnection.registry/hooks/providerRegistry` 允许运行时增删工具、挂审计/限流钩子、换 LLM 协议——**均不产生 HTTP 路由**，所以 `/api/catalog` 计数恒定（142）。

### B. 插件框架（0.8.3 新）

- 红线（用户原话"只做框架，不要有任何自己的内容"）：`PluginManager` 不认识任何具体插件，只做发现 / 装载 / 自描述。
- 三条发现路径：`register`（代码内）、`discover`（ServiceLoader 扫 `META-INF/services`）、`discoverFrom`（指定目录 jar，真·外部插件）。
- 三条安全不变量：①一个坏插件不拖垮别的（失败进 `loadFailures`）；②插件不注册 HTTP 路由（端点计数恒定）；③卸载彻底（内置工具撤不掉）。
- `GET /api/plugins` 把装载状态暴露给界面——装没装上、为什么没装上必须可见。

---

## 6. 安全模型要点

- 同源闸比对 `ServerIdentity`（绑定 host/port），**不是**请求头 `Host`（防 DNS 重绑定）。
- `GET/HEAD/OPTIONS` 放行；`POST/PUT/DELETE` 需同源 `Origin`；WebSocket 把"无 Origin"当跨站拒掉。
- 出站 SSRF 闸门（`NetworkSecurity`）：拒内网 / 链路本地 / 保留段。
- **`LEGADO_HOST=0.0.0.0` = 把整库写权限交给局域网**，文档必须点破。

---

## 7. 文档漂移的收口位置

线上契约自洽，只有散文文档会过期。两张对照表都在 **§2**：`2026-10-20` 那批（版本号 / 端点数）
与 `2026-10-21` 那批（表数量 / `book_mark` / 文档索引份数）。改文档前先看那两张表，别重复踩。

遗留说明：`legado/AGENTS.md` 里的 `0.8.2` 是**历史叙述**（v0.8.2 发行包实测、`version=dev` 的坑），
非"当前版本 0.8.2"的漂移，保留。该文件 §6 的端点数已与契约一致（139 条 / 19 组）。

### 运行态留痕

`legado/hs_err_pid12944.log` —— 2026-10-20 07:41 JVM OOM（**Gradle daemon**，`-Xmx6g`，arena 分配失败），非服务进程本身。提示本机（8 核 / 23GB）有内存压力，但与 1234 服务无直接证据关联。

---

## 8. 基础框架的分层纪律（2026-10-20 读源码实证）

用户原话："咱们做的是基础框架，能够包容一切的框架，不要有任何自己的内容。" 这句话不是风格，是
用**代码结构 + 判据测试**落地的硬约束。读 `plugin/`、`ai/`、`web/src/{lab,extensions,plugins,features}`
与 `FrameworkHasNoContent.test.ts` 后，可拆成四条可验证纪律：

### 8.1 框架只立钩子，内容交给外部（"零内容"红线）

- 后端：`PluginManager` / `Plugin` 接口**不认识任何具体插件**，只定义"插件长什么样、怎么被发现、
  怎么装进进程、怎么介绍自己"（`Plugin.kt` 注释原话）。装什么、做什么完全由插件作者决定。
- 前端：`web/src/lab/Lab.tsx` 是**纯容器**（悬浮窗 + 实验条目登记位），不 import 任何具体功能；
  `web/src/extensions/registry.ts` 是**契约**（定义 `FrontendPlugin` / `LabEntry` 形状），不依赖
  `plugins/`、`features/`。AI 接入只是"登记了一条实验条目"，不是实验室里写死了 AI。

### 8.2 依赖方向单向：内容 → 框架（判据钉死）

- `FrameworkHasNoContent.test.ts` 守的不只是"有没有某词"，而是**依赖方向**：
  - `lab/`、`extensions/` 不许 `import '../plugins/...'` 或 `'../features/...'`（框架依赖内容 = 夹带，判据红）；
  - `plugins/`、`features/` 可以依赖 `lab/`、`extensions/`（内容依赖框架，正常）；
  - `Lab.tsx` 里不许出现 `AiConnections` / `openai` / `api/agent` / `书源` / `朗读` 等具体字样；
  - 装配点必须在 `plugins/labHost.tsx`（内容侧决定装什么），且不得硬编码 `title`/`description`。
- AI 是**功能条目**（`features/ai`），不是插件：判据要求 `features/ai/labEntry.tsx` 不实现
  `FrontendPlugin`、不往插件注册表登记；内置插件清单（`plugins/index.ts`）不含 AI。

### 8.3 扩展点只增"能力"，不增"HTTP 路由"（端点计数恒定）

- 后端两条扩展面都**不注册 HTTP 路由**：
  - 插件：`PluginManager` 注释明确"插件不能注册 HTTP 路由，端点计数恒定（ApiCatalog 门禁照旧）"；
    插件只能通过往 `ToolRegistry` 加工具来暴露能力，工具天然能被 `/api/agent/*` 调到。
  - AI：`AgentConnection` 是**进程内网关**（不额外开端口、不注册路由），`/api/agent/*` 只是薄收口
    （解析参数 → 委派 `Agent` → 包成响应）；`AgentConnection.registry/hooks/providerRegistry`
    允许运行时增删工具、挂钩子、换 `LlmProvider`，**均不产生新路由**。
- 推论（已比对契约确认）：`/api/catalog` 恒为 **142 端点 / 19 组**，与插件、AI 工具数量无关。
  `ApiCatalog.test.ts` 双向核对门禁照常成立。

### 8.4 框架守纪律，不让扩展破坏既有约束（三条硬门）

- 后端插件三条安全不变量（读 `Plugin.kt` / `ToolRegistry.kt` / `PluginManager.kt`）：
  1. **一个坏插件不拖垮别的**：`onLoad`/`tools()`/`hooks()` 抛异常只进 `loadFailures()`，其余照装。
  2. **内置工具永远在**：`ToolRegistry` 默认拒绝删内置 id（`allowRemovingBuiltin=false`），防止插件
     把 `source.delete` 之类核心能力悄悄摘掉；id 重复也默认拒绝覆盖（防互踩）。
  3. **钩子不能绕过护栏**：`PluginHooks` 在工具**外面**，只能拒绝/改写，不能替工具跳过写前确认。
  - 卸载要彻底：插件带来的工具、LLM 协议、钩子、事件订阅全部撤销（漏了会撞 id 或留失效回调）。
- 前端注册表同一纪律：id 重复/空则拒绝并留痕；`FrontendPluginRegistry` 是模块级单例，提供 `reset()`
  给测试/热重载用；版本号禁止字面量（唯一来源 `/healthz`），随程序发布的插件用 `HOST_VERSION` 占位。

### 8.5 判据测试是"框架纪律"的守护者（不是装饰）

- 后端：`PluginFrameworkTest`(19) / `LlmProviderFrameworkTest`(10) / `AiAsPluginTest`(3，证明"内置 AI
  可由插件提供"端到端：拿掉内置→插件装回→对话可用→卸载干净→可重装) / `EventBusTest`(14) /
  `BusinessEventsTest`(5) / `AgentToolCallingTest`(8)。
- 前端：`FrameworkHasNoContent.test.ts`（依赖方向 + 容器零内容）、`LabPluginFramework.test.ts`、
  `HeaderMenu.test.ts`（禁止前端出现字面量版本号）。

> 一句话总结：青阅 0.8.3 的"框架"不是营销词——它由**纯容器 + 纯契约 + 单向依赖 + 判据测试**
> 四件套保证"只立钩子、不夹带内容"，扩展只能以"工具/实验条目/设置分区/LLM 协议"的形态注入，
> 且永远不能新增 HTTP 路由或绕过既有护栏。

---

## 9. 后续会话可直接复用的结论

- 改版本 → 只动 `legado/app/build.gradle`，`agent-api.json` 与两个 `package.json`、父仓库 `VERSION` 同步更新。
- 加/改 HTTP 端点 → 必须同时在 `agent-api.json` 登记，跑 `npx tsx web/test/ApiCatalog.test.ts` 比对。
- 插件 / AI 工具 **不**增加 `/api/catalog` 计数（已读源码确认：两条扩展面都不注册路由）。
- 对外契约以 `/api/catalog` 为准，不手抄。
- 框架纪律（§8）是硬约束，动 `lab/`、`extensions/`、`plugin/` 前先看 `FrameworkHasNoContent` 与
  `PluginFrameworkTest`，别让框架依赖内容或新增路由。
- 本会话未能真机探测 1234（沙箱坏 + localhost 禁），运行版本以 `curl http://127.0.0.1:1234/healthz` 为最终确认手段。
- **沙箱里 `pwsh` 会整个不可用**（2026-10-21 亲身踩过）：报
  `DSH workspace preparation failed (not a user permission denial):`，无更多正文，连 `echo hi` 都不行；
  换 `danger-full-access`、换 workdir 都一样。**文件类工具（读 / 写 / grep / glob）不受影响** ——
  所以表数量、端点分组、文档份数这类核对照样能做完，只有"跑测试 / 打 jar / 真机打接口"必须等 shell 恢复。
  恢复办法见 skill `diagnose-windows-sandbox-acl`（Windows 文件权限诊断，需完全权限跑那一条命令）。
  本例中用户直接把会话切到完全权限后，shell 立刻恢复。
- 恢复 shell 后**第一件事应该是编译**：前三轮静态核对全部通过，一编译就暴露出 4 个"编译不过"。
  "文档与代码看着对"和"能构建"是两件事，别把静态核对当验证。
