package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import io.legado.ops.UpdateCheck

/**
 * 「关于 → 检查更新」的版本比较（用户 2026-10-02）。
 * 只测纯函数，不打网络 —— 网络那一半失败要有可读的说法，由界面门禁判。
 */
class UpdateCheckTest {
    @Test
    fun `tag 的 v 前缀与位数不齐都不影响判断`() {
        assertTrue(UpdateCheck.isNewer("v0.4.0", "0.3.0"))
        assertTrue(UpdateCheck.isNewer("0.3.1", "0.3.0"))
        assertTrue(UpdateCheck.isNewer("0.3", "0.2.9"))
        assertFalse(UpdateCheck.isNewer("0.3.0", "0.3.0"))
        assertFalse("只是前缀不同，不是新版本", UpdateCheck.isNewer("v0.3.0", "0.3.0"))
        assertFalse("旧版不能反过来报有更新", UpdateCheck.isNewer("0.3.0", "0.4.1"))
    }

    @Test
    fun `拿不到 latest 就说没有，不当成有更新`() {
        assertFalse(UpdateCheck.isNewer("", "0.3.0"))
        assertFalse(UpdateCheck.isNewer("  ", "0.3.0"))
    }

    @Test
    fun `比不了的写法只判字面不同，但绝不把降级算成更新`() {
        // 预发布/后缀这种四段写法没法逐段比数字，保守判"不同即提示"，让用户自己点进去看
        assertTrue(UpdateCheck.isNewer("0.4.0-rc1", "0.3.9"))
        assertFalse(UpdateCheck.isNewer("0.3.0", "0.3.0"))
    }

    @Test
    fun `请求头前缀只能是 ASCII（中文应用名当头像值会把接口炸成 500）`() {
        // 实测：`User-Agent: 青阅/0.6.3` 让 JDK 在建请求时抛 `invalid header value`，
        // 而那段代码在 runCatching 之外 → 异常冲出路由 → 接口 500，界面把它念成「检查请求没有发出去」。
        assertTrue(UpdateCheck.userAgentPrefix.matches(Regex("^[\\x21-\\x7E]+$")))
        assertFalse("显示名不能进请求头", UpdateCheck.userAgentPrefix.contains(BuildInfo.title))
    }

    @Test
    fun `默认仓库是本项目自己的，不是空也不是别人家的`() {
        // 出厂状态就该能检查更新（用户 2026-10-11「检查更新不当」）。之前默认是空 → 永远
        // not_configured；再之前硬编码别人家仓库（`lukelzlz/legado`，代码 clone 来的地方），
        // 用户 2026-10-05 明确不许把仓库放到别人手里。
        assertTrue("默认仓库不能是空的，否则检查更新出厂即死", UpdateCheck.repository.isNotBlank())
        assertFalse("默认仓库不许是 clone 来的别人家仓库", UpdateCheck.repository.contains("lukelzlz"))
        assertEquals("linqinqiu/qingyue", UpdateCheck.DEFAULT_REPOSITORY)
    }

    @Test
    fun `滚动构建标签 latest 不当成版本号`() {
        // CI 每推一次 main 就发一个标签 `latest` 的滚动构建，`/releases/latest` 会返回它。
        // 以前直接拿 tag_name 去比 → isNewer("latest","0.6.46") 走"比不了即不同"那条 → true →
        // 每次都说「有新版本 latest」。现在只有像版本号的标签才参与比较，`latest` 归滚动构建那组。
        assertFalse(UpdateCheck.isVersionTag("latest"))
        assertTrue(UpdateCheck.isVersionTag("v0.6.26"))
        assertTrue(UpdateCheck.isVersionTag("0.6.26"))
    }
}
