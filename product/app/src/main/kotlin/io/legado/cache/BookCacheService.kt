package io.legado.cache

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import io.legado.AppConfig
import io.legado.data.Database
import io.legado.data.beginBookCache
import io.legado.data.cacheBookContent
import io.legado.data.cacheRequests
import io.legado.data.cachedChapterUrls
import io.legado.data.finishBookCache
import io.legado.data.getSource
import io.legado.data.listBookshelf
import io.legado.data.saveTocCache
import io.legado.data.updateBookCacheProgress
import io.legado.localbook.LocalBookParser
import io.legado.model.CachedBookRequest
import io.legado.rules.RuleExecutionException
import io.legado.rules.RuleRunner

class BookCacheService(private val database: Database, private val runner: RuleRunner, private val coverCache: CoverCache, private val log: (String) -> Unit) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = ConcurrentHashMap<String, kotlinx.coroutines.Job>()

    fun start() { database.cacheRequests().forEach(::enqueue) }
    fun stop() {
        scope.cancel()
        // 等所有在途缓存 worker 把数据库连接归还/关闭，避免外部紧接着 database.close() 时连接仍被占用（Windows 下删不掉文件）
        runCatching { runBlocking { scope.coroutineContext[Job]?.join() } }
    }

    fun enqueue(book: CachedBookRequest) {
        val key = "${book.sourceId}\u0000${book.bookUrl}"
        if (jobs[key]?.isActive == true) return
        jobs[key] = scope.launch {
            try { cache(book) } finally { jobs.remove(key) }
        }
    }

    fun cancel(sourceId: String, bookUrl: String) {
        val job = jobs.remove("$sourceId\u0000$bookUrl")
        job?.cancel()
        database.finishBookCache(sourceId, bookUrl, "已取消缓存")
    }

    private suspend fun cache(book: CachedBookRequest) {
        try {
            if (book.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                // 本地书导入时目录与正文已直接入库，没有可回源的书源记录，按已就绪收尾即可
                database.finishBookCache(book.sourceId, book.bookUrl)
                log("book cache completed: ${book.bookUrl}, local book already cached")
                return
            }
            val source = database.getSource(book.sourceId) ?: throw IllegalArgumentException("书源不存在")
            val chapters = withContext(Dispatchers.IO) { runner.chapters(source.json, book.tocUrl) }
            if (chapters.isEmpty()) throw RuleExecutionException("目录规则未提取到章节")
            database.saveTocCache(book.sourceId, book.tocUrl, chapters)
            if (book.bookUrl != book.tocUrl) {
                database.saveTocCache(book.sourceId, book.bookUrl, chapters)
            }

            // Slice chapters by range if specified
            val targetChapters = if (book.startIndex != null || book.endIndex != null || book.count != null) {
                val start = (book.startIndex ?: 0).coerceIn(0, chapters.size)
                val end = if (book.endIndex != null) {
                    (book.endIndex + 1).coerceIn(start, chapters.size)
                } else if (book.count != null) {
                    (start + book.count).coerceIn(start, chapters.size)
                } else {
                    chapters.size
                }
                if (start < end) chapters.subList(start, end) else emptyList()
            } else {
                chapters
            }

            // Breakpoint resume: skip already-cached chapter URLs
            val alreadyCached = database.cachedChapterUrls(book.sourceId, book.bookUrl)
            val remaining = targetChapters.filter { it.url !in alreadyCached }

            database.beginBookCache(book.sourceId, book.bookUrl, chapters.size)

            val failures = AtomicInteger(0)
            val cachedCount = AtomicInteger(alreadyCached.size)
            val lastProgressUpdate = AtomicLong(0L)
            val semaphore = Semaphore(CACHE_CONCURRENCY)

            val bookName = database.listBookshelf().firstOrNull { it.sourceId == book.sourceId && it.bookUrl == book.bookUrl }?.name
            coroutineScope {
                val batches = remaining.chunked(CACHE_CONCURRENCY)
                for ((index, batch) in batches.withIndex()) {
                    if (!isActive) break
                    batch.map { chapter ->
                        async {
                            semaphore.withPermit {
                                try {
                                    val content = withContext(Dispatchers.IO) { runner.content(source.json, chapter.url, bookName, book.bookUrl) }
                                    if (content.content.toByteArray().size <= MAX_CHAPTER_BYTES) {
                                        database.cacheBookContent(
                                            book.sourceId, book.bookUrl, chapter.url,
                                            content.copy(title = content.title ?: chapter.title),
                                            chapter.index,
                                        )
                                        // 漫画/图文书：正文是 `![图片](url)` 占位行 —— 把图也抓进磁盘缓存，
                                        // 离线打开才有图（阅读器那边点图也走同一个缓存，不会重复抓）。
                                        cacheChapterImages(content.content, chapter.url)
                                        reportProgress(book, cachedCount.incrementAndGet(), lastProgressUpdate)
                                    } else {
                                        failures.incrementAndGet()
                                    }
                                } catch (error: Throwable) {
                                    if (error is CancellationException) throw error
                                    failures.incrementAndGet()
                                }
                            }
                        }
                    }.awaitAll()
                    if (index < batches.size - 1 && BATCH_THROTTLE_DELAY_MS > 0 && isActive) {
                        delay(BATCH_THROTTLE_DELAY_MS)
                    }
                }
            }

            val totalFailures = failures.get()
            val error = if (totalFailures == 0) null else "$totalFailures 章未缓存"
            database.finishBookCache(book.sourceId, book.bookUrl, error)
            log("book cache completed: ${book.bookUrl}, chapters=${chapters.size}, skipped=${alreadyCached.size}, failures=$totalFailures")
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            database.finishBookCache(book.sourceId, book.bookUrl, error.message ?: "缓存失败")
            log("book cache failed: ${book.bookUrl}, error=${error.message}")
        }
    }

    /**
     * Writes fine-grained cache progress to the database at most once per
     * [PROGRESS_UPDATE_INTERVAL_MS]. The final `finishBookCache` call remains the
     * authoritative sync point, so a throttled update failure never corrupts progress.
     */
    private fun reportProgress(book: CachedBookRequest, cachedCount: Int, lastProgressUpdate: AtomicLong) {
        val now = System.currentTimeMillis()
        while (true) {
            val last = lastProgressUpdate.get()
            if (now - last < PROGRESS_UPDATE_INTERVAL_MS) return
            if (!lastProgressUpdate.compareAndSet(last, now)) continue
            runCatching {
                database.updateBookCacheProgress(book.sourceId, book.bookUrl, cachedCount)
            }
            return
        }
    }

    /**
     * 把一话正文里的图片抓进 `CoverCache` 的磁盘缓存（离线看漫画用）。
     *
     * 正文里的图是 `![图片](绝对地址)` 占位行（`cleanContent()` 生成的）。Referer 用**这一章的地址** ——
     * 图站按来源放行防盗链，阅读器那边 `api.bookImage(url, chapter.url)` 也是这么传的，两边命中同一份缓存。
     * 单话图片数封顶，坏规则不至于把整本书的缓存拖成图片爬虫。
     */
    private suspend fun cacheChapterImages(content: String, chapterUrl: String) {
        if (!content.contains("![图片](")) return
        val urls = IMAGE_PLACEHOLDER.findAll(content).map { it.groupValues[1] }.take(MAX_IMAGES_PER_CHAPTER).toList()
        if (urls.isEmpty()) return
        withContext(Dispatchers.IO) {
            urls.forEach { url -> runCatching { coverCache.cacheContentImage(url, chapterUrl) } }
        }
    }

    private companion object {
        const val MAX_CHAPTER_BYTES = 2 * 1024 * 1024
        const val MAX_IMAGES_PER_CHAPTER = 80
        val IMAGE_PLACEHOLDER = Regex("""!\[图片\]\((https?://[^)\s]+)\)""")
        val CACHE_CONCURRENCY = AppConfig.cacheConcurrency
        const val BATCH_THROTTLE_DELAY_MS = 25L
        const val PROGRESS_UPDATE_INTERVAL_MS = 1_000L
    }
}
