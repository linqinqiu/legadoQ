package io.legado

import io.legado.backup.BackupStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * `BackupStore` —— 备份包里"没有原生归宿"的条目原样收在磁盘上。
 *
 * 这段原来 20/53 行覆盖。它是**纯文件读写**，最容易测，而它处理的输入
 * （备份包里的文件名）是**不可信数据** —— 所以路径安全是这里最该钉的东西：
 *
 * - `keep()` / `read()` 都做 `substringAfterLast('/')` 剥掉目录部分；
 * - 再用 `[^A-Za-z0-9._-]` 把非法字符换成 `_`；
 * - 且只接受白名单里的名字。
 *
 * 三道加起来才挡住 `../../etc/passwd` 这类路径穿越。任何一道被"顺手简化"掉，
 * 都会变成"导入一个恶意备份包就能往数据目录外写文件"。
 */
class BackupStoreTest {

    private lateinit var dir: Path

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("backup-store-test")
    }

    @After
    fun tearDown() {
        runCatching {
            Files.walk(dir).use { s -> s.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } }
        }
    }

    // ===== 路径安全（最重要） =====

    @Test
    fun `带目录的文件名只取最后一段，不会写到目录外`() {
        val store = BackupStore(dir)
        // 典型路径穿越尝试
        assertTrue("带路径的白名单文件应能收下（只取最后一段）", store.keep("../../etc/readRecord.json", "[]"))
        // 落点必须在 dir 内
        assertTrue("文件应落在目标目录里", Files.exists(dir.resolve("readRecord.json")))
        assertFalse("不该在上级目录生成任何东西", Files.exists(dir.parent.resolve("etc")))
    }

    @Test
    fun `文件名里的非法字符被换成下划线`() {
        val store = BackupStore(dir)
        // 白名单按「替换后」比对，所以替换后能命中才收
        assertFalse("替换后不是白名单名字的应被拒", store.keep("read Record.json", "[]"))
        // 能命中白名单的（大小写不敏感）
        assertTrue("readrecord.json 大小写不敏感应命中", store.keep("readRecord.json", "[]"))
    }

    @Test
    fun `不在白名单里的名字一律拒绝，不落盘`() {
        val store = BackupStore(dir)
        for (name in listOf("evil.sh", "passwd", "config.xml", "arbitrary.json", "../outside.json")) {
            assertFalse("「$name」不该被收下", store.keep(name, "x"))
        }
        // 目录里不该有任何文件
        val files = if (Files.isDirectory(dir)) Files.list(dir).use { it.count() } else 0L
        assertEquals("被拒的条目不该落盘", 0L, files)
    }

    @Test
    fun `read 不会读到目录外的文件`() {
        val store = BackupStore(dir)
        // 先在目录外放一个文件，再尝试用穿越路径读它
        val outside = dir.parent.resolve("secret-${System.nanoTime()}.json")
        Files.writeString(outside, "SECRET")
        try {
            val got = store.read("../" + outside.fileName)
            assertNull("不该读到目录外的文件，实际读到：$got", got)
        } finally {
            Files.deleteIfExists(outside)
        }
    }

    // ===== 正常读写 =====

    @Test
    fun `收下后能原样读回（UTF-8，不丢中文）`() {
        val store = BackupStore(dir)
        val text = """[{"name":"阅读样式","value":"宋体"}]"""
        assertTrue(store.keep("readConfig.json", text))
        assertEquals("读回内容应与写入完全一致", text, store.read("readConfig.json"))
    }

    @Test
    fun `重复收同一个名字会覆盖，不产生第二份`() {
        val store = BackupStore(dir)
        store.keep("readConfig.json", "第一次")
        store.keep("readConfig.json", "第二次")
        assertEquals("第二次", store.read("readConfig.json"))
        val count = Files.list(dir).use { s -> s.filter { Files.isRegularFile(it) }.count() }
        assertEquals("只该有一个文件（临时文件要被原子替换掉）", 1L, count)
    }

    @Test
    fun `读不存在的条目返回 null，不抛`() {
        assertNull(BackupStore(dir).read("readConfig.json"))
    }

    // ===== list =====

    @Test
    fun `list 列出已收下的条目，带字节数与条数`() {
        val store = BackupStore(dir)
        store.keep("readConfig.json", """[{"a":1},{"b":2}]""")
        store.keep("dictRule.json", """[{"x":1}]""")
        val entries = store.list()
        assertEquals("应收下 2 条", 2, entries.size)
        // 按名字小写排序：dictRule 在前
        assertEquals("dictrule.json", entries[0].name.lowercase())
        assertEquals("readconfig.json", entries[1].name.lowercase())
        assertEquals("条数应数出顶层元素", 2, entries.first { it.name.equals("readConfig.json", true) }.items)
        assertTrue("字节数应大于 0", entries.all { it.bytes > 0 })
    }

    @Test
    fun `list 跳过隐藏文件（临时文件残留不会显示成条目）`() {
        val store = BackupStore(dir)
        store.keep("readConfig.json", "[]")
        Files.writeString(dir.resolve(".keep-leftover.tmp"), "x")
        val names = store.list().map { it.name }
        assertEquals("只应列出 1 条，隐藏文件被跳过", 1, names.size)
        assertEquals("readConfig.json", names.first())
    }

    @Test
    fun `list 在目录不存在时返回空表，不抛`() {
        assertTrue(BackupStore(dir.resolve("not-exist")).list().isEmpty())
    }

    @Test
    fun `list 标出哪些能套用`() {
        val store = BackupStore(dir)
        store.keep("readConfig.json", "[]")   // 可套用
        store.keep("dictRule.json", "[]")     // 不可套用
        val byName = store.list().associateBy { it.name.lowercase() }
        assertTrue("readConfig 应标为可套用", byName["readconfig.json"]!!.appliable)
        assertFalse("dictRule 不该标为可套用", byName["dictrule.json"]!!.appliable)
    }

    @Test
    fun `list 给出中文标签，认不出的名字回落原名`() {
        val store = BackupStore(dir)
        store.keep("readConfig.json", "[]")
        assertEquals("阅读样式", store.list().first().label)
        // 静态方法也要能用
        assertEquals("字典规则", BackupStore.labelOf("dictRule.json"))
        assertEquals("路径前缀应被剥掉", "字典规则", BackupStore.labelOf("a/b/dictRule.json"))
        assertEquals("认不出的回落原名", "unknown.json", BackupStore.labelOf("unknown.json"))
    }

    @Test
    fun `内容不是 JSON 数组时条数为 0，但条目仍列出`() {
        val store = BackupStore(dir)
        store.keep("readConfig.json", "not json at all")
        val entry = store.list().first()
        assertEquals("数不出条数应为 0", 0, entry.items)
        assertTrue("字节数仍是真实大小", entry.bytes > 0)
    }

    // ===== 白名单本身的一致性 =====

    @Test
    fun `白名单里不该有仅大小写不同的重复项`() {
        val names = BackupStore.KEEP_NAMES.map { it.lowercase() }
        val dups = names.groupBy { it }.filter { it.value.size > 1 }.keys
        // 实测发现过：httpTTS.json 与 httptts.json 同时存在，是同一个文件名的两种写法
        assertTrue("白名单里有仅大小写不同的重复项：$dups", dups.isEmpty())
    }

    @Test
    fun `可套用名单必须是白名单的子集`() {
        val keep = BackupStore.KEEP_NAMES.map { it.lowercase() }.toSet()
        val appliable = BackupStore.APPLYABLE_NAMES.map { it.lowercase() }
        for (name in appliable) {
            assertTrue("「$name」标了可套用却不在白名单里 —— 界面上会出现套用不了的按钮", name in keep)
        }
    }

    @Test
    fun `isAppliable 大小写不敏感且剥路径`() {
        assertTrue(BackupStore.isAppliable("readConfig.json"))
        assertTrue(BackupStore.isAppliable("READCONFIG.JSON"))
        assertTrue(BackupStore.isAppliable("a/b/readConfig.json"))
        assertFalse(BackupStore.isAppliable("dictRule.json"))
    }
}
