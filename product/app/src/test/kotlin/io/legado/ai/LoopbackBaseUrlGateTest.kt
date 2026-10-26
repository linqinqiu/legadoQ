package io.legado.ai

import io.legado.http.NetworkSecurity
import io.legado.http.ServerIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AI 连接的**回环口子**（`LEGADO_AI_ALLOW_LOOPBACK_BASEURL`）的判据。
 *
 * 为什么需要这个口子：这台软件只跑在本机，而想接的模型也常常就在本机 ——
 * Ollama 默认 `127.0.0.1:11434`、LM Studio 默认 `127.0.0.1:1234/v1`，只有回环地址可填。
 * 一刀切拒掉回环的实际后果（0.8.5 实测）是：文档写着"任何 openai-compatible 地址都行"、
 * provider 自述"支持 Ollama / LM Studio"，而照着填就是 0 条能用 —— 本机模型接不进来。
 *
 * 但放开时必须守住两条，所以它不是"关掉闸门"：
 * 1. **只放回环**。私网 / CGNAT / 链路本地 / 云元数据照旧拒。
 * 2. **硬拒打到这台服务自己**。本服务对不带 Origin 的请求放行写操作，而 JDK
 *    `HttpClient` 发请求不带 Origin —— 一个能打到 1234 的 AI 连接等于绕过它唯一的写保护。
 *
 * 从前这类判据只能单向测（只测默认关的那一半），"口子开了会绕过什么"没人验过。
 * 这里两个方向都钉。
 */
class LoopbackBaseUrlGateTest {

    /** 关掉口子（默认）：与历史行为逐字一致。 */
    private val closed = OpenAiCompatibleProvider(loopbackAllowed = { false })

    /** 打开口子：回环可用，但仍守住"不许打到自己"。 */
    private val open = OpenAiCompatibleProvider(loopbackAllowed = { true })

    // ===== 关着时必须拒（既有行为，防被这次改动悄悄放宽）=====

    @Test
    fun `开关关着时回环与本机名照旧被拒`() {
        for (url in listOf("http://127.0.0.1:5591/v1", "http://localhost:11434/v1", "http://[::1]:11434/v1")) {
            val error = assertThrows("$url 默认必须被拒", IllegalArgumentException::class.java) {
                closed.assertPublicBaseUrl(url)
            }
            assertTrue("要说清是内网/本机，实际「${error.message}」",
                error.message?.contains("内网") == true || error.message?.contains("本机") == true)
        }
    }

    @Test
    fun `开关开着时私网段仍被拒（只放回环，不是关掉闸门）`() {
        for (url in listOf(
            "http://192.168.1.1:8080/v1",   // RFC1918
            "http://10.0.0.5/v1",            // RFC1918
            "http://172.16.3.4/v1",          // RFC1918
            "http://100.64.1.1/v1",          // CGNAT
            "http://169.254.169.254/v1",     // 链路本地 / 云元数据
        )) {
            assertThrows("$url 开了口子也必须被拒", IllegalArgumentException::class.java) {
                open.assertPublicBaseUrl(url)
            }
        }
    }

    // ===== 开着时必须放行回环，否则这个口子等于没开 =====

    @Test
    fun `开关开着时回环地址放行（本机 Ollama 与 mock 接得进来）`() {
        // 端口刻意不用 ServerIdentity 那个，避开"打到自己"那条守卫（下面单独验它）。
        ServerIdentity.init("127.0.0.1", 1234)
        for (url in listOf("http://127.0.0.1:5591/v1", "http://localhost:11434/v1", "http://127.0.0.1:1235/v1")) {
            open.assertPublicBaseUrl(url)   // 不抛即通过
        }
    }

    /**
     * 口子放开后唯一必须守住的一条：**不能让 AI 连接打到这台服务自己**。
     *
     * 这条比"拒内网"更要紧：写保护全靠"浏览器跨站会带 Origin"这一件事，
     * 而服务侧自己发出去的请求不带 Origin，于是会被当成"本机脚本"直接放行写操作。
     */
    @Test
    fun `即便开了回环口子也不许指向服务自己`() {
        ServerIdentity.init("127.0.0.1", 1234)
        val error = assertThrows("打到自己的 1234 必须被拒", IllegalArgumentException::class.java) {
            open.assertPublicBaseUrl("http://127.0.0.1:1234/v1")
        }
        assertTrue("要说清是「会绕过写保护」这类话，实际「${error.message}」",
            error.message?.contains("写保护") == true || error.message?.contains("自己") == true)

        // localhost 与 127.x 是同一个回环的不同写法，不能靠字面量比较放过另一个。
        assertThrows("localhost:1234 也算自己", IllegalArgumentException::class.java) {
            open.assertPublicBaseUrl("http://localhost:1234/v1")
        }
        // 换到别的端口就不是自己（上面"放行"那条例子），确认守卫不是一刀切拒所有回环。
        open.assertPublicBaseUrl("http://127.0.0.1:5591/v1")
    }

    @Test
    fun `绑在 0 地址时任何主机配自己那个端口都算打到自己`() {
        // LEGADO_HOST=0.0.0.0 的部署（Docker 模板里就这么写）：服务确实在所有网卡上听，
        // 于是从回环打进去也会命中它自己 —— 这条不能漏。
        ServerIdentity.init("0.0.0.0", 8080)
        assertThrows(IllegalArgumentException::class.java) {
            open.assertPublicBaseUrl("http://127.0.0.1:8080/v1")
        }
    }

    // ===== 异常类型本身：分类能不能被上层可靠区分 =====

    /**
     * 「被拒绝」与「到不了」必须是**两种可分别 catch 的类型**。
     * 从前两者都抛裸的 `IllegalArgumentException`，上层只能一把抓：
     * 于是域名打错一个字母被报成"你的请求非法"，而填了内网地址又被另一条路径报成"连不上"。
     */
    @Test
    fun `被拒与到不了是两种类型 上层才分得开`() {
        ServerIdentity.init("127.0.0.1", 1234)
        val blocked = assertThrows(IllegalArgumentException::class.java) {
            closed.assertPublicBaseUrl("http://127.0.0.1:5591/v1")
        }
        assertTrue("被拒的要能被 catch(IllegalArgumentException) 接住",
            blocked is NetworkSecurity.BlockedAddressException)

        // .invalid 是 RFC 保留的"必然解析不了"域名：不需要联网就能稳定复现 DNS 失败。
        val dnsFailed = assertThrows(Exception::class.java) {
            closed.assertPublicBaseUrl("https://typo-in-the-name.invalid/v1")
        }
        assertTrue("解析失败必须是「到不了」那一类：${dnsFailed::class.simpleName}",
            dnsFailed is NetworkSecurity.UnreachableTargetException)
        assertTrue("而**不是** IllegalArgumentException —— 否则上层 catch 非法参数时会把它误分类成 4xx",
            dnsFailed !is IllegalArgumentException)
        assertTrue("信息里要能看出是解析问题，实际「${dnsFailed.message}」",
            dnsFailed.message?.contains("无法解析") == true)
    }

    @Test
    fun `非 http 协议仍按被拒处理而不是到不了`() {
        ServerIdentity.init("127.0.0.1", 1234)
        for (url in listOf("file:///etc/passwd", "ftp://example.com/v1")) {
            val error = assertThrows("$url 该被拒", IllegalArgumentException::class.java) {
                closed.assertPublicBaseUrl(url)
            }
            assertTrue("协议不对是被拒这一类", error is NetworkSecurity.BlockedAddressException)
        }
    }

    /**
     * 连不上时的报错只回显 host+path，不把用户 baseUrl 里的 query（常带 key）整条抄回去。
     *
     * 这条必须真发一次请求才有意义：`assertPublicBaseUrl` 那句文案是闸门写的、不含地址，
     * 而"连不上 xxx"是 provider 拼的 —— 它手上拿着完整 URL。
     * 5599 上没有任何服务在听，`client.send` 必然抛连接被拒：不依赖外网、也不用起 mock。
     * （从前这条路径压根不抛 —— `runCatching{…}.getOrNull()` 把异常压成 null，
     *  于是"域名打错一个字母"与"上游挂了"在用户眼里是同一句套话。）
     */
    @Test
    fun `连不上的报错不回显带密钥的完整地址`() {
        ServerIdentity.init("127.0.0.1", 1234)
        val profile = AgentProfileStore.Profile(
            id = "leaky", name = "会漏 key 的连接", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
            // key 就放在 baseUrl 的 query 里（不少中转站这么拼）：报错时不能整条回显。
            baseUrl = "http://127.0.0.1:5599/v1?key=sk-super-secret-value",
            apiKey = "", model = "m", options = emptyMap(),
        )
        val error = assertThrows(
            "开了回环口子后该真发请求、并抛出「到不了」那一类",
            Exception::class.java,
        ) { open.chat(profile, listOf(LlmMessage("user", "hi"))) }
        val message = error.message.orEmpty()
        assertTrue("抛的必须是 UnreachableTargetException，实际 ${error::class.simpleName}",
            error is NetworkSecurity.UnreachableTargetException)
        assertTrue("不该把带 key 的整条地址回显：$message", !message.contains("sk-super-secret-value"))
        assertTrue("但要能看出连的是哪儿，便于排查：$message", message.contains("5599"))
    }
}
