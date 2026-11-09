package io.legado.http

import io.legado.ops.NetworkSecurity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

/**
 * `HttpClients` 的判据。
 *
 * ## 这份文件是被重写的，原版根本编译不了
 *
 * 原版用 `org.junit.jupiter.api.*`（JUnit 5），而本仓库**只有** JUnit 4
 *（`junit:junit:4.13.2`，`useJUnit()`，见 `app/build.gradle`）—— 于是整个 `compileTestKotlin`
 * 失败。它还有两处**断言了不存在的行为**：
 * - `client.timeout()`：`HttpClient` 没有这个方法（超时是 `HttpRequest` 上的）；
 * - `HttpClients.create(allowLoopback = true)` 抛 `IllegalStateException`：
 *   实现只是把 flag 转给 `NetworkSecurity.newHttpClient`，不会抛。
 *
 * 所以这份判据改成只断言**实现里真实成立的**东西。判据断言不存在的行为，
 * 比没有判据更糟：它绿不了，还会让人以为功能坏了。
 *
 * ## 判据纪律
 *
 * - 用**字面 IP** 而不靠 DNS：`validate` 对字面 IP 不需要解析，离线也能稳定跑；
 * - 断言「被拦」时只说「抛 BlockedAddressException」，不断言错误文案（文案会改）。
 */
class HttpClientsTest {

    @Test
    fun `create 返回可用的客户端`() {
        assertNotNull("create() 必须返回一个 HttpClient", HttpClients.create())
        assertNotNull("allowLoopback=true 也必须返回客户端", HttpClients.create(allowLoopback = true))
    }

    @Test
    fun `validate 拦下回环地址`() {
        assertThrows(NetworkSecurity.BlockedAddressException::class.java) {
            HttpClients.validate(URI.create("http://127.0.0.1:8080/admin"), "admin panel")
        }
    }

    @Test
    fun `validate 拦下私有网段`() {
        listOf(
            "http://10.0.0.1/admin",      // 私有 A
            "http://172.16.0.1/router",   // 私有 B
            "http://192.168.1.1/internal", // 私有 C
        ).forEach { url ->
            assertThrows("私有网段必须被拦：$url", NetworkSecurity.BlockedAddressException::class.java) {
                HttpClients.validate(URI.create(url), "private net")
            }
        }
    }

    @Test
    fun `validate 拦下云元数据地址`() {
        assertThrows(NetworkSecurity.BlockedAddressException::class.java) {
            HttpClients.validate(URI.create("http://169.254.169.254/latest/meta-data"), "cloud metadata")
        }
    }

    @Test
    fun `validate 放行公网字面地址`() {
        // 用字面 IP 而不是域名：不依赖 DNS，离线也能断言「公网地址不该被误拦」。
        HttpClients.validate(URI.create("http://93.184.216.34/"), "public literal")
    }

    @Test
    fun `validateAndBuildUri 拼接并编码查询参数`() {
        val uri = HttpClients.validateAndBuildUri(
            baseUrl = "http://93.184.216.34/search",
            params = mapOf("q" to "小说", "page" to "1"),
            serviceName = "search engine",
        )
        assertEquals("/search", uri.path)
        assertEquals("93.184.216.34", uri.host)
        // 中文必须被百分号编码，且参数顺序不影响断言
        assertTrue("中文参数要编码：${uri.query}", uri.rawQuery.contains("q=%E5%B0%8F%E8%AF%B4"))
        assertTrue("普通参数原样：${uri.query}", uri.rawQuery.contains("page=1"))
    }

    @Test
    fun `validateAndBuildUri 无参数时不加问号`() {
        val uri = HttpClients.validateAndBuildUri(
            baseUrl = "http://93.184.216.34/api",
            params = emptyMap(),
            serviceName = "API",
        )
        assertEquals("http://93.184.216.34/api", uri.toString())
        assertNull("没有参数就不该出现询问串", uri.query)
    }

    @Test
    fun `validate 对空白地址不做放行`() {
        // 空地址或非 http(s) 必须被拒 —— 否则调用方拼错地址时会发往意料之外的地方。
        assertThrows(RuntimeException::class.java) {
            HttpClients.validate(URI.create("file:///etc/passwd"), "invalid scheme")
        }
    }
}
