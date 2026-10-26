package io.legado.http

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/**
 * 端点目录：把随包的 `resources/agent-api.json` 发给外部程序（脚本 / AI 客户端），
 * 只把里面的 `version` 换成**当前真正在跑的构建号** —— 目录内容与产品版本各漂各的，
 * 是这份契约最容易烂掉的方式。
 *
 * 为什么不去反射 Ktor 的路由树：3.4 没把 `getRoutingRoot` 暴露成可解析的公开扩展（编译期就取不到），
 * 而就算读得到，树上也只有方法与路径 —— 给不出「这个端点做什么、请求体长什么样」，
 * 而那才是接进来的人真正需要的东西。
 *
 * 漂移由 `web/test/ApiCatalog.test.ts` 双向钉住：目录里多一条代码中没有的端点、
 * 或少一条代码里有的书源端点，都会红（不是靠人记得改文档）。
 */
internal object RouteCatalog {
    private val json = Json
    private val source = Json.parseToJsonElement(
        RouteCatalog::class.java.getResourceAsStream("/agent-api.json")
            ?.readBytes()?.decodeToString()
            ?: error("随包端点目录 agent-api.json 不见了（它应当和这份代码一起提交）"),
    ).jsonObject

    /**
     * 响应时盖三样东西：
     * - `version` 换成**当前真正在跑的构建号**；
     * - `count` 按端点条数现数；
     * - `howToConnect.baseUrl` 换成**当前真正在监听的地址**。
     *
     * 前两个只要是人填的就一定会有对不上的一天。第三个同理：文件里写死的
     * `http://127.0.0.1:1234` 只在产品入口（`npm start`）成立；开发者用
     * `gradlew :app:run`（默认 8080）时，契约就会把调用方指到错误的端口。
     * 所以 baseUrl 不写死在文件里，按运行时身份注入 —— 哪个端口起的，就报哪个。
     */
    fun serve(version: String, baseUrl: String): String {
        val endpoints = source["endpoints"]?.jsonArray ?: error("端点目录里没有 endpoints 数组")
        val entries = LinkedHashMap<String, JsonElement>(source)
        entries["version"] = JsonPrimitive(version)
        entries["count"] = JsonPrimitive(endpoints.size)
        (source["howToConnect"] as? JsonObject)?.let { howTo ->
            entries["howToConnect"] = JsonObject(howTo + ("baseUrl" to JsonPrimitive(baseUrl)))
        }
        return json.encodeToString(JsonObject.serializer(), JsonObject(entries))
    }
}
