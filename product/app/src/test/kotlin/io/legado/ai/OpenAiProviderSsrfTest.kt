package io.legado.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AI 外呼的内网地址闸门（SSRF）—— 补的是一个真实的侧门。
 *
 * 背景：`baseUrl` 是用户自己填的，而 AI 这一层以前**没有过 `NetworkSecurity`** 那道闸门
 * —— 书源、订阅、TTS 的出站都过，只有 AI 外呼没过。
 * 服务本身只绑 127.0.0.1、靠同源门挡跨站写，但填一个内网地址，
 * 这台机器上的其它本机服务（路由器管理页、数据库、另一个本地端口）就会被这个 AI 连接打通。
 *
 * **这里刻意分成两组**：
 * - 「闸门」组走 [OpenAiCompatibleProvider.assertPublicBaseUrl] —— 真正做网络判定的那个函数；
 * - 「拼接」组走 [OpenAiCompatibleProvider.endpointUrl] —— 纯字符串逻辑，用假域名就够。
 *
 * 为什么拆开：第一版把校验塞进了 `endpointUrl`，结果既有的
 * `OpenAiCompatibleProviderTest`（用 `api.example.com` 测拼接）六条一起红 ——
 * 那是**把两件事耦合成一件事**的代价：拼地址是纯逻辑，不该被 DNS 拖着。
 */
class OpenAiProviderSsrfTest {

    private fun profile(baseUrl: String?) = AgentProfileStore.Profile(
        id = "test",
        name = "测试连接",
        kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
        baseUrl = baseUrl,
        apiKey = null,
        model = "test-model",
        options = emptyMap(),
    )

    private val provider = OpenAiCompatibleProvider()

    /** 拼出地址后过闸门 —— 与 `post()` 里的真实路径同序。 */
    private fun endpointAfterGuard(baseUrl: String?): String? {
        val url = provider.endpointUrl(profile(baseUrl)) ?: return null
        provider.assertPublicBaseUrl(url)
        return url
    }

    // ===== 闸门：内网/本机地址必须被拒 =====

    @Test
    fun `本机回环地址被拒`() {
        for (host in listOf("http://127.0.0.1:5591", "https://127.0.0.1", "http://localhost:11434")) {
            assertThrows("$host 应该被拒", IllegalArgumentException::class.java) {
                endpointAfterGuard(host)
            }
        }
    }

    @Test
    fun `私网地址被拒`() {
        for (host in listOf("http://192.168.1.1:8080", "http://10.0.0.5", "http://172.16.3.4")) {
            assertThrows("$host 应该被拒", IllegalArgumentException::class.java) { endpointAfterGuard(host) }
        }
    }

    @Test
    fun `链路本地与云元数据地址被拒`() {
        // 169.254.169.254 是云环境的元数据端点，打进去能直接偷到临时凭据
        assertThrows(IllegalArgumentException::class.java) { endpointAfterGuard("http://169.254.169.254") }
    }

    @Test
    fun `零地址与任意地址被拒`() {
        for (host in listOf("http://0.0.0.0:1234", "http://[::]:8080")) {
            assertThrows("$host 应该被拒", IllegalArgumentException::class.java) { endpointAfterGuard(host) }
        }
    }

    @Test
    fun `CGNAT 与保留段被拒`() {
        // 100.64/10（CGNAT）与 198.18/15（基准测试）JDK 内建判定会漏
        assertThrows(IllegalArgumentException::class.java) { endpointAfterGuard("http://100.64.1.1") }
        assertThrows(IllegalArgumentException::class.java) { endpointAfterGuard("http://198.18.0.1") }
    }

    @Test
    fun `IPv6 ULA 被拒`() {
        assertThrows(IllegalArgumentException::class.java) { endpointAfterGuard("http://[fd00::1]:8080") }
    }

    @Test
    fun `拒绝信息要能让人看懂是地址问题 而不是连不上`() {
        val error = assertThrows(IllegalArgumentException::class.java) { endpointAfterGuard("http://127.0.0.1:5591") }
        val message = error.message ?: ""
        assertTrue("错误要说明是内网/本机地址，实际是「$message」", message.contains("内网") || message.contains("本机"))
    }

    @Test
    fun `非 http 协议被拒`() {
        assertThrows(IllegalArgumentException::class.java) { endpointAfterGuard("file:///etc/passwd") }
        assertThrows(IllegalArgumentException::class.java) { endpointAfterGuard("ftp://example.com") }
    }

    // ===== 闸门：公网地址照常放行 =====
    //
    // 用 `example.com` 而不是自造的 `api.example.com`：后者在本机 DNS 解析不了，
    // 会以「无法解析域名」失败，测的就不是"公网放行"而是"域名是否存在"。
    // example.com 是 IANA 保留的示例域名，公网可解析，且不属于内网。

    @Test
    fun `公网中转站照常放行`() {
        val url = endpointAfterGuard("https://example.com/v1")
        assertEquals("https://example.com/v1/chat/completions", url)
    }

    @Test
    fun `公网地址不带 v1 也能过闸门并补上 v1`() {
        val url = endpointAfterGuard("https://example.com")
        assertEquals("https://example.com/v1/chat/completions", url)
    }

    // ===== 拼接：纯字符串逻辑，假域名就够（不被 DNS 拖着） =====

    @Test
    fun `拼接不解析域名 假域名也能用`() {
        assertEquals(
            "https://api.example.com/v1/chat/completions",
            provider.endpointUrl(profile("https://api.example.com")),
        )
        assertEquals(
            "https://api.example.com/v1/chat/completions",
            provider.endpointUrl(profile("https://api.example.com/v1")),
        )
    }

    @Test
    fun `尾斜杠与前后空白在拼接时被处理掉`() {
        assertEquals(
            "https://api.example.com/v1/chat/completions",
            provider.endpointUrl(profile("  https://api.example.com/v1/  ")),
        )
    }

    // ===== 原有语义不变 =====

    @Test
    fun `baseUrl 为 null 或空时返回 null（原有语义）`() {
        assertNull("null 仍返回 null", provider.endpointUrl(profile(null)))
        assertNull("空串仍返回 null", provider.endpointUrl(profile("")))
        assertNull("纯空白仍返回 null", provider.endpointUrl(profile("   ")))
    }
}
