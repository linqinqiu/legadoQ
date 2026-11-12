package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.legado.model.ApiError
import io.legado.ops.UiPrefsStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * 服务端界面偏好（用户 2026-11-12：「改端口后壁纸恢复默认、又弹免责声明」）。
 *
 * 三条路由，形状刻意分成"读整表 / 写单值"：
 * - GET 一次把整表取回 —— 前端在启动路径上只用发一个请求，不用为每个设置各发一次；
 * - PUT 的 body 是**这个 key 对应的 JSON 值本身**，不是 { value: … } 包装对象：
 *   前端存的是什么，请求体就是什么，多一层包装只会让"存对象"与"存字符串"看起来一样；
 * - DELETE 幂等（key 不存在也回 204）：界面要"恢复默认"时不必先查存在性。
 *
 * 写端点第一行都是 requireSameOriginWrite()：偏好文件里可能存着用户自定义壁纸等个人化内容，
 * 与库里的数据同属"这台机器上的状态"，跨站页面没有资格替用户改（同源闸门见 Guard.kt）。
 *
 * 错误码刻意分开：invalid_prefs_key（400）、invalid_prefs_value（400）、
 * prefs_too_large（413）。前端据此可以只对最后一种说"设置太大"，而不是笼统一句"保存失败"。
 */
fun Route.prefsRoutes(prefs: UiPrefsStore) {

    get("/ui-prefs") {
        // 直接回字符串：JsonElement 在 ContentNegotiation 里的序列化形状依赖客户端预测的类型，
        // 这份响应是给浏览器 fetch 用的，形状必须板上钉钉（{ "prefs": { … } }）。
        call.respondText(prefs.snapshotJson(), ContentType.Application.Json)
    }

    put("/ui-prefs/{key}") {
        if (!call.requireSameOriginWrite()) return@put
        val key = call.parameters["key"]
        if (key == null || !UiPrefsStore.isKeyAllowed(key)) {
            return@put call.respond(
                HttpStatusCode.BadRequest,
                ApiError("invalid_prefs_key", "界面偏好 key 不合法：$key（仅小写字母、数字、连字符、下划线与点，1~64 位）"),
            )
        }
        // 先按声明的长度挡一次：规范化后限 32KB，原文留 1MB 给空白/转义，超过这个量级不必读进内存。
        val declared = call.request.contentLength()
        if (declared != null && declared > MAX_RAW_BODY_BYTES) {
            return@put call.respond(
                HttpStatusCode.PayloadTooLarge,
                ApiError("prefs_too_large", "请求体 $declared 字节，超过界面偏好允许上传的上限"),
            )
        }
        val raw = call.receiveText()
        val value: JsonElement = runCatching { Json.parseToJsonElement(raw) }.getOrNull()
            ?: return@put call.respond(
                HttpStatusCode.BadRequest,
                ApiError("invalid_prefs_value", "请求体必须是这个 key 的 JSON 值本身（对象、数组、字符串、数字或布尔）"),
            )
        try {
            prefs.put(key, value)
            call.respond(HttpStatusCode.NoContent)
        } catch (_: UiPrefsStore.InvalidKeyException) {
            // 走到这里说明路径参数在解码后越过了白名单（例如 %2F），同样是调用方传错。
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_prefs_key", "界面偏好 key 不合法：$key"))
        } catch (error: UiPrefsStore.TooLargeException) {
            call.respond(HttpStatusCode.PayloadTooLarge, ApiError("prefs_too_large", error.message ?: "界面偏好超过体积上限"))
        }
    }

    delete("/ui-prefs/{key}") {
        if (!call.requireSameOriginWrite()) return@delete
        val key = call.parameters["key"]
        if (key == null || !UiPrefsStore.isKeyAllowed(key)) {
            return@delete call.respond(
                HttpStatusCode.BadRequest,
                ApiError("invalid_prefs_key", "界面偏好 key 不合法：$key（仅小写字母、数字、连字符、下划线与点，1~64 位）"),
            )
        }
        // 幂等：删一个本来就不存在的 key 也算成功，界面「恢复默认」不必先 GET 一次。
        prefs.delete(key)
        call.respond(HttpStatusCode.NoContent)
    }
}

/** 请求体原文上限：规范化后限 32KB，留出空白与转义的空间，超过这个量级不再读进内存。 */
private const val MAX_RAW_BODY_BYTES = 1L * 1024 * 1024
