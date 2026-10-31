package io.legado

import io.legado.rules.ChapterNumbers
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 章节序号转数字（`java.toNumChapter` 的底座）。
 *
 * 判据盯的是**与上游一致**，不是"看起来合理"：社区书源 146 处调用它来归一化章节标题，
 * 我们算错一个数量级，目录顺序就跟上游 App 不一样，而界面上完全看不出问题。
 * 期望值全部按上游 `chineseNumToInt` 的分支逐条推演过。
 */
class ChapterNumbersTest {

    @Test
    fun `阿拉伯数字原样返回`() {
        assertEquals("第123章", ChapterNumbers.toNumChapter("第123章"))
        // 上游用 `Integer.parseInt`，前导零本来就不保留：「第0012章」→「第12章」
        assertEquals("第12章", ChapterNumbers.toNumChapter("第0012章"))
    }

    @Test
    fun `中文进位式按上游算法结算`() {
        assertEquals("第1234章", ChapterNumbers.toNumChapter("第一千二百三十四章"))
        assertEquals("第23章", ChapterNumbers.toNumChapter("第二十三章"))
        assertEquals("第1025章", ChapterNumbers.toNumChapter("第一零二五章"))
        assertEquals(12, ChapterNumbers.stringToInt("十二"))
    }

    @Test
    fun `一万以上分段`() {
        assertEquals(10000, ChapterNumbers.stringToInt("一万"))
        assertEquals(12345, ChapterNumbers.stringToInt("一万二千三百四十五"))
        assertEquals(20000, ChapterNumbers.stringToInt("二万"))
    }

    @Test
    fun `一千二这类省略写法照上游补成二百`() {
        // 上游末位分支：`一千二` → 1000 + (2*1000/10) = 1200
        assertEquals(1200, ChapterNumbers.stringToInt("一千二"))
    }

    @Test
    fun `全角数字与空白先归一`() {
        assertEquals(1205, ChapterNumbers.stringToInt("１２０５"))
        assertEquals(1205, ChapterNumbers.stringToInt(" 1 2 0 5 "))
    }

    @Test
    fun `认不出来的写法给 -1 而不是猜`() {
        assertEquals(-1, ChapterNumbers.stringToInt("终章"))
        // 空串：上游 parseInt 抛异常后走进位式，循环一次都不进 —— 得到的是 0，不是 -1。
        // （-1 只在「表里没有这个字」时才出现。）
        assertEquals(0, ChapterNumbers.stringToInt(""))
        // 标题里没有「第…章」就原样返回，不做任何加工
        assertEquals("番外篇 雪夜", ChapterNumbers.toNumChapter("番外篇 雪夜"))
    }
}
