# 架构审计：三份外部重构报告的核对与"钉住现状"的六条纪律

> 状态：**已落地**（写于 2026-11-11，commit `4a98ba1` 时点的快照）。本文记录的是对三份外部架构建议（Kototoro 规则内核端口化、ifc-lite 声明式 Widget 扩展、legado-with-MD3 Feature-first + convention plugin 等）逐条**拿仓库真实代码核对**后的结论，以及据此刻意保留、并由 `ArchitectureBoundaryTest` 钉住的六条边界。
>
> 判据文件：`app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt`（零依赖，JUnit 4，单模块 `:app`）。取证方式：文件系统 + 实跑命令，非文档转述。
>
> **分工**：本文=对三份外部重构报告的审计（写于当次 commit 的快照）；**现行全景架构→[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)**；规模数字→[`restructure/facts.md`](restructure/facts.md)；重组过程记录→[`restructure/`](restructure/)。

## 1. 结论先行

三份报告的方向都对，但它们描述的是**上游 Legado 家族的形态**，而 legadoQ 已经把最关键的一层重写掉了。逐条核对后，绝大多数"下一步该做的解耦/抽象"**要么已完成、要么是为不存在的消费者预付成本**。真正还开着、且值得钉住的边界，加上一条实测已为 0 的零基线锁，共六条，全部由 `ArchitectureBoundaryTest` 守住，**不新建 Gradle 模块、不引入 ArchUnit、不赌未来扩展消费者**。

| 报告主张 | 仓库实测 | 判定 |
|---|---|---|
| 引擎是 `AnalyzeRule`，焊死 Android/持久化，脱不开 Ktor 单测；要抽 `rule-core/rule-bridge/rule-host` | 无 `AnalyzeRule`；引擎是 `RuleRunner`（类注释自陈 server-safe）。`Models.kt` 零持久化注解；离线测试 `RuleRunner({ url -> … })` 不传 Database、不起 Ktor 即跑通 | **已解决**，三层抽取不必重做 |
| 规则内核完全端口化 | **部分未**：`rules → data` 23 条具体 import（变量/ Cookie/ 登录态/ 脚本缓存仍走 `data.*` 实现），`rules → source.WebViewProxy`（与 `source → rules` 成环），`rules → http.NetworkSecurity`（SSRF 闸门住错层） | **真缺口**，抽 `VariableStorePort/CookieStorePort/WebViewFetcher` + 下沉 `NetworkSecurity` |
| 前端插件携带 JSX 不安全，要走声明式 Widget DSL + slot catalogue + 命令分发 | `extensionRegistry.Extension = ComponentType`（确是 JSX），但 AGENTS.md 明确"插件装载机制已移除"，5 个内置扩展同 bundle 同 React 版本，**无第三方扩展消费者** | **不成立**，四类风险（信任边界/宿主升级/跨端/a11y）都建立在不存在的外部扩展面上，DSL 属预付抽象税 |
| 配置层没做厚：主题"可能硬编码"、快捷键"可能硬编码"、reader.json 待建 | 主题 = CSS 变量（`styles.css` `--canvas/--surface/--ink…`）+ `SkinModal.tsx`；快捷键 = `shortcuts.ts` 单一真源表 + `ShortcutHelp.tsx`；热区 = `TapZoneEditor.tsx`；阅读行为 = `readerSettings.ts` | **不成立**，四项均已交付，撤掉该条 |
| 拆 `:core/:server/:desktop-renderer` 多模块 + convention plugin 锁依赖 | `settings.gradle` 仅 `:app` 单模块，无 `core/` 包，"core 变上帝模块"风险当前不存在 | **超前**，单模块用边界测试即可 |
| 书源调试应做成 CLI 以证明内核独立性 | `source/SourceDebugger.kt` 已进程内 + `/api/sources/{id}/debug` SSE；内核独立性已被离线测试证明 | **证据已产出**，CLI 锦上添花 |
| `book_sources` 里 last_read_at 索引缺失等 | 属并行重构范畴，见 sessions 记录 | 不在本文范围 |

## 2. `java` 桥暴露面（`createJavaBridge`）

`JsSandbox.kt` 的 `createJavaBridge` 用 `putProperty(api,"…")` 把宿主能力投影给脚本（`ScriptableObject.putProperty(scope,"java", …)`），**共 68 个方法**。取证语料：`E:\legado-out\legado-releases/qingyue-portable-0.8.6/data/legado.sqlite`（2026-11-11 从仓库内移出），**5598 个源、其中 2019 个含 JS**，正则扫 `java\.[A-Za-z0-9_]+` 得到每方法调用次数。

### 2.1 高频（真实依赖，必须保留）

`ajax`(1454) `log`(1406) `getString`(1331) `get`(1254) `put`(988) `toast`(794) `md5Encode`(790) `longToast`(350) `timeFormat`(306) `getElements`(254) `base64Encode`(241) `startBrowserAwait`(171) `toNumChapter`(146) `base64Decode`(142) `md5Encode16`(133) `base64DecodeToByteArray`(115) `startBrowser`(110) `getStringList`(107) `encodeURI`(102) `setContent`(98) `post`(83) `getElement`(75) …

### 2.2 零调用（12 个，候选裁剪，但**不就地删**）

`aesDecodeToBase64` `copyText` `desBase64DecodeToString` `desDecodeToString` `desEncodeToString` `digestBase64Str` `getKey` `getStrResponseAwait` `md5` `openWeb` `reUiView` `refreshBookToc`

不直接删的原因：① 这是**单份快照语料**，零调用 ≠ 全网没人用；`md5/aesDecodeToBase64/desEncodeToString` 多为上游历史别名（`md5Encode` 790 次在用而 `md5` 为 0，疑似旧写法），删了会砸这份库之外的社区源。② `copyText/getKey` 虽零调用但有宿主副作用，是"可安心收"的一小撮，仍需走 §4 流程。**因此本测试只冻结现状（68 全保留）防扩面，删与补都交后续扩语料举证。**

### 2.3 语料用了、桥未暴露（潜在兼容缺口，需人工定性）

`getVerificationCode`(11) `webView`(47) `refreshTocUrl`(31) `ruleUrl`(10) `initUrl`(8) `t2s`(151)

这些是"别人写好了、我们的桥不认"方向，比裁剪更值得先看。**但**其中 `t2s/ruleUrl/initUrl` 很可能是压缩脚本里 `java` 恰为局部变量的正则误命中，未逐条确认前不定性为缺口。建议后续用更长正则 + 反混淆抽样人工核验。

## 3. 领域包依赖矩阵（跨包 import 边表）

实测 `io/legado` 下 14 个领域包的 `import io.legado.<pkg>` 计数（排除包内自引）：

正常重力方向（组合根读 DTO/DAO，健康）：`http→model` 107、`http→data` 100、`data→model` 59、`ai→data` 40。
`model` **不反向依赖任何上层 = 0**（已核实，锁死）。

被钉住的六条硬边界：

| 边界 | 现状 | 处置 |
|---|---|---|
| `rules → data` **28→13** | 初 23 条具体 import；**Cookie 组(6)+Variable 组(4) 已端口化**（`Database.asCookieStore()/asVariableStore()` → `io.legado.port` 接口，rules 不再 import 这些扩展） | 剩 13：脚本缓存 3 + 登录态 5 + Database 句柄&读 4（+WebViewProxy 环 1）。基线 24→14 |
| `rules ↔ source` **已断环** | 原 `rules→source.WebViewProxy`(2)、`source→rules`(4) | `credentialDomains`/`loginPageUrl` 逐字搬到 `io.legado.port.SourceUrlProbe`，WebViewProxy 委托之（Cookie 域名闸 `allowedDomains`/`defaultStartUrl` 一行没动）；rules 改 import SourceUrlProbe，**不再依赖 source** |
| `NetworkSecurity` 曾住 `http/` | `rules→http.NetworkSecurity`、`ai→http` 6 向上够安全原语 | **已下沉**：`NetworkSecurity` + `GuardedHttpClient` 整体搬到 `io.legado.ops`（纯 JDK 自包含安全单元），`rules→http` 边清零，基线 25→24 |
| `http/` 被任何非组合根包反向依赖 | 实测 **0**（原 2 条：`ai→http.ServerIdentity`、`cache→http.proxyRequestHeaders`） | **已清零并钉成零基线**：`ServerIdentity`、`proxyRequestHeaders` 两件纯原语整体下沉到 `io.legado.ops`（与 `NetworkSecurity` 同址），新增第 4 条判据「`http/` 只能被 `http/` 自身与组合根 import」，扫描面覆盖全部 14 个非 `http` 包，**无豁免通道** |
| `engine → infra` 向上依赖 | 实测 **6 条，落在 5 个文件上**（`source/WebViewProxy.kt` 同时够 `data` 与 `ops`）。**此前这一截没有任何判据覆盖** —— 它夹在判据 2（`model→任何包`）与判据 4（`任何包→http`）之间 | **本轮新增第 5 条判据**并用基线钉住。价值不在"发现了新违规"（这 6 条一条都不新），而在**把"没人测、也没人知道多大"的一截变成可收窄的显式基线**。基线回填方式：先置空跑一次，用判据自己报出的集合写入，保证基线与实现严格相等；负向对照已验证（`content/__EngineBoundaryProbe.kt` 够 `data` → 只报这一条，证明基线不宽不窄） |
| 包间**双向依赖**（2-环） | 实测 **4 对**（组合根除外）：`data<->source`（唯一跨层真环）、`cache<->data`、`data<->ops`、`content<->rules`。含组合根的 7 对 `root↔X` 按设计排除 | **本轮新增第 6 条判据**。前五条全是**单向**的，而单向判据天然看不见环 —— `a→b` 合法、`b→a` 也合法，两条各自都过，合起来却是"这两个包其实是一个模块"，比单向横穿更隐蔽。⚠️ 该判据自带**空转哨兵**（扫描边数 < 20 即红）：它第一次写完时正则少了 `(?m)`，`^` 只匹配位置 0，一条边都没扫到却报了"无 2-环"的**假绿**；空集合永远满足这个断言，所以必须有哨兵 |

`rules→model` 12 是只读视图依赖，属**软边界**，本测试**不钉**（钉太死会逼出一堆无意义接口）。

## 3.1 `rules → data` 23 条横穿分组账本（端口化第一刀依据）

这 23 条**全部是 `fun Database.xxx(...)` 扩展函数**，经 `RuleRunner.database: Database?`（第 86 行）与 `JsSandbox.database: Database?`（第 45 行）两个宽句柄触达。按能力归类，每类对应一个待抽的窄端口：

| 端口 | 条数 | 成员（`data.` 前缀省略） |
|---|---|---|
| **CookieStorePort** | 6 | `getCookieForUrl` `setCookieForUrl` `setCookieFromSetCookie` `cookieBucket` `cookieBucketsForHosts` `removeCookieBucket` |
| **VariableStorePort** | 4 | `getSourceVariable` `saveSourceVariable` `getSourceKv` `saveSourceKv` |
| **ScriptCachePort** | 3 | `getScriptCache` `putScriptCache` `deleteScriptCache` |
| **LoginStatePort** | 5 | `getSourceLoginState` `saveSourceLoginInfo` `removeSourceLoginInfo` `saveSourceLoginHeader` `removeSourceLoginHeader` |
| **书源/书籍读取 + DB 句柄** | 5 | `Database`（类型本身）`getSource` `shelfBook` `getTocCache` `getEnabledReplaceRulesForScope` |

**切口顺序（以"基线条目单调下降"为验收）**：

- ✅ **P0 第一刀（已完成）= `CookieStorePort`(6) + `VariableStorePort`(4) = 10 条**。落地方式：`io.legado.port` 放两个窄接口，`data` 侧 `DatabaseCookieStore/DatabaseVariableStore` 适配器**委托既有扩展（不删扩展，http/ai 调用零波及）**，`Database` 加成员 `asCookieStore()/asVariableStore()`。rules 改调 `db.asCookieStore()?.xxx(...)`——返回类型靠推断、rules **连 `io.legado.port` 都不用 import**。做完 `rules→data` 23→13、总基线 24→14（930 项测试全绿）。
- ✅ **P1（已完成）= `ScriptCachePort`(3) + `LoginStatePort`(5)**：同 P0 手法（`Database.asScriptCacheStore()/asLoginStateStore()` 委托扩展，rules 改走成员、不 import 端口类型）。基线 14→6。行为由 `StorePortEquivalenceTest` 锁「端口↔扩展」等值。
- ✅ **P-final-A（已完成）= 只读投影 `KernelReader`(4)**：`getSource/shelfBook/getTocCache/getEnabledReplaceRulesForScope` 经 `Database.asReader()` 端口化（同 P0/P1 手法，零构造波及）。基线 **5→1**。
- ✅ **P-final-B（已完成，基线清零）= 宽 `data.Database` 句柄（最后 1 条）**：实测发现 `rules/` **从未调用 `Database` 的任何原始方法** —— 所有调用都经由 `asCookieStore()`(10) / `asVariableStore()`(4) / `asScriptCacheStore()`(3) / `asLoginStateStore()`(14) / `asReader()`(5) 这组适配器访问器。也就是说这条横穿**只剩一个类型名**，能力面早已收敛。于是把这组访问器提成 `io.legado.port.PortBundle` 接口、让 `Database` 实现它，`rules/` 只认接口。
  > ⚠️ **本条原先的预判是错的，此处更正**：原文写「清零要把两个宽句柄换成端口集合（`KernelPorts`），牵动 `Application.kt` + **49 个 `RuleRunner(db)` 测试构造点**，是面最广、需专门一轮」。那个预判假定**必须把 5 个端口作为独立参数传进构造器**，于是每个构造点都要改写 —— 但换一种接口形状就不必：让 `Database` **实现** `PortBundle`，`Database` 就是它的子类型，`RuleRunner(db)` 等 **53 个既有构造点因类型兼容一处都不用动**。实际改动只有 1 个新接口文件 + `Database` 声明 + 4 个文件里的类型名。
  > 教训：**"牵面最广"往往是接口形状选出来的，不是问题本身的属性。** 评估重构面之前先问一句"能不能让改动只落在类型关系上"。
  现在 `rules→data` / `rules→source` / `rules→http` **均为 0**，`RULES_CONCRETE_BASELINE = emptySet()`，判据 3 与判据 2、4 一样是**零基线无豁免**。负向对照已验（探针 `rules/__BoundaryProbe.kt` 的 `import io.legado.data.Database` 使其精确变红）。
- 每消一组，除了从 `RULES_CONCRETE_BASELINE` 删条目，还应**在同测试文件加正向断言**：`rules→data` import 集合 == 基线（等值，非子集），杜绝端口化过程中又有人新 import `data` 具体类。

**Stage B 触发判据（何时才该从 `:app` 单模块升级为独立 Gradle 模块）**——借 legado-with-MD3 的 Stage A/B/C 纪律，但**不照搬它的 Compose/MVI**：

- legadoQ 当前**主动停在 Stage A**（`:app` 内 feature-first 包 + `ArchitectureBoundaryTest` 钉边界），起点比 MD3 干净得多（MD3 从 803 个混杂文件的 `ui/` 往外理，这里只有 14 个领域包 + 6 条横穿）。"不建模块"不是保守，是与 MD3 同构的**低成本等价选择**——ArchUnit 式等值断言 + 例外清单已经能钉住边界。
- 只有满足以下**真实依赖证据**才升 Stage B（独立 `:port` / `:feature` 模块），不为"看起来该拆了"而拆：
  1. 端口层（`io.legado.port`）被 **≥3 个消费者**依赖（例如 `rules/`、未来的 CLI 调试工具、第三宿主同时用），且
  2. **每个消费者只用其中 ≤2 个方法**（依赖集明显小于整体），或某 feature 被两个宿主同时消费；
  3. 且文件移动 / 业务重构 / 模块抽取**不在同一个 PR** 里混做（MD3 的评审教训）。
- 在此之前，端口接口零外部依赖、只被 `rules`↔`data` 两家够着，建模块的收益抵不过构建配置成本 → **保持 Stage A**。

## 4. 变更流程（比测试更重要：测试防回退，流程防"顺手加一个"）

- **新增桥方法**：必须同时 (a) 附**至少一份真实书源** `java.<方法>` 使用举证；(b) 更新 `ArchitectureBoundaryTest.BRIDGE_WHITELIST`；(c) 在本文 §2 记一行（归属哪个能力类/端口）。三者缺一，测试红。
- **新增 rules→data/source/http 横穿**：默认禁止。确需时先在本文论证，并走端口化；临时豁免须进 `RULES_CONCRETE_BASELINE` 且**带 issue 编号 + 到期日**。基线**只能单调缩小**——测试断言相等，条目被消掉却不删基线同样红。
- **model 反向依赖**：无豁免通道，当前 0，任何非零直接红。
- **任何包反向依赖 api**（`http/` 被 `http/` 自身与组合根 `Application.kt` / `StaticWeb.kt` 之外的包 import）：**无豁免通道**，当前 0，任何非零直接红。清法有两种，按被依赖物的性质选：内核要的能力 → 下沉成 `port/` 端口；基础设施要的纯原语 → 整体搬到 `ops/`（`NetworkSecurity`、`ServerIdentity`、`proxyRequestHeaders` 都是这么下来的）。
- **裁剪桥方法**：先扩大语料（多份社区书源包）复扫确认全网零调用，再从 `BRIDGE_WHITELIST` 移除；测试会因"少一个未同步"逼迫这次删除是显式的。

## 5. 有意不做的事

Gradle 多模块 / convention plugin、Widget DSL / slot catalogue / 命令分发、KMP / 新宿主 / server 瘦身、重做规则内核三层、`SourcesRoutes.kt` 里 Cookie 路由单飞（刚经历"过度收紧→恢复"，等本守卫立住、路由级测试补齐后再拆）。理由见 §1 对应行：或已解决，或为不存在的消费者预付成本。
