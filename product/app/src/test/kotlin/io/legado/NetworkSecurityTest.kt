package io.legado

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.URI
import java.net.InetAddress
import java.net.Inet6Address
import io.legado.ops.NetworkSecurity

class NetworkSecurityTest {

    @Before
    @After
    fun reset() {
        NetworkSecurity.clearCache()
    }

    @Test
    fun `rejects invalid schemes and blank hosts`() {
        assertThrows(IllegalArgumentException::class.java) {
            NetworkSecurity.resolveAndValidateSafeHttpTarget(URI("ftp://example.com/file"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            NetworkSecurity.resolveAndValidateSafeHttpTarget(URI("file:///etc/passwd"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            NetworkSecurity.resolveAndValidateSafeHttpTarget(URI("http:///path"))
        }
    }

    @Test
    fun `blocks SSRF targets including localhost, loopback and private networks`() {
        val blockedUris = listOf(
            "http://127.0.0.1/test",
            "http://localhost:8080/api",
            "http://10.0.0.1/admin",
            "http://192.168.1.1/secret",
            "http://172.16.0.1/status",
            "http://169.254.169.254/latest/meta-data"
        )
        for (uriStr in blockedUris) {
            val ex = assertThrows(IllegalArgumentException::class.java) {
                NetworkSecurity.resolveAndValidateSafeHttpTarget(URI(uriStr))
            }
            assertTrue(ex.message?.contains("拒绝访问内网") == true || ex.message?.contains("无法解析") == true)
        }
    }

    @Test
    fun `caches resolved DNS lookups for subsequent requests`() {
        assertEquals(0, NetworkSecurity.cacheSize())
        val uri = URI("https://example.com/books")
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri)
        assertEquals(1, NetworkSecurity.cacheSize())

        // Second call should hit in-memory cache without errors
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri)
        assertEquals(1, NetworkSecurity.cacheSize())
    }

    @Test
    fun `rejects IPv4 mapped private addresses and allows mapped public addresses`() {
        fun mappedV4(a: Int, b: Int, c: Int, d: Int) = Inet6Address.getByAddress(
            null,
            byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1, a.toByte(), b.toByte(), c.toByte(), d.toByte()),
            -1,
        )
        assertTrue(NetworkSecurity.isSpecialV6(mappedV4(127, 0, 0, 1)))
        assertTrue(NetworkSecurity.isSpecialV6(mappedV4(10, 2, 3, 4)))
        assertTrue(!NetworkSecurity.isSpecialV6(mappedV4(8, 8, 8, 8)))
    }

    @Test
    fun `rejects an entire DNS answer when any address is private`() {
        val mixedAnswers = arrayOf(
            InetAddress.getByName("8.8.8.8"),
            InetAddress.getByName("192.168.1.20"),
        )
        assertThrows(NetworkSecurity.BlockedAddressException::class.java) {
            NetworkSecurity.validateResolvedAddresses(mixedAnswers)
        }
    }

    @Test
    fun `explicit loopback allowance does not allow private or mixed answers`() {
        NetworkSecurity.validateResolvedAddresses(arrayOf(InetAddress.getByName("127.0.0.1")), allowLoopback = true)
        assertThrows(NetworkSecurity.BlockedAddressException::class.java) {
            NetworkSecurity.validateResolvedAddresses(
                arrayOf(InetAddress.getByName("127.0.0.1"), InetAddress.getByName("192.168.0.2")),
                allowLoopback = true,
            )
        }
    }
}
