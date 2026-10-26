package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.model.ApiError
import io.legado.model.TtsSessionAck
import io.legado.model.TtsSessionChunkRequest
import io.legado.model.TtsSessionControlRequest
import io.legado.model.TtsSpeakRequest
import io.legado.tts.EdgeTtsService
import io.legado.tts.TtsSessionService

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：朗读会话与一次性合成。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.ttsRoutes(
    edgeTts: EdgeTtsService,
    ttsSessions: TtsSessionService,
) {
        route("/tts") {
            get("/voices") {
                call.respond(edgeTts.listVoices())
            }
            post("/session") {
                if (!call.requireSameOriginWrite()) return@post
                call.respond(ttsSessions.create(LOCAL_TTS_OWNER))
            }
            post("/session/{id}/chunks") {
                if (!call.requireSameOriginWrite()) return@post
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@post
                    }
                try {
                    val accepted = session.append(call.receive<TtsSessionChunkRequest>())
                    if (!accepted) {
                        call.respond(HttpStatusCode.Conflict, ApiError("tts_session_busy", "朗读队列已满"))
                    } else {
                        call.respond(TtsSessionAck(accepted = true))
                    }
                } catch (error: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_tts_chunk", error.message ?: "朗读分片无效"))
                }
            }
            post("/session/{id}/control") {
                if (!call.requireSameOriginWrite()) return@post
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@post
                    }
                val request = call.receive<TtsSessionControlRequest>()
                when (request.action) {
                    "pause" -> session.pause()
                    "resume" -> session.resume()
                    "stop" -> ttsSessions.remove(session)
                    else -> {
                        call.respond(HttpStatusCode.BadRequest, ApiError("invalid_tts_action", "不支持的朗读操作"))
                        return@post
                    }
                }
                call.respond(TtsSessionAck(accepted = true))
            }
            delete("/session/{id}") {
                if (!call.requireSameOriginWrite()) return@delete
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@delete
                    }
                ttsSessions.remove(session)
                call.respond(HttpStatusCode.NoContent)
            }
            get("/session/{id}/audio") {
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@get
                    }
                call.response.cacheControl(CacheControl.NoStore(null))
                call.response.header("X-Accel-Buffering", "no")
                call.response.header("Cache-Control", "no-cache, no-transform")
                call.response.header("Connection", "keep-alive")
                call.respondBytesWriter(ContentType.Audio.MPEG, status = HttpStatusCode.OK) {
                    session.streamAudio(this)
                }
            }
            get("/session/{id}/events") {
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@get
                    }
                call.response.cacheControl(CacheControl.NoStore(null))
                call.response.header("X-Accel-Buffering", "no")
                call.response.header("Cache-Control", "no-cache, no-transform")
                call.response.header("Connection", "keep-alive")
                call.respondTextWriter(ContentType.Text.EventStream) {
                    session.streamEvents(this)
                }
            }
            post("/speak") {
                // customUrl 由请求体决定，等于让调用方指定服务端要抓哪个地址；
                // 之前只验会话不验 CSRF，任何网页发个简单跨站请求就能借这台机器去打内网。
                if (!call.requireSameOriginWrite()) return@post
                val req = call.receive<TtsSpeakRequest>()
                val text = req.text.trim()
                if (text.isEmpty()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_text", "朗读文本不能为空"))
                    return@post
                }
                try {
                    if (req.engine == "custom" && !req.customUrl.isNullOrBlank()) {
                        val (contentType, audioBytes) = edgeTts.synthesizeCustom(req)
                        call.respondBytes(
                            bytes = audioBytes,
                            contentType = ContentType.parse(contentType),
                            status = HttpStatusCode.OK,
                        )
                    } else {
                        val audioBytes = edgeTts.synthesize(
                            text = text,
                            voice = req.voice.ifBlank { "zh-CN-XiaoxiaoNeural" },
                            rate = req.rate,
                            pitch = req.pitch,
                        )
                        call.respondBytes(
                            bytes = audioBytes,
                            contentType = ContentType.Audio.MPEG,
                            status = HttpStatusCode.OK,
                        )
                    }
                } catch (e: Exception) {
                    call.application.log.warn("TTS synthesis failed for voice={}: {}", req.voice, e.message)
                    call.respond(HttpStatusCode.InternalServerError, ApiError("tts_failed", e.message ?: "语音合成失败"))
                }
            }
            get("/speak") {
                val text = call.request.queryParameters["text"]?.trim() ?: ""
                if (text.isEmpty()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_text", "朗读文本不能为空"))
                    return@get
                }
                val voice = call.request.queryParameters["voice"] ?: "zh-CN-XiaoxiaoNeural"
                val rate = call.request.queryParameters["rate"]?.toIntOrNull() ?: 0
                val pitch = call.request.queryParameters["pitch"]?.toIntOrNull() ?: 0
                try {
                    val audioBytes = edgeTts.synthesize(text = text, voice = voice, rate = rate, pitch = pitch)
                    call.respondBytes(
                        bytes = audioBytes,
                        contentType = ContentType.Audio.MPEG,
                        status = HttpStatusCode.OK,
                    )
                } catch (e: Exception) {
                    call.application.log.warn("TTS get speak failed: {}", e.message)
                    call.respond(HttpStatusCode.InternalServerError, ApiError("tts_failed", e.message ?: "语音合成失败"))
                }
            }
        }
}

/** 不设身份后，朗读会话的"归属者"就是这台机器上的唯一用户。 */
internal const val LOCAL_TTS_OWNER = "local"

