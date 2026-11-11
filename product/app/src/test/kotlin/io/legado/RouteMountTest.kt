package io.legado

import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText

/**
 * 路由组「文件存在」≠「装配点挂载」判据。
 *
 * 为什么需要它：`agent-api.json`（161 条目录）由 `web/test/ApiCatalog.test.ts` 按**源码文本**
 * 双向核对，它扫的是 `http/` 下所有 `*Routes.kt` —— 一个组文件只要还在，目录就照样声称它的端点
 * 在跑，哪怕 `Routes.kt` 里那一行 `xxxRoutes(...)` 被删了。结果是「目录说有、实际 404，两边都绿」。
 * `RouteCatalogTest` 已对 `/api/books/content-process` 这条做过运行期点状补丁，但没覆盖
 * 「整组漏挂载」这个更常见的失效模式。
 *
 * 本判据只守**装配关系**（静态、零副作用）：每个 `<组>Routes.kt` 里的 `fun Route.<组>Routes(...)`
 * 必须在装配点 `Routes.kt` 的 `apiRoutes` 里被调用；反过来，装配点里出现的 `xxxRoutes(` 也必须有
 * 对应文件。它不证明运行期真的注册（那由 `RouteCatalogTest` 起服务打一发），但把
 * 「加了一组文件忘挂」「删了一行调用」这两类错从"没人发现"变成"提交即红"。
 *
 * 演进路径：若将来把 161 条目录改成运行时反射生成，这条判据可以退役；
 * 在那之前，它是 `docs/ARCHITECTURE.md` §13#2「catalog 与运行时注册不绑定」缺口的最小止血。
 */
class RouteMountTest {

    @Test
    fun `每个路由组文件都必须在 apiRoutes 里挂载`() {
        val entryFns = routeEntryFunctions()
        assertTrue(
            "只扫到 ${entryFns.size} 个路由组函数（$entryFns）—— 判据八成空转了，" +
                "先确认 http/ 下 *Routes.kt 还在、函数签名仍是 `fun Route.xxxRoutes(`",
            entryFns.size >= 10,
        )

        val assembly = serverDir().resolve("http/Routes.kt").readText()
        val missing = entryFns.filterNot { fn -> callPattern(fn).containsMatchIn(assembly) }
        assertTrue(
            "这些路由组文件存在，但装配点 `Routes.kt` 的 apiRoutes 里没有调用：$missing\n" +
                "后果：`agent-api.json` 与 ApiCatalog 测试仍会声称它们的端点在，实际请求全是 404。\n" +
                "修法：在 `route(\"/api\") { ... }` 里补上 `xxxRoutes(...)`，并跑 `RouteCatalogTest`。",
            missing.isEmpty(),
        )
    }

    @Test
    fun `装配点里的每个路由组调用都必须有对应文件`() {
        val entryFns = routeEntryFunctions()
        val assembly = serverDir().resolve("http/Routes.kt").readText()
        val calls = Regex("""\b(\w+Routes)\s*\(""")
            .findAll(assembly)
            .map { it.groupValues[1] }
            .toSet()
            .minus("apiRoutes") // 装配点自身的函数定义，不是组
        val orphan = calls - entryFns
        assertTrue(
            "装配点调用了这些函数，但 http/ 下找不到对应的 `fun Route.<name>(`：$orphan\n" +
                "若刚删掉一个组文件，请把装配点那一行一起删；若改名，请两处同步。",
            orphan.isEmpty(),
        )
    }

    /** `http/`（含子包）下所有 `*Routes.kt`（装配点 `Routes.kt` 除外）里的入口函数名。 */
    private fun routeEntryFunctions(): Set<String> {
        val httpDir = serverDir().resolve("http")
        val files = Files.walk(httpDir).use { stream ->
            stream.filter { Files.isRegularFile(it) }.toList()
        }.filter {
            val name = it.fileName.toString()
            name.endsWith("Routes.kt") && name != "Routes.kt"
        }
        val fn = Regex("""fun\s+Route\.(\w+Routes)\s*\(""")
        return files.flatMap { file -> fn.findAll(file.readText()).map { it.groupValues[1] }.toList() }.toSet()
    }

    private fun callPattern(name: String): Regex = Regex("""\b${Regex.escape(name)}\s*\(""")

    private fun serverDir(): Path = findServerSourceDir()

    private companion object {
        /** 从模块根 / 仓库根向上回溯定位 `src/main/kotlin/io/legado`（与 ArchitectureBoundaryTest 同法）。 */
        fun findServerSourceDir(): Path {
            val rel = listOf("src", "main", "kotlin", "io", "legado")
            val candidates = sequence {
                val cur = Path.of(System.getProperty("user.dir"))
                yield(cur.resolve(rel.joinToString("/")))
                yield(cur.resolve((listOf("server") + rel).joinToString("/")))
                var p: Path? = cur
                while (p != null) {
                    yield(p.resolve(rel.joinToString("/")))
                    yield(p.resolve((listOf("server") + rel).joinToString("/")))
                    p = p.parent
                }
            }
            return candidates.firstOrNull { Files.exists(it) && Files.isDirectory(it) }
                ?: Path.of("app/src/main/kotlin/io/legado")
        }
    }
}
