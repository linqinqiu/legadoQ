package io.legado.rules

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `java.t2s` / `java.s2t` 背后的表与算法。
 *
 * 判据挑的是**字表单独做不对**的那几种：词组（头发→頭髮）、歧义字（干→幹）、
 * 台港字形（爲→為）、以及 s2t 之后再过一遍 TW 表的顺序（因为→因爲→因為）。
 */
class ScriptConvertTest {

    @Test
    fun `繁转简走词组表`() {
        assertEquals("头发", ScriptConvert.t2s("頭髮"))
        assertEquals("干净", ScriptConvert.t2s("乾淨"))
        assertEquals("里面", ScriptConvert.t2s("裡面"))
    }

    @Test
    fun `简转繁走词组表而不是逐字`() {
        // 逐字会给出「頭發」（发→發），词组表才能到「頭髮」
        assertEquals("頭髮", ScriptConvert.s2t("头发"))
        assertEquals("乾淨", ScriptConvert.s2t("干净"))
    }

    @Test
    fun `长词组优先`() {
        // 「一干二净」必须赢过「一干」；逐字则会得到「一幹二淨」
        assertEquals("一乾二淨", ScriptConvert.s2t("一干二净"))
    }

    @Test
    fun `简转繁收尾过台港字形表`() {
        // 通用繁体给的是「因爲/裏面」，台港字形再改成「因為/裡面」
        assertEquals("因為", ScriptConvert.s2t("因为"))
        assertEquals("裡面", ScriptConvert.s2t("里面"))
    }

    @Test
    fun `原样保留非中文与空串`() {
        assertEquals("", ScriptConvert.t2s(""))
        assertEquals("", ScriptConvert.s2t(""))
        assertEquals("abc 123 \uD83D\uDE00", ScriptConvert.t2s("abc 123 \uD83D\uDE00"))
        assertEquals("abc 123 \uD83D\uDE00", ScriptConvert.s2t("abc 123 \uD83D\uDE00"))
    }

    @Test
    fun `扩展区汉字按码点走不劈半`() {
        // 𠗣（U+205E3）在 UTF-16 里是两个码元。按码元切会把代理对劈开、逐半查表再拼回去，
        // 这里钉住"整串长度与内容都没被拆坏"（按码点迭代才不会在 Character.toChars 上炸）。
        val converted = ScriptConvert.s2t("𠗣头")
        assertEquals("𠗣頭", converted)
        assertEquals(2, converted.codePointCount(0, converted.length))
    }
}
