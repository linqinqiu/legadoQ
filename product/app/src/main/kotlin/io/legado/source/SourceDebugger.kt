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
        val search = timedRun { runner.searchWithReason(sourceJson, keyword) }
        val searchHits: List<SearchResult> = search.value.getOrNull()?.first.orEmpty()
        val searchClue = search.value.getOrNull()?.second.orEmpty()
        val firstHit: SearchResult? = searchHits.firstOrNull()
        if (search.value.isFailure) {
            emit(DebugStep("搜索", "失败", explain(search.value.exceptionOrNull()!!), false, elapsedMs = search.elapsedMs))
        } else {
            emit(
                DebugStep(
                    stage = "搜索",
                    label = "${searchHits.size} 条命中",
                    detail = searchHits.take(3).joinToString("\n") { "${it.name}｜${it.author ?: "-"}｜${it.bookUrl.take(96)}" }
                        .ifBlank {
                            "一条都没有。这次上游回的是：$searchClue\n" +
                                "（规则没匹配上、站点要登录、页面是拦截页 —— 看上面那句就分得开。）"
                        },
                    ok = searchHits.isNotEmpty(),
                    elapsedMs = search.elapsedMs,
                )
            )
        }

        // —— 2 详情（逐字段规则追溯）
        val targetBookUrl = bookUrl?.takeIf { it.isNotBlank() } ?: firstHit?.bookUrl
        if (targetBookUrl == null) {
            emit(DebugStep("详情", "跳过", "没有可用的书籍地址：搜索没出结果，也没手工指定。", false, elapsedMs = search.elapsedMs))
            return
        }
        // 视频 / 音频 / 漫画源普遍**不配** ruleBookInfo.name —— 上游的做法是详情阶段沿用搜索结果里
        // 的标题，只把配了规则的字段补上。以前这里一律报《未命名书籍》并判 FAIL，
        // 把「这源没有详情规则」说成「详情阶段挂了」（实测番茄短剧就是这样）。
        val nameRule = (sourceJson.objectValue()["ruleBookInfo"] as? JsonObject)?.string("name")?.isNotBlank() == true
        val searchedName = searchHits.firstOrNull { it.bookUrl == targetBookUrl }?.name ?: firstHit?.name
        val details = timedRun { runner.debugDetails(sourceJson, targetBookUrl) }
        val tocUrl: String?
        if (details.value.isFailure) {
            tocUrl = null
            emit(DebugStep("详情", "失败", explain(details.value.exceptionOrNull()!!), false, elapsedMs = details.elapsedMs))
        } else {
            val (book, detailTraces) = details.value.getOrThrow()
            tocUrl = book.tocUrl
            val displayName = if (book.name == "未命名书籍") searchedName?.takeIf { it.isNotBlank() } ?: book.name else book.name
            val keepsSearchTitle = !isJsSource && !nameRule
            emit(
                DebugStep(
                    stage = "详情",
                    label = "《$displayName》${book.author?.takeIf { it.isNotBlank() }?.let { "｜$it" } ?: ""}",
                    detail = "书籍地址：${targetBookUrl.take(160)}\n目录地址：${book.tocUrl.take(160)}" +
                        (if (isJsSource) "\n这是 JS 书源，字段由 mainJs 自己组装，逐字段追溯不适用。" else "") +
                        (if (keepsSearchTitle) "\n该书源未配置详情名称规则（ruleBookInfo.name），标题沿用搜索结果。" else ""),
                    ok = keepsSearchTitle || displayName != "未命名书籍",
                    elapsedMs = details.elapsedMs,
                    traces = detailTraces,
                )
            )
        }

        // —— 3 目录
        if (tocUrl == null) {
            emit(DebugStep("目录", "跳过", "详情阶段没拿到目录地址。", false, elapsedMs = details.elapsedMs))
            return
        }
        val chapters = timedRun { runner.chapters(sourceJson, tocUrl) }
        val chapterList: List<Chapter>
        if (chapters.value.isFailure) {
            chapterList = emptyList()
            emit(DebugStep("目录", "失败", explain(chapters.value.exceptionOrNull()!!), false, elapsedMs = chapters.elapsedMs))
        } else {
            val found = chapters.value.getOrThrow()
            chapterList = found
            emit(
                DebugStep(
                    stage = "目录",
                    label = "${found.size} 章",
                    detail = ("目录地址：${tocUrl.take(160)}\n" +
                        found.take(3).joinToString("\n") { "· ${it.title.take(40)}｜${it.url.take(88)}" } +
                        found.takeLast(1).joinToString("\n") { "… 末章 ${it.title.take(40)}" })
                        .ifBlank { "目录为空：chapterList 没匹配到条目；若这本书目录本身分页，检查 nextTocUrl。" },
                    ok = found.isNotEmpty(),
                    elapsedMs = chapters.elapsedMs,
                )
            )
        }
        val picked = chapterList.getOrNull(chapterIndex.coerceAtLeast(0)) ?: chapterList.firstOrNull()

        // —— 4 正文
        if (picked == null) {
            emit(DebugStep("正文", "跳过", "目录阶段没拿到章节。", false, elapsedMs = chapters.elapsedMs))
            return
        }
        val content = timedRun { runner.content(sourceJson, picked.url, null) }
        if (content.value.isFailure) {
            emit(
                DebugStep(
                    stage = "正文", "失败：${picked.title.take(30)}",
                    explain(content.value.exceptionOrNull()!!), false, elapsedMs = content.elapsedMs,
                )
            )
        } else {
            val chapter = content.value.getOrThrow()
            val body = chapter.content
            // 音频/文件/视频源的「正文」是一条媒体直链（`yp_url` / `openUrl` / 正文规则取回直链）。
            // 以前这里只报「多少字」，播放器到底有没有地址全靠前端碰运气 —— 调试面板看不到。
            val media = chapter.mediaUrl?.takeIf { it.isNotBlank() }
            val kind = media?.let(::mediaKindLabel)
            emit(
                DebugStep(
                    stage = "正文",
                    label = if (media != null) "《${picked.title.take(30)}》${kind}直链" else "《${picked.title.take(30)}》${body.length} 字",
                    detail = buildString {
                        append("章节地址：${picked.url.take(160)}\n")
                        if (media != null) append("媒体地址：${media.take(200)}\n")
                        append("开头：${body.replace("\n", " ").take(120)}\n")
                        append("正文配图占位：${Regex("!\\[图片]\\(https?://").findAll(body).count()} 处")
                    },
                    ok = media != null || body.isNotBlank(),
                    elapsedMs = content.elapsedMs,
                )
            )
        }
    }

    /** 媒体直链按后缀归类，调试面板用来区分音频 / 视频 / 文件源取到的是不是想要的东西。 */
    private fun mediaKindLabel(url: String): String {
        val path = runCatching { java.net.URI(url.trim()).path }.getOrNull()?.lowercase().orEmpty()
        return when {
            path.endsWith(".m3u8") || path.endsWith(".m3u") -> "HLS "
            path.endsWith(".mp3") || path.endsWith(".m4a") || path.endsWith(".aac") ||
                path.endsWith(".ogg") || path.endsWith(".oga") || path.endsWith(".wav") ||
                path.endsWith(".flac") || path.endsWith(".wma") -> "音频"
            path.endsWith(".mp4") || path.endsWith(".m4v") || path.endsWith(".webm") ||
                path.endsWith(".mkv") || path.endsWith(".mov") || path.endsWith(".flv") ||
                path.endsWith(".avi") || path.endsWith(".ts") -> "视频"
            path.endsWith(".epub") || path.endsWith(".txt") || path.endsWith(".pdf") ||
                path.endsWith(".zip") || path.endsWith(".rar") -> "文件"
            else -> ""
        }
    }

    /**
     * 跑一个阶段并**连失败一起计时**。以前的 `timed{}` 只在成功时留下耗时，
     * 异常路径的 DebugStep 一律显示「0 ms」—— 用户对着一个等满 20 秒超时的源，
     * 看到的是「失败 | 0 ms」，分不清是秒挂还是慢到超时。
     */
    private fun <T> timedRun(block: () -> T): StageOutcome<T> {
        val started = System.currentTimeMillis()
        return StageOutcome(runCatching(block), System.currentTimeMillis() - started)
    }

    /** 规则引擎自己抛的异常消息已经是给人看的话，不用再冠个类名。 */
    private fun explain(error: Throwable): String =
        (error as? RuleExecutionException)?.message?.take(400)
            ?: "${error.javaClass.simpleName}：${error.message?.take(400) ?: "无消息"}"

    private class StageOutcome<T>(val value: Result<T>, val elapsedMs: Long)

    private fun String.objectValue(): JsonObject = runCatching { Json.parseToJsonElement(this).jsonObject }.getOrDefault(JsonObject(emptyMap()))
    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
}
