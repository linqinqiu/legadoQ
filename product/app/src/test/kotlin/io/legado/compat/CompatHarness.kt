package io.legado.compat

import io.legado.rules.RuleRunner
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

/**
 * compat 模块公共装具（阶段 2 骨架，2026-11-20）。
 *
 * 来源：把 `GoldenRuleTest` 的离线 fixture 加载与断言能力抽到共享 harness，
 * 使新增 golden sample（S-1 / `14` §5 的 7 个补充样本）只需声明输入与期望，不复制样板。
 * 断言粒度遵循 `21` §4.2 的 L1–L4 分层：
 *   - L1 正文整段：`assertBodyEquals` 逐字符 equals（含换行/空行/图片占位行位置/首尾空白）
 *   - L2 结构化字段：`assertFieldEquals` 逐字段 + `assertDtoShape`（键集合封闭，不接受多余字段）
 *   - L3 请求形态：`assertRequested` 整串 URL equals + 请求序列 equals
 *   - L4 二进制：沿用 `ImageDecodeTest` 的逐字节 assertArrayEquals
 *
 * 本骨架**不改任何规则实现**，只把判据模块化。阶段 4 每搬一个域，对应 case 移到这里即可。
 */
object CompatHarness {
    val json: Json = Json { ignoreUnknownKeys = true }

    fun fixture(path: String): String =
        CompatHarness::class.java.classLoader.getResource(path)?.readText()
            ?: error("缺少 fixture：$path（应位于 app/src/test/resources/$path）")

    fun expected(path: String): JsonObject =
        json.parseToJsonElement(fixture(path)).jsonObject

    /** 离线响应桩：按 URL 路由到对应响应体，未预期请求直接失败（登录链路零请求）。 */
    fun offlineRunner(routes: Map<String, String>): RuleRunner = RuleRunner { url ->
        routes[url] ?: error("compat 离线桩收到未预期请求：$url")
    }

    fun pageRunner(page: String): RuleRunner = RuleRunner { _ -> page }

    // ---- L2：结构化字段逐字段等值 + 键集合封闭 ----
    fun assertFieldEquals(label: String, index: Int, field: String, expectedText: String, actual: String?) {
        assertEquals("$label[$index].$field 应与金标准一致", expectedText, actual)
    }

    /** 断言 DTO 字段集无增无减（不接受多余字段，也不缺字段）。 */
    fun assertDtoShape(label: String, expectedFields: Set<String>, actualFields: Set<String>) {
        assertEquals("$label 字段集应封闭", expectedFields, actualFields)
    }

    // ---- L1：正文整段逐字符 equals ----
    fun assertBodyEquals(label: String, expectedText: String, actualContent: String) {
        assertEquals("$label 正文应逐字符一致（含换行/空行/图片占位行位置/首尾空白）", expectedText, actualContent)
    }

    // ---- L3：请求形态 ----
    fun assertRequestedSingle(label: String, urlPrefix: String, requested: List<String>) {
        assertEquals("$label 只应请求一次", 1, requested.size)
        assertTrue("$label 请求地址应由 searchUrl 渲染而来，实际：${requested.single()}", requested.single().startsWith(urlPrefix))
    }

    fun assertListEquals(label: String, expected: JsonArray, actual: List<String>, pick: (JsonObject) -> String) {
        assertEquals("$label 条数应一致", expected.size, actual.size)
        expected.forEachIndexed { i, el ->
            assertEquals("$label[$i]", pick(el.jsonObject), actual[i])
        }
    }
}
