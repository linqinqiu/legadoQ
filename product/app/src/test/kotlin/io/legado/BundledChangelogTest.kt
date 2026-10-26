package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 随包的更新日志必须和仓库根的 `CHANGELOG.md` 一致。
 *
 * 0.8.4 踩过的坑：`app/build.gradle` 的 `processResources` 里用 `from(CHANGELOG.md)` 把
 * 更新日志拷成 `meta/changelog.md`，但那个 `from` 是配置阶段动态求值的，Gradle 的增量快照
 * 有时抓不到它 —— `processResources` 被判 UP-TO-DATE，jar 里留的是上一次构建的旧副本。
 * 用户看到的现象是「改了 CHANGELOG，界面里的更新日志没变」，而且**构建是成功的**，
 * 没有任何报错能提示这件事。
 *
 * 修法是在 `processResources` 里把 `CHANGELOG.md` 显式登记为任务输入（`inputs.files`）。
 * 这条测试钉住"结果"而不是"配置"：不管以后用什么写法，只要 jar 里那份和源文件不一致就红。
 *
 * 判据用**前若干行逐字比对**而不是全文：`processResources` 会做行尾归一（CRLF→LF），
 * 全文比对会因为换行符差异误报；头部含版本号与最新条目，正是"有没有更新"该看的地方。
 */
class BundledChangelogTest {

    @Test
    fun `随包更新日志与仓库根 CHANGELOG 一致`() {
        val fromClasspath = javaClass.classLoader
            .getResourceAsStream("meta/changelog.md")
            ?.bufferedReader()
            ?.use { it.readText() }
            ?: error("构建产物里没有 meta/changelog.md —— processResources 没把 CHANGELOG.md 打进去")

        // 测试的工作目录是 app/，仓库根在上一级
        val root = listOf(File("../CHANGELOG.md"), File("CHANGELOG.md"))
            .firstOrNull { it.exists() }
            ?: error("找不到仓库根的 CHANGELOG.md（当前目录=${File(".").absolutePath}）")
        val source = root.readText()

        fun normalize(text: String) = text.replace("\r\n", "\n").replace("\r", "\n").trimEnd()

        val a = normalize(fromClasspath).lines()
        val b = normalize(source).lines()

        assertTrue(
            "随包的更新日志只有 ${a.size} 行，源文件有 ${b.size} 行 —— 它没跟着更新（processResources 被判 UP-TO-DATE）",
            a.size >= b.size,
        )

        // 头部 40 行含标题、版本号与最新一版条目：这些不一致就说明"更新日志没更新"
        val headA = a.take(40)
        val headB = b.take(40)
        assertEquals(
            "随包更新日志的头部与源文件不一致 —— 界面里那张「更新日志」页会显示旧内容。\n"
                + "修法：确认 app/build.gradle 的 processResources 把 CHANGELOG.md 登记成了 inputs.files。",
            headB,
            headA,
        )
    }
}
