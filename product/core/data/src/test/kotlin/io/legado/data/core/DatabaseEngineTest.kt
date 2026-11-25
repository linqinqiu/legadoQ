package io.legado.data.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class DatabaseEngineTest {

    @Test
    fun `initialize creates schema and rolls back a failed migration`() {
        val path = Files.createTempDirectory("legado-core-data-").resolve("test.sqlite")
        val engine = DatabaseEngine(path.toString(), maxPoolSize = 2, snapshotKeep = 0, snapshotMinIntervalMs = 0)
        try {
            val failure = IllegalStateException("migration failed")
            val error = runCatching {
                engine.initialize { db ->
                    db.createStatement().use {
                        it.executeUpdate("insert into app_meta(key, value) values('migration', 'pending')")
                    }
                    throw failure
                }
            }.exceptionOrNull()

            assertSame(failure, error)
            engine.read { db ->
                db.createStatement().use { statement ->
                    statement.executeQuery("select count(*) from app_meta where key = 'migration'").use { rows ->
                        assertTrue(rows.next())
                        assertEquals(0, rows.getInt(1))
                    }
                }
            }
        } finally {
            engine.close()
        }
    }

    @Test
    fun `nested transactions preserve outer rollback`() {
        val path = Files.createTempDirectory("legado-core-data-").resolve("test.sqlite")
        val engine = DatabaseEngine(path.toString(), maxPoolSize = 2, snapshotKeep = 0, snapshotMinIntervalMs = 0)
        try {
            engine.initialize {}
            val failure = IllegalStateException("outer failed")
            val error = runCatching {
                engine.transaction {
                    engine.transaction { db ->
                        db.createStatement().use {
                            it.executeUpdate("insert into app_meta(key, value) values('nested', 'committed')")
                        }
                    }
                    throw failure
                }
            }.exceptionOrNull()

            assertSame(failure, error)
            engine.read { db ->
                db.createStatement().use { statement ->
                    statement.executeQuery("select count(*) from app_meta where key = 'nested'").use { rows ->
                        assertTrue(rows.next())
                        assertEquals(0, rows.getInt(1))
                    }
                }
            }
        } finally {
            engine.close()
        }
    }

    @Test
    fun `close is idempotent and rejects new work`() {
        val path = Files.createTempDirectory("legado-core-data-").resolve("test.sqlite")
        val engine = DatabaseEngine(path.toString(), maxPoolSize = 2, snapshotKeep = 0, snapshotMinIntervalMs = 0)
        engine.initialize {}
        engine.close()
        engine.close()

        val error = runCatching { engine.read { 1 } }.exceptionOrNull()
        assertTrue(error is IllegalStateException)
    }
}
