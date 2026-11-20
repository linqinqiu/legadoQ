# 12c · JS 沙箱与 Java 桥白名单（Phase 0.5 深读）— 唯一 RCE 防线

> 审计员：`deep-rules-sandbox`（legadoQ Phase 0.5「规则引擎深读」）
> 读源：`E:\legadoQ-archive\product\app\src\main\kotlin\io\legado\`（**只读**，不写归档、不 build、不启动、不执行脚本）
> 证据标注：**confirmed**＝已在源码读到实现（带 `文件:行号`）；**likely**＝源码结构支持但未跑通；**needs-runtime-test**＝必须实测才能定性
> 纪律：注释与实现冲突时**以源码为准**并记录；不构造恶意书源实弹测试。
> 本轮获授权整篇读指定文件（分批 ≤400 行）。

---

## 0. 阅读进度与覆盖率

| 文件 | 行数 | 读取范围 | 状态 |
|---|---|---|---|
| `rules/JsSandbox.kt` | 2100 | 1–2100（整篇，分 6 块） | ✅ 100% |
| `rules/JavaPackages.kt` | 1415 | 1–1415（整篇，分 6 块） | ✅ 100% |
| `rules/JsGuard.kt` | 159 | 1–159（整篇） | ✅ 100% |
| `rules/JsScriptShape.kt` | 63 | 1–63（整篇） | ✅ 100% |
| `rules/JsMapObject.kt` | 108 | 1–108（整篇） | ✅ 100% |
| `rules/ScriptCrypto.kt` | 211 | 1–211（整篇） | ✅ 100% |
| `rules/ScriptCache.kt` | 88 | 1–88（整篇） | ✅ 100% |
| `rules/ScriptConvert.kt` | 148 | 1–40 + 结构（简繁表，非安全面） | 🟡 结构级 |
| `rules/ScriptHtml.kt` | 66 | 1–66（整篇） | ✅ 100% |
| `rules/JsoupBridge.kt` | 215 | 1–215（整篇） | ✅ 100% |
| `rules/GzipLimits.kt` | 87 | 1–87（整篇） | ✅ 100% |
| **交叉** `rules/RuleLogin.kt` | 394 | 30–130、240–394（JS 入沙箱的全部入口） | 🟡 交叉相关段 100% |
| **交叉** `rules/RuleRunner.kt` | 1679 | JS 相关段：119、455–500、570–610、715–735、1059–1130、1212–1440、1643–1695 | 🟡 仅 JS 面 |
| **交叉** `rules/ResponseBody.kt` | — | 限额常量 | ✅ 相关行 |
| **交叉** `AppConfig.kt` | — | 140–184（两个 JS 旋钮） | ✅ 相关行 |

**必读清单覆盖率：11 个指定文件全读 = 10/11 整篇 + 1 个结构级；两处交叉文件按 JS 面读全。**
本册不重复 12a（执行链）、12b（规则语义）已覆盖的内容，只在必要处引其结论。

> **注释与实现冲突（已发现 2 处，按源码为准）**
> 1. `product/docs/rules-sandbox-audit.md:15` 称第 1 层在「`JsSandbox.kt`、`RuleRunner.kt` 的 `callOptional`」——**属实**（`JsSandbox.kt:303`、`RuleRunner.kt:1667` 两处），但与 12b/本册强调的「唯一防线」措辞需对齐：**两处都设了 shutter，但只有 `JsSandbox` 那条是书源规则主路径**；`RuleRunner.kt:1665` 的 `mainJs` 路径 `enter()` **未传 hostByteBudget**（见 §5.4）。
> 2. `JavaPackages.kt:44` 注释称「返回给脚本的一律是 JS 对象/字符串/数组，**没有一个 Java 对象引用**能穿进沙箱」。源码层面基本成立，但存在**两条残留通道**：`JsSandbox.toJsValue` 的兜底分支 `Context.javaToJS`（§8.2），以及 `sessionStore`/`ScriptCache.putMemory` 把**上一轮的 Rhino 对象**留到下一轮（§6.3）。注释说的是「当次注入」，不是「进程内不出现」，这里必须记清。

---

## 1. Rhino Context 生命周期

### 1.1 唯一的进入/退出点

| 事实 | 位置 | 判定 |
|---|---|---|
| 每次求值都 `BoundedJs.enter(AppConfig.jsTimeoutMs, hostByteBudget)` | `JsSandbox.kt:300` | confirmed |
| `try { … } catch (Exception) { … } finally { BoundedJs.exit() }` | `JsSandbox.kt:301` / `447` / `456` | confirmed |
| `enter` 把 `deadlineMs = now + timeoutMs`、`hostByteBudget`、`hostBytes=0` 写进 Context | `JsGuard.kt:110-115` | confirmed |
| `exit` 就是 `Context.exit()` | `JsGuard.kt:117` | confirmed |

**异常路径是否确保 exit？——是（含 `Error`）。**
`finally { BoundedJs.exit() }`（`JsSandbox.kt:452-457`）对任何 `Throwable` 都执行，包括 `catch (e: Exception)`（`:447`）兜不住的 `StackOverflowError` / `OutOfMemoryError`。所以「脚本把 Context 泄漏掉」这条不存在。
唯一例外：`BoundedJs.enter(...)` 自身抛错（`JsGuard.kt:110` 之前失败）时没有已进入的 Context 需要退出，对称，无泄漏。

### 1.2 是否复用 Context

- **scope 一定不复用**：每次求值 `val scope = cx.initSafeStandardObjects()`（`JsSandbox.kt:304`）→ 全新全局对象。这是本沙箱**最强的一条隔离保证**（见 §6.1）。
- **Context 是否复用取决于 Rhino `ContextFactory.enter()` 的语义**，本册**无法静态定论**：
  `BoundedJs.enter` 走 `BoundedContextFactory.enter()`（`JsGuard.kt:110`），`makeContext()`（`JsGuard.kt:52-88`）里设 `optimizationLevel=-1`、`instructionObserverThreshold=20000`、`maximumInterpreterStackDepth=1000`、`languageVersion=VERSION_ES6`——这些都是 **Context 级**状态。若 `enter()` 在**同一线程已有 Context** 时直接复用而不新建，则：
  1. 嵌套求值（`java.getString`/`getElements` → `RuleRunner.listItemsByRule` → 又一条 JS 规则，`JsSandbox.kt:1714` / `1756`；以及 `execContext.bridgeContent` 再入，`1696-1703`）会**覆盖**外层的 `deadlineMs` / `hostByteBudget` / `hostBytes`（`JsGuard.kt:110-115` 无条件赋值）→ 外层 30s 墙钟与 64MB 预算被内层重置（**预算洗白**）。
  2. 内层 `Context.exit()` 在 Rhino 里是**引用计数**语义，只有计数归零才真正释放；若实现不是计数式的，内层退出会提前解除外层的线程绑定。
  **标注：needs-runtime-test**（判据见 §5.5）。两条都不会导致逃逸，但会让「预算真的生效」这件事在再入路径上失真。

### 1.3 每书源 / 每脚本是否新建 scope

- **每脚本**：是（`:304`）。
- **每书源**：不是——同一书源的一次 `eval` 只是重建一次 scope；`jsLib` 也在**同一个 scope 内**先求值（`:423-425` → `evalLibrary`，`:488-507`），所以「jsLib 的顶层函数对动作脚本可见」成立，且**不会跨书源串**（scope 是新的）。
- `JsSandbox` 实例本身是**进程单例**（`Application.kt:168` 建 `RuleRunner`，其内部 `internal val jsSandbox = JsSandbox(this)` 在 `RuleRunner.kt:119`）——实例级状态见 §6。

### 1.4 对象包装级别（`WrapFactory`）

**没有自定义 `WrapFactory`。** 全仓 `grep -rn "WrapFactory" rules/` 无命中（confirmed）：
- 未覆盖 → Rhino 用默认 `WrapFactory`，`ScriptableObject.putProperty` 放进原始 Kotlin 值时由 `Context.javaToJS` 兜底包装（`JsSandbox.kt:2097`）。
- **替代品是「压根不放 Java 对象」**：所有桥对象都是 `NativeObject` / `BaseFunction` 子类（`JsSandbox.kt:586-594` 的 `ChainedObject`、`:819-835` 的 `CallableBody`、`JsMapObject`、`JsClass`），响应对象是 `new String(正文)` 再挂成员（`:596-679`）。
- 因此第 1 层防线（`ClassShutter`）在正常脚本里**几乎用不到**——它防的是「万一有人塞了 Java 对象进来」的兜底，不是主防线。**这点必须写进新架构文档，否则后人会误以为防线在 shutter 上。**

---

## 2. 全局对象与注入面（`globalThis` 逐项清单）

`initSafeStandardObjects()`（`JsSandbox.kt:304`）先给出**安全**标准对象，然后是 14 个显式注入。逐项：

### A. 由 Rhino `initSafeStandardObjects` 自带的（非本项目注入）

ES6 标准内建：`Object/Function/Array/String/Number/Boolean/Date/RegExp/Math/JSON/Error/Map/Set/Promise/Symbol/Proxy/Reflect` 等，以及 ES6 的 `globalThis`。
**Rhino 的 "safe" 模式刻意不含**：`Packages`、`java`、`javax`、`org`、`com`、`edu`、`net`、`getClass`、`JavaAdapter`、`Continuation`、`loadClass`、`defineClass`、`load`、`print`、`readFile`、`readUrl`、`runCommand`、`spawn`、`sync`、`quit`、`version`、`gc`、`doctest`。
→ **`load` / `print` / `readFile` / `readUrl` / `runCommand` / `quit` / `getClass` 一律不存在**（判定 **likely**：属 Rhino API 语义，本仓未覆盖 `initSafeStandardObjects`；运行验证见 §5.5 的 S-0 用例）。
→ **没有 `console`**：`java.log` 是空实现（`JsSandbox.kt:1244-1248`），脚本日志全部丢弃（兼容性风险，见 §9.4）。

### B. 本项目显式注入的 14 个（全部是**代理/模拟对象**，没有任何真 Java 对象）

| # | 名字 | 注入点 | 实现 | 真实 Java 对象？ | 危险度 |
|---|---|---|---|---|---|
| 1 | `org`（`org.jsoup.Jsoup`） | `JsSandbox.kt:331` | `JsoupBridge.install`（`JsoupBridge.kt:34-62`） | ❌ 纯 JS 包装；**无 `Jsoup.connect`**（`JsoupBridge.kt:22-26`） | 低 |
| 2 | **bindings**（`result`/`src`/`baseUrl`/`sourceId`/`bookSourceUrl`/`isLongClick`/`key`/`page`/`__loginState`…） | `JsSandbox.kt:349-351` | `toJsValue`（`:2090-2098`）：Map→`NativeObject`、List→JS 数组、**其它→`Context.javaToJS`** | ⚠️ **视调用方给什么**（§8.2） | 低（现调用方只给 String/Map） |
| 3 | `java` | `:339`，`createJavaBridge` `:1143-2037` | `NativeObject` + 约 60 个 `BaseFunction` | ❌ 全替身 | 中（网络出口，§4） |
| 4 | `Reload(url)` | `:347-368` | 抓 URL 回**字符串**，不执行 | ❌ | 中（网络出口） |
| 5 | `Packages` | `:360` → `JavaPackages.install` `:71` | `PackageNode` 白名单树（`JavaPackages.kt:81-96`） | ❌ 树里只有 `JsClass` 替身 | **核心，§3** |
| 6 | `JavaImporter` | `:360` → `:72` | `ImporterObject`（`JavaPackages.kt:129-170`） | ❌ | 核心，§3 |
| 7 | `importPackage` | `:360` → `:73` | 只遍历 `PACKAGE_CLASSES`（`:172-181`） | ❌ | 核心，§3 |
| 8 | `importClass` | `:360` → `:74` | 只接受 `JsClass` 实例（`:183-188`） | ❌ | 核心，§3 |
| 9 | `source` | `:366`（需 sourceId 非空） | `createSourceBridge` `:837-970`：登录信息/变量/键值读写 | ❌ | 中（凭据面） |
| 10 | `cookie` | `:377` | `createCookieBridge` `:972-1042`：带**域白名单软闸**（`:981-985`） | ❌ | 中（凭据面） |
| 11 | `put($$$)`（裸全局） | `:384-409` | 写 `source.variable` | ❌ | 低 |
| 12 | `cache` | `:404-408` | `createCacheBridge` `:1054-1141` → `ScriptCache`（键按书源隔离） | ❌ | 低 |
| 13 | `book` / `chapter` | `:411` / `:413` | `createBookBridge` `:526-576` / `createChapterBridge` `:510-519` | ❌ | 低 |
| 14 | `environment` | `:418-420` | 只有 `IS_LEGADO_SIGMA=false` | ❌ | 无 |

**结论（confirmed）**：沙箱里**没有一个真实 Java 对象是真类实例**——
`okhttp3.OkHttpClient/Request/RequestBody/MediaType/HttpUrl`（`JavaPackages.kt:627-642`）全部是**模拟类**，`newCall().execute()` 最终转调 `RuleRunner.fetchResponse`（`:1242-1260`）；
`java.util.HashMap/ArrayList`（`:425-438`）是 `JsMapObject` / JS 数组；
`javax.crypto.Cipher/Mac`（`:504-515`）是真 JCE 实例，但**句柄不出沙箱**（只有 `init/doFinal/update` 等 wrap 方法，`:1023-1044`）。

---

## 3. Java 桥白名单（本册核心）

### 3.1 白名单全量（`JavaPackages.kt`）

**唯一真源：`CLASS_NAMES = setOf(...)`（`JavaPackages.kt:1385-1403`），43 个类。**
命名空间树由它派生，不是手写第二份：`PACKAGE_CLASSES`（`:1405-1406` `groupBy`）、`NAMESPACES`（`:1408-1413` 按包名逐级前缀展开）。

| 组 | 类（简单名） | 数量 | 声明行 | 实现行 |
|---|---|---|---|---|
| `java.lang` | Thread, System, String, StringBuilder, StringBuffer, Integer, Long, Double, Float, Boolean | 10 | 1386-1388 | 240-379 |
| `java.util` | UUID, Base64, Arrays, HashMap, LinkedHashMap, ArrayList | 6 | 1389-1390 | 382-438 |
| `java.net` | URLEncoder, URLDecoder | 2 | 1391 | 441-454 |
| `java.security` | MessageDigest, SecureRandom, KeyFactory, Signature | 4 | 1392-1393 | 457-483 |
| `java.security.spec` | PKCS8EncodedKeySpec, X509EncodedKeySpec | 2 | 1394 | 484-494 |
| `javax.crypto` | Cipher, Mac, SecretKeyFactory | 3 | 1395 | 504-532 |
| `javax.crypto.spec` | SecretKeySpec, DESKeySpec, IvParameterSpec, GCMParameterSpec | 4 | 1396-1397 | 484-501 |
| `android.*` | android.util.Base64, android.text.TextUtils, android.os.Build | 3 | 1398 | 535-570 |
| `cn.hutool.*` | core.codec.Base64, core.util.StrUtil, core.util.ZipUtil, crypto.digest.DigestUtil | 4 | 1399-1400 | 571-624 |
| `okhttp3` | OkHttpClient, Request, RequestBody, MediaType, HttpUrl | 5 | 1401-1402 | 627-642 |
| **合计** | | **43** | | |

**可达命名空间（21 个，`NAMESPACES` 展开结果）**：`java` · `java.lang` · `java.util` · `java.net` · `java.security` · `java.security.spec` · `javax` · `javax.crypto` · `javax.crypto.spec` · `android` · `android.util` · `android.text` · `android.os` · `cn` · `cn.hutool` · `cn.hutool.core` · `cn.hutool.core.codec` · `cn.hutool.core.util` · `cn.hutool.crypto` · `cn.hutool.crypto.digest` · `okhttp3`。
**注意**：`java.io` / `java.nio.file` / `java.lang.reflect` / `javax.naming` / `javax.script` / `sun.*` **连命名空间都不存在**（`NAMESPACES` 由白名单派生，`:1408-1413`）。
**注意 2**：`Packages.org…` 走不通——`PackageNode.get` 对 `org` 既不 `resolve` 也不在白名单前缀里，返回 `NOT_FOUND`（`:88-94`）。`org.jsoup.*` 只有**裸全局 `org`** 那一条路（`:331`）。

**入口计数基线**：`JavaPackagesEntryBaselineTest`（`src/test/.../rules/JavaPackagesEntryBaselineTest.kt:60-`）用反射枚举并**精确比对**「43 个类 / 98 个静态入口 / 13 个只有构造的类」，并单独钉住「带记账的入口名字」。这是本册最有力的一份现成判据（confirmed）。

### 3.2 危险类可达性逐项判定

判定口径：脚本请求 `Packages.java.lang.Runtime` → `PackageNode("java.lang").get("Runtime")` → `resolve("java.lang.Runtime")` → `full !in CLASS_NAMES` → `null` → `"java.lang.Runtime" !in NAMESPACES` → `return NOT_FOUND`（`JavaPackages.kt:86-95` + `:192-196`）。

| 危险面 | 可达？ | 请求到的是什么 | 证据 |
|---|---|---|---|
| `java.lang.Runtime` | ❌ 不可达 | `undefined` | 不在 `CLASS_NAMES`(1385-1403)；`resolve` 判据 194 |
| `java.lang.ProcessBuilder` | ❌ | `undefined` | 同上 |
| `java.io.File` / `FileOutputStream` / `RandomAccessFile` | ❌ | `undefined`（**`java.io` 命名空间不存在**） | `NAMESPACES` 无 `java.io`（1408-1413） |
| `java.nio.file.Files` / `Paths` | ❌ | `undefined`（`java.nio` 不存在） | 同上 |
| `Class.forName(...)` | ❌ | `Packages.java.lang.Class` → `undefined` | `Class` 不在白名单；另 `ClassShutter{false}` 让 `java.lang.Class` 对脚本不可见（303） |
| `getClass()`（反射入口） | ❌ 无对象可调 | 沙箱内**没有任何真 Java 对象** → 无 `getClass`；`initSafeStandardObjects` 也不给全局 `getClass` | §2.B 全表为 `NativeObject`/`BaseFunction`；`initSafeStandardObjects`(304) |
| `getDeclaredMethod` / `getMethod` / `newInstance` | ❌ | 需要 `Class`/`Method` 实例，两者都拿不到 | 同上 |
| `java.lang.Thread` | ⚠️ **部分可达（替身）** | 只有 `sleep(ms)`（**clamp 到 1000ms**，`JavaPackages.kt:241-249`）与 `currentThread().{getName→"main", sleep}`（`:250-259`）。**无** `start/run/stop/new Thread( Runnable )` | confirmed |
| `System.exit` / `setProperty` / `getSecurityManager` / `setSecurityManager` | ❌ | `System` 替身只有 `currentTimeMillis/nanoTime/getProperty/getenv/arraycopy`（`:261-277`）；`System.exit` → `undefined` → 调用抛 TypeError | confirmed |
| `System.getenv(任意)` | ⚠️ 可达但**恒返回 `""`** | 刻意移除直通（`:272-275` 注释：会把部署方环境变量里的 API key 泄给任意源） | confirmed |
| `sun.misc.Unsafe` | ❌ | `undefined` | 无 `sun` 命名空间 |
| JNDI（`javax.naming.*`、`InitialContext.lookup`） | ❌ | `undefined`（`javax.naming` 不存在） | 同上 |
| `URLClassLoader` / `ClassLoader` / `defineClass` | ❌ | `Packages.java.net.URLClassLoader` → `undefined`（`java.net` 命名空间**存在**，但该名不在 `CLASS_NAMES` → NOT_FOUND） | 194 |
| `ScriptEngine` / `ScriptEngineManager`（`javax.script`） | ❌ | `undefined` | 同上 |
| `java.lang.reflect.*` / `Method.invoke` | ❌ | `undefined` | 同上 |
| 文件/进程/反射**通配**探针（`Packages.java.io.File`、`Packages.sun.misc.Unsafe` …） | ❌ | `undefined`（静默，不抛错） | §3.3 |

**同时要记录的一条「刻意开放」**：`okhttp3.*` 与 `java.net.URLEncoder` 构成**完整网络出口**（§4），这是设计内的，不是漏。`GzipLimits` / `Arrays` / `SecureRandom` / `Base64` 构成**宿主分配面**，由记账闸口兜住（§5.3）。

### 3.3 未知类被请求时的真实行为（防逃逸关键判据）

**静默 `NOT_FOUND`（JS 侧表现为 `undefined`），不抛错、不记日志、不回 `null`。**
代码原文（`JavaPackages.kt:86-95`）：
```kotlin
override fun get(name: String, start: Scriptable): Any? {
    if (name in OBJECT_MEMBERS) return super.get(name, start)
    val full = if (path.isEmpty()) name else "$path.$name"
    resolve(full)?.let { return it }
    if (full in NAMESPACES || full.startsWith("org.jsoup")) return PackageNode(full)
    return NOT_FOUND          // ← 未知类的唯一出口
}
```
- `JavaImporter` 路径同样：`ImporterObject.get` 找不到就 `return NOT_FOUND`（`:157-169`）。
- `importPackage("随便.什么")`：`globalImportPackage` 只认 `WhitelistMarker`（即真命名空间节点）→ 字符串参数**被忽略**（`:172-181`）；即便进了 `packages` 列表，最后仍要过 `resolve()` 的 `CLASS_NAMES` 判据（`:165-167`）。
- **唯一会抛错的分支**是「类在 `CLASS_NAMES` 里但 `buildClass` 没写实现」：`else -> error("未实现的 Java 白名单类：$full")`（`:644`）→ `IllegalStateException` 穿进 Rhino。这是**开发期自检**，不是安全边界（白名单与实现必须成对，`JavaPackagesEntryBaselineTest` 会红）。
- **负面效果（要给新架构留警示）**：未知类静默 `undefined` 意味着**拼错类名的书源不会报错、只会「取不到值」**，排查成本高；但换掉这个行为（改成抛错）会破坏大量 try/catch 探测型源（例如探测 `io.legado.app.*` 的魔改版探测，`JavaPackages.kt:50-51` 明说故意让它失败）。

### 3.4 `setClassShutter` 的返回值

**恒 `false`。** 代码原文（`JsSandbox.kt:302-304`，≤5 行）：
```kotlin
cx.optimizationLevel = -1
cx.setClassShutter(ClassShutter { false }) // Sandbox: block all Java reflection
val scope = cx.initSafeStandardObjects()
```
`ClassShutter` 是单方法接口 `visibleToScripts(String fullClassName): Boolean`，SAM 转换的 lambda `{ false }` **无条件返回 false** = 所有 Java 类对脚本不可见（deny-all，比上游 legado-with-MD3 的黑名单更强）。

**同一道闸还有第二处（12a 未覆盖）**：`RuleRunner.kt:1667`（`JsSourceRunner.callOptional`，`mainJs` 书源那条路径）同样 `context.setClassShutter(ClassShutter { false })`，也 `initSafeStandardObjects()`（`:1668`）。两处一致，**但那里只注入了一个 `java.ajax`（`:1669`、`:1686-1690`）**，没有 `Packages`/`cookie`/`source`/`cache`——即 `mainJs` 源的暴露面比规则 JS **更窄**（同时也意味着那边**没有 hostByteBudget**，见 §5.4）。

---

## 4. 网络访问入口与出站预算

### 4.1 书源 JS 能自己发 HTTP——能，且有 11 个入口

| 入口 | 位置 | 底层 | 备注 |
|---|---|---|---|
| `java.ajax(url)` | `JsSandbox.kt:1150-1163` | `runner.fetch` | `data:text/html;base64,…` 走本地解码（`:1153-1156`），不发网络 |
| `java.ajaxAll(urls)` | `:1168-1190` | `runner.fetchResponse` × N | **并发**（全局 8 线程池，见 4.4） |
| `java.post(url, body, headers)` | `:1193-1210` | `fetchResponse(POST)` | |
| `java.get(url[,headers])` | `:1215-1228` | `fetchResponse(GET)` | 双语义：`args.size>=2 \|\| 看起来是 URL` 才当网络调用，否则当 KV 读（`sessionStore`，`:1226`） |
| `java.connect` / `getStrResponse` / `getStrResponseAwait` | `:1800-1815` | `fetchResponse(GET)` | 返回响应对象 |
| `java.head(url)` | `:1819-1828` | `fetchResponse(HEAD)` | 正文强制清空（`:1824`） |
| `java.cacheFile(url[,saveTime])` | `:1379-1399` | `runner.fetch` | 结果进 `ScriptCache`（键 `dl:`+md5_16） |
| `java.importScript(path)` | `:1404-1422` | `cacheFileText` | http 直取；非 http 按书源地址相对解析 |
| `Reload(url)` | `:347-368` | `runner.fetch` | 回**文本**，由脚本自己 `eval` |
| `Packages.okhttp3 …newCall().execute()` | `JavaPackages.kt:1203-1213` → `executeRequest` `:1242-1260` | `fetchResponse`（带 `deadlineMs`） | **唯一传 deadline 的 JS 网络入口** |
| 远端 jsLib 映射（`jsLib` 是 `{"名":"https://…js"}`） | `JsSandbox.kt:488-507`（`evalLibrary`） | `runner.fetch` | 每次规则求值都会（首次）抓取并**执行** |

**`java.startBrowserAwait` 的 `browserCompleted` 分支也会服务端抓一页**（`:1298-1303`）。

### 4.2 是否走 `NetworkSecurity` 闸门——走，无一例外（confirmed）

所有入口最终都汇到 `RuleRunner.fetch` / `fetchResponse`（`RuleRunner.kt:1059` / `:1070`）→ `fetchDetailed` → `fetchDetailedImpl`（`:1221`）→ `buildRequest`（`:1332`）→ **`validateTarget(initial)` → `NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "站点")`**（`:1315-1323`）；每一跳重定向也单独校验（`:1306`）。
→ 回环 / 私网 / 云元数据地址在**发请求之前**被拒（抛 `RuleExecutionException`）。
**唯一的旁路风险**：`fetchedFetcher` / `responseFetcher` 测试桩（`:1229-1230`）会**短路**掉整条链路（不校验）。生产不设这两个桩，但新架构若保留「可注入 fetcher」就保留了这条旁路——必须在装配层禁止非测试注入。

### 4.3 Cookie 会不会自动带——会（confirmed，且是「按每一跳的地址」查）

`effectiveHeaders`（`RuleRunner.kt:1381-1400`）：每跳先取 `db.asLoginStateStore().getSourceLoginState(sourceId).loginHeader`，再取 `db.asCookieStore().getCookieForUrl(uri.toString())`（`:1393`），按键位合并（`mergeCookieStrings`，`:1421-1431`），最后叠加脚本给的 headers。
**所以书源 JS 发的任何请求都自带该书源已存的登录态 Cookie / 登录头。**
响应侧 `Set-Cookie` 全部落罐（`:1257-1266`），且**用当前那一跳的地址归档**（注释 `:1260-1261`：防 A 站 Cookie 发给 B 站）。
JS 读 Cookie 另有一道**软闸**：`cookie.getCookie(url)` / `java.getCookie(tag)` 只允许「本书源配置里出现过的域 + 自己的主域」（`JsSandbox.kt:981-994`、`:1327-1331`），源码注释自己承认这是**文本判定、可被绕过**（`:369-376`：「一个铁了心的恶意源把域名写进规则串就能越过这条线」）。

### 4.4 出站次数 / 字节 / 并发预算——**基本没有**（这是上一轮 P1-5 的确认结论）

| 维度 | 有无预算 | 证据 |
|---|---|---|
| **单响应字节** | ✅ 有：2 MiB | `ResponseBody.kt:20` `MAX_BODY_BYTES = 2 MiB`；`:98`/`:110` 两处抛 `RuleExecutionException` |
| **单请求超时** | ✅ 有：每跳 20s | `RuleRunner.kt:1334` |
| **重定向跳数** | ✅ 有：4 跳 | `:1239` `repeat(4)`，超出抛「重定向次数超过限制」（`:1309-1310`） |
| **单次执行的出站请求数** | ❌ **无** | 全仓无 per-eval 请求计数器；`java.ajax` 可在 `for` 循环里无限调 |
| **单次执行的出站总字节** | ❌ **无** | `MAX_BODY_BYTES` 是**逐响应**；N 次 × 2 MiB 无上限，且**网络字节不进 `hostByteBudget`**（`AppConfig.kt:158-159` 明说「网络响应体不计入」） |
| **并发** | 🟡 半有：`ajaxAll` 全局固定 8 线程（`JsSandbox.kt:200-207`，守护线程池，跨书源共享 → 总并发上限 8）；`okhttp.execute()` 串行；**普通 `java.ajax` 无任何限制**，由调用它的工作线程直接做 |
| **墙钟对网络的约束** | ⚠️ **漏洞**：只有 `okhttp3.execute()` 传了 `deadlineMs`（`JavaPackages.kt:1255`）。`java.ajax`(`:1160`)、`java.get`(`:1222`)、`java.post`(`:1198-1205`)、`connect`(`:1804-1805`)、`head`(`:1823-1824`)、`cacheFile`(`:1386`)、`Reload`(`:351`) **都没传** → 一条 `for(i=0;i<100;i++) java.ajax(url)` 最多可占 **100 × 20s ≈ 33 分钟**，而 `observeInstructionCount` 在阻塞期间**零回调**（`JsGuard.kt:8-13` 自述），30s 墙钟对它完全失效。**判定：confirmed（代码层）+ needs-runtime-test（实际耗时，用一个必然慢的本地桩地址测）** |

**结论**：`java.ajaxAll` 有并发上限（8），但**出站次数、出站总字节、以及「JS 网络调用的墙钟」三项都没有**。这是新架构必须补的第一优先项（§9.2 的 C-1/C-2）。

---

## 5. 执行时间与内存限制

### 5.1 墙钟限制在哪实现

| 要素 | 值/位置 | 判定 |
|---|---|---|
| 观察器 | `BoundedContext.observeInstructionCount`（`JsGuard.kt:44-48`）：`if (now > deadlineMs) throw EvaluatorException("书源 JS 执行超过 ${timeoutMs}ms 上限，已中断（疑似死循环）")` | confirmed |
| 触发频率 | `instructionObserverThreshold = GRANULARITY = 20_000`（`JsGuard.kt:64`、`:90`） | confirmed |
| 前提 | **必须解释模式** `optimizationLevel = -1`（`JsGuard.kt:63` 在 factory 里设，`JsSandbox.kt:302` 再设一次）——编译模式下观察器永不触发 | confirmed |
| 时限来源 | `AppConfig.jsTimeoutMs`，默认 30_000ms，`LEGADO_JS_TIMEOUT_MS` 可调（`AppConfig.kt:148`） | confirmed |
| 递归保护 | `maximumInterpreterStackDepth = 1000`（`JsGuard.kt:76`、`:91`）——防「深度递归把解释器栈推爆 → `StackOverflowError`（`Error`，`runCatching` 兜不住）」 | confirmed |
| 阻塞调用的兜底 | `BoundedJs.deadlineOrNull()`（`JsGuard.kt:158`）交给 `fetchResponse(deadlineMs=…)`，**只有 okhttp3 一处用**（§4.4） | confirmed |

**超时后如何终止**：抛出 `EvaluatorException`（一个 `RuntimeException`）→ 从 `observeInstructionCount` 冒到解释器 → `cx.evaluateString` 抛出 → 被 `evalImpl` 的 `catch (e: Exception)`（`JsSandbox.kt:447`）接住 → 写 `execContext.lastError` / `lastError` → **返回 null**（`:452`）→ `finally` 里 `BoundedJs.exit()`（`:456`）。
**没有**中断线程、没有 `Thread.stop`、没有杀进程——是**协作式中断**，只在下一条指令边界生效。

### 5.2 堆内存是否记账——**只记宿主分配，纯 JS 分配完全不记（confirmed）**

- 记账函数：`BoundedJs.chargeHostBytes(bytes)`（`JsGuard.kt:132-144`）→ 累加到 `ctx.hostBytes`，超 `hostByteBudget` 抛 `IllegalArgumentException`（注意是 `Exception` 不是 `Error`，脚本 `runCatching` 能兜住）。
- **记账点只有 4 处**（`JavaPackages.kt`）：`requireAllowedLength`（`:780`）、`requireStringBuilderWithinLimit`（`:792`）、`ZipUtil.gzip`（`:606`）、`ZipUtil.unGzip`（`:614`）。
- 而这 4 处**只覆盖「脚本给出的长度/元素数引发的宿主分配」**：`Arrays.copyOf/copyOfRange`、`System.arraycopy`、`bytesOf`（`:722`）、`bytesArray`（`:749`）、`SecureRandom.nextBytes`（`:1017`）、Base64 解码输入（`:955`）、`StringBuilder.append/insert/setLength`、GZIP 两向。
- **纯 JS 分配（`'x'.repeat(n)`、数组 push、对象、字符串拼接、`Array(n).fill()`）在 Rhino 堆里发生，本仓没有任何 instrument 点 → 一分钱都不记。**
- 预算默认 **64MB**（`AppConfig.kt:151` `DEFAULT_JS_HOST_BYTES = 64MB`；`:176-179` `0`/负数 → `Long.MAX_VALUE` 不设限）。
- **同时存在的单次硬上限**：`MAX_HOST_ALLOC_BYTES = 8MB`（`JavaPackages.kt:1366`）、`MAX_STRING_BUILDER_LENGTH = 1e6`（`:1352`）、`MAX_SLEEP_MS = 1000`（`:1350`）、`MAX_UNZIP_BYTES = 16MB` / `MAX_GZIP_INPUT_BYTES = 16MB`（`GzipLimits.kt:35`/`:64`）、`MAX_KEY_MATERIAL_ENTRIES = 1024`（`:1375`）。

### 5.3 64MB 是怎么累计的

`JsSandbox(hostByteBudget = AppConfig.jsHostBytes)`（`JsSandbox.kt:213`）→ `BoundedJs.enter(timeout, budget)`（`:300`）→ `BoundedContext.hostByteBudget`（`JsGuard.kt:113`），每次 `enter` 把 `hostBytes = 0`（`:114`）→ **预算是「单次 eval」口径，不是书源口径、不是进程口径**。
累计发生在**唯一收口函数**里（设计意图见 `JsGuard.kt:120-127`：「在 106 个入口逐个记账是漏记一处等于没有」）。
超限行为：抛 `IllegalArgumentException`，文案带「已累计分配宿主内存 N MB，超过 64MB 上限，已拒绝（疑似脚本放大攻击）」+ 提示 `LEGADO_JS_HOST_BYTES`（`JsGuard.kt:138-142`）。

### 5.4 两处「预算缺失」的路径（重要）

1. **`mainJs` 书源路径**：`RuleRunner.kt:1665` `BoundedJs.enter(AppConfig.jsTimeoutMs)` —— **只传超时，`hostByteBudget` 取默认 `Long.MAX_VALUE`（不设限）**（`JsGuard.kt:108`）。该路径暴露面窄（只有 `java.ajax`，`:1669`），所以 8MB 级放大入口不可达；但它是**唯一一处「有墙钟无内存预算」的 JS 执行点**，新架构要么补齐、要么明确记录。
2. **嵌套求值**（§1.2）：若 Rhino 复用线程 Context，内层 `enter` 会把 `hostBytes` 归零并换成自己的预算 → 外层预算被「洗白」。

### 5.5 上一轮遗留问题：`var a=[]; for(;;) a.push('x'.repeat(1<<20))` 会不会先 OOM 再被墙钟拦？

**静态判断：会（likely → 需实测确认）。** 推理链：

1. 每次迭代分配 1 MiB 的 Rhino `NativeString` + 数组槽增长，**不进 `hostBytes`**（§5.2）。
2. 观察器每 20000 条**指令**才回调一次（`JsGuard.kt:90`）。一次 `repeat` + 一次 `push` 约几十条指令 → 一个观察窗口（20000 指令）内可分配 **数百 MB**。
3. 观察器只在**超时**时抛错（`JsGuard.kt:45`），所以第一次回调之前的所有分配都「合法」；30s 内能分配到的量远超常见 JVM 堆（默认 `-Xmx` 通常是物理内存的 1/4）。
4. 撞上 `OutOfMemoryError` 时：`evalImpl` 只 `catch (e: Exception)`（`JsSandbox.kt:447`）→ **OOM 是 `Error`，不被捕获**，只有 `finally` 的 `BoundedJs.exit()` 会跑（`:456`），异常继续上抛到 HTTP 层 → 该请求 500；JVM 是否存活取决于堆压力是否波及其它线程（GC 抖动/线程创建失败）。
   → 这与「`StackOverflowError` 把工作线程打掉」是同一类失败模式，`JsGuard.kt:65-76` 只解决了栈深度、**没有解决堆**。
5. 反向证据（说明「确实没人处理过」）：`AppConfig.kt:158-159` 与 `GzipLimits.kt:10-16` 的注释都只讨论**宿主**分配；全仓没有任何针对 Rhino 堆的限额、`-Xmx` 设定或 sandbox 子进程隔离。

**标注：needs-runtime-test。** 验证脚本思路（**不是**恶意书源，是判据）：
```
// 与 JsGuardLimitsTest 同形（该文件已证明"注入 120ms 超时"的做法可行）
@Test fun `纯 JS 堆分配会不会先于墙钟 OOM`() {
    // ① 先确认墙钟在这段脚本上确实会触发（注入 300ms）：
    val e1 = runCatching { JsSandbox().eval("var a=[];for(;;)a.push('x'.repeat(1<<20))") }.exceptionOrNull()
    //    期望：抛 EvaluatorException("…超过 300ms 上限")，而不是 OutOfMemoryError
    // ② 用受限堆复现 OOM 面（Gradle test 加 jvmArgs '-Xmx128m'，或独立 main + -Xmx64m）：
    //    期望看到 java.lang.OutOfMemoryError: Java heap space，且堆栈里没有我们的 catch
    // ③ 记三个数：触发时分配的 MB、耗时、抛的异常类型 —— 三者决定它到底是「墙钟先到」还是「堆先到」
}
```
**必须同时测的对照组**：`java.util.Arrays.copyOf([1], 8388607)` × 9 次（走 `requireAllowedLength`）→ 期望第 9 次抛 64MB 预算错误 → 证明「宿主路已封、纯 JS 路未封」的**不对称**。若要修，最小改动是给 `initSafeStandardObjects` 出来的 scope 挂一个**自有 String/Array 分配代理**（不可行）或**把 JS 执行移到独立进程/或在同一 JVM 用 `-Xmx` + 捕获 `OutOfMemoryError` 做「可恢复」判定**——结论见 §9.2 C-3。

---

## 6. 并发隔离

### 6.1 不共享的东西（confirmed）

| 项 | 隔离方式 | 证据 |
|---|---|---|
| 全局变量 / 函数 | **每次 eval 新建 scope** `cx.initSafeStandardObjects()` | `JsSandbox.kt:304` |
| 执行上下文（书源、书、章节、登录信息、toast、openUrl…） | `ThreadLocal<JsExecutionContext?>`，且 `withSourceContext` 用 **save/restore** 语义并在 finally 还原 | `:250-263` |
| 失败原因 `lastError` | `ThreadLocal<String?>`（**曾经是 `@Volatile` 字段，实测会串**，`:465-475` 的注释记了这个 bug） | `:462-475` |
| 变量替换的 jsLib / loginScript | 由 `execContext` 携带，不进全局 | `:275-287`、`:423-431` |
| `Rhino Context` | **每 eval 一个 enter/exit 配对**（是否真新建见 §1.2 needs-runtime-test） | `:300`/`:456` |

### 6.2 共享的东西（设计如此，但都有代价）

| 项 | 类型 | 键 | 风险 |
|---|---|---|---|
| `sessionStore`（`java.put/get` 的 KV） | `ConcurrentHashMap<String, Any>`（**存的是原始 JS 值**） | `sourceId\u0000key`（`:239-240`） | ① **无容量上限**（`:2033` 直接 put）→ 跨执行累积，且不计入 64MB 预算（预算是 per-eval）→ 脚本可用 `for(i<1e6) java.put('k'+i,'x'.repeat(1000))` 留下 GB 级常驻内存；② 存的是**上一轮 Context 里的 `Scriptable`**，下一轮取出后跨 Context 使用（见 6.3） |
| `remoteJsLibCache` | `ConcurrentHashMap<String,String>`，**满 64 条整表 clear** | 远端 URL（**不按书源**） | 跨书源共享正文：A 源引用的 URL 被 B 源命中即复用（内容相同才无害）；clear 风暴可被单源触发（`:498-504`） |
| `ajaxAllPool` | 全局固定 8 线程守护池 | — | 单源可占满 → 其它源 `ajaxAll` 排队（`:200-207`） |
| `ScriptCache.memory` | 全局 LRU 2048 条（`ScriptCache.kt:25-33`） | `sourceId\u0000key` | 键已隔离 ✅；但 LRU 是**全局**的，单源可把别人的缓存挤掉（性能面，非安全面） |
| DB / Cookie / 变量存储 | 按 `sourceId` 分键（`asVariableStore`、`asCookieStore`…） | sourceId | 见 §8.3 软闸 |

### 6.3 Rhino 线程安全性如何处理

- **本仓没有任何锁、也没有 `synchronized` 包住 `evaluateString`。** 隔离手段是「每 eval 独立 Context + 独立 scope」（§6.1），这在**正常路径**上足够（Rhino 的 `Scriptable` 不是线程安全的，但没有被跨线程共享）。
- **两条破坏「不跨线程共享」的通道**（**needs-runtime-test**）：
  1. `java.put(key, value)` 存原始值（`JsSandbox.kt:2029-2036`），`java.get(key)` 原样取回（`:1226`）→ 第二次求值（**可能是另一个线程、另一个 Context**）拿到的是上一个 Context 创建的 `NativeObject`/`NativeArray`。Rhino 对象的 `parentScope` 指向旧 scope，跨 Context 使用可能表现为原型链异常、`TypeError`、或静默取不到属性。
  2. `cache.putMemory(key, value)` 把原始值放进**进程级全局 LRU**（`:1094-1098` → `ScriptCache.kt:48-50`），同样跨 eval/跨线程。
  - 说明：`cache.get` 的读路径只接受字符串（`:1071-1077`、`ScriptCache.kt:68`），所以「读回对象」只在 `getFromMemory`（`:1108-1111`）上发生；`java.get` 则是**必读回对象**。
- **并发下真实的用户可见症状**（需要在实测里确认）：同一书源并发请求（书架批量刷新）时 `java.get` 返回的对象偶发不可用；`ajaxAll` 结果保序由 `Future.get` 保证（`:1182-1187`），不受影响。
- 已验证的并发正确性成果（可引用）：`lastError` 的 ThreadLocal 化、`sessionKey` 的按源隔离、`remoteJsLibCache` 的并发 map——这三条都是**已修过的串数据 bug**，说明这条线历史上真的出过问题（`JsSandbox.kt:239-240`、`:466-475` 的注释）。

---

## 7. 异常传播与错误分类

### 7.1 脚本抛异常时用户看到什么

| 环节 | 行为 | 位置 |
|---|---|---|
| 捕获 | `catch (e: Exception)`：**吞掉异常、只记原因**，返回 `null` | `JsSandbox.kt:447-452` |
| 原因落地 | `execContext.lastError = detail`（供登录/界面）+ `lastError`（线程级，供无 context 的调用方） | `:449-451` |
| 脱敏 | `scrubInternalSourceTag`：只擦**我们自己的**脚本名行号 `(sandbox-compat\|json-compat\|shape-probe)#N`；**保留** `rule.js#3` / `jsLib.js#12`（书源自己的脚本，对用户有用） | `:696-704` |
| 栈 | **不记录、不返回 Java 堆栈**。Rhino 只给 `异常文案 (脚本名#行)`；Java 侧异常经 `fetchFailureText` 压成一句人话「抓取失败：<最深一层 message>」，取 5 层 cause 防成环 | `:177-185` |
| 规则层传播 | 取不到值 → `RuleExecutionException("正文规则未提取到内容，脚本异常：$lastError")` 这类 | `RuleRunner.kt:470-472`；12a 已展开 |
| 登录层传播 | `SourceLoginActionResult(success = lastError == null, error = lastError)`；v2 渲染失败把 `lastError` 直接给前端 | `RuleLogin.kt:337-353`、`:122-125`、`:70-75` |
| 不可捕获的错误 | `Error`（OOM、StackOverflow）**穿透** `catch(Exception)`，只走 `finally` | §5.5 |

### 7.2 是否吞异常——**吞，而且是分层吞**

- `evalImpl` 吞掉所有 `Exception`（用户只看到一句话 + `null`）。
- 桥内部大量 `runCatching{}.getOrDefault("")`：`java.ajax` 失败回一句文案字符串（`:1160-1161`）、`base64Decode` 回 `""`（`:1463-1472`）、`hexDecode` 回原文（`:1572-1580`）、`aesBase64DecodeToString` 回 `""`（`:1502-1522`）、`toURL` 解析失败给空字段（`:767-798`）。
- **有意的例外（一定范围内"说清是谁失败"）**：`simpleCrypto` / `bytesResult` / `createSymmetricCrypto` / `desLike` 都把失败写进 `lastError`（`:1835-1846`、`:1868-1879`、`:1918-1923`、`:1991-2009`），因为「密文当明文用、界面显示正文为空」是历史上最难排查的错误。
- `java.log` 是**空实现**（`:1244-1248`）→ 脚本的调试输出全部丢失（§9.4 兼容性注意）。

### 7.3 错误如何分类

**代码层没有枚举式的错误类型**，只有**文案前缀 + 抛出层级**：

| 类别 | 判定点 | 用户可见文案形状 |
|---|---|---|
| **网络失败** | `RuleExecutionException("上游返回 HTTP n")` / 「重定向次数超过限制」/ `fetchFailureText` | 「抓取失败：…」——**作为字符串交给脚本**，不抛给脚本（`:1157-1161` 注释：Java 异常直接穿 Rhino 会被包成 `ClassCastException` 文案） |
| **规则失败**（取不到值） | 空结果 → `RuleExecutionException("…未提取到内容")` | 「正文规则未提取到内容，脚本异常：<detail>」 |
| **登录失败** | `execContext.lastError != null` | `ok=false` + `message=detail`（前端原样显示） |
| **脚本超时** | `EvaluatorException("…超过 30000ms 上限，已中断（疑似死循环）")` | 同上「脚本异常：…」 |
| **资源超限** | `IllegalArgumentException("…超过 64MB 上限，已拒绝（疑似脚本放大攻击）")` | 同上；但只有桥调用才产出 |
| **沙箱内部故障** | `error("未实现的 Java 白名单类…")`、`EvaluatorException("org.jsoup.x 失败：…（来自 方法名）")` | 带内部痕迹（已尽量擦） |

**结论**：分类靠**文案约定**，跨 3 个文件（`JsSandbox` / `RuleRunner` / `RuleLogin`）各写一遍。新架构要补一个 `enum RuleFailureKind`（network/script/timeout/budget/login/auth），否则前端永远只能正则匹配中文。这在 §9.2 列为 C-5。

---

## 8. 沙箱逃逸面评估（按攻击面）

> 纪律：以下**没有任何一条**被认定为「存在漏洞」。等级是「静态审查下的可疑度」，凡有推断成分一律 `needs-runtime-test` 并给验证思路。全部验证都在**测试代码里**做（`JsSandbox().eval(...)` + 注入小预算/小超时，与 `JsGuardLimitsTest` / `JsSandboxHostBudgetTest` 同一套手法），**不导入任何恶意书源**。

### E1 · 反射绕过 —— 等级 **低**
- **攻击面**：`Packages.java.lang.Class`、任意对象的 `getClass()`、`getDeclaredMethod` 链、`Function("return this")()`、`__proto__`/`constructor.constructor` 原型链。
- **证据**：`ClassShutter{false}`（`JsSandbox.kt:303`、`RuleRunner.kt:1667`）+ 白名单 43 类里**无** `Class`/`Method`/`ClassLoader`（`JavaPackages.kt:1385-1403`）+ 沙箱内无真 Java 对象（§2.B）。`initSafeStandardObjects` 不给全局 `getClass`。
- **残余疑点**：`JsClass` 是 `BaseFunction` 子类（`JavaPackages.kt:219-236`），其 `constructor`/`__proto__` 属于 **JS 层**（Rhino 的 Function 原型），不指向 Java 反射——但「Rhino 的 `Function` 能不能拿到宿主 Java 类」这件事没有实测。
- **验证思路**：
  ```kotlin
  // 一条脚本，逐项断言全部为 undefined / 抛 TypeError
  """
  var probes = [
    typeof Packages.java.lang.Class,              // 期望 "undefined"
    typeof Packages.java.lang.Runtime,            // 期望 "undefined"
    typeof Packages.java.lang.Class.forName,      // 期望 "undefined"
    typeof JavaImporter,                          // 期望 "function"（我们的替身）
    ({}).getClass === undefined,                  // 期望 true
    typeof Function("return this")().Packages,    // 期望 "object"（白名单树，不是 Rhino 的）
    typeof Function("return this")().java.lang,   // 期望 "undefined"（我们只注入了 java 桥）
  ];
  JSON.stringify(probes)
  """
  // 另测：Packages.java.util.Arrays.getClass —— 拿到的 JsClass 是 BaseFunction，
  //       .getClass 应为 undefined；.constructor 应为 Function（JS 侧），其构造的实例无 Java 能力
  ```
  再加一条**基线式**判据：复用 `JavaPackagesEntryBaselineTest` 的反射枚举，断言暴露面集合**逐字不变**。

### E2 · 宿主对象泄漏（把真实 Connection/Database 传进沙箱）—— 等级 **低，但结构性脆弱**
- **攻击面**：`JsSandbox.toJsValue`（`:2090-2098`）的 `else -> Context.javaToJS(value, scope)`。**任何非 Map/List/String 的 Kotlin 对象**作为 binding 传进来，就会被 Rhino 包成 `NativeJavaObject` 落进 scope——此时只剩 `ClassShutter` 一层防护（与 §1.4 的「压根不放 Java 对象」设计相悖）。
- **现状**：全部调用点都只传 `String`/`Map`/`emptyMap`/`Int`/`Boolean`：
  `RuleRunner.kt:290`（baseUrl/sourceId）、`:592`（baseUrl/sourceId/result=emptyMap）、`:723`（result=Base64 串）、`RuleLogin.kt:62`/`:111-117`/`:329-335`（state/form JSON 串 + loginData）。
  → **当前无泄漏（confirmed）**；但这条通道没有任何机制拦住「下一个人顺手把 `db` 或 `Fetched` 塞进 bindings」。
- **同类残留**：`java.put`（`:2033`）与 `cache.putMemory`（`:1096`）会把**上一轮的 Rhino 对象**存起来跨执行复用（§6.3）。
- **验证思路**：
  ```kotlin
  // ① 负向：断言所有注入对象的类型
  val sandbox = JsSandbox()
  val out = sandbox.eval("""
    function probe(o){ return o === null ? "null" : (typeof o + ":" + Object.prototype.toString.call(o)); }
    JSON.stringify([probe(java), probe(source), probe(book), probe(chapter), probe(cache), probe(org)])
  """, emptyMap(), JsExecutionContext(sourceId = "https://leak.example"))!!
  // 期望全部是 "object:[object Object]" / "function:…"，出现 "object:[JavaObject …]" 即失败
  // ② 正向（应当安全）：传一个真实 Java 对象作为 binding，断言脚本拿不到它的方法
  val rr = RuleRunner(database = null)
  sandbox.eval("String(result.getClass)", mapOf("result" to rr), JsExecutionContext())  // 期望 "undefined" 或不含类名
  ```
  并把「bindings 只允许 String/Number/Boolean/Map/List」做成**类型层约束**（新架构用一个 sealed `JsBinding` 代替裸 `Map<String,Any?>`）。

### E3 · `load()` / 远端脚本 —— 等级 **中（设计内，但缺一道确认）**
- **`load()` 本身不存在**：`initSafeStandardObjects` 不含 `load`/`loadClass`/`defineClass`/`readFile`/`readUrl`（§2.A，likely）。
- **真正等价于 `load()` 的是四个入口**：
  1. `Reload(url)`（`:347-368`）——抓回**字符串**，脚本自己 `eval(String(Reload(...)))`；
  2. `java.importScript(path)`（`:1404-1422`）——抓回字符串，**空内容抛 `EvaluatorException`**；
  3. `evalLibrary` 的**远端 jsLib 映射**（`:488-507`）——`jsLib` 写成 `{"名":"https://…js"}` 时，**每次规则求值都会先把远端 JS 抓下来并 `cx.evaluateString`**，无需用户任何动作，也无需脚本显式调用；
  4. `java.cacheFile(url)`（`:1379-1399`）——抓回字符串（本身不执行，但与 1/2 组合即可执行）。
- **防护现状**：全部走同一条 `runner.fetch` → `NetworkSecurity` SSRF 闸门（§4.2）+ 2 MiB 响应上限。缓存 `remoteJsLibCache` 按 URL 存正文、满 64 条清空（`:498-504`）。
- **残余风险**：**远端 JS 在沙箱内执行，沙箱 = 全部白名单能力**（含 `java.ajax`、`cookie.getCookie`、`source.setVariable`、`cache`）。也就是说「导入一个引用外站 jsLib 的书源」≈「信任那个外站随时推新代码」；而**这一条不区分用户意图**，与「只导入信任书源」的安全前提是同一个前提（源码注释 `:355-359` 自己承认：「执行权仍然交给书源自己的 eval —— 满足"只导入信任书源"的安全前提」）。
- **验证思路**：
  ```
  本地起一个 http 服务（或 FETCHER 桩）回一段 JS：
    (a) 记录 java.ajax 是否可用 → 证明远端脚本拿到了全部能力
    (b) 记录 source.setVariable / cache.put 能否改写库内数据
  另测 NetworkSecurity 是否真的挡住 http://127.0.0.1:<port>（期望抛「拒绝访问内网或本机地址」）
  再测 2MiB 上限：回一个 3MiB 的 jsLib，期望 RuleExecutionException 而不是把 3MiB 喂给 Rhino
  ```

### E4 · 脚本缓存投毒 / 跨源污染 —— 等级 **低-中**
- **已隔离的部分（confirmed）**：
  - `ScriptCache` 内存+磁盘键都是 `sourceId\u0000key`（`ScriptCache.kt:36`、`:77-87`）；
  - `sessionStore` 键 `sourceId\u0000key`（`JsSandbox.kt:239-240`）；
  - `java.cacheFile` 用 `"dl:"+md5Hex16(url)` 作键，但**存储仍按 sourceId 分**（`:1381-1387`）。
- **未隔离的部分**：
  1. `remoteJsLibCache` **按 URL 全局共享**（`:486-506`）——A 源与 B 源引用同一 URL 时共用一份正文。若该 URL 内容可被第三方改写（外站），**一次投毒同时影响所有引用它的源**；反之若某源能让人写入该 URL（不成立，只读），则是直接投毒。
  2. `ScriptCache.memory` 是**全局 LRU 2048**（`ScriptCache.kt:25-33`）→ 单源可把其它源的缓存条目挤掉（可用性面）。
  3. `java.put` 的 `sessionStore` **无容量上限**（§6.2）→ 单源可留下 GB 级常驻对象。
- **验证思路**：
  ```
  ① 两源同 key 隔离：sourceId=A 写 cache.put('k','A')，sourceId=B 读 cache.get('k') → 期望 null
  ② jsLib 跨源共享：A/B 同 jsLib URL，桩只允许抓一次 → 断言桩调用次数=1（证明共享）
     再让桩返回不同内容第二次 → 断言 B 拿到的是第一次的旧内容（证明"投毒窗口"存在）
  ③ sessionStore 无界：在预算内跑 for(i<200000) java.put('k'+i, repeat(200)) 后测堆增长（不设 limit，看是否被任何机制拦住）
  ```

### E5 · 加密脚本（`ScriptCrypto`）密钥管理 —— 等级 **低**
- **不存在宿主密钥**：`ScriptCrypto` / `JavaPackages` 的加密族**只用脚本传进来的 key/iv**（`ScriptCrypto.kt:90-99`），没有 keystore、没有 `KeyStore`、没有预置密钥、没有 PBKDF；`KeyFactory`/`SecretKeyFactory`/`Signature` 的算法名也是脚本给的（`JavaPackages.kt:461-483`、`:516-532`、`:1066-1093`）。
- **「密钥管理」在本项目里的真实含义**：书源的 AES key **明文存在书源 JSON 里**（社区源本来就这么分发），沙箱只负责算法等价。所以「密钥泄漏」不是沙箱问题，而是**书源即凭据**的问题。
- **唯一的技术疑点**：脚本可控的 `transformation` / `algorithm` 直接进 `Cipher.getInstance` / `Signature.getInstance`（无 `runCatching`，`JavaPackages.kt:1024`、`:1067`）→ 未知算法抛的是**原始 Java 异常**，穿进 Rhino 后可能变成脚本 `catch` 接不住的 `WrappedException`（同类问题在 `importScript` 处被显式修过：`:1414-1417` 注释「raw IllegalStateException 会穿透 JS catch，最后变成 cannot be cast to java.lang.Error」）。
- **验证思路**：
  ```kotlin
  // ① 算法名乱写的可控性
  eval(""" try { Packages.javax.crypto.Cipher.getInstance("NO/SUCH/ALG"); "caught" } catch(e) { "caught:" + (e && e.message) } """)
  // 期望拿到 "caught:…"；若返回 "caught" 说明 JS catch 接住了（好）；若整个 eval 抛错 → 复现了穿透问题
  // ② 密钥材料上限：循环 new SecretKeySpec 1100 次，期望第 1025 次抛「密钥/IV 超过 1024 个上限」
  // ③ 断言沙箱内不存在 KeyStore / SecureRandom 之外的真随机源 / 文件型 keystore
  ```

### E6 · HTML/JSON 桥的注入面 —— 等级 **中（本册最值得警惕的一条）**
- **`JsoupBridge` 本身很窄（confirmed）**：只 `parse`/`parseBodyFragment`（`:38-44`），**没有 `Jsoup.connect`**（`:22-26` 明说「那是网络出口，不在这里开第二条路」），元素包装只挂只读方法（`:76-118`），越界下标返回 `undefined`（`:194-196`），异常一律转 `EvaluatorException` 带方法名（`:197-199`）。**HTML 解析不经网络、不读文件、不碰 `baseUri` 以外的东西**。
- **真正的注入面在「内容往哪去」**：
  1. `java.htmlFormat` → `ScriptHtml.formatKeepImg`（`ScriptHtml.kt:37-53`）**故意保留 `<img src="…">`**，含页面里的任意 `data-*` 值。这段字符串最终会作为正文进前端 → `img src` 可控。
  2. `java.startBrowserAwait('data:text/html;base64,…')` → `decodeDataUrlText`（`JsSandbox.kt:191-215`）→ `execContext.inlineHtml` → 交给**界面 iframe 本地渲染**（`:1294-1309`，注释：「书源自带设置页由界面 iframe 本地渲染；关闭时把整页 HTML 交回来」）。
     → **这是唯一让书源控制的 HTML/JS 在「宿主浏览器里」执行、而不是在 Rhino 沙箱里执行的通道。** 它绕过了本节讨论的所有 Rhino 防护。
  3. `execContext.browserBody`（界面交回的整页 HTML）会被再次喂给脚本当 `r.body`（`:1298-1300`）——数据流是双向的。
- **验证思路**：
  ```
  ① htmlFormat 注入：java.htmlFormat('<img src="javascript:alert(1)">') → 断言输出仍含 javascript: 协议
     再跟到前端渲染层（ReaderBody 的图片渲染 / img src 归一化）确认有没有协议白名单 —— 若前端做了
     http(s)/data 白名单则降为「低」；若原样进 img src 则必须列为「中」
  ② inlineHtml：用 startBrowserAwait('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')
     走一次登录 UI 渲染，检查 iframe 的 sandbox 属性 / CSP / origin。这是 needs-runtime-test 的核心一项，
     必须在前端侧（InlineBrowser/WebViewProxy）复核，本册无权限到那一步
  ③ JSON 桥：book/chapter/JsMapObject 均为 NativeObject + 兜底方法（JsMapObject.kt:51-107），
     断言 for..in 遍历不会把方法当数据带出（注释 :18-20 声称如此，需实测确认）
  ```

### E7 · 其他值得记录的三条（补充，非清单要求但同等级）

| # | 面 | 等级 | 证据 | 验证 |
|---|---|---|---|---|
| **E7a** | **`java.ajax` 系列绕过墙钟**：JS 网络调用不传 `deadlineMs`，阻塞期间指令观察器零回调 → 100 次 `java.ajax` ≈ 33 分钟 | **中** | §4.4 全表（`:1160`/`:1222`/`:1198`/`:1804`/`:1823`/`:1386`/`:351` 均无 `deadlineMs`；仅 `JavaPackages.kt:1255` 有） | 桩地址 `delay(20_000)`，注入 300ms 超时，跑 `for(i<5) java.ajax(u)`，测真实耗时（期望 ≈100s 即证明守卫失明） |
| **E7b** | **`sessionStore` / `cache.putMemory` 把 Rhino 对象存进程级容器**（跨 eval、跨线程、无上限、不计预算） | **中** | `JsSandbox.kt:2033`（无 cap）、`:1096`、`ScriptCache.kt:48-50` | 见 E4 ③ + §6.3 的跨 Context 用例 |
| **E7c** | `mainJs` 路径无 hostByteBudget | 低 | `RuleRunner.kt:1665`（`enter()` 只传超时） | 断言 `BoundedJs.hostBytesSpent()` 在该路径恒 0 且不抛预算错 |

---

## 9. 结论：这块能不能原样搬进新架构

### 9.1 结论

**可以搬，但不能「原样」搬。** 现状是**一个「白名单 deny-all」的优秀骨架 + 三层不完整的外围**：
- 第 1 层（`ClassShutter{false}` + `initSafeStandardObjects`）：**强，可原样搬**，是本项目相对上游的真正优势。
- 第 2 层（手写 43 类替身 + 98 个静态入口）：**方向正确、有枚举基线判据（`JavaPackagesEntryBaselineTest`）**，但它是「漏一个就是一个洞」的形状，必须**连同基线判据一起搬**，否则等于把洞当成 API 搬走。
- 第 3 层（墙钟 20k 指令 / 64MB 宿主预算 / 8MB 单次 / 16MB GZIP）：**只覆盖「宿主分配 + 死循环」两类**，**不覆盖纯 JS 堆、不覆盖网络阻塞、不覆盖累计态（sessionStore）**。

### 9.2 搬之前必须先补的判据与约束（按优先级）

| # | 必须补的 | 为什么（本册证据） | 形态 |
|---|---|---|---|
| **C-1** | **出站预算**：单次执行的请求次数上限 + 出站总字节上限 | §4.4：三项全无；`MAX_BODY_BYTES` 只逐响应；`AppConfig.kt:158` 明说网络字节不计入预算 | 在 `BoundedContext` 加 `fetchCount` / `egressBytes`，在所有 `runner.fetch*` 入口统一 charge（与 `chargeHostBytes` 同形） |
| **C-2** | **JS 网络调用的墙钟**：让 `java.ajax/get/post/connect/head/cacheFile/Reload` 也传 `deadlineMs` | §4.4 / E7a：只有 okhttp3 传了 | 一行改动 ×7 处，但**必须逐个单测**（这些入口被全部书源共用，`fetchResponse` 的 `deadlineMs=null` 默认值是为兼容留的） |
| **C-3** | **纯 JS 堆的上限**：要么进程隔离（子进程 + `-Xmx`），要么接受并写清「OOM 会穿透 `catch(Exception)`」 | §5.5：`hostByteBudget` 对 Rhino 堆完全失明；`OutOfMemoryError` 不被捕获 | 短期：捕获 `OutOfMemoryError` 的风险评估 + `-Xmx` 显式设定 + 文档化；长期：JS 执行独立进程（`rhino` 已是纯 JVM 依赖，`JsGuard`/`GzipLimits` 已刻意不依赖 `io.legado`，`JsGuard.kt:22-24`、`GzipLimits.kt:30` 都写了「这是将来把沙箱层拆成独立模块的前提」——**作者已经预留了这条路**） |
| **C-4** | **累计态封顶**：`sessionStore` 与 `cache.putMemory` 的容量/字节上限 | §6.2 / E7b：预算 per-eval，但容器 per-process | 加 cap + LRU；或让 `java.put` 只存**字符串**（上游 `put` 就是 `value.toString()`，`JsSandbox.kt:1049` 的注释也这么说） |
| **C-5** | **错误分类枚举**：`RuleFailureKind` | §7.3：分类靠中文文案跨 3 文件各写一遍 | `enum { Network, Script, Timeout, Budget, Login, Parse }` + 保留现有文案 |
| **C-6** | **bindings 类型约束** | §E2：`toJsValue` 的 `javaToJS` 兜底是唯一「放真 Java 对象进来」的通道 | `sealed interface JsBinding`，只允许 String/Number/Boolean/Map/List/Bytes |
| **C-7** | **嵌套求值的预算正确性** | §1.2：内层 `enter` 可能覆盖外层 `deadlineMs`/`hostBytes` | 实测 `ContextFactory.enter()` 语义；若有复用，改成「取 min(deadline)、累加 hostBytes、引用计数」 |
| **C-8** | **`inlineHtml` / 图片 src 的宿主侧白名单** | §E6：唯一绕过 Rhino 的通道 | 前端 iframe `sandbox` + `img src` 协议白名单（跨册，需前端审计员确认） |
| **C-9** | **`mainJs` 路径补 `hostByteBudget`** | §5.4 | 一行改动 |
| **C-10** | **`fetchedFetcher`/`responseFetcher` 桩只能测试注入** | §4.2：短路 SSRF 闸门 | 装配层禁止 + 一条断言的架构测试 |

### 9.3 **绝对不能改语义**的地方（社区书源依赖的宿主 API 行为）

按「改了就有成百上千份源静默失败」排序。每一条都在源码里带实测份数注释，**新架构必须逐字保留**：

| 语义 | 为什么不能动 | 证据 |
|---|---|---|
| **`java.get` 的双重分派**：`args.size>=2 \|\| 看起来是 URL` → HTTP GET，否则 → KV 读 | 曾经两个注册互相覆盖 → 所有用 `java.get` 抓页的源拿到 `undefined`（「执行成功但内容为空」） | `JsSandbox.kt:1212-1228` |
| **`JSON.parse` 兼容层**（对象直接返回、字符串走原解析） | 不做 → 「搜索完成：0 项」（try/catch 吞掉后整条记录消失） | `:306-341` |
| **`JsScriptShape` 的「顶层 return 才包 IIFE」** | 按文本搜 `return` 会吞掉 210 份源的结果 | `JsScriptShape.kt:14-27`、`JsSandbox.kt:288-294` |
| **`responseView` 的「既是字符串又是响应对象」** | 116 处调字符串方法、115 处调 `.body()`/`.statusCode()`；只给一种另一批就碎 | `:596-679` |
| **`cookie.setCookie/replaceCookie/setWebCookie/removeCookie` 返回空串** | 返回 `true` 会让 253 份源的 searchUrl 变成 `true/search/...` | `:996-1020` |
| **`source.getVariable()` 未命中回 `""`；`book.getVariable()` 未命中回 `"null"`（字符串！）** | 上游 `RuleDataInterface` 的真实行为；改成 `null` 会让 `+` 拼接变 `"undefined"` | `:563`、`:935-939` |
| **`getUserAgent() === getWebViewUA()` 必须相等** | 蓝批系列用相等性判「是否运行在阅读里」，不等会走降级分支 | `:155-168`、`:1344-1355` |
| **`timeFormatUTC(ts, fmt, 小时)` 按小时换算**（**故意偏离上游**） | 上游把小时当毫秒传，等于不生效；照抄会让番茄系时间错 8 小时 | `:1661-1680`（注释明确记录这是有意为之） |
| **`java.getStringList` vs `getElements` 的区别**（取值列表 vs 条目本身） | `.dropDown@li@data-p` 要的是属性列表；JSONPath 要的是条目文本 | `:1705-1785` |
| **`loginUrl` 的 JS 只在 `includeLoginScript=true` 时执行** | 普通规则预跑它，qyyuapi 系脚本的 `put($$$)` 会打断搜索 | `:96-105`、`:426-431` |
| **未知类静默 `undefined`**（不是抛错） | 大量 try/catch 探测型源（魔改版探测）依赖它安静失败 | `JavaPackages.kt:50-51`、`:86-95` |
| **`Reload` 挂浏览器 UA + Referer** | qyyuapi 系按 UA 拦，默认 UA 直接 403 | `JsSandbox.kt:120-123`（`reloadFetchUrl`）、`:134-158`（`headerSafe` + 两个 UA 常量） |
| **`importScript` 空内容抛 `EvaluatorException`**（不是 Java 异常） | Java 异常会穿透 JS catch，最后变成 `cannot be cast to java.lang.Error` | `:1414-1417` |
| **数字输出去掉 `.0`** | Rhino number 恒 double，`a.length` 会印成 "2.0" 直接显示到界面 | `:800-812` |

### 9.4 兼容性遗留（不阻塞搬迁，但要记账）

1. **没有 `console`，`java.log` 是空实现**（`:1244-1248`）→ 书源作者的调试输出全丢。新架构若要加 `console`，需要评估「脚本用 `console.log` 探测宿主」的既有写法（目前会 ReferenceError，某些源可能用 try/catch 探测）。
2. **`isLongClick` / `book.readConfig` / `chapter.start-end` 均为桩值**（`:536-537`、`:547-549`、`:517-518`）。
3. **`java.toast` 只收集不弹**（`:1231-1241`），由前端决定。
4. **`Thread.currentThread().getName()` 硬编码 `"main"`**（`JavaPackages.kt:252`）——脚本若用它判线程会得到假信息（比泄漏真实线程名好）。
5. **`java.version` 返回真实 JVM 版本**（`:268`）——审计文档 §3 F 项判定「刻意保留，收益接近零、风险非零」（`product/docs/rules-sandbox-audit.md:83`）。

---

## 10. 证据索引 + 未确认 + 覆盖率

### 10.1 证据索引（本册所有 `file:line` 按主题归并）

| 主题 | 位置 |
|---|---|
| **进入/退出** | `JsSandbox.kt:300`（enter）、`:301`（try）、`:447`（catch Exception）、`:452`（return null）、`:456`（finally exit）；`JsGuard.kt:106-117`（enter/exit）、`:44-48`（观察器）、`:63-64`（解释模式+阈值）、`:76`（栈深）、`:87`（ES6） |
| **scope 与注入** | `JsSandbox.kt:304`（initSafeStandardObjects）、`:331`（org）、`:349-351`（bindings）、`:339`（java）、`:347`（Reload）、`:360`（Packages/JavaImporter/importPackage/importClass）、`:366`（source）、`:377`（cookie）、`:384`（put）、`:404-408`（cache）、`:411`/`:413`（book/chapter）、`:418`（environment）；`JavaPackages.kt:70-75`（install） |
| **白名单** | `JavaPackages.kt:1385-1403`（CLASS_NAMES 43）、`:1405-1406`（PACKAGE_CLASSES）、`:1408-1413`（NAMESPACES）、`:81-96`（PackageNode.get）、`:192-196`（resolve）、`:129-170`（ImporterObject）、`:172-181`（importPackage）、`:183-188`（importClass）、`:238-645`（buildClass 全表）、`:644`（未实现 error） |
| **危险类** | `JavaPackages.kt:240-260`（Thread 替身+sleep cap）、`:261-277`（System 替身，无 exit）、`:272-275`（getenv 恒空）、`:425-438`（HashMap/ArrayList 替身） |
| **shutter** | `JsSandbox.kt:303`、`RuleRunner.kt:1667` |
| **网络** | `JsSandbox.kt:1150`（ajax）、`:1168`（ajaxAll）、`:1193`（post）、`:1215`（get 双分派）、`:1800`（connect）、`:1819`（head）、`:1393`（cacheFile）、`:1404`（importScript）、`:347`（Reload）、`:488-507`（远端 jsLib）；`JavaPackages.kt:1203-1260`（okhttp3→fetchResponse+deadline）；`RuleRunner.kt:1059`/`:1070`（fetch/fetchResponse）、`:1221-1311`（fetchDetailedImpl）、`:1315-1323`（validateTarget→NetworkSecurity）、`:1332`（buildRequest 调用）、`:1334`（20s）、`:1239`（4 跳）、`:1381-1400`（effectiveHeaders/Cookie）、`:1257-1266`（Set-Cookie 落罐）；`ResponseBody.kt:20`/`:98`/`:110`（2 MiB） |
| **内存/时间预算** | `JsGuard.kt:26-49`（BoundedContext）、`:132-144`（chargeHostBytes）、`:158`（deadlineOrNull）；`JavaPackages.kt:772-781`（requireAllowedLength+记账）、`:784-793`（StringBuilder）、`:806-813`（keyMaterial cap）、`:1349-1375`（四个常量）、`:606`/`:614`（GZIP 记账）；`GzipLimits.kt:35`/`:45-61`/`:64`/`:76-86`；`AppConfig.kt:148`（30s）、`:151`（64MB）、`:176-179`（0=不设限） |
| **并发** | `JsSandbox.kt:239-240`（sessionKey）、`:250-263`（threadContext+withSourceContext）、`:462-475`（lastError ThreadLocal）、`:200-207`（ajaxAllPool）、`:486-507`（remoteJsLibCache）；`ScriptCache.kt:25-36`（全局 LRU + 按源分键） |
| **错误** | `JsSandbox.kt:696-704`（擦内部 tag）、`:177-185`（fetchFailureText）、`:1835-1846`/`:1868-1879`/`:1918-1923`（lastError 记录）；`RuleRunner.kt:470-472`；`RuleLogin.kt:70-75`/`:122-125`/`:337-353` |
| **登录入沙箱** | `RuleLogin.kt:44-78`（v2 render，`includeLoginScript=true`）、`:84-130`+`:320-354`（v2 action / v1 action）、`:250-261`（v1 loginUi 脚本）、`:356-394`（loginCheckJs） |
| **既有判据** | `JsGuardLimitsTest`（墙钟真触发 + GZIP）、`JsSandboxHostBudgetTest`（累计预算）、`JsSandboxResourceLimitTest`（4 个宿主上限+sandbox 存活）、`JsSandboxHostAmplificationTest`（脚本可控 length 模式）、`JsSandboxRequestShapeTest`（无 Java 引用）、`JavaPackagesEntryBaselineTest`（43/98/13 枚举基线）、`JsoupBridgeTest`、`JsScriptShapeTest`、`StrUtilFormatTest` |
| **既有审计文档** | `product/docs/rules-sandbox-audit.md`（109 行，10 项已修 + A~G 逐项，E 项 2026-11-14 收口） |

### 10.2 未确认事项（needs-runtime-test，按重要性）

| # | 未确认 | 为什么静态无法定论 | 验证入口 |
|---|---|---|---|
| U1 | 纯 JS 堆分配是否先于墙钟 OOM | Rhino 堆无 instrument；取决于 `-Xmx` 与分配速率 | §5.5 脚本 |
| U2 | `ContextFactory.enter()` 是否复用线程 Context（→ 嵌套预算洗白） | 属 Rhino 库语义，本仓未覆盖 | 断言 `BoundedJs.hostBytesSpent()` 在嵌套 eval 前后是否被清零 |
| U3 | `java.ajax` 等 7 个入口的阻塞是否完全无视墙钟 | 依赖「阻塞期间观察器零回调」这一 Rhino 行为（代码注释自述，未实测） | E7a 桩地址测耗时 |
| U4 | `initSafeStandardObjects` 到底不给哪些全局（`load`/`print`/`getClass`/`console`） | 属 Rhino API，随版本变化 | S-0：`typeof load/print/getClass/console/readFile/quit` 全表断言 |
| U5 | `jsLib` 远端脚本是不是**每次规则求值都抓一次**（首次后走缓存） | 缓存键是 URL、命中即复用，但首轮 N 次抓取无法从静态看出 | 桩计数 |
| U6 | `inlineHtml` 的 iframe 在执行书源 HTML 时有无 sandbox/CSP | 属前端（本册无权限） | E6 ②，交前端审计员 |
| U7 | `java.get` 取回的跨 eval Rhino 对象在实际并发下会不会坏 | Rhino 线程语义 | §6.3 |
| U8 | `Cipher.getInstance(脚本给的名字)` 抛的 Java 异常能否被 JS `catch` 接住 | 与 `importScript` 同类问题，但那条是显式修的 | E5 ① |
| U9 | `org.jsoup` 元素包装在 `for..in` / `JSON.stringify` 下的真实形状 | Rhino NativeObject 序列化语义 | E6 ③ |

**明确不在本册范围（留给其他审计员）**：`WebViewProxy`（书源 WebView 代理）、前端 `img src` 渲染白名单、`Database`/Cookie 存储的加密、`mainJs` 执行链细节（12a）。

### 10.3 覆盖率声明

- **本册必读清单 11 个文件：10 个整篇（100%）+ `ScriptConvert.kt` 结构级（非安全面，简繁表）**。
- **JsSandbox.kt：2100/2100 = 100%**（6 块窗口：1–240 / 240–520 / 520–830 / 830–1120 / 1120–1500 / 1500–1880 / 1880–2100）。
- **JavaPackages.kt：1415/1415 = 100%**（1–200 / 200–470 / 470–700 / 700–880 / 880–1000 / 1000–1135 / 1130–1290 / 1290–1415）。
- **交叉文件按 JS 面读全**：`RuleLogin.kt`（JS 入口 8 处全覆盖）、`RuleRunner.kt`（fetch/buildRequest/effectiveHeaders + 两处 shutter + 全部 `jsSandbox.eval` 调用点）、`ResponseBody.kt`/`AppConfig.kt`（额度常量）。
- **未读**：`RuleRunner` 的取值/切分主体（12b 范围）、`ScriptConvert` 的转换表实现、`WebViewProxy`（他人范围）。
- **统计**：43 个白名单类 / 21 个可达命名空间 / 14 个注入全局 / 11 个网络出口 / 9 个宿主上限常量 / 8 条已识别逃逸面（含 3 条补充）/ 9 项未确认。
