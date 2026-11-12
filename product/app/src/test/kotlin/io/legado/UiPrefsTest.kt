package io.legado

import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import io.legado.http.prefsRoutes
import io.legado.ops.UiPrefsStore
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * 服务端界面偏好的判据（task-4，用户 2026-11-12：「改端口后壁纸恢复默认、又弹免责声明」）。
 *
 * 这一组刻意分两层：
 * - 纯 Store 层（读写 / 覆盖 / 原子 / 并发 / 坏文件 / 重启）：不启服务，快且直指 bug 本身；
 * - HTTP 层：状态码与语义（400 / 413 / 204）以及「路由真的挂上了」——
 *   只看 Store 绿是不够的，/api/diagnostics 那次就是逻辑全绿、端点 500 没人验。
 *
 * 每个用例都写了「反向对照」：把实现往哪一处改坏，这条必须变红。没有这条注释的用例不算判据。
 */
class UiPrefsTest {

    private lateinit var dir: Path
    private val file: Path get() = dir.resolve(UiPrefsStore.FILE_NAME)

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("legado-uiprefs")
    }

    @After
    fun tearDown() {
        runCatching { dir.toFile().deleteRecursively() }
    }

    private fun newStore() = UiPrefsStore(file)

    /** 把 prefsRoutes 挂在 /api 下，起一个最小 Ktor 测试实例（不建库、不扫磁盘）。 */
    private fun ApplicationTestBuilder.installPrefsApp(store: UiPrefsStore) {
        application {
            // 与生产装配一致：错误回包是 ApiError（序列化对象），没有 ContentNegotiation 时
            // Ktor 无法协商出表示形式，会回 406 而不是我们断言的 400/413。
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            routing {
                route("/api") { prefsRoutes(store) }
            }
        }
    }

    // ── Store 层 ──────────────────────────────────────────────────────────────

    /**
     * 往返读写：写进去的复杂 JSON 值（对象 / 布尔 / 数字 / 带空格 URL）必须原样读回来。
     * 反向对照：若把值再包一层（{value:…}）或按字符串二次编码，assertEquals 直接红。
     */
    @Test
    fun `往返读写：写进去的 JSON 值原样读出来，响应是 prefs 信封`() {
        val store = newStore()
        val value = buildJsonObject {
            put("enabled", true)
            put("fontSize", 18)
            put("url", "https://example.com/a b.jpg")
        }
        store.put("reader-settings", value)

        // 新实例 = 新一次启动读盘，不是读内存缓存。
        assertEquals(value, newStore().read()["reader-settings"])
        val root = Json.parseToJsonElement(newStore().snapshotJson()).jsonObject
        assertEquals(value, root["prefs"]!!.jsonObject["reader-settings"])
        assertEquals("信封顶层只应有 prefs 一个键", 1, root.keys.size)
    }

    /**
     * 覆盖同名 key：后写必须生效，文件里不能出现两个同名键（会让读到哪个变成运气问题）。
     * 反向对照：若 put 只是 append 而不是同表覆盖，数量断言与「最后一个值」断言同时红。
     */
    @Test
    fun `覆盖同名 key：后写生效且文件里只有一个该键`() {
        val store = newStore()
        store.put("wallpaper", JsonPrimitive("a.jpg"))
        store.put("wallpaper", JsonPrimitive("b.jpg"))

        assertEquals(JsonPrimitive("b.jpg"), newStore().read()["wallpaper"])
        val text = Files.readString(file)
        val occurrences = Regex("""("wallpaper")\s*:""").findAll(text).count()
        assertEquals("同一个 key 只应出现一次：$text", 1, occurrences)
        assertEquals(1, newStore().read().size)
    }

    /**
     * 重启后仍在：这是用户报的那个 bug 的核心 —— 新进程（新端口）只认数据目录里的文件。
     * 反向对照：若偏好只存在进程内 Map 而不落盘，新实例读到的是空表，这条红。
     */
    @Test
    fun `重启后仍在：新实例从同一文件读回偏好`() {
        newStore().put("agreement", JsonPrimitive("2026-11-12T10:00:00Z"))
        newStore().put("wallpaper", JsonPrimitive("dark.jpg"))

        // 模拟「改端口后重启」：浏览器 localStorage 已随 origin 换掉，只有数据目录还在。
        val restarted = UiPrefsStore(dir.resolve(UiPrefsStore.FILE_NAME))
        assertEquals(JsonPrimitive("2026-11-12T10:00:00Z"), restarted.read()["agreement"])
        assertEquals(JsonPrimitive("dark.jpg"), restarted.read()["wallpaper"])
    }

    /**
     * 非法 key：Store 必须抛可识别异常，且一个字节都不落盘。
     * 反向对照：把白名单正则放宽成任意字符串，这些断言全部会走到 fail() / 文件存在。
     */
    @Test
    fun `非法 key 被拒且不落盘`() {
        val store = newStore()
        val bad = listOf("Wallpaper", "-wallpaper", ".wallpaper", "_wallpaper", "wall paper", "壁纸", "x".repeat(65), "")
        for (key in bad) {
            try {
                store.put(key, JsonPrimitive(1))
                fail("key 应当被拒：[$key]")
            } catch (_: UiPrefsStore.InvalidKeyException) {
                // 期望路径
            }
        }
        assertFalse("非法 key 不能生成偏好文件", Files.exists(file))
        assertTrue(store.read().isEmpty())
    }

    /**
     * 白名单必须放行连字符 / 下划线 / 点 —— 前端会用的 agreement、wallpaper、reader-settings 都在里面。
     * 反向对照：若正则漏掉连字符（只留 [a-z0-9]），reader-settings 立刻被拒，这条红。
     */
    @Test
    fun `白名单允许连字符下划线与点`() {
        val store = newStore()
        val allowed = listOf("agreement", "wallpaper", "reader-settings", "a.b_c", "x9")
        for (key in allowed) {
            assertTrue("应在白名单内：$key", UiPrefsStore.isKeyAllowed(key))
            store.put(key, JsonPrimitive(key))
        }
        assertEquals(allowed.size, newStore().read().size)
    }

    /**
     * 坏文件回落空表、不抛、不删；之后一次写入能把文件重建。
     * 反向对照：若读坏了抛异常，启动路径直接 500（用户看到的是界面白屏）；
     * 若把坏文件删了，用户手工编辑留下的其它 key 会被静默清掉。
     */
    @Test
    fun `坏文件回落空表且不抛，之后写入能重建`() {
        Files.writeString(file, "{ this is not json at all")
        val store = newStore()

        assertTrue("坏文件应回落空表", store.read().isEmpty())
        assertTrue("GET 必须是空信封：${store.snapshotJson()}", store.snapshotJson().contains("""{"prefs":{}}"""))
        assertTrue("坏文件不应被静默删除", Files.isRegularFile(file))

        store.put("wallpaper", JsonPrimitive("ok.jpg"))
        assertEquals(JsonPrimitive("ok.jpg"), newStore().read()["wallpaper"])
    }

    /**
     * 并发写不同 key：一个都不能丢。
     * 反向对照：把 put 里的锁去掉（读整表 → 改 → 写回），4 个线程必然互相覆盖，键数 < 32 直接红。
     */
    @Test
    fun `并发写不同 key 不丢更新`() {
        val store = newStore()
        val start = CountDownLatch(1)
        val writers = (0 until 4).map { w ->
            thread {
                start.await()
                for (i in 0 until 8) store.put("k-$w-$i", JsonPrimitive(i))
            }
        }
        start.countDown()
        writers.forEach { it.join(30_000) }

        assertEquals("并发写丢了 key", 32, newStore().read().size)
    }

    /**
     * 写在读的一侧永远只能看到完整 JSON：临时文件 + rename 的核心保证。
     * 反向对照：把 write 改成直接 Files.writeString(target)，读到半个文件时解析为 null，这条红。
     */
    @Test
    fun `写入期间从文件读到的永远是完整 JSON`() {
        val store = newStore()
        store.put("wallpaper", JsonPrimitive("v0"))
        val stop = AtomicBoolean(false)
        val broken = Collections.synchronizedList(mutableListOf<String>())
        val chunk = "z".repeat(30_000)
        val writer = thread {
            for (i in 0 until 20) store.put("wallpaper", JsonPrimitive(chunk + i))
            stop.set(true)
        }

        var reads = 0
        while ((!stop.get() || reads < 100) && reads < 20_000) {
            if (Files.isRegularFile(file)) {
                reads++
                val text = runCatching { Files.readString(file) }.getOrNull() ?: continue
                val prefs = runCatching { Json.parseToJsonElement(text).jsonObject["prefs"]?.jsonObject }.getOrNull()
                if (prefs == null || prefs["wallpaper"] == null) broken.add(text.take(60))
            }
            Thread.sleep(1)
        }
        writer.join(30_000)

        assertTrue("写入期间读到过非完整文件（共 ${broken.size} 次），例如：${broken.firstOrNull()}", broken.isEmpty())
        assertNotNull("读线程应至少跑过一轮", reads)
        assertTrue(reads > 0)
    }

    // ── HTTP 层 ─────────────────────────────────────────────────────────────

    /**
     * 非法 key 走 URL 时必须 400 + invalid_prefs_key（PUT 与 DELETE 都是）。
     * 反向对照：若路由把校验交给 Store 的异常却不 catch，会变成 500 —— 状态码断言红。
     */
    @Test
    fun `HTTP 非法 key 回 400 且不落盘`() = testApplication {
        installPrefsApp(newStore())
        val bad = listOf("Wallpaper", "-wallpaper", "a".repeat(65), "wall paper")
        for (raw in bad) {
            val key = URLEncoder.encode(raw, StandardCharsets.UTF_8).replace("+", "%20")
            val put = client.put("/api/ui-prefs/$key") {
                contentType(ContentType.Application.Json)
                setBody(JsonPrimitive("x").toString())
            }
            assertEquals("PUT 非法 key [$raw] 应回 400", HttpStatusCode.BadRequest, put.status)
            assertTrue("应回 invalid_prefs_key：${put.bodyAsText()}", put.bodyAsText().contains("invalid_prefs_key"))

            val delete = client.delete("/api/ui-prefs/$key")
            assertEquals("DELETE 非法 key [$raw] 应回 400", HttpStatusCode.BadRequest, delete.status)
        }
        assertFalse("非法 key 不应生成文件", Files.exists(file))
    }

    /**
     * PUT 的 body 就是这个 key 的 JSON 值本身（字符串 / 对象都原样存），DELETE 幂等回 204。
     * 反向对照：若后端按 { value: … } 包装解析，第一个断言拿到的会是对象而不是字符串，红；
     * 若 DELETE 对不存在的 key 回 404，第二次 204 断言红。
     */
    @Test
    fun `PUT body 是值本身，DELETE 幂等回 204`() = testApplication {
        installPrefsApp(newStore())

        val putScalar = client.put("/api/ui-prefs/wallpaper") {
            contentType(ContentType.Application.Json)
            setBody(JsonPrimitive("paper.jpg").toString())
        }
        assertEquals(HttpStatusCode.NoContent, putScalar.status)

        val putObject = client.put("/api/ui-prefs/reader-settings") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("fontSize", 18); put("lineHeight", 1.6) }.toString())
        }
        assertEquals(HttpStatusCode.NoContent, putObject.status)

        val prefs = Json.parseToJsonElement(client.get("/api/ui-prefs").bodyAsText()).jsonObject["prefs"]!!.jsonObject
        assertEquals(JsonPrimitive("paper.jpg"), prefs["wallpaper"])
        assertEquals(JsonPrimitive(18), prefs["reader-settings"]!!.jsonObject["fontSize"])

        assertEquals(HttpStatusCode.NoContent, client.delete("/api/ui-prefs/wallpaper").status)
        // 幂等：再删一次仍是 204，不是 404。
        assertEquals(HttpStatusCode.NoContent, client.delete("/api/ui-prefs/wallpaper").status)
        val after = Json.parseToJsonElement(client.get("/api/ui-prefs").bodyAsText()).jsonObject["prefs"]!!.jsonObject
        assertFalse(after.containsKey("wallpaper"))
        assertTrue(after.containsKey("reader-settings"))
    }

    /**
     * 单值恰好 32KB 收下、多 1 字节回 413；而且拒绝后旧值不能被覆盖成半截。
     * 反向对照：把上限判断去掉或改成 > 会放行 32769；把写放在判断之前，旧值断言红。
     */
    @Test
    fun `单值恰好 32KB 收下，超过 1 字节回 413 且旧值不动`() = testApplication {
        installPrefsApp(newStore())
        // JsonPrimitive 的字符串序列化 = 两侧引号 + 原文，所以 32766 个 ASCII 字符正好 32768 字节。
        val exact = JsonPrimitive("x".repeat(32766))
        assertEquals(32768, exact.toString().toByteArray(StandardCharsets.UTF_8).size)
        val ok = client.put("/api/ui-prefs/wallpaper") {
            contentType(ContentType.Application.Json)
            setBody(exact.toString())
        }
        assertEquals("恰好 32KB 应被接受", HttpStatusCode.NoContent, ok.status)

        val tooBig = JsonPrimitive("x".repeat(32767))
        val rejected = client.put("/api/ui-prefs/wallpaper") {
            contentType(ContentType.Application.Json)
            setBody(tooBig.toString())
        }
        assertEquals(HttpStatusCode.PayloadTooLarge, rejected.status)
        assertTrue("应回 prefs_too_large：${rejected.bodyAsText()}", rejected.bodyAsText().contains("prefs_too_large"))

        val prefs = Json.parseToJsonElement(client.get("/api/ui-prefs").bodyAsText()).jsonObject["prefs"]!!.jsonObject
        assertEquals("被拒的写入不能改动旧值", exact, prefs["wallpaper"])
    }

    /**
     * 整表超过 256KB 回 413，且这次失败的写入一个 key 都不多写。
     * 反向对照：若只查单值不查整表，第 8 个会 204，键数断言（7）红。
     */
    @Test
    fun `整表超过 256KB 回 413 且不多写 key`() = testApplication {
        installPrefsApp(newStore())
        val value = JsonPrimitive("y".repeat(32766)).toString()
        for (i in 0 until 7) {
            val resp = client.put("/api/ui-prefs/k$i") {
                contentType(ContentType.Application.Json)
                setBody(value)
            }
            assertEquals("第 $i 个应还没超总上限", HttpStatusCode.NoContent, resp.status)
        }
        val eighth = client.put("/api/ui-prefs/k7") {
            contentType(ContentType.Application.Json)
            setBody(value)
        }
        assertEquals(HttpStatusCode.PayloadTooLarge, eighth.status)
        assertTrue("应回 prefs_too_large：${eighth.bodyAsText()}", eighth.bodyAsText().contains("prefs_too_large"))

        val prefs = Json.parseToJsonElement(client.get("/api/ui-prefs").bodyAsText()).jsonObject["prefs"]!!.jsonObject
        assertEquals("超限的这次写入不能留下半个 key", 7, prefs.size)
        assertFalse(prefs.containsKey("k7"))
    }

    /**
     * 真装配（legadoApplication）下路由确实挂上了，且偏好文件落在数据目录 —— 不是内存、不是安装根。
     * 反向对照：把 Routes.kt 里的 prefsRoutes(uiPrefs) 删掉，PUT 会 404，状态码断言红；
     * 把路径改成 homeDirectory 而不是数据目录，文件位置断言红。
     */
    @Test
    fun `真装配下预置路由已挂载，文件落在数据目录`() = testApplication {
        val data = Files.createTempDirectory("legado-uiprefs-app")
        val dbPath = Files.createTempFile("legado-uiprefs-app", ".sqlite").toString()
        val config = ServerConfig(
            host = "127.0.0.1",
            port = 8080,
            databasePath = dbPath,
            coverCacheDirectory = data,
            localBooksDirectory = data.resolve("local_books"),
        )
        try {
            application { legadoApplication(config) }
            val resp = client.put("/api/ui-prefs/agreement") {
                contentType(ContentType.Application.Json)
                setBody(JsonPrimitive("2026-11-12T10:00:00Z").toString())
            }
            assertEquals("PUT 404 说明路由没挂上", HttpStatusCode.NoContent, resp.status)

            val prefs = Json.parseToJsonElement(client.get("/api/ui-prefs").bodyAsText())
                .jsonObject["prefs"]!!.jsonObject
            assertEquals(JsonPrimitive("2026-11-12T10:00:00Z"), prefs["agreement"])
            assertTrue("偏好文件应在数据目录：$data", Files.isRegularFile(data.resolve(UiPrefsStore.FILE_NAME)))
        } finally {
            runCatching { Files.deleteIfExists(Path.of(dbPath)) }
            runCatching { Files.deleteIfExists(Path.of("$dbPath-wal")) }
            runCatching { Files.deleteIfExists(Path.of("$dbPath-shm")) }
            runCatching { data.toFile().deleteRecursively() }
        }
    }
}
