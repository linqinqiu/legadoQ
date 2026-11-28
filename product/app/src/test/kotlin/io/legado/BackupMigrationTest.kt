package io.legado

import io.legado.backup.*
import io.legado.data.*
import kotlinx.serialization.json.*
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import org.junit.Assert.*
import org.junit.Test

class BackupMigrationTest {
    private fun fixture(run: (Database, BackupStore, Path) -> Unit) {
        val dir = Files.createTempDirectory("legado-migration-test-")
        val db = Database(dir.resolve("test.sqlite").toString())
        try { db.initialize(); run(db, BackupStore(dir.resolve("kept")), dir) }
        finally { db.close(); dir.toFile().deleteRecursively() }
    }

    private fun seed(db: Database, store: BackupStore, dir: Path) {
        val input = dir.resolve("input.json")
        Files.writeString(input, """{"bookSource":[
            {"bookSourceUrl":"https://migration.example/#甲","bookSourceName":"甲","custom":123},
            {"bookSourceUrl":"https://migration.example/#乙","bookSourceName":"乙"}],
            "bookshelf":[{"origin":"https://migration.example/#甲","bookUrl":"book","name":"书","durChapterIndex":2,"durChapterTime":10}]}""")
        BackupImporter(db, store).import(input)
        assertTrue(store.keep("readConfig.json", "[ {\"fontSize\": 23} ]\n"))
        assertTrue(store.keep("sourceSub.json", "[{\"url\":\"https://subscription.example/\",\"type\":1,\"unknown\":true}]"))
    }

    private fun migration(db: Database, store: BackupStore, dir: Path): Path = dir.resolve("migration.zip").also {
        Files.newOutputStream(it).use { out -> BackupMigration.export(db, store, out) }
    }

    private fun rewrite(input: Path, output: Path, mutate: (String, ByteArray) -> Pair<String, ByteArray>?) {
        ZipFile(input.toFile()).use { source -> ZipOutputStream(Files.newOutputStream(output)).use { target ->
            source.entries().asSequence().forEach { entry ->
                mutate(entry.name, source.getInputStream(entry).use { it.readBytes() })?.let { (name, bytes) ->
                    target.putNextEntry(ZipEntry(name)); target.write(bytes); target.closeEntry()
                }
            }
        } }
    }

    @Test fun `迁移包空库往返保留原生域和全部留档字节 预览只读 重复复用`() = fixture { db, store, dir ->
        seed(db, store, dir)
        val file = migration(db, store, dir)
        fixture { other, otherStore, otherDir ->
            val importer = BackupImporter(other, otherStore)
            val preview = importer.preview(file)
            assertEquals(2, preview.sections.single { it.id == "kept" }.items)
            assertTrue(other.listSources(null).isEmpty()); assertTrue(otherStore.list().isEmpty())
            val result = importer.import(file)
            assertEquals(1, other.listSources(null).size); assertEquals(1, other.listBookshelf().size)
            assertEquals(3, result.keptSections.size)
            assertEquals(store.migrationFiles().map { it.first to it.second.toList() },
                otherStore.migrationFiles().map { it.first to it.second.toList() })
            importer.import(file)
            assertEquals(3, otherStore.list().size)
            fun native(database: Database) = ByteArrayOutputStream().also { BackupExporter.exportAll(database, it) }.toByteArray()
            val first = otherDir.resolve("first.zip"); Files.write(first, native(db))
            val second = otherDir.resolve("second.zip"); Files.write(second, native(other))
            ZipFile(first.toFile()).use { a -> ZipFile(second.toFile()).use { b ->
                a.entries().asSequence().forEach { entry ->
                    assertEquals(Json.parseToJsonElement(a.getInputStream(entry).reader().readText()),
                        Json.parseToJsonElement(b.getInputStream(b.getEntry(entry.name)).reader().readText()))
                }
            } }
        }
    }

    @Test fun `未选留档不保存证据 仅留档不激活源或导入书架`() = fixture { db, store, dir ->
        seed(db, store, dir); val file = migration(db, store, dir)
        fixture { other, otherStore, _ ->
            val importer = BackupImporter(other, otherStore)
            importer.import(file, sections = setOf("shelf"))
            assertTrue(otherStore.list().isEmpty()); assertTrue(other.listSources(null).isEmpty())
            importer.import(file, sections = setOf("kept"))
            assertEquals(2, otherStore.list().size); assertTrue(other.listSources(null).isEmpty())
        }
    }

    @Test fun `迁移包留档损坏 缺清单 未声明文件及路径别名均在预览和写入前拒绝`() = fixture { db, store, dir ->
        seed(db, store, dir); val file = migration(db, store, dir)
        val mutations = listOf<(String, ByteArray) -> Pair<String, ByteArray>?>(
            { name, bytes -> name to if (name == "kept/readConfig.json") "[]".toByteArray() else bytes },
            { name, bytes -> if (name == BackupMigration.MANIFEST) null else name to bytes },
            { name, bytes -> (if (name == "kept/readConfig.json") "kept/theme.json" else name) to bytes },
            { name, bytes -> (if (name == "bookSource.json") "nested/bookSource.json" else name) to bytes },
            { name, bytes -> (if (name == "kept/readConfig.json") "kept/../readConfig.json" else name) to bytes },
            { name, bytes -> name to if (name == BackupMigration.MANIFEST) "{\"format\":\"future\",\"files\":[]}".toByteArray() else bytes },
            { name, bytes -> name to if (name == BackupMigration.MANIFEST) "{\"format\":\"legadoq-migration-v1\"}".toByteArray() else bytes },
            { name, bytes -> name to if (name == BackupMigration.MANIFEST) byteArrayOf(0xc3.toByte(), 0x28) else bytes },
            { name, bytes -> name to if (name == BackupMigration.MANIFEST) ByteArray(1024 * 1024 + 1) { 32 } else bytes },
        )
        mutations.forEachIndexed { index, mutation ->
            val bad = dir.resolve("bad-$index.zip"); rewrite(file, bad, mutation)
            fixture { other, otherStore, _ ->
                val importer = BackupImporter(other, otherStore)
                assertThrows(IllegalArgumentException::class.java) { importer.preview(bad) }
                assertThrows(IllegalArgumentException::class.java) { importer.import(bad) }
                assertTrue(other.listSources(null).isEmpty()); assertTrue(otherStore.list().isEmpty())
            }
        }
    }

    @Test fun `历史订阅留档排在根域之前仍只恢复根域订阅`() = fixture { db, store, dir ->
        seed(db, store, dir); val file = migration(db, store, dir)
        val reordered = dir.resolve("reordered.zip")
        ZipFile(file.toFile()).use { source -> ZipOutputStream(Files.newOutputStream(reordered)).use { target ->
            source.entries().asSequence().toList().sortedBy { if (it.name.startsWith("kept/")) 0 else 1 }.forEach { entry ->
                target.putNextEntry(ZipEntry(entry.name)); source.getInputStream(entry).use { it.copyTo(target) }; target.closeEntry()
            }
        } }
        fixture { other, otherStore, otherDir ->
            BackupImporter(other, otherStore).import(reordered)
            val exported = otherDir.resolve("all.zip")
            Files.newOutputStream(exported).use { BackupExporter.exportAll(other, it) }
            ZipFile(exported.toFile()).use { zip ->
                assertEquals("[]", zip.getInputStream(zip.getEntry("sourceSub.json")).reader().readText())
            }
            assertEquals(store.read("sourceSub.json"), otherStore.read("sourceSub.json"))
        }
    }

    @Test fun `留档大小写别名拒绝 避免 Windows 覆盖`() = fixture { db, store, dir ->
        seed(db, store, dir); val file = migration(db, store, dir)
        val bad = dir.resolve("case-alias.zip")
        ZipFile(file.toFile()).use { source -> ZipOutputStream(Files.newOutputStream(bad)).use { target ->
            source.entries().asSequence().forEach { entry ->
                val bytes = source.getInputStream(entry).use { it.readBytes() }
                target.putNextEntry(ZipEntry(entry.name)); target.write(bytes); target.closeEntry()
                if (entry.name == "kept/readConfig.json") {
                    target.putNextEntry(ZipEntry("kept/readconfig.json")); target.write(bytes); target.closeEntry()
                }
            }
        } }
        assertThrows(IllegalArgumentException::class.java) { BackupImporter(db, store).preview(bad) }
    }

    @Test fun `证据目录失败回滚全部原生数据 缺目录不静默忽略`() = fixture { db, store, dir ->
        seed(db, store, dir); val file = migration(db, store, dir)
        fixture { other, _, otherDir ->
            val blocked = otherDir.resolve("blocked"); Files.writeString(blocked, "file")
            for (target in listOf(null, BackupStore(blocked))) {
                assertThrows(BackupArchiveException::class.java) { BackupImporter(other, target).import(file) }
                assertTrue(other.listSources(null).isEmpty()); assertTrue(other.listBookshelf().isEmpty())
            }
        }
    }

    @Test fun `被篡改的源证据即使清单哈希一致也拒绝`() = fixture { db, store, dir ->
        seed(db, store, dir)
        val archive = store.list().single { it.name.startsWith("source-variants-") }
        Files.writeString(dir.resolve("kept").resolve(archive.name), "{}")
        assertThrows(Exception::class.java) { migration(db, store, dir) }
    }

    @Test fun `条目实际展开上限拒绝 不进行部分恢复`() = fixture { db, store, dir ->
        seed(db, store, dir); val file = migration(db, store, dir)
        val huge = dir.resolve("huge.zip")
        rewrite(file, huge) { name, bytes ->
            name to if (name == "kept/readConfig.json") ByteArray((BackupImporter.MAX_ENTRY_BYTES + 1).toInt()) { 32 } else bytes
        }
        fixture { other, otherStore, _ ->
            assertThrows(Exception::class.java) { BackupImporter(other, otherStore).import(huge) }
            assertTrue(other.listSources(null).isEmpty()); assertTrue(otherStore.list().isEmpty())
        }
    }

    @Test fun `普通 all 导出仍只有六个原生域`() = fixture { db, store, dir ->
        seed(db, store, dir)
        val file = dir.resolve("all.zip"); Files.newOutputStream(file).use { BackupExporter.exportAll(db, it) }
        ZipFile(file.toFile()).use { zip -> assertEquals(6, zip.size()); assertNull(zip.getEntry(BackupMigration.MANIFEST)) }
    }
}
