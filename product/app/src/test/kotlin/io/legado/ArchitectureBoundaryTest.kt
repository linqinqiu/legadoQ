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
 * 它把三份外部架构报告（`docs/architecture-audit.md`）实测收敛出的**四条硬边界**
 * 变成一条"没人能违反的依赖声明，而不是文档"——这正是那几份报告反复强调、
 * 但当时只停在口号层面的东西。刻意**不引 ArchUnit、不建 Gradle 多模块**：
 * 前者要给 `build.gradle` 加依赖（有并行重构撞车风险），后者对单模块项目是超前投资。
 * 这里用「扫源码 + 显式基线 + 断言相等」实现等价效果。
 *
 * 六条判据：
 * 1. **`java` 桥暴露面** —— `JsSandbox.createJavaBridge` 里 `putProperty(api,"…")` 的方法名集合，
 *    必须与 [BRIDGE_WHITELIST] **完全相等**。多一个＝未登记就扩面（红）；少一个＝有人删了桥方法
 *    却没同步白名单（红，逼你确认删除是有意的）。真实语料（5598 源）里有 12 个方法零调用，
 *    裁剪候选见审计文档 §3。
 * 2. **`model/` 不得反向依赖** —— `model/` 任何文件都不得 import 除 `io.legado.model` 外的
 *    `io.legado.*` 包。当前实测 **0**，此判据把它锁死，防"数据类反吞宿主/上层类型"回流。
 * 3. **`rules/` 不得直连实现层** —— `rules/` 不得 import `data/` `source/` `http/` 下的**具体实现类**，
 *    已知横穿进入 [RULES_CONCRETE_BASELINE]，**现已清零**（初测 25 → NetworkSecurity 下沉 −1 →
 *    Cookie/Variable 端口化 −10 → ScriptCache/LoginState 端口化 −8 → 断 rules↔source 环 −1 →
 *    只读投影端口化 −4 → 宽 `Database` 句柄换成 `port.PortBundle` 载体 −1），断言**相等**：
 *    新横穿＝红；某条随端口化（CookieStore/VariableStore/ScriptCacheStore/LoginStateStore/KernelReader）
 *    被消掉，也必须从基线同步删除（红→逼你缩小基线）。基线只允许单调缩小。
 * 4. **`http/` 只能被 `http/` 自身与组合根 import** —— `io/legado` 下除 `http` 外的 14 个包
 *    （domain / engine / infra 全部）一律不得 import `io.legado.http.*`。实测 **0**，做成
 *    **零基线、不设豁免通道**：依赖方向只能是 `http/ → 其余各层`，反过来就是把 HTTP 适配层
 *    变成内核与基础设施的必需品，日后换协议（CLI / 桌面 IPC / 内嵌自动化）都得改它们。
 *    组合根（`Application.kt`、`StaticWeb.kt`）不在任何包目录里，天然不在扫描面内 ——
 *    装配 HTTP 层本来就是它的职责。
 * 5. **`engine/` 不得向上依赖 `infra/`** —— 判据 2 守 `model→任何包`、判据 4 守 `任何包→http`，
 *    中间**恰好漏掉 `engine→infra` 这一截**（这正是本轮补它的原因：不是发现了新违规，
 *    而是发现这一截**从来没有判据**，于是长期无人知道它有多大）。实测 **6 条 / 5 个文件**
 *    进 [ENGINE_TO_INFRA_BASELINE]，且没有一条是真正的能力依赖：4 条够 `ops` 是顺手拿纯工具，
 *    2 条够 `data` 是 Cookie 域名的安全判定。断言**相等**，基线只允许单调缩小。
 *    方向纪律：`domain ← engine ← infra ← api`，箭头只能从右往左。
 * 6. **包之间不得存在双向依赖（2-环）** —— 前五条都是**单向**的，而单向判据天然看不见环：
 *    `a→b` 合法、`b→a` 也合法，两条各自都过，合起来却是"这两个包其实是一个模块"。
 *    这是 `backend-layering.md` 点出的最大盲区。组合根（`package io.legado` 顶层文件）整包排除 ——
 *    它装配一切是职责，计入会得到 7 对 `root↔X` 假环。实测 **4 对**进 [PACKAGE_CYCLE_BASELINE]：
 *    `data<->source`（唯一的跨层真环）、`cache<->data`、`data<->ops`、`content<->rules`。
 *    ⚠️ 本判据自带**空转哨兵**（边数 < 20 即红）：空集合永远满足"没有 2-环"，
 *    而它第一次写完时正因为正则少了 `(?m)` 而一条边都没扫到、报了个假绿。
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

    // ===== 4. api 层（http/）只能被 http/ 自身与组合根 import =====

    @Test
    fun `http 不得被除组合根外的任何包 import`() {
        val violations = API_LAYER_CALLERS.flatMap { pkg ->
            scanCodeLines(serverDir().resolve(pkg)).flatMap { (file, lines) ->
                lines.mapNotNull { API_LAYER_IMPORT.find(it) }
                    .map { "$pkg/${file.fileName} → io.legado.http.${it.groupValues[1]}" }
            }
        }
        assertTrue(
            "有包反向 import 了 api 层（http/）：$violations\n" +
                "依赖方向必须单向：http/ → 其余各层，不能倒过来。" +
                "任何一层一旦 import http/，HTTP 适配层就成了它的必需品，" +
                "日后换协议（CLI / 桌面 IPC / 内嵌自动化）都得动它。" +
                "本判据为**零基线、无豁免通道**：确需某种能力时，" +
                "把能力下沉（内核走 port/ 端口，基础设施下沉到 ops/），" +
                "而不是让它们去够 HTTP。",
            violations.isEmpty(),
        )
    }

    // ===== 5. engine 层不得向上依赖 infra 层 =====

    @Test
    fun `engine 不得依赖 infra`() {
        val violations = ENGINE_PACKAGES.flatMap { pkg ->
            scanCodeLines(serverDir().resolve(pkg)).flatMap { (file, lines) ->
                val rel = serverDir().relativize(file).toString().replace('\\', '/')
                lines.mapNotNull { LEGADO_SUBPACKAGE_IMPORT.find(it) }
                    .map { it.groupValues[1] }
                    .filter { it in INFRA_PACKAGES }
                    .map { "$rel → io.legado.$it" }
            }
        }.toSet()
        val fresh = violations - ENGINE_TO_INFRA_BASELINE
        val shrunk = ENGINE_TO_INFRA_BASELINE - violations
        assertTrue(
            "engine/ 新增了向上的 infra 依赖：$fresh\n" +
                "依赖方向必须单调：domain ← engine ← infra ← api。" +
                "engine 够 infra，就是把规则内核重新焊回存储与宿主，" +
                "日后换存储（远程库 / 内存库）或换网络栈都得动内核。\n" +
                "清法：内核真正要的能力下沉成 port/ 端口；纯工具函数搬进 engine 自己的工具包。",
            fresh.isEmpty(),
        )
        assertTrue(
            "engine/ 向上依赖已减少：$shrunk —— 清理成功后请把它们从 ENGINE_TO_INFRA_BASELINE 里删掉。" +
                "基线只允许单调缩小；条目消失了却不删，判据就失去约束力。",
            shrunk.isEmpty(),
        )
    }

    // ===== 6. 包之间不得存在双向依赖（组合根除外）=====

    @Test
    fun `包之间不得存在双向依赖`() {
        val edges = packageEdges()
        // 空转哨兵：空集合永远满足"没有 2-环"，所以必须先证明扫描面真的扫到了东西。
        assertTrue(
            "扫描面异常：源码里只解析出 ${edges.size} 条包级 import 边，明显偏少。" +
                "此时'无 2-环'是假绿 —— 请先确认 packageEdges() 的正则与源码根定位有效。",
            edges.size >= 20,
        )
        val cycles = edges
            .filter { (a, b) -> edges.contains(b to a) }
            .map { (a, b) -> listOf(a, b).sorted().joinToString("<->") }
            .toSet()
        val fresh = cycles - PACKAGE_CYCLE_BASELINE
        val shrunk = PACKAGE_CYCLE_BASELINE - cycles
        assertTrue(
            "出现了新的包间双向依赖（2-环）：$fresh\n" +
                "2-环意味着这两个包事实上已经是同一个模块 —— 谁也没法被单独理解、单独测试、单独替换。" +
                "单看一条 import 是看不出环的，所以它比单向横穿更隐蔽，也更该钉住。\n" +
                "清法按性质选：能力类下沉 port/ 端口；纯原语类整体搬到合适的那一层（ops/ 就是这么来的）。",
            fresh.isEmpty(),
        )
        assertTrue(
            "包间 2-环已减少：$shrunk —— 环断开后请把它们从 PACKAGE_CYCLE_BASELINE 里删掉。" +
                "基线只允许单调缩小；留着过期条目就永远看不出还剩多少债。",
            shrunk.isEmpty(),
        )
    }

    // ===== 辅助：源码定位 + 剥注释扫描（对齐 FrameworkContractTest 的做法）=====

    private fun serverDir(): Path = findServerSourceDir()

    private fun readServerFile(rel: String): String = serverDir().resolve(rel).readText()

    /**
     * 扫全部 `.kt`，返回**包级有向边**集合（一级子包粒度，去自环）。
     *
     * 组合根（`package io.legado`，取不到一级子包）**整包排除** —— 它装配一切本来就是职责，
     * 把它算进去会得到一堆 `root↔X` 的假环（实测 7 对），把真信号淹掉。
     */
    private fun packageEdges(): Set<Pair<String, String>> {
        val edges = mutableSetOf<Pair<String, String>>()
        val ktFiles = Files.walk(serverDir()).use { s -> s.filter { it.extension == "kt" }.toList() }
        for (file in ktFiles) {
            val text = file.readText()
                .replace(BLOCK_COMMENT, "")
                .replace(LINE_COMMENT, "")
            val self = PACKAGE_DECL.find(text)?.groupValues?.get(1).orEmpty()
            if (self.isEmpty()) continue
            // 注意：这里扫的是**整份文件文本**，必须用带 (?m) 的版本；
            // 判据 5 用的 LEGADO_SUBPACKAGE_IMPORT 是逐行匹配的，`^` 在那里才成立。
            for (m in LEGADO_IMPORT_MULTILINE.findAll(text)) {
                val to = m.groupValues[1]
                if (to != self) edges.add(self to to)
            }
        }
        return edges
    }

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
         * 第 4 条判据的扫描面：`io/legado` 下**除 `http` 之外的全部包**（14 个）。
         * 唯一允许 import `io.legado.http.*` 的是 `http/` 自身与组合根
         * （`Application.kt` / `StaticWeb.kt` 不在任何包目录里，天然不在扫描面内）。
         *
         * 实测 0：原 `ai→http.ServerIdentity`、`cache→http.proxyRequestHeaders` 两条，
         * 已随 `ServerIdentity`、`proxyRequestHeaders` 下沉到 `ops/` 清零。
         */
        val API_LAYER_CALLERS = listOf(
            "ai", "backup", "cache", "content", "data", "localbook", "model",
            "ops", "port", "reading", "rules", "source", "subscription", "tts",
        )

        /** 命中 `import io.legado.http.Xxx`；扫的是剥注释后的行，注释里的示例不误伤。 */
        val API_LAYER_IMPORT = Regex("""^import\s+io\.legado\.http\.([A-Za-z][A-Za-z0-9_]*)""")

        // —— 第 5 条判据（跨层方向）——

        /** engine 层：可执行规则 / 内容处理 / 本地书解析 / 书源接入。 */
        val ENGINE_PACKAGES = listOf("rules", "content", "localbook", "source")

        /** infra 层：存储、缓存、AI、运维、TTS、备份、订阅、阅读记录。 */
        val INFRA_PACKAGES = setOf(
            "data", "cache", "ai", "ops", "tts", "backup", "subscription", "reading",
        )

        /** 命中 `import io.legado.<一级子包>`，用于跨层方向判定。 */
        val LEGADO_SUBPACKAGE_IMPORT = Regex("""^import\s+io\.legado\.([A-Za-z][A-Za-z0-9_]*)""")

        /** 包声明：`package io.legado`（组合根，取不到子包）或 `package io.legado.<一级子包>`。 */
        val PACKAGE_DECL = Regex("""(?m)^package\s+io\.legado(?:\.([A-Za-z][A-Za-z0-9_]*))?""")

        /**
         * 同 [LEGADO_SUBPACKAGE_IMPORT]，但用于**整份文件文本**，故必须带 `(?m)` 让 `^` 匹配每一行行首。
         *
         * 这不是洁癖：少了 `(?m)`，`^` 只匹配位置 0，`findAll` 于是一条边都扫不到，
         * 而"空集合"恰好满足"没有 2-环" —— 判据会变成**永远绿的摆设**。
         * 本判据第一次写完就是这个样子（报 0 失败，实测却有 4 对环），
         * 所以配套加了下面 `edges.size >= 20` 的空转哨兵。
         */
        val LEGADO_IMPORT_MULTILINE = Regex("""(?m)^import\s+io\.legado\.([A-Za-z][A-Za-z0-9_]*)""")

        /**
         * 包间双向依赖（2-环）基线 —— 实测 **4 对，均不含组合根**。
         *
         * 为什么要有这条判据：判据 2/3/4/5 都是**单向**的，而单向判据天然看不见环 ——
         * `a→b` 合法、`b→a` 也合法，两条各自都过，合起来却是"两个包其实是一个模块"。
         * 这正是 `backend-layering.md` 点出的最大盲区（它实测出 15 对含组合根的环）。
         *
         * 组合根（`Application.kt` / `StaticWeb.kt` 等 `package io.legado` 顶层文件）整包排除：
         * 它装配一切是职责，计入会得到 7 对 `root↔X` 假环，把真信号淹掉。
         *
         * 清法：环里的每一对都得挑一个方向断开 —— 能力类下沉 `port/` 端口，
         * 纯原语类整体搬到合适的那一层（`NetworkSecurity`/`ServerIdentity` 下沉 `ops/` 就是先例）。
         */
        val PACKAGE_CYCLE_BASELINE = setOf(
            // infra ↔ engine：存储反手够书源层（`data/CookieDao.kt`、`data/db/CookieUtil.kt`、
            //   `data/Database.kt` 反向够 `WebViewProxy`）。这是唯一跨层的真环，也是最该先断的一对。
            "data<->source",
            // infra ↔ infra：同层内的双向依赖，说明这两个包该合成一个或重新划线。
            "cache<->data",
            "data<->ops",
            // engine ↔ engine：规则内核与内容处理互相够。
            "content<->rules",
        )

        /**
         * `engine → infra` 向上依赖基线 —— 实测 **4 条，落在 3 个文件上**
         * （`source/WebViewProxy.kt` 同时够 `data` 与 `ops`）。初测 6 条。
         *
         * 为什么要有这条判据：判据 2 守 `model→任何包`、判据 4 守 `任何包→http`，
         * 中间**恰好漏掉 engine→infra 这一截** —— 于是这一截长期无人测、也无人知道有多大。
         *
         * ## 已清掉的 2 条（2026-11，日志门面端口化）
         *
         * `content/ContentProcessor.kt`、`localbook/TxtTocRule.kt` 两条**只为打一行日志**才够 `ops`。
         * 处置不是给日志造 capability 端口（那会让每个调用点都得先拿到端口实例），
         * 而是把**门面**（`LogCategory`/`LogLevel`/八个 `logXxx`）下沉到域层的 `port/Logging.kt`，
         * 把**实现**（落库 / 去重 / 写文件）留在 `ops/LogService.kt`，装配走 `LogService.install()`。
         * 日志是**横切关注点**，不是某一层的专属能力 —— 这才是它该待的位置。
         *
         * ⚠️ 同一轮里 `rules/RuleRunner.kt → ops` **没有**跟着消失：它除了日志还用 `NetworkSecurity`。
         * 这正是本判据按**文件**而不是按包对记账的价值 —— 按包对记会以为"日志搬完 RuleRunner 就干净了"。
         *
         * ## 剩下的 4 条
         *
         * 没有一条是真正的能力依赖：2 条够 `ops` 是顺手拿了出站闸门 `NetworkSecurity`，
         * 2 条够 `data` 是 Cookie 域名的安全判定（唯一实现落在 infra）。
         * 清法与判据 4 的处置纪律一致：能力类 → 下沉 `port/` 端口；
         * 纯原语类 → 把纯判定部分搬进 engine（`NetworkSecurity` 里不持状态的那部分就是候选）。
         *
         * 口径说明：条目是 `相对源码根的路径 → io.legado.<一级子包>`，按**文件**记账而不是按包对 ——
         * 包对粒度会漏掉"某个包又多了一个文件向上够"这种增量。
         */
        val ENGINE_TO_INFRA_BASELINE = setOf(
            // —— 够 ops：都是 `NetworkSecurity`（出站闸门），属"顺手拿了个纯工具" ——
            "rules/RuleRunner.kt → io.legado.ops",
            "source/WebViewProxy.kt → io.legado.ops",
            // —— 够 data：Cookie 域名的安全判定，唯一实现落在 infra ——
            // 清法应是把「域匹配」这件纯判定下沉成 port/ 端口（判据 4 的处置纪律同款），
            // 而不是让 engine 继续反向够存储。
            "source/WebViewProxy.kt → io.legado.data",
            "source/ExternalBrowserLogin.kt → io.legado.data",
        )

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
         * `rules → data/source/http` 已知横穿基线 —— **0 条，已清零**。
         * 演进：25 → NetworkSecurity 下沉(−1) → Cookie+Variable 端口化(−10) → ScriptCache+LoginState 端口化(−8)
         * → 断 rules↔source 环(−1) → 只读投影端口化(−4) → 宽 `Database` 句柄换成端口载体(−1)。
         *
         * 最后一条的解法值得记着：实测 `rules/` **从未调用 `Database` 的原始方法** —— 14 处
         * `asLoginStateStore()`、10 处 `asCookieStore()`、5 处 `asReader()`、4 处 `asVariableStore()`、
         * 3 处 `asScriptCacheStore()`，全部经由适配器访问器取窄端口。也就是说那条横穿**只剩一个类型名**，
         * 能力面早就收敛了。于是把这组访问器提成 `io.legado.port.PortBundle` 接口、让 `Database` 实现它：
         * **`Database` 是 `PortBundle` 的子类型，53 个 `RuleRunner(db)` 构造点一处都不用改**。
         * （若按"传入 5 个端口"的写法，那 53 处全要动 —— 这是没走那条路的原因。）
         */
        val RULES_CONCRETE_BASELINE = emptySet<String>()
    }
}
