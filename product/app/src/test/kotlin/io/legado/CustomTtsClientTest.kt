package io.legado

import io.legado.ops.CustomTtsClient
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

class CustomTtsClientTest {

    @Test
    fun `allows loopback and private network targets`() {
        val allowed = listOf(
            "http://127.0.0.1:8080/speak",
            "http://localhost:5000/speak",
            "http://10.1.2.3/speak",
            "http://172.16.5.5/speak",
            "http://192.168.1.10/speak",
            "http://[::1]:9000/speak",
            "http://[fc00::1]/speak",
        )
        for (raw in allowed) {
            CustomTtsClient.requireAllowed(URI(raw))
        }
    }

    @Test
    fun `blocks metadata, link-local, CGNAT and reserved targets`() {
        val blocked = listOf(
            "http://169.254.169.254/latest/meta-data",
            "http://[fe80::1]/speak",
            "http://[::ffff:169.254.169.254]/speak",
            "http://0.0.0.0/speak",
            "http://[::]/speak",
            "http://100.64.0.1/speak",
            "http://198.18.0.1/speak",
            "http://224.0.0.1/speak",
            "http://255.255.255.255/speak",
            "http://[2001:db8::1]/speak",
        )
        for (raw in blocked) {
            val error = runCatching { CustomTtsClient.requireAllowed(URI(raw)) }.exceptionOrNull()
            assertTrue("$raw 未被拦截，实际结果：$error", error is IllegalArgumentException)
            assertTrue(error?.message?.contains("拒绝访问") == true)
        }
    }

    @Test
    fun `rejects non-http schemes and hosts that are not literal addresses`() {
        for (raw in listOf("ftp://127.0.0.1/file", "file:///etc/passwd")) {
            assertThrows(IllegalArgumentException::class.java) {
                CustomTtsClient.requireAllowed(URI(raw))
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            CustomTtsClient.requireAllowed(URI("http:///speak"))
        }
    }
}
