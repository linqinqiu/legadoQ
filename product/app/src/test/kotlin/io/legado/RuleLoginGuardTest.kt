package io.legado

import io.legado.data.Database
import io.legado.rules.RuleRunner
import io.legado.rules.loginUiVersion
import io.legado.rules.parseLoginUi
import io.legado.rules.checkLoginStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * 登录子系统抽取到 `RuleLogin.kt` 前的判据护栏：钉住 loginUiVersion / parseLoginUi(空) /
 * checkLoginStatus(无 loginCheckJs) 这几条最容易被"搬家"改坏的纯逻辑分支。
 * 更完整的登录行为（JS 动作、Cookie 合并、HTTP 端点）见 `SourceLoginTest`。
 */
class RuleLoginGuardTest {

    private fun runner(): RuleRunner {
        val db = Database(Files.createTempFile("legado-login-guard", ".sqlite").toString())
        db.initialize()
        return RuleRunner(database = db)
    }

    @Test
    fun `loginUiVersion distinguishes v1 v2 and malformed`() {
        val r = runner()
        // 没有 loginUi → v1
        assertEquals(1, r.loginUiVersion("""{"bookSourceUrl":"https://a.com"}"""))
        // v1 是 JSON 数组 → v1
        assertEquals(1, r.loginUiVersion("""{"bookSourceUrl":"https://a.com","loginUi":"[{\"name\":\"u\",\"type\":\"text\"}]"}"""))
        // v2 标记 → 2
        assertEquals(2, r.loginUiVersion("""{"bookSourceUrl":"https://a.com","loginUi":"{\"version\":2}"}"""))
        // version 非 2 → v1
        assertEquals(1, r.loginUiVersion("""{"bookSourceUrl":"https://a.com","loginUi":"{\"version\":3}"}"""))
        // 坏 JSON → v1（不抛）
        assertEquals(1, r.loginUiVersion("""{"bookSourceUrl":"https://a.com","loginUi":"{oops"}"""))
    }

    @Test
    fun `parseLoginUi returns empty when no loginUi and no loginUrl`() {
        val r = runner()
        val items = r.parseLoginUi("""{"bookSourceUrl":"https://a.com","bookSourceName":"无登录"}""")
        assertTrue(items.isEmpty())
    }

    @Test
    fun `checkLoginStatus without loginCheckJs reports not-logged-in when no credential`() {
        val r = runner()
        val result = r.checkLoginStatus("""{"bookSourceUrl":"https://nologin.example.com","bookSourceName":"无凭据"}""")
        assertFalse(result.loggedIn)
        assertFalse(result.hasCredential)
        assertFalse(result.verified)
        assertEquals("未登录", result.message)
    }
}
