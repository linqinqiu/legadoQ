package io.legado

import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 数据目录选址。
 *
 * 盯的是"解压到哪都能用"：旧行为把库钉在 `<镜像>/data`，装进 `C:\Program Files`
 * 就写不进去、启动直接失败 —— 用户看到的是"双击没反应"。这里锁住三条：
 * ① 显式配置不被改写（静默搬库 = 用户以为数据丢了）；
 * ② 便携位置可写时不动（不把便携包变成"写用户目录"的安装版）；
 * ③ 不可写才退回 `<LOCALAPPDATA>\legadoQ\data`，且如实标记 `fellBack`。
 *
 * 路径一律用临时目录拼，**不写任何真实盘符**：这条判据要同时在 Windows 与 Linux CI 上跑，
 * 而 `Path.of("C:/…").isAbsolute` 在 Unix 上是 false —— 写死盘符会让"绝对路径"那几条在
 * Linux 上解析成相对路径，红得莫名其妙（开源卫生判据也会抓个人盘符）。
 */
class DesktopDataDirTest {

    private val imageRoot: Path = Files.createTempDirectory("legado-image").toAbsolutePath().resolve("legadoq")

    @Test
    fun `显式配置优先且不做退回`() {
        val relative = chooseDataDir(imageRoot, "mydata", null) { false }
        assertEquals(imageRoot.resolve("mydata").toAbsolutePath(), relative.path)
        assertFalse("显式路径不该被当成退回", relative.fellBack)

        val elsewhere = Files.createTempDirectory("legado-explicit").toAbsolutePath()
        val absolute = chooseDataDir(imageRoot, elsewhere.toString(), null) { false }
        assertEquals(elsewhere, absolute.path)
        assertFalse(absolute.fellBack)
    }

    @Test
    fun `便携位置可写时保持镜像内 data`() {
        val choice = chooseDataDir(imageRoot, null, Files.createTempDirectory("legado-local").toString()) { true }
        assertEquals(imageRoot.resolve("data").toAbsolutePath(), choice.path)
        assertFalse(choice.fellBack)
    }

    @Test
    fun `便携位置不可写时退回用户目录并标记`() {
        val localAppData = Files.createTempDirectory("legado-localappdata").toAbsolutePath()
        val choice = chooseDataDir(imageRoot, null, localAppData.toString()) { false }
        assertEquals(localAppData.resolve("legadoQ").resolve("data"), choice.path)
        assertTrue("退回必须能被上层记进日志", choice.fellBack)
    }

    @Test
    fun `没有 LOCALAPPDATA 时保持原路径交给启动失败对话框`() {
        val choice = chooseDataDir(imageRoot, null, null) { false }
        assertEquals(imageRoot.resolve("data").toAbsolutePath(), choice.path)
        assertFalse("没有可退的地方就不算退回", choice.fellBack)
    }

    @Test
    fun `探针写文件才是可写判据`() {
        val dir = Files.createTempDirectory("legado-writable")
        try {
            assertTrue("新建的空目录必须判为可写", isWritableDir(dir))
            val file = Files.createFile(dir.resolve("blocker"))
            assertTrue("目录里有普通文件不影响可写判定", isWritableDir(dir))
            Files.deleteIfExists(file)
        } finally {
            Files.deleteIfExists(dir)
        }
    }
}
