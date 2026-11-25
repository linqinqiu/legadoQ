package io.legado

import io.legado.backup.BackupStore
import io.legado.cache.BookCacheService
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.MentionsWarmer
import io.legado.data.getCookieForUrl
import io.legado.feedback.FeedbackService
import io.legado.localbook.TocRules
import io.legado.ops.LocalControlClient
import io.legado.ops.UiPrefsStore
import io.legado.rules.RuleRunner
import io.legado.source.ExternalBrowserLogin
import io.legado.source.SourceDebugger
import io.legado.source.WebViewProxy
import io.legado.subscription.SubscriptionService
import io.legado.tts.EdgeTtsService
import io.legado.tts.TtsSessionService
import java.util.concurrent.atomic.AtomicBoolean

class AppContainer private constructor(
    val config: ServerConfig,
    val database: Database,
    val runner: RuleRunner,
    val coverCache: CoverCache,
    val subscriptions: SubscriptionService,
    val bookCache: BookCacheService,
    val edgeTts: EdgeTtsService,
    val ttsSessions: TtsSessionService,
    val webView: WebViewProxy,
    val backupKeep: BackupStore,
    val uiPrefs: UiPrefsStore,
    val externalLogin: ExternalBrowserLogin,
    val debugger: SourceDebugger,
    val feedbackService: FeedbackService,
    private val log: (String) -> Unit,
) {
    private val started = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)

    fun start() {
        if (closed.get() || !started.compareAndSet(false, true)) return
        MentionsWarmer.schedule(database, delayMs = 0)
        subscriptions.start()
        bookCache.start()
        database.scheduleReclaimFragmentation()
        val purgedCovers = coverCache.purgeGeneratedLocalCovers(database)
        if (purgedCovers > 0) log("已回收 $purgedCovers 张自动生成的本地书封面")
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        subscriptions.stop()
        bookCache.stop()
        ttsSessions.close()
        database.close()
    }

    companion object {
        fun create(
            config: ServerConfig,
            feedbackService: FeedbackService,
            log: (String) -> Unit = {},
        ): AppContainer {
            var database: Database? = null
            var subscriptions: SubscriptionService? = null
            var bookCache: BookCacheService? = null
            var ttsSessions: TtsSessionService? = null
            try {
                val db = Database(config.databasePath).also { database = it }
                db.initialize()

                val subs = SubscriptionService(db) { message -> log(message) }.also { subscriptions = it }
                val runner = RuleRunner(database = db)
                val coverCache = CoverCache(config.coverCacheDirectory, cookieFor = { db.getCookieForUrl(it) })
                val cache = BookCacheService(db, runner, coverCache) { message -> log(message) }.also { bookCache = it }
                val edgeTts = EdgeTtsService()
                val tts = TtsSessionService(edgeTts).also { ttsSessions = it }
                val webView = WebViewProxy(db)
                val backupKeep = BackupStore(config.localBooksDirectory.resolveSibling("backup_kept"))
                val uiPrefs = UiPrefsStore(config.localBooksDirectory.resolveSibling(UiPrefsStore.FILE_NAME))
                val externalLogin = ExternalBrowserLogin(
                    db,
                    config.localBooksDirectory.resolveSibling("external-browser-profile"),
                    LocalControlClient,
                )
                val debugger = SourceDebugger(runner)
                TocRules.useStore(config.localBooksDirectory.resolveSibling("txt_toc_rules.json"))

                return AppContainer(
                    config = config,
                    database = db,
                    runner = runner,
                    coverCache = coverCache,
                    subscriptions = subs,
                    bookCache = cache,
                    edgeTts = edgeTts,
                    ttsSessions = tts,
                    webView = webView,
                    backupKeep = backupKeep,
                    uiPrefs = uiPrefs,
                    externalLogin = externalLogin,
                    debugger = debugger,
                    feedbackService = feedbackService,
                    log = log,
                )
            } catch (error: Throwable) {
                runCatching { ttsSessions?.close() }
                runCatching { bookCache?.stop() }
                runCatching { subscriptions?.stop() }
                runCatching { database?.close() }
                throw error
            }
        }
    }
}
