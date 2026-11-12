# 书源 JS 沙箱：宿主侧逃逸面审计

> 审计对象：`product/app/src/main/kotlin/io/legado/rules/JavaPackages.kt`
> 审计日期：2026-11-08
> 结论：**类层防护是 deny-all（强），风险全部集中在手写替身白名单内部**

---

## 0. 这套沙箱是怎么工作的（先看这个，否则会误判）

legadoQ 执行用户导入的「书源」里的 JavaScript，那是**不可信代码**。防护有三层：

| 层 | 机制 | 位置 |
|---|---|---|
| 1 | **拒绝一切真实 Java 类**：`setClassShutter(ClassShutter { false })` | `JsSandbox.kt`、`RuleRunner.kt` 的 `callOptional` |
| 2 | **手写替身白名单**：纯 Kotlin 实现 `Packages.java.lang.Thread` 等「假类」 | `JavaPackages.kt` |
| 3 | **墙钟守卫**：Rhino 每 2 万条指令回调一次，超时抛错 | `JsGuard.kt` |

**第 1 层比上游更强。** `legado-with-MD3` 用的是**黑名单**（挡 `Runtime`/`ProcessBuilder`/`File`
等一串危险类），而 deny-all 让任何类都取不到 —— 黑名单漏一个类就被绕过，denial-all 不会。
所以「是否该移植上游的 ClassShutter」这个问题，答案是**不需要，我们已经是更强的形态**。

**但第 3 层有个结构性盲区，这是本次审计的全部由来：**

> `observeInstructionCount` 只在执行 **Rhino 指令**时被回调。
> 凡是开销发生在 **JVM 宿主**、一条 Rhino 指令都不产生的操作，守卫全程看不见，
> `deadlineMs` 形同虚设。

于是第 2 层（手写替身）成了唯一防线 —— 而它是一份**手写白名单**，漏一个就是一个洞。
本文审计的就是「这份白名单漏了什么」。

判据统一为：**脚本能否触发它，且它消耗的资源（时间/内存/CPU）发生在宿主而非 Rhino 指令流里。**

---

## 1. 已修复（本次及此前）

| # | 逃逸点 | 危害 | 修法 | 判据 |
|---|---|---|---|---|
| 1 | `Thread.sleep` / `currentThread().sleep` | 宿主阻塞；`sleep(999999)` 占死工作线程 ~11.6 天 | `MAX_SLEEP_MS = 1s` | `JsSandboxResourceLimitTest` |
| 2 | `System.getenv` | 直通宿主环境变量，泄露部署方凭据 | 恒返回空串（保留 key，探测型脚本不抛 TypeError） | 同上 |
| 3 | `StringBuilder.setLength` | 立即分配 n 个 char，可触发 GB 级分配 → `OutOfMemoryError` | `MAX_STRING_BUILDER_LENGTH = 1e6` | 同上 |
| 4 | `ZipUtil.unGzip` | `readBytes()` 无上限，几百字节解出几十 GB | `GzipLimits.unzipBounded` 流式记账，16MB 上限 | `JsGuardLimitsTest` |
| 5 | 脚本可控 `length` 直接决定宿主分配（`bytesOf` / `Arrays.copyOf` / `SecureRandom.nextBytes`） | `Arrays.equals({length: 2147483000}, [])` → ~2GB 分配 → 线程被打掉 | `requireAllowedLength`，`MAX_HOST_ALLOC_BYTES = 8M` | `JsSandboxHostAmplificationTest` |
| 6 | `Arrays.fill` / `System.arraycopy` 的宿主循环 | `{length: 2000000000}` 让 Kotlin 空转 20 亿次再 OOM，守卫零回调 | `arrayLength()` 内统一 clamp | 同上 |
| 7 | `bytesArray` 逐字节装箱放大 10~20 倍 | 16MB 字节 → 数千万 `Integer` → 数百 MB，抵消了解压上限 | 元素数上限 | 同上 |
| 8 | `StringBuilder.append` / `insert` | **绕过 `setLength` 上限**：200 次 append 累计 200MB，指令数远低于检查间隔 | 与 `setLength` 共用上限 | 同上 |
| 9 | `ZipUtil.gzip`（压缩方向） | 只修了解压，压缩方向无输入上限，峰值约 3× 输入 | `GzipLimits.gzipBounded`，16MB 上限 | `JsGuardLimitsTest` |
| 10 | `digestHex` 每字节一次 `String.format` | 2MB 正文 = 200 万次格式化，纯宿主 CPU | 改用查表的 `ScriptCrypto.bytesToHex` | — |

另有一项**非漏洞但重要**的修复：`BoundedJs.enter(timeout)` 把超时从 `AppConfig` 全局常量
改成**可注入参数**。这不只是解耦 —— 它是上述判据能存在的前提：判据要传 120ms 才能在一秒内
验完「死循环会被中断」，而进程级配置测试改不动。**在此之前，「守卫真的会触发」这件事从未被验证过。**

---

## 2. 明确「不存在」的类别（逐项核对过，不是没找）

| 类别 | 结论 | 依据 |
|---|---|---|
| **文件 / 进程能力** | **确认不存在** | `CLASS_NAMES` 全表无 `java.io.*`、`java.nio.file.*`、`Runtime`、`ProcessBuilder`、`ClassLoader`；`java.lang.System` 只暴露 `currentTimeMillis`/`nanoTime`/`getProperty`/`getenv`/`arraycopy`，**无** `exit`/`setProperty`/`getSecurityManager` |
| **网络能力** | 存在，但**属于设计内且只有一条出口** | `okhttp3.*` 不是真 OkHttp，而是转调 `RuleRunner.fetchResponse`，共用同一条带 SSRF 校验（回环/私网/`169.254.169.254` 一律拒）、2MiB 响应上限、20s 超时、4 跳重定向限制的通道 |
| **正则灾难性回溯** | **确认不存在** | 全文只有一处 `Regex(...)`，pattern 是宿主常量 `"%(\d+\$)?([sdfxXb])"`，无可控嵌套量词；`StrUtil.format` 用的是字面量 `replaceFirst`，不是正则 |
| **排序类放大** | **确认不存在** | 白名单里没有 `Collections`；`Arrays` 只有 `copyOfRange`/`copyOf`/`fill`/`equals`/`toString`，没有带比较器的 `sort` |
| **宿主信息泄露** | 除 `java.version` 外**没有** | `getenv` 恒空串；`Thread.currentThread().getName()` 硬编码 `"main"`；`android.os.Build` 全为硬编码假值；`file.encoding`/`line.separator` 为常量；无文件路径、用户名、进程信息 |
| **`classCache` 跨脚本污染** | **有界** | `resolve()` 先判 `full in CLASS_NAMES`（46 项）才 `getOrPut`；且 `JavaPackages` 每次 `eval` 新建 |
| **`Cipher` / `MessageDigest` 放大** | 未发现可用入口 | 无 PBKDF / keygen / `KeyPairGenerator`；`init` 只能喂 `SecretKeySpec` 或 DER 解析，成本随输入线性 |

---

## 3. A~D 已修（第二轮），E~G 仍未修

第一轮只修了 §1 里那 10 项；本节 A~D 是第二轮补的。E~G 是**明确记录在案的已知项**，
不是遗漏 —— 它们需要改动面更大的设计决策。

| # | 问题 | 定级 | 状态 |
|---|---|---|---|
| A | `keyMaterial`（`IdentityHashMap`）无界增长，强引用已丢弃的密钥 | 中 | **已修**：`rememberKeyMaterial` 收口四处插入并限 `MAX_KEY_MATERIAL_ENTRIES = 1024`。选条目上限而非 `WeakHashMap`，是因为后者回收时机由 GC 决定、判据无法稳定断言 |
| B | `Base64` 编解码无输入上限 | 中 | **已修**：在唯一收口 `decodeBase64Text` 判输入长度（三套口径都走它）；同时把无条件 `filterNot` 全串复制改成「确实含空白才复制」 |
| C | `StrUtil.format` 的 O(参数数 × 模板长度) | 中 | **已修**：提成顶层纯函数 `StrUtilFormat.render`，单遍扫描 O(n + 参数总长)；同时限模板长度与参数个数。语义按原 `replaceFirst` 口径保持（参数用尽后 `{}` 原样保留），判据 `StrUtilFormatTest` 11 例 |
| D | okhttp3 `execute()` 宿主阻塞，单次最坏 ~100s，超出 30s 守卫 | 中 | **已修**：`BoundedJs.deadlineOrNull()` 把这次 JS 执行的截止时刻传进 `fetchResponse(deadlineMs=…)`，每跳超时压到 `min(20s, 剩余预算)`，过期即中止。**默认 `null` 时行为与改动前完全一致**——这条路径被所有抓取共用 |
| E | 宿主侧调用**没有统一预算**（时间/分配字节累计） | 架构级 | **未修**（2026-11-12 复核仍维持）。这是第 3 层盲区的通用解（`BoundedJs` 挂 `hostBudget`，每个入口记账），但「漏记一处等于没有」—— 和手写白名单是同一个失效模式，只是换了一层。做它之前应先加一条**枚举式判据**（列出全部 `JavaPackages` 公开入口，断言每一个都记了账），否则预算本身就会变成新的漏洞面。**本轮没做这条前置判据**：预算层不存在时，把 106 个入口名抄进基线没有防守对象（谁都没记账，基线全绿）；等真要做预算时，先落基线再落记账，两步同一笔提交 |
| F | `System.getProperty("java.version")` 返回真实 JVM 版本 | 低 | **刻意保留**。仅是指纹；改常量会变成假值（更糟），改空串有极小概率影响「探测 JDK 版本」的源。收益接近零，风险非零 |
| G | `_request` 把一个真实 Java `data class` 实例放进沙箱 | 低 | **已修**（2026-11-12）：`requestBuilderBox().build()` 改成挂 `_url` / `_method` / `_headers` / `_body` 四个**原生值**，`newCall` 侧由 `requestDataOf` 还原，沙箱里不再出现 `RequestData` 实例。语义等价由既有 `JsCachePackagesBridgeTest` 的 okhttp 用例继续钉着（方法/头/正文/URL 都真的到了抓取层），形状由 `JsSandboxRequestShapeTest` 钉住（`_request` 必须 `undefined`、属性表必须正好那五个） |

## 4. 判据在哪

| 文件 | 钉什么 |
|---|---|
| `JsSandboxResourceLimitTest` | 已知的 4 个具体 API 上限（sleep / getenv / setLength / unGzip） |
| `JsGuardLimitsTest` | `GzipLimits` 的行为 + **墙钟守卫真的会中断死循环** |
| `JsSandboxHostAmplificationTest` | 「长度由脚本给、开销在宿主」这一整个模式 |
| `StrUtilFormatTest` | `StrUtil.format` 的**语义等价**（参数用尽后 `{}` 原样保留）+ 复杂度没有退化成平方 |
| `JsSandboxRequestShapeTest` | 沙箱里不出现 Java 引用：`okhttp3.Request.Builder().build()` 的产物只有原生值，`_request` 槽位必须不存在 |

三个文件都遵守同一条判据纪律：**既断言「被拦住」，也断言「沙箱随后仍可用」** ——
只证明抛了错不够，还要证明线程没被打掉。

写这类判据的坑（已踩过，记在这里）：
- **不要**在判据里构造十几 MB 的 payload 喂进 Rhino。Rhino 把字节数组按元素装箱成 JS 数组，
  17/20/24MB 三种 payload 全部触发 `Native memory allocation (mmap) failed`
  （`DOS error 1455` = Windows 页面文件打满），挂掉的是 **Gradle 测试执行器**，测的就不是被测代码了。
  这就是 `GzipLimits` 被提成顶层纯函数的原因：可以在 Kotlin 里直接调，不必穿过 Rhino。
- `JsSandbox.eval` 取的是**最后一个表达式**的值，多行 / 带 `importPackage` 的写法会被
  `JsScriptShape` 判成「无返回值」而回 `null` —— 那不是被测行为，是判据写错了。
- `Packages.*` 那套替身需要非空 `execContext` 才装得上。
