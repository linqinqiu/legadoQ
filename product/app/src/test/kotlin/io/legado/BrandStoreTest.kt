package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * 自定义品牌（用户 2026-10-23：「允许自定义图标和名称」）。
 *
 * 判据分两层：
 * ① 存取的形状 —— 空品牌必须**逐字节回落到内置**，不能因为"没配"就把界面弄成无名无图；
 * ② 安全边界 —— 图标只按魔数认 PNG/JPEG/WebP，**SVG 必须拒**：品牌图标会被浏览器当作
 *    本站自己的资源取用，放一张能带脚本的 SVG 进去等于自己开一条同源脚本执行面
 *    （与 `CoverCache` 拒 `image/svg+xml`、`MediaRoutes` 把同源 SVG 降级成 octet-stream 同一条纪律）。
 */
class BrandStoreTest {

    /** 真的 PNG 文件头（8 字节签名）+ 一小段 IHDR，够判类型也够当"另一张图"的对照字节。 */
    private fun PNG() = byteArrayOf(
        0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
    )

    private fun tempHome() = Files.createTempDirectory("legado-brand")

    @Test
    fun `没配品牌时是空品牌且显示名回落内置`() {
        val home = tempHome()
        val brand = BrandStore.load(home)
        assertEquals("没有 brand.json 时名称应为空", "", brand.name)
        assertTrue("空品牌不该声称有图标", !brand.hasIcon)
        assertEquals("显示名回落内置的应用名", BuildInfo.title, brand.displayName)
        assertEquals("短名同样回落", BuildInfo.title, brand.displayShortName)
    }

    @Test
    fun `存了名字之后重启进程还在`() {
        val home = tempHome()
        BrandStore.save(home, Brand(name = "我的小书房", shortName = "小书房"))
        val reloaded = BrandStore.load(home)
        assertEquals("换一个 store 再读回来 = 重启进程", "我的小书房", reloaded.name)
        assertEquals("我的小书房", reloaded.displayName)
        // 文件确实在安装根：这台服务可以整体搬盘/改名，品牌属于"这一台机器长什么样"。
        assertTrue("brand.json 应落在安装根", Files.isRegularFile(home.resolve("brand.json")))
    }

    @Test
    fun `名称里的换行被清掉 主题色只认井号十六进制`() {
        val home = tempHome()
        val saved = BrandStore.save(
            home,
            Brand(name = "有\n换行的名字", themeColor = "red; background:url(evil)"),
        )
        assertTrue("换行必须被清掉（它要进 JSON 与 <title>）：${saved.name}", !saved.name.contains('\n'))
        assertEquals("非法颜色一律丢回空", "", saved.themeColor)
        val ok = BrandStore.save(home, Brand(name = "行", themeColor = "#247A58"))
        assertEquals("合法颜色要收并且归一小写", "#247a58", ok.themeColor)
        val short = BrandStore.save(home, Brand(name = "a".repeat(80)))
        assertTrue("名称要有上限（它会被拼进清单与标题）：${short.name.length}", short.name.length <= 40)
    }

    @Test
    fun `图标按魔数认 PNG 但拒 SVG 与未知字节`() {
        assertEquals("image/png", BrandStore.sniffImageType(PNG()))
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte()) + ByteArray(12)
        assertEquals("image/jpeg", BrandStore.sniffImageType(jpeg))
        val svg = ("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\">" +
            "<script>alert(1)</script></svg>").toByteArray()
        assertNull("SVG 必须认不出（能带脚本的同源资源不收）", BrandStore.sniffImageType(svg))
        assertNull("太短不足以判类型", BrandStore.sniffImageType(byteArrayOf(1, 2, 3)))
    }

    @Test
    fun `存图标要落文件并把文件名记进品牌`() {
        val home = tempHome()
        val name = BrandStore.saveIcon(home, PNG())
        assertNotNull("PNG 应存下", name)
        val brand = BrandStore.save(home, Brand(name = "带图标", iconFile = name ?: ""))
        assertTrue("品牌该报有图标", brand.hasIcon)
        val bytes = BrandStore.iconBytes(home, brand)
        assertNotNull("图标字节要读得回来", bytes)
        assertEquals("类型按魔数报，不信文件名", "image/png", bytes!!.second)
        // 换一张覆盖同一格：不在磁盘上堆历史图标，界面上的 URL 也不用变。
        BrandStore.saveIcon(home, PNG())
        val dir = home.resolve("brand").toFile()
        assertEquals("brand/ 里只该留一张：${dir.listFiles()?.map { it.name }?.joinToString()}",
            1, dir.listFiles()?.size ?: 0)
    }

    @Test
    fun `图标文件被手动删掉时品牌如实说没有`() {
        val home = tempHome()
        val name = BrandStore.saveIcon(home, PNG())!!
        BrandStore.save(home, Brand(name = "x", iconFile = name))
        Files.delete(home.resolve("brand").resolve(name))
        val brand = BrandStore.load(home)
        assertTrue("文件没了就不该再声称有图标（否则界面上是一个 404 图标）", !brand.hasIcon)
        assertNull("读字节也要跟着说没有", BrandStore.iconBytes(home, brand))
    }

    @Test
    fun `clear 把品牌与图标一起清干净`() {
        val home = tempHome()
        val name = BrandStore.saveIcon(home, PNG())!!
        BrandStore.save(home, Brand(name = "要清掉", iconFile = name))
        val cleared = BrandStore.clear(home)
        assertEquals("清完回内置名", BuildInfo.title, cleared.displayName)
        assertTrue("brand.json 该没了", !Files.exists(home.resolve("brand.json")))
        assertTrue("图标字节也不该留着当孤儿", !Files.exists(home.resolve("brand").resolve(name)))
    }

    @Test
    fun `坏掉的 brand json 不炸 回落到内置外观`() {
        val home = tempHome()
        Files.writeString(home.resolve("brand.json"), "{这不是 JSON")
        val brand = BrandStore.load(home)
        assertEquals("解析失败必须回落空品牌", "", brand.name)
        assertEquals(BuildInfo.title, brand.displayName)
    }

    @Test
    fun `带 BOM 的配置文件也读得动`() {
        val home = tempHome()
        // 很多编辑器与 PowerShell 默认写 BOM；kotlinx 见了会整份解析失败 —— 同 AgentProfileStore 那条教训。
        Files.writeString(home.resolve("brand.json"), "\uFEFF{\"name\":\"有BOM的名字\"}")
        assertEquals("有BOM的名字", BrandStore.load(home).name)
    }

    @Test
    fun `清单改写 没配品牌时一个字节都不动`() {
        val packaged = BrandManifest.packagedText()
        assertTrue("随包 manifest 必须读得到（jar 里没有它说明打包环节坏了）", !packaged.isNullOrBlank())
        val same = BrandManifest.render(Brand(), null, null)
        assertEquals("没设品牌就该原样发内置那份", packaged, same)
    }

    @Test
    fun `清单改写 名称与主题色替换而内置图标全部留着`() {
        val rendered = BrandManifest.render(
            Brand(name = "我的书斋", themeColor = "#123456"),
            iconUrl = "/brand/icon",
            iconType = "image/png",
        )
        assertTrue("name 要换成自定义的：${rendered.take(120)}", rendered.contains("\"name\":\"我的书斋\""))
        assertTrue("short_name 跟着走", rendered.contains("\"short_name\":\"我的书斋\""))
        assertTrue("theme_color 要跟上", rendered.contains("\"theme_color\":\"#123456\""))
        // 内置的 maskable 那一条必须留着：我们不对上传的图做重栅格化，
        // 拿一张没有安全区的普通图顶替 maskable，正是"图标缺角"那个投诉的形状。
        assertTrue("内置 maskable 图标不许被替掉", rendered.contains("maskable-icon-512x512.png"))
        assertTrue("自定义图标该排在最前", rendered.indexOf("\"src\":\"/brand/icon\"") < rendered.indexOf("pwa-192x192.png"))
        // 其余字段一个都不能丢（start_url/scope 缺一个 PWA 就装不上）。
        for (keep in listOf("start_url", "scope", "display", "shortcuts", "lang")) {
            assertTrue("改写后仍要保留 $keep", rendered.contains(keep))
        }
    }

    @Test
    fun `图标指纹稳定且随字节变化`() {
        val a = BrandManifest.iconEtag(PNG())
        assertEquals("指纹应是 12 位十六进制", 12, a.length)
        assertTrue(a.matches(Regex("[0-9a-f]{12}")))
        assertEquals("同一字节必须同一指纹（缓存才谈得上 immutable）", a, BrandManifest.iconEtag(PNG()))
        assertTrue("不同字节要不同指纹", a != BrandManifest.iconEtag(PNG() + 1))
    }
}
