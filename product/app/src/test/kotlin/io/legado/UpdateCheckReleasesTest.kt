package io.legado

import io.legado.ops.UpdateCheck
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 「检查更新」里**发布分类与选择**的判据（`UpdateCheck.parseReleases`）。
 *
 * 这段逻辑原来埋在 `check()` 里，而 `check()` 硬编码了 GitHub 地址、HttpClient 又是
 * `private val` —— 没法注入假响应，于是"哪个算新版本"这 35 行长期零覆盖。
 * 抽成纯函数后可以拿 JSON 原文直接喂。
 *
 * 它守的是这块最容易错的几条规则：
 * - 草稿不是发布；
 * - 空 tag 跳过；
 * - 版本号标签用 `isNewer` 取最大，**不是**按列表顺序取第一个；
 * - 非版本号标签（`latest`）按发布时间取最新，且**不硬判新旧**。
 */
class UpdateCheckReleasesTest {

    private fun releases(vararg items: String): String =
        items.joinToString(",", prefix = "[", postfix = "]")

    private fun release(tag: String, publishedAt: String = "2026-01-01T00:00:00Z", draft: Boolean = false, url: String = ""): String =
        """{"tag_name":"$tag","published_at":"$publishedAt","draft":$draft,"html_url":"$url"}"""

    @Test
    fun `草稿不算发布`() {
        val body = releases(
            release("v0.9.0", draft = true),
            release("v0.8.3", publishedAt = "2026-01-02T00:00:00Z"),
        )
        val parsed = UpdateCheck.parseReleases(body)
        assertNotNull("应有可用的版本发布", parsed)
        assertEquals("草稿应被跳过，取 v0.8.3", "v0.8.3", parsed!!.bestVersioned?.get("tag"))
    }

    @Test
    fun `空 tag 与缺字段的条目被跳过，不抛异常`() {
        val body = releases(
            """{"tag_name":"","published_at":"2026-01-01T00:00:00Z"}""",
            """{"published_at":"2026-01-01T00:00:00Z"}""",
            release("v0.8.0"),
        )
        val parsed = UpdateCheck.parseReleases(body)
        assertNotNull(parsed)
        assertEquals("v0.8.0", parsed!!.bestVersioned?.get("tag"))
    }

    @Test
    fun `版本号发布取最大的那个，不是列表第一个`() {
        // 故意把小的放前面：按列表顺序取会拿到 v0.7.0
        val body = releases(
            release("v0.7.0", publishedAt = "2026-01-05T00:00:00Z"),
            release("v0.9.1", publishedAt = "2026-01-01T00:00:00Z"),
            release("v0.8.3", publishedAt = "2026-01-03T00:00:00Z"),
        )
        val parsed = UpdateCheck.parseReleases(body)
        assertEquals("应按版本号取最大，不是按发布时间或列表顺序", "v0.9.1", parsed!!.bestVersioned?.get("tag"))
    }

    @Test
    fun `滚动构建按发布时间取最新，且与版本发布分开记`() {
        val body = releases(
            release("latest", publishedAt = "2026-01-01T00:00:00Z", url = "https://x/old"),
            release("latest", publishedAt = "2026-02-01T00:00:00Z", url = "https://x/new"),
            release("v0.8.3", publishedAt = "2026-01-15T00:00:00Z"),
        )
        val parsed = UpdateCheck.parseReleases(body)!!
        assertEquals("版本发布应取 v0.8.3", "v0.8.3", parsed.bestVersioned?.get("tag"))
        assertEquals("滚动构建应取发布时间最新的那条", "https://x/new", parsed.rolling?.get("url"))
    }

    @Test
    fun `只有滚动构建时也返回结果，不硬判新旧`() {
        val body = releases(release("latest", publishedAt = "2026-02-01T00:00:00Z", url = "https://x/latest"))
        val parsed = UpdateCheck.parseReleases(body)
        assertNotNull("只有滚动构建也算有发布", parsed)
        assertNull("不该凭空造一个版本号", parsed!!.bestVersioned)
        assertEquals("latest", parsed.rolling?.get("tag"))
    }

    @Test
    fun `一条可用发布都没有时返回 null`() {
        assertEquals("空数组应返回 null", null, UpdateCheck.parseReleases("[]"))
        assertEquals("全是草稿应返回 null", null,
            UpdateCheck.parseReleases(releases(release("v1.0.0", draft = true))))
        assertEquals("坏 JSON 应返回 null 而不是抛异常", null, UpdateCheck.parseReleases("not json"))
        assertEquals("空串应返回 null", null, UpdateCheck.parseReleases(""))
    }

    @Test
    fun `字段缺失不崩，url 与时间回落成空串`() {
        val body = releases("""{"tag_name":"v0.8.3"}""")
        val parsed = UpdateCheck.parseReleases(body)
        assertNotNull(parsed)
        assertEquals("v0.8.3", parsed!!.bestVersioned?.get("tag"))
        assertEquals("缺 html_url 应回落成空串", "", parsed.bestVersioned?.get("url"))
        assertEquals("缺 published_at 应回落成空串", "", parsed.bestVersioned?.get("publishedAt"))
    }

    @Test
    fun `真机形态：版本发布 + 滚动构建共存时两类都对`() {
        // 模拟本项目真实情况：CI 每推一次 main 发一个 latest，版本发布另有一套
        val body = releases(
            release("latest", publishedAt = "2026-10-21T06:00:00Z", url = "https://github.com/x/releases/tag/latest"),
            release("v0.8.3", publishedAt = "2026-10-20T12:00:00Z", url = "https://github.com/x/releases/tag/v0.8.3"),
            release("v0.8.2", publishedAt = "2026-10-19T12:00:00Z", url = "https://github.com/x/releases/tag/v0.8.2"),
            release("v0.9.0", publishedAt = "2026-10-22T12:00:00Z", draft = true),
        )
        val parsed = UpdateCheck.parseReleases(body)!!
        assertEquals("最新版本发布是 v0.8.3（v0.9.0 是草稿）", "v0.8.3", parsed.bestVersioned?.get("tag"))
        assertEquals("latest", parsed.rolling?.get("tag"))
        assertEquals("滚动构建的链接要带上", "https://github.com/x/releases/tag/latest", parsed.rolling?.get("url"))
    }
}
