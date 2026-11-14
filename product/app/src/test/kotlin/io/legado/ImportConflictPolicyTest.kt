package io.legado

import io.legado.data.Database
import io.legado.data.getReplaceRule
import io.legado.data.getSource
import io.legado.data.importReplaceRules
import io.legado.data.importRssSources
import io.legado.data.importSources
import io.legado.data.listRssSources
import io.legado.data.listSources
import io.legado.data.listSubscriptions
import io.legado.data.saveReplaceRule
import io.legado.data.saveSource
import io.legado.data.saveSubscription
import io.legado.model.ReplaceRule
import io.legado.model.SubscriptionWriteRequest
import io.legado.ops.NetworkSecurity
import io.legado.source.SourceCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.nio.file.Files

class ImportConflictPolicyTest {
    @Test
    fun `source backup preserves local enabled while direct save applies requested enabled`() {
        withDatabase { db ->
            db.importSources(listOf(source("https://source.example", enabled = false)))
            assertFalse(db.listSources("source.example").single().enabled)

            db.saveSource(SourceCodec.parse(source("https://source.example", enabled = true)), expectedVersion = 1)
            assertTrue(db.listSources("source.example").single().enabled)

            db.importSources(listOf(source("https://source.example", enabled = false)))
            assertTrue(db.listSources("source.example").single().enabled)
            db.importSources(listOf(source("https://new.example", enabled = false)))
            assertFalse(db.listSources("new.example").single().enabled)
        }
    }

    @Test
    fun `RSS and replace rule imports overwrite local enabled state`() {
        withDatabase { db ->
            val rssOn = """{"sourceUrl":"https://feed.example/rss","sourceName":"feed","enabled":true}"""
            val rssOff = """{"sourceUrl":"https://feed.example/rss","sourceName":"feed","enabled":false}"""
            db.importRssSources(listOf(rssOn))
            db.importRssSources(listOf(rssOff))
            assertFalse(db.listRssSources(null).single().enabled)

            db.saveReplaceRule(ReplaceRule(id = "rule-1", pattern = "x", isEnabled = true))
            db.importReplaceRules(listOf(ReplaceRule(id = "rule-1", pattern = "y", isEnabled = false)))
            assertFalse(db.getReplaceRule("rule-1")!!.isEnabled)
        }
    }

    @Test
    fun `subscription upsert applies request enabled state on URL conflict`() {
        withDatabase { db ->
            val initial = db.saveSubscription(SubscriptionWriteRequest("https://subscription.example/list.json", enabled = true))
            val updated = db.saveSubscription(SubscriptionWriteRequest("https://subscription.example/list.json", enabled = false))
            assertEquals(initial.id, updated.id)
            assertFalse(db.listSubscriptions().single().enabled)
        }
    }

    private fun source(url: String, enabled: Boolean) =
        """{"bookSourceUrl":"$url","bookSourceName":"test","enabled":$enabled}"""

    private fun withDatabase(block: (Database) -> Unit) {
        val directory = Files.createTempDirectory("legado-import-policy")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            block(database)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }
}
