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
 * ③ 不可写才退回 `%LOCALAPPDATA%\legadoQ\data`，且如实标记 `fellBack`。
 */
class DesktopDataDirTest {

    private val imageRoot: Path = Path.of("C:/Program Files/legadoq")

    @Test
    fun `显式配置优先且不做退回`() {
        val relative = chooseDataDir(imageRoot, "mydata", "C:/Users/x/AppData/Local") { false }
        assertEquals(imageRoot.resolve("mydata").toAbsolutePath(), relative.path)
        assertFalse("显式路径不该被当成退回", relative.fellBack)

        val absolute = chooseDataDir(imageRoot, "D:/legado/data", "C:/Users/x/AppData/Local") { false }
        assertEquals(Path.of("D:/legado/data"), absolute.path)
        assertFalse(absolute.fellBack)
    }

    @Test
    fun `便携位置可写时保持镜像内 data`() {
        val choice = chooseDataDir(imageRoot, null, "C:/Users/x/AppData/Local") { true }
        assertEquals(imageRoot.resolve("data").toAbsolutePath(), choice.path)
        assertFalse(choice.fellBack)
    }

    @Test
    fun `便携位置不可写时退回用户目录并标记`() {
        val choice = chooseDataDir(imageRoot, null, "C:/Users/x/AppData/Local") { false }
        assertEquals(Path.of("C:/Users/x/AppData/Local/legadoQ/data"), choice.path)
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
