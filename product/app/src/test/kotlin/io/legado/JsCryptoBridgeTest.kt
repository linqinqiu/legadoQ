package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * `java.aesBase64DecodeToString` —— Legado 的标准加密桥。
 *
 * 这条判据来自真实书源：全免漫画的 `ruleBookInfo.init` 是
 * `result=String(java.getString("$.data")).replace(/arsadata/,""); java.aesBase64DecodeToString(result,key,trans,iv)`，
 * 也就是**响应体是 AES 加密后的 JSON**。少了这个函数，`init` 抛错后引擎会拿密文当 JSON 解析，
 * 报 `Unexpected End Of File position 36020` —— 错误信息指向"JSON 坏了"，真因却是"缺解密能力"。
 */
class JsCryptoBridgeTest {

    private val sandbox = JsSandbox()
    private val key = "4548ded8c9e02690"
    private val iv = "1992360ee9bc4f8f"
    private val transformation = "AES/CBC/PKCS5Padding"

    private fun context() = JsExecutionContext(
        sourceId = "https://comic.example",
        bookUrl = "https://comic.example/book/1",
        bookName = "加密源测试书",
        bookAuthor = "某作者",
        bookTocUrl = "https://comic.example/book/1/chapters",
        chapterUrl = "https://comic.example/read/1.html",
        chapterIndex = 1,
        chapterTitle = "第1话",
    )

    private fun eval(script: String) = sandbox.eval(script, emptyMap(), context())

    /** 用同一套 key/iv 加密，保证判据测的是"能不能解 Legado 加密出来的东西"，而不是自说自话。 */
    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(transformation)
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key.toByteArray(Charsets.UTF_8), "AES"),
            IvParameterSpec(iv.toByteArray(Charsets.UTF_8)),
        )
        return Base64.getEncoder().encodeToString(cipher.doFinal(plain.toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `aes 加密的正文能被规则解密回原文`() {
        val plain = """{"data":{"comic_name":"测试漫画","chapters":[{"chapter_id":1}]}}"""
        val encoded = encrypt(plain)
        val out = eval("""java.aesBase64DecodeToString("$encoded","$key","$transformation","$iv")""")
        assertEquals(plain, out)
    }

    @Test
    fun `真实源里那种先替换再解密的写法也能跑通`() {
        val plain = """{"comic_name":"全免漫画测试"}"""
        // 上游把密文前面拼了一段 "arsadata" 标记，规则里先 replace 掉
        val encoded = "arsadata" + encrypt(plain)
        val out = eval(
            """result=String("$encoded").replace(/arsadata/,"");""" +
                """java.aesBase64DecodeToString(result,"$key","$transformation","$iv")""",
        )
        assertEquals(plain, out)
    }

    @Test
    fun `密钥不对时返回空串而不是把规则整条炸掉`() {
        val encoded = encrypt("""{"ok":true}""")
        val out = eval("""java.aesBase64DecodeToString("$encoded","0000000000000000","$transformation","$iv")""")
        assertEquals("", out)
        assertFalse("解不开不该吐出密文原文", out.orEmpty().contains(encoded.take(8)))
    }

    @Test
    fun `不传 iv 时按无 IV 的模式解，不抛异常`() {
        val cipher = Cipher.getInstance("AES/ECB/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key.toByteArray(Charsets.UTF_8), "AES"))
        val encoded = Base64.getEncoder().encodeToString(cipher.doFinal("ecb 载荷".toByteArray(Charsets.UTF_8)))
        val out = eval("""java.aesBase64DecodeToString("$encoded","$key","AES/ECB/PKCS5Padding","")""")
        assertEquals("ecb 载荷", out)
    }
}
