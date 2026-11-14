package io.legado

import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import io.legado.backup.BackupStore

/**
 * 网络边界的**负向判据**（审计第 5 项：S-1 / S-2 / S-3）。
 *
 * 只补判据、不改行为 —— 这里的每一条都在钉「该拒的必须拒」，不写「能跑通」式的空测试：
 *
 * - **S-1**：同源写门给「书源登录 Cookie 同步」留了一个口子（那条路由要放行书源自己的域名）。
 *   口子必须只有那一条路径宽：兄弟路由（`login-header`）跨站照样被挡，别的站声称自己是
 *   该书源的页面照样被挡。
 * - **S-2**：路径穿越。备份包条目名、快照恢复名、封面 key、本地书内嵌资源名 —— 四类名字都
 *   来自客户端，四类都必须穿不出去。
 * - **S-3**：错误响应不许把堆栈、异常类名与绝对路径念给客户端听。
 */
class HttpSurfaceNegativeTest {

    private fun config() = ServerConfig(
        host = "127.0.0.1",
        port = 8080,
        databasePath = Files.createTempFile("legado-surface-negative", ".sqlite").toString(),
        coverCacheDirectory = Files.createTempDirectory("legado-surface-covers"),
    )

    /** 错误响应里出现任何一个都算泄底。 */
    private val forbiddenLeaks = listOf(
        "Exception", "at io.legado", ".kt:", "java.lang.", "C:\\", "E:\\", "/home/", "stacktrace", "SQLITE_",
    )

    private fun assertNoLeak(where: String, body: String) {
        val hit = forbiddenLeaks.filter { body.contains(it, ignoreCase = true) }
        assertTrue("$where 的错误响应泄底了（命中 $hit）：$body", hit.isEmpty())
    }

    private fun assertRejected(where: String, response: HttpResponse, body: String) {
        assertTrue("$where 必须被拒，实际 ${response.status}：$body", response.status.value in 400..499)
        assertNoLeak(where, body)
    }

    // ==================== S-1：Cookie 例外的口子只有一条路径宽 ====================

    @Test
    fun `登录 Cookie 同步不接受不属于该书源的站点`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        val response = client.post("/api/sources/whatever/login-cookie") {
            header("Origin", "http://evil.example")
            header("Host", "127.0.0.1:8080")
            contentType(ContentType.Application.Json)
            setBody("""{"cookie":"token=injected","url":"https://evil.example"}""")
        }
        val body = response.bodyAsText()
        assertEquals("别的站不能往书源的 Cookie 罐里写：${response.status} $body", HttpStatusCode.Forbidden, response.status)
        assertTrue("要说清是来源不被接受，而不是含糊的 403：$body", body.contains("origin_not_allowed") || body.contains("cross_origin"))
        assertNoLeak("login-cookie 跨站", body)
    }

    @Test
    fun `Cookie 例外的兄弟路由没有跟着免检`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        // 与 login-cookie 同属 /api/sources/{id}/ 下，但它是写路由，必须仍走同源闸门
        val response = client.delete("/api/sources/whatever/login-header") {
            header("Origin", "http://evil.example")
            header("Host", "127.0.0.1:8080")
        }
        val body = response.bodyAsText()
        assertEquals("兄弟路由不该被 Cookie 例外顺带放行：${response.status} $body", HttpStatusCode.Forbidden, response.status)
        assertTrue("应是被同源闸门挡下：$body", body.contains("cross_origin"))
        assertNoLeak("login-header 跨站", body)
    }

    @Test
    fun `Cookie 例外只认以 login-cookie 结尾的那条路径`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        // 尾部多一个斜杠：闸门的判定是 endsWith("/login-cookie")，不该被"看起来很像我"骗过去
        val response = client.post("/api/sources/whatever/login-cookie/") {
            header("Origin", "http://evil.example")
            header("Host", "127.0.0.1:8080")
            contentType(ContentType.Application.Json)
            setBody("""{"cookie":"token=injected"}""")
        }
        val body = response.bodyAsText()
        assertTrue("不能 2xx 通过：${response.status} $body", response.status.value >= 400)
        assertNoLeak("login-cookie 带尾斜杠", body)
    }

    // ==================== S-2：四类客户端给的名字都穿不出去 ====================

    @Test
    fun `备份保留条目名穿不出数据目录`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        listOf(
            "/api/backup/kept/..%2F..%2Flegado.sqlite",
            "/api/backup/kept/%2E%2E%2Fsecret.json",
            "/api/backup/kept/....//secret.json",
        ).forEach { path ->
            val response = client.get(path)
            val body = response.bodyAsText()
            assertRejected("GET $path", response, body)
        }
    }

    @Test
    fun `封面 key 只认 64 位十六进制`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        val response = client.get("/api/covers/..%2F..%2Flegado.sqlite")
        assertEquals("封面 key 不是 64 位 hex 就该 404：${response.status}", HttpStatusCode.NotFound, response.status)
    }

    /**
     * 路由那条只证明「这个 URL 拿不到东西」；真正的闸门在 `CoverCache.file` 的 64 位 hex 校验上，
     * 所以再钉一条单元级：把目录外的真实文件摆在那儿，让名字直接指过去 —— 必须拿不到。
     */
    @Test
    fun `封面缓存不认目录外的文件名`() {
        val directory: Path = Files.createTempDirectory("legado-cover-traversal")
        try {
            val secret = directory.parent.resolve("legado-cover-secret.png")
            Files.write(secret, byteArrayOf(1, 2, 3, 4))
            val cache = io.legado.cache.CoverCache(directory.resolve("covers"))
            assertNull("目录外的真实文件必须拿不到", cache.file("../legado-cover-secret.png"))
            assertNull("绝对路径必须拿不到", cache.file(secret.toString()))
            assertNull("非 64 位 hex 一律不认", cache.file("legado-cover-secret.png"))
            assertNull("上跳简写不认", cache.file(".."))
            Files.deleteIfExists(secret)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `本地书内嵌资源拒绝穿越路径与非法 bookId`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        listOf(
            "/api/books/local/asset?bookId=..&path=../../etc/passwd",
            "/api/books/local/asset?bookId=0123456789abcdef&path=../../etc/passwd",
            "/api/books/local/asset?bookId=0123456789abcdef&path=a/../../b.png",
            "/api/books/local/asset?bookId=0123456789abcdef&path=",
        ).forEach { path ->
            val response = client.get(path)
            assertEquals("GET $path 必须 404：${response.status}", HttpStatusCode.NotFound, response.status)
        }
    }

    @Test
    fun `快照恢复名不能指到备份目录之外`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        listOf("../legado.sqlite", "../../legado.sqlite", "legado-1750000000000.sqlite/../legado.sqlite").forEach { name ->
            val response = client.post("/api/backup/snapshots/restore") {
                contentType(ContentType.Application.Json)
                setBody("""{"name":"$name"}""")
            }
            val body = response.bodyAsText()
            assertRejected("restore name=$name", response, body)
            assertFalse("不该因为名字穿越就回 2xx：$body", body.contains("\"scheduled\":true"))
        }
    }

    /** 单元级：`BackupStore` 自己那道闸（白名单 + 只取最后一段 + 非法字符替换）。 */
    @Test
    fun `BackupStore 不写也不读目录外的文件`() {
        val directory: Path = Files.createTempDirectory("legado-keep-traversal")
        try {
            val secret = directory.parent.resolve("legado-keep-secret.json")
            Files.writeString(secret, """["不该被读到"]""")
            val store = BackupStore(directory.resolve("kept"))

            // 读：路径段被剥掉后不属于白名单 → 必须拿不到
            assertNull("目录外的文件必须读不到", store.read("../legado-keep-secret.json"))
            assertNull("绝对路径也必须读不到", store.read(secret.toString()))

            // 写：只接受白名单条目名，且不许带路径
            assertFalse("非白名单名字不许落盘", store.keep("../../legado-keep-secret.json", "[]"))
            assertFalse("任意文件名不许落盘", store.keep("evil.sh", "#!/bin/sh"))
            assertTrue("白名单条目照旧能落盘", store.keep("../dictrule.json", "[]"))
            val landed = Files.list(directory.resolve("kept")).use { s -> s.map { it.fileName.toString() }.toList() }
            assertEquals("落盘只该有那一份白名单条目：$landed", listOf("dictrule.json"), landed)
            Files.deleteIfExists(secret)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    // ==================== S-3：错误响应不吐堆栈与绝对路径 ====================

    @Test
    fun `解析失败的错误响应不含堆栈与绝对路径`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        val response = client.post("/api/replace-rules") {
            contentType(ContentType.Application.Json)
            setBody("这不是 JSON")
        }
        val body = response.bodyAsText()
        assertTrue("请求体坏掉应当是 4xx：${response.status} $body", response.status.value in 400..499)
        assertNoLeak("坏 JSON", body)
    }

    @Test
    fun `未知端点与缺失参数都不吐实现细节`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        listOf(
            "/api/definitely-not-a-route",
            "/api/backup/snapshots/restore",
            "/api/covers/",
        ).forEach { path ->
            val response = client.get(path)
            assertTrue("$path 不该 2xx：${response.status}", response.status.value >= 400)
            assertNoLeak("GET $path", response.bodyAsText())
        }
        val post = client.post("/api/backup/snapshots/restore") {
            contentType(ContentType.Application.Json)
            setBody("""{"nope":1}""")
        }
        assertRejected("restore 缺 name", post, post.bodyAsText())
    }
}
