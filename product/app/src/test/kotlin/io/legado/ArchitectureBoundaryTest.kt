package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.readText

/**
 * 架构边界守卫（零依赖，单模块 `:app` 即可跑）。
 *
 * 它把三份外部架构报告（`docs/architecture-audit.md`）实测收敛出的**三条硬边界**
 * 变成一条"没人能违反的依赖声明，而不是文档"——这正是那几份报告反复强调、
 * 但当时只停在口号层面的东西。刻意**不引 ArchUnit、不建 Gradle 多模块**：
 * 前者要给 `build.gradle` 加依赖（有并行重构撞车风险），后者对单模块项目是超前投资。
 * 这里用「扫源码 + 显式基线 + 断言相等」实现等价效果。
 *
 * 三条判据：
 * 1. **`java` 桥暴露面** —— `JsSandbox.createJavaBridge` 里 `putProperty(api,"…")` 的方法名集合，
 *    必须与 [BRIDGE_WHITELIST] **完全相等**。多一个＝未登记就扩面（红）；少一个＝有人删了桥方法
 *    却没同步白名单（红，逼你确认删除是有意的）。真实语料（5598 源）里有 12 个方法零调用，
 *    裁剪候选见审计文档 §3。
 * 2. **`model/` 不得反向依赖** —— `model/` 任何文件都不得 import 除 `io.legado.model` 外的
 *    `io.legado.*` 包。当前实测 **0**，此判据把它锁死，防"数据类反吞宿主/上层类型"回流。
 * 3. **`rules/` 不得直连实现层** —— `rules/` 不得 import `data/` `source/` `http/` 下的**具体实现类**，
 *    已知横穿进入 [RULES_CONCRETE_BASELINE]（初测 25 条；NetworkSecurity 下沉 `ops/` 后 24 条），断言**相等**：
 *    新横穿＝红；某条随端口化（VariableStorePort/CookieStorePort/WebViewFetcher/NetworkSecurity）
 *    被消掉，也必须从基线同步删除（红→逼你缩小基线）。基线只允许单调缩小。
 *
 * 运行：`gradlew :app:test --tests "*ArchitectureBoundaryTest"`（JUnit 4，与仓库统一）。
 */
class ArchitectureBoundaryTest {

    // ===== 1. java 桥白名单 =====

    @Test
    fun `java 桥暴露的方法集合必须与白名单完全相等`() {
        val exposed = extractBridgeApiMethods(readServerFile("rules/JsSandbox.kt"))
        val added = exposed - BRIDGE_WHITELIST
        val removed = BRIDGE_WHITELIST - exposed
        assertTrue(
            "java 桥新增了未登记方法：$added\n" +
                "新增桥方法的变更流程（见 docs/architecture-audit.md §4）：" +
                "(a) 附一份真实书源使用 java.$added 的语料举证；" +
                "(b) 同步更新本测试 BRIDGE_WHITELIST；" +
                "(c) 在审计文档记一条并说明它属于哪个端口/能力类。",
            added.isEmpty(),
        )
        assertTrue(
            "java 桥少了白名单里的方法：$removed —— 若确为裁剪（如 12 个零调用候选），" +
                "请一并从 BRIDGE_WHITELIST 移除；否则说明桥被无声收窄。",
            removed.isEmpty(),
        )
    }

    // ===== 2. model 不得反向依赖上层 =====

    @Test
    fun `model 包不得 import 任何其他领域包`() {
        val dir = serverDir().resolve("model")
        val violations = scanCodeLines(dir).flatMap { (file, lines) ->
            lines.mapNotNull { MODEL_REVERSE_IMPORT.find(it) }
                .filter { it.groupValues[1] != "model" }
                .map { "${file.fileName}:${it.groupValues[1]}" }
        }
        assertTrue(
            "model/ 出现反向依赖（纯数据类不该 import 上层实现），当前基线为 0，任何新增都要评审：" +
                violations.joinToString(),
            violations.isEmpty(),
        )
    }

    // ===== 3. rules 只能走端口，不得直连 data/source/http 具体实现 =====

    @Test
    fun `rules 对 data source http 的具体 import 必须与基线完全相等`() {
        val dir = serverDir().resolve("rules")
        val actual = scanCodeLines(dir).flatMap { (_, lines) ->
            lines.mapNotNull { RULES_CONCRETE_IMPORT.find(it) }
                .map { "${it.groupValues[1]}.${it.groupValues[2]}" }
        }.toSet()
        val fresh = actual - RULES_CONCRETE_BASELINE
        val shrunk = RULES_CONCRETE_BASELINE - actual
        assertTrue(
            "rules/ 引入基线外的新横穿依赖：$fresh。\n" +
                "rules/ 不得直接依赖 data/source/http 具体实现类（那是把内核重新焊死到宿主）。" +
                "确需时先走端口化，或在 docs/architecture-audit.md 论证后带 issue 编号 + 到期日临时入基线。",
            fresh.isEmpty(),
        )
        assertTrue(
            "rules/ 横穿依赖已减少：$shrunk —— 端口化成功后请把它们从 RULES_CONCRETE_BASELINE 删除" +
                "（基线只能缩小，不能留着过期条目当垃圾桶）。",
            shrunk.isEmpty(),
        )
    }

    // ===== 辅助：源码定位 + 剥注释扫描（对齐 FrameworkContractTest 的做法）=====

    private fun serverDir(): Path = findServerSourceDir()

    private fun readServerFile(rel: String): String = serverDir().resolve(rel).readText()

    /** 扫目录下 .kt，剥掉块注释与行注释，返回每文件的代码行列表（`import` 顶格才计，注释里的示例不误伤）。 */
    private fun scanCodeLines(dir: Path): List<Pair<Path, List<String>>> {
        if (!Files.exists(dir)) return emptyList()
        val ktFiles = Files.walk(dir).use { s ->
            s.filter { it.extension == "kt" }.toList()
        }
        return ktFiles.map { file ->
            val cleaned = file.readText()
                .replace(BLOCK_COMMENT, "")
                .replace(LINE_COMMENT, "")
                .lines()
                .map { it.trimStart() }
                .filter { it.startsWith("import ") }
            file to cleaned
        }
    }

    /** 从 createJavaBridge 函数体（闭合于 4 空格缩进的 `}`）里抓所有 `putProperty(api,"xxx")` 的 xxx。 */
    private fun extractBridgeApiMethods(text: String): Set<String> {
        val after = text.substringAfter("private fun createJavaBridge", missingDelimiterValue = "")
        assertTrue("找不到 createJavaBridge 定义", after.isNotEmpty())
        val body = "private fun createJavaBridge" + after.substringBefore("\n    }")
        return BRIDGE_API_PUT
            .findAll(body)
            .map { it.groupValues[1] }
            .toSet()
    }

    /** 从多种可能的 cwd（模块根 app/ / 仓库根 product/）向上回溯定位 `io/legado/` 源码根。 */
    private fun findServerSourceDir(): Path {
        val rel = listOf("src", "main", "kotlin", "io", "legado")
        val joined = rel.joinToString("/")
        val cur = Path.of(System.getProperty("user.dir"))
        val candidates = sequence {
            yield(cur.resolve(joined))
            yield(cur.resolve("app/$joined"))
            var p: Path? = cur
            while (p != null) {
                yield(p.resolve(joined))
                yield(p.resolve("app/$joined"))
                yield(p.resolve("product/app/$joined"))
                p = p.parent
            }
        }
        return candidates.firstOrNull { Files.exists(it) && Files.isDirectory(it) }
            ?: error("找不到 io/legado 源码根（cwd=${System.getProperty("user.dir")}）")
    }

    private companion object {
        val BLOCK_COMMENT = Regex("""(?s)/\*.*?\*/""")
        val LINE_COMMENT = Regex("""//.*$""", RegexOption.MULTILINE)
        val BRIDGE_API_PUT = Regex("""putProperty\(\s*api\s*,\s*"([A-Za-z][A-Za-z0-9_]*)"""")
        val MODEL_REVERSE_IMPORT = Regex("""^import\s+io\.legado\.([a-z]+)\.""")
        val RULES_CONCRETE_IMPORT = Regex("""^import\s+io\.legado\.(data|source|http)\.([A-Za-z][A-Za-z0-9_]*)""")

        /**
         * `java` 桥白名单 —— 冻结于 2026-11-04（实测 68 个）。按能力分类注释，每类对应一个端口。
         * 与 docs/architecture-audit.md §3 的语料频次一一对应。
         */
        val BRIDGE_WHITELIST = setOf(
            // —— 网络/HTTP（对应 LegadoHttpExecutor 端口）——
            "ajax", "ajaxAll", "connect", "get", "getStrResponse", "getStrResponseAwait",
            "head", "post",
            // —— WebView/浏览器（对应 LegadoWebViewFetcher 端口）——
            "getWebViewUA", "getUserAgent", "openWeb", "showBrowser", "showReadingBrowser",
            "startBrowser", "startBrowserAwait", "startBrowserDp",
            // —— Cookie/变量/存储（对应 LegadoCookieStorePort / LegadoVariableStorePort 端口）——
            "cacheFile", "getCookie", "getKey", "getString", "getStringList", "importScript", "put",
            // —— DOM/内容/排版 ——
            "getElement", "getElements", "htmlFormat", "setContent", "toNumChapter", "toURL",
            // —— 编码/摘要/加解密 ——
            "aesBase64DecodeToString", "aesDecodeToBase64", "base64Decode", "base64DecodeToByteArray",
            "base64Encode", "bytesToStr", "createSymmetricCrypto", "desBase64DecodeToString",
            "desDecodeToString", "desEncodeToBase64String", "desEncodeToString",
            "digestBase64Str", "digestHex", "HMacBase64", "HMacHex",
            "hexDecodeToByteArray", "hexDecodeToString", "hexEncodeToString",
            "md5", "md5Encode", "md5Encode16", "strToBytes",
            // —— 时间与设备标识 ——
            "androidId", "deviceID", "randomUUID", "timeFormat", "timeFormatUTC",
            // —— 登录/UI/宿主刷新（副作用类，审计重点关注）——
            "copyText", "reLoginView", "reUiView", "refreshBookInfo", "refreshBookToc",
            "refreshContent", "refreshExplore", "upLoginData",
            // —— 环境（对应 LegadoRuntimeLogger 端口）——
            "encodeURI", "log", "longToast", "toast",
        )

        /**
         * `rules → data/source/http` 已知横穿基线 —— 24 条（初测 25，NetworkSecurity 下沉 `ops/` 后 −1）。
         * 只能缩小：等 VariableStorePort/CookieStorePort/WebViewFetcher 抽出后逐条从此集合删除。
         * （`rules → http` 已随 NetworkSecurity 下沉清零，见本文件 §3 边界说明。）
         */
        val RULES_CONCRETE_BASELINE = setOf(
            // rules → data（23：变量/Cookie/脚本缓存/登录态/书籍读写仍走具体实现）
            "data.Database", "data.cookieBucket", "data.cookieBucketsForHosts",
            "data.deleteScriptCache", "data.getCookieForUrl", "data.getEnabledReplaceRulesForScope",
            "data.getScriptCache", "data.getSource", "data.getSourceKv",
            "data.getSourceLoginState", "data.getSourceVariable", "data.getTocCache",
            "data.putScriptCache", "data.removeCookieBucket", "data.removeSourceLoginHeader",
            "data.removeSourceLoginInfo", "data.saveSourceKv", "data.saveSourceLoginHeader",
            "data.saveSourceLoginInfo", "data.saveSourceVariable", "data.setCookieForUrl",
            "data.setCookieFromSetCookie", "data.shelfBook",
            // rules → source（1：WebView 抓取应经 LegadoWebViewFetcher 端口，而非直连 WebViewProxy）
            "source.WebViewProxy",
            // rules → http 现为空：NetworkSecurity 已从 http/ 下沉到 ops/（见 docs/architecture-audit.md §3）。
        )
    }
}
