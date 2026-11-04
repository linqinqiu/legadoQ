# 架构审计：三份外部重构报告的核对与"钉住现状"的三条纪律

> 状态：**已落地**。本文记录的是对三份外部架构建议（Kototoro 规则内核端口化、ifc-lite 声明式 Widget 扩展、legado-with-MD3 Feature-first + convention plugin 等）逐条**拿仓库真实代码核对**后的结论，以及据此刻意保留、并由 `ArchitectureBoundaryTest` 钉住的三条边界。
>
> 判据文件：`app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt`（零依赖，JUnit 4，单模块 `:app`）。取证方式：文件系统 + 实跑命令，非文档转述。

## 1. 结论先行

三份报告的方向都对，但它们描述的是**上游 Legado 家族的形态**，而 legadoQ 已经把最关键的一层重写掉了。逐条核对后，绝大多数"下一步该做的解耦/抽象"**要么已完成、要么是为不存在的消费者预付成本**。真正还开着、且值得钉住的只剩三条边界，全部由 `ArchitectureBoundaryTest` 守住，**不新建 Gradle 模块、不引入 ArchUnit、不赌未来扩展消费者**。

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

`JsSandbox.kt` 的 `createJavaBridge` 用 `putProperty(api,"…")` 把宿主能力投影给脚本（`ScriptableObject.putProperty(scope,"java", …)`），**共 68 个方法**。取证语料：`legado-releases/qingyue-portable-0.8.6/data/legado.sqlite`，**5598 个源、其中 2019 个含 JS**，正则扫 `java\.[A-Za-z0-9_]+` 得到每方法调用次数。

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

被钉住的三条硬边界：

| 边界 | 现状 | 处置 |
|---|---|---|
| `rules → data` **28→13** | 初 23 条具体 import；**Cookie 组(6)+Variable 组(4) 已端口化**（`Database.asCookieStore()/asVariableStore()` → `io.legado.port` 接口，rules 不再 import 这些扩展） | 剩 13：脚本缓存 3 + 登录态 5 + Database 句柄&读 4（+WebViewProxy 环 1）。基线 24→14 |
| `rules ↔ source` **成环** | `rules→source.WebViewProxy` 2、`source→rules` 4 | 基线冻结 `source.WebViewProxy` 1 条，待抽 `LegadoWebViewFetcher` 端口断环 |
| `NetworkSecurity` 曾住 `http/` | `rules→http.NetworkSecurity`、`ai→http` 6 向上够安全原语 | **已下沉**：`NetworkSecurity` + `GuardedHttpClient` 整体搬到 `io.legado.ops`（纯 JDK 自包含安全单元），`rules→http` 边清零，基线 25→24 |

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
- **P1 = `ScriptCachePort`(3) + `LoginStatePort`(5)**。
- **P2（最后）= 剩余 5 条**：`data.Database` 是**锚**——只要 `RuleRunner` / `JsSandbox` 还持有 `Database?`，这条 import 就消不掉。真正清零要把这两个宽句柄换成窄端口集合，并把 `getSource/shelfBook/getTocCache/getEnabledReplaceRulesForScope` 归入一个只读投影端口。**这一步风险最高**（牵动 930 项测试的构造注入），单列一轮做。
- 每消一组，除了从 `RULES_CONCRETE_BASELINE` 删条目，还应**在同测试文件加正向断言**：`rules→data` import 集合 == 基线（等值，非子集），杜绝端口化过程中又有人新 import `data` 具体类。

## 4. 变更流程（比测试更重要：测试防回退，流程防"顺手加一个"）

- **新增桥方法**：必须同时 (a) 附**至少一份真实书源** `java.<方法>` 使用举证；(b) 更新 `ArchitectureBoundaryTest.BRIDGE_WHITELIST`；(c) 在本文 §2 记一行（归属哪个能力类/端口）。三者缺一，测试红。
- **新增 rules→data/source/http 横穿**：默认禁止。确需时先在本文论证，并走端口化；临时豁免须进 `RULES_CONCRETE_BASELINE` 且**带 issue 编号 + 到期日**。基线**只能单调缩小**——测试断言相等，条目被消掉却不删基线同样红。
- **model 反向依赖**：无豁免通道，当前 0，任何非零直接红。
- **裁剪桥方法**：先扩大语料（多份社区书源包）复扫确认全网零调用，再从 `BRIDGE_WHITELIST` 移除；测试会因"少一个未同步"逼迫这次删除是显式的。

## 5. 有意不做的事

Gradle 多模块 / convention plugin、Widget DSL / slot catalogue / 命令分发、KMP / 新宿主 / server 瘦身、重做规则内核三层、`SourcesRoutes.kt` 里 Cookie 路由单飞（刚经历"过度收紧→恢复"，等本守卫立住、路由级测试补齐后再拆）。理由见 §1 对应行：或已解决，或为不存在的消费者预付成本。
