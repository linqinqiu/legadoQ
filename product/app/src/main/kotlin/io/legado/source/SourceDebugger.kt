package io.legado.source

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.contentOrNull
import io.legado.rules.DebugTrace
import io.legado.rules.RuleExecutionException
import io.legado.rules.RuleRunner
import io.legado.model.Chapter
import io.legado.model.SearchResult

@Serializable
data class DebugStep(
    val stage: String,
    val label: String,
    val detail: String = "",
    val ok: Boolean = true,
    val elapsedMs: Long = 0,
    val traces: List<DebugTrace> = emptyList(),
)

/**
 * 分阶段把一本书源跑一遍：结构 → 搜索 → 详情 → 目录 → 正文，每一步给出实际地址、
 * 规则原文、结果样本和失败原因。
 *
 * 它存在的理由是「源挂了但不知道挂在哪一步」：只看搜索返回 0 条，分不清是站死了、
 * 规则方言不认、还是要登录。全部复用引擎的公开方法，不另开一条平行实现。
 * 每完成一阶段就回调一次，让调用方可以流式吐给前端 —— 慢源/死源最坏要等满各阶段超时，
 * 不流式的话界面看起来像卡住了。
 */
class SourceDebugger(private val runner: RuleRunner) {

    fun flow(
        sourceJson: String,
        keyword: String,
        bookUrl: String?,
        chapterIndex: Int,
        emit: (DebugStep) -> Unit = {},
    ) {
        val validation = SourceCodec.validate(sourceJson)
        emit(
            DebugStep(
                stage = "结构",
                label = if (validation.valid) "书源结构校验通过" else "书源结构有问题",
                detail = (validation.errors.map { "错误：$it" } + validation.warnings.map { "提示：$it" }).take(8).joinToString("\n"),
                ok = validation.valid,
            )
        )
        if (!validation.valid) return

        val isJsSource = sourceJson.objectValue().string("mainJs")?.isNotBlank() == true

        // —— 1 搜索
        val search = runCatching { timed { runner.search(sourceJson, keyword) } }
        val firstHit: SearchResult? = search.getOrNull()?.value?.firstOrNull()
        if (search.isFailure) {
            emit(DebugStep("搜索", "失败", explain(search.exceptionOrNull()!!), false))
        } else {
            val found = search.getOrThrow()
            emit(
                DebugStep(
                    stage = "搜索",
                    label = "${found.value.size} 条命中",
                    detail = found.value.take(3).joinToString("\n") { "${it.name}｜${it.author ?: "-"}｜${it.bookUrl.take(96)}" }
                        .ifBlank { "一条都没有：多半是 bookList 规则没匹配上，或站点回的是登录页/拦截页。" },
                    ok = found.value.isNotEmpty(),
                    elapsedMs = found.elapsedMs,
                )
            )
        }

        // —— 2 详情（逐字段规则追溯）
        val targetBookUrl = bookUrl?.takeIf { it.isNotBlank() } ?: firstHit?.bookUrl
        if (targetBookUrl == null) {
            emit(DebugStep("详情", "跳过", "没有可用的书籍地址：搜索没出结果，也没手工指定。", false))
            return
        }
        val details = runCatching { timed { runner.debugDetails(sourceJson, targetBookUrl) } }
        val tocUrl: String?
        if (details.isFailure) {
            tocUrl = null
            emit(DebugStep("详情", "失败", explain(details.exceptionOrNull()!!), false))
        } else {
            val timedDetails = details.getOrThrow()
            val book = timedDetails.value.first
            tocUrl = book.tocUrl
            emit(
                DebugStep(
                    stage = "详情",
                    label = "《${book.name}》${book.author?.takeIf { it.isNotBlank() }?.let { "｜$it" } ?: ""}",
                    detail = "书籍地址：${targetBookUrl.take(160)}\n目录地址：${book.tocUrl.take(160)}" +
                        if (isJsSource) "\n这是 JS 书源，字段由 mainJs 自己组装，逐字段追溯不适用。" else "",
                    ok = book.name != "未命名书籍",
                    elapsedMs = timedDetails.elapsedMs,
                    traces = timedDetails.value.second,
                )
            )
        }

        // —— 3 目录
        if (tocUrl == null) {
            emit(DebugStep("目录", "跳过", "详情阶段没拿到目录地址。", false))
            return
        }
        val chapters = runCatching { timed { runner.chapters(sourceJson, tocUrl) } }
        val chapterList: List<Chapter>
        if (chapters.isFailure) {
            chapterList = emptyList()
            emit(DebugStep("目录", "失败", explain(chapters.exceptionOrNull()!!), false))
        } else {
            val found = chapters.getOrThrow()
            chapterList = found.value
            emit(
                DebugStep(
                    stage = "目录",
                    label = "${found.value.size} 章",
                    detail = ("目录地址：${tocUrl.take(160)}\n" +
                        found.value.take(3).joinToString("\n") { "· ${it.title.take(40)}｜${it.url.take(88)}" } +
                        found.value.takeLast(1).joinToString("\n") { "… 末章 ${it.title.take(40)}" })
                        .ifBlank { "目录为空：chapterList 没匹配到条目；若这本书目录本身分页，检查 nextTocUrl。" },
                    ok = found.value.isNotEmpty(),
                    elapsedMs = found.elapsedMs,
                )
            )
        }
        val picked = chapterList.getOrNull(chapterIndex.coerceAtLeast(0)) ?: chapterList.firstOrNull()

        // —— 4 正文
        if (picked == null) {
            emit(DebugStep("正文", "跳过", "目录阶段没拿到章节。", false))
            return
        }
        val content = runCatching { timed { runner.content(sourceJson, picked.url, null) } }
        if (content.isFailure) {
            emit(DebugStep("正文", "失败：${picked.title.take(30)}", explain(content.exceptionOrNull()!!), false))
        } else {
            val timedContent = content.getOrThrow()
            val body = timedContent.value.content
            emit(
                DebugStep(
                    stage = "正文",
                    label = "《${picked.title.take(30)}》${body.length} 字",
                    detail = "章节地址：${picked.url.take(160)}\n" +
                        "开头：${body.replace("\n", " ").take(120)}\n" +
                        "正文配图占位：${Regex("!\\[图片]\\(https?://").findAll(body).count()} 处",
                    ok = body.isNotBlank(),
                    elapsedMs = timedContent.elapsedMs,
                )
            )
        }
    }

    private fun <T> timed(block: () -> T): Timed<T> {
        val started = System.currentTimeMillis()
        return Timed(block(), System.currentTimeMillis() - started)
    }

    /** 规则引擎自己抛的异常消息已经是给人看的话，不用再冠个类名。 */
    private fun explain(error: Throwable): String =
        (error as? RuleExecutionException)?.message?.take(400)
            ?: "${error.javaClass.simpleName}：${error.message?.take(400) ?: "无消息"}"

    private data class Timed<T>(val value: T, val elapsedMs: Long)

    private fun String.objectValue(): JsonObject = runCatching { Json.parseToJsonElement(this).jsonObject }.getOrDefault(JsonObject(emptyMap()))
    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
}
