package io.legado.backup

import io.legado.data.Database
import io.legado.data.forEachSourcePayload
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * 备份导出 —— 先落地**第一域：书源**。
 *
 * 只导"导入侧能原样恢复"的域（见 `docs/research/研究-备份导出设计-2026-11-16.md`）：
 * 包内文件名沿用上游 `help/storage/Backup.kt` 的写法（`bookSource.json`），
 * 内容是一整个 JSON 数组，每条就是库里的 `source.payload` 原文 ——
 * `BackupImporter` 认这个名字、也认这种形状，所以导出的包能直接喂回导入。
 *
 * 两个刻意的做法：
 * 1. **流式写**：5,600 条约 30–40 MB，不能先拼成一个大字符串（峰值会翻两三倍）。
 *    按游标逐条追加到 64 KB 缓冲，满了就写进 zip。
 * 2. **不 close 调用方的流**：`ZipOutputStream.finish()` 写完中央目录就够；
 *    关闭由调用方负责（HTTP 那条路由的 `respondOutputStream` 会自己关）。
 *    在库函数里 close 别人的流，测试里看不出问题、真机上会把连接提前掐断。
 *
 * 其余四域（替换规则 / 书架+进度 / 分组 / RSS）按设计文档的字段映射逐个补，
 * 每个域都要先有往返判据再上线。
 */
internal object BackupExporter {

    /** 上游与 `BackupImporter` 都认的条目名。 */
    const val SOURCES_ENTRY = "bookSource.json"

    /** 攒到这么大就落一次盘；太小会让小库也写很多次，太大会让峰值内存变难看。 */
    private const val FLUSH_CHARS = 64 * 1024

    fun exportSources(database: Database, out: OutputStream) {
        val zip = ZipOutputStream(out)
        zip.putNextEntry(ZipEntry(SOURCES_ENTRY))
        val buffer = StringBuilder(FLUSH_CHARS + 1024)
        buffer.append('[')
        var first = true
        database.forEachSourcePayload { payload ->
            if (!first) buffer.append(',')
            buffer.append(payload)
            first = false
            if (buffer.length >= FLUSH_CHARS) {
                zip.write(buffer.toString().toByteArray(Charsets.UTF_8))
                buffer.setLength(0)
            }
        }
        buffer.append(']')
        zip.write(buffer.toString().toByteArray(Charsets.UTF_8))
        zip.closeEntry()
        zip.finish()
        zip.flush()
    }
}
