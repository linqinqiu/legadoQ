package io.legado.rules

import io.legado.charsetOf
import io.legado.decodeStrict
import io.legado.decodeTextAuto
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.charset.Charset
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream

/**
 * 响应体解码：gzip/deflate 解压 + 字符集判定 + 有上限读取。
 *
 * 纯字节逻辑，不碰网络与 JS —— 从 `RuleRunner` 的 HTTP 段里单独切出来（见
 * `product/docs/研究-阅读器拆分续-下一步.md` 之外的后端拆分计划）。抽走后 `RuleRunner`
 * 只留一行 `resolveBodyCharset` 委托，`ResponseCharsetTest` 照旧直接调它。
 */
internal object ResponseBody {
    const val MAX_BODY_BYTES = 2 * 1024 * 1024

    /**
     * 页面自报的字符集：`<meta charset="gbk">` 与
     * `<meta http-equiv="Content-Type" content="text/html; charset=gb2312">` 都算
     * （上游 `BookSource.getCharset` 用的就是这一类正则）。
     * 限定在 `<meta` 开头的那个标签里，名字必须以字母起手，避免正文里的裸 "charset" 字样误判。
     */
    private val META_CHARSET = Regex("""(?i)<meta[^>]{0,300}?charset\s*=\s*["']?([a-z][\w-]{1,20})""")

    /**
     * 响应头声明的编码（gzip/deflate）解压后，按 [resolveBodyCharset] 判定的字符集解码。
     *
     * 解压后**再判一次字符集**：压缩只影响字节容器，不影响内容编码；但站点把 GBK 内容标成
     * `charset=iso-8859-1` 时严格解码不报错、只会整页乱码，所以失败后交给 `decodeTextAuto` 自动识别。
     */
    fun decodeBody(
        bytes: ByteArray,
        contentEncoding: String,
        declared: Charset?,
        contentType: String?,
    ): String {
        val encoding = contentEncoding.lowercase()
        val decoded = when {
            encoding.contains("gzip") -> GZIPInputStream(bytes.inputStream()).use(::readAll)
            encoding.contains("deflate") -> InflaterInputStream(bytes.inputStream()).use(::readAll)
            else -> bytes
        }
        val charset = resolveBodyCharset(decoded, declared, contentType)
        return runCatching { decodeStrict(decoded, charset) }
            .getOrElse { decodeTextAuto(decoded, charset) }
    }

    /**
     * 字符集判定（拆出来是为了能逐条钉用例；口径对齐上游 `BookSource.getCharset`）：
     *
     * 1. 源在这次请求里声明的 `charset` —— 书源作者最清楚这家站是什么编码；
     * 2. 页面自己写的 `<meta charset>` / `<meta http-equiv="Content-Type" content="…;charset=">`；
     * 3. 响应头 `Content-Type: …; charset=`；
     * 4. UTF-8。
     *
     * **响应头排在页面自报之后**：中文老站的服务器默认值（`charset=iso-8859-1`、干脆不给 charset）
     * 比页面里的 meta 更常出错，而 meta 是这份内容自己声明的。上游更极端 ——
     * `getCharset` 里响应头那一支实际只在值是 `"utf-8,utf-8"` 这种垃圾串时才命中，
     * 等于靠 meta 判定，我们保留读头的权利，但让它给 meta 让路。
     */
    fun resolveBodyCharset(bytes: ByteArray, declared: Charset?, contentType: String?): Charset {
        declared?.let { return it }
        metaCharset(bytes)?.let { return it }
        charsetOf(contentType)?.let { return it }
        return Charsets.UTF_8
    }

    /**
     * 从页面头部嗅 `<meta>` 声明的字符集（只看前 4 KB，声明都在 `<head>` 前面）。
     * 先按 ISO-8859-1 读：那一层是单字节保真的，ASCII 标签怎么都读得出来，
     * 真正的编码要等这里拿到声明之后才用得上。
     */
    private fun metaCharset(bytes: ByteArray): Charset? {
        if (bytes.isEmpty()) return null
        // 只对**标记文档**做嗅探：JSON 接口里常带 HTML 片段（`"html": "<meta charset=gbk>…"`），
        // 那是一段数据而不是这份响应的编码声明 —— 误判会把整份接口按错的字符集解，
        // 且解得动（不报错），只在界面上留下满屏乱码。
        val first = bytes.firstOrNull { it.toInt() > 0x20 } ?: return null
        if (first != '<'.code.toByte()) return null
        val head = String(bytes, 0, minOf(bytes.size, 4096), Charsets.ISO_8859_1)
        val name = META_CHARSET.find(head)?.groupValues?.getOrNull(1) ?: return null
        return runCatching { Charset.forName(name.trim().trim('"', '\'')) }.getOrNull()
    }

    fun readAll(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) return output.toByteArray()
            output.write(buffer, 0, count)
            // 2 MiB 上限原本只卡在压缩字节上：一个 gzip 炸弹就能在解压时无限膨胀直接把进程顶爆。
            if (output.size() > MAX_BODY_BYTES) throw RuleExecutionException("响应解压后超过 2 MiB 限制")
        }
    }

    fun readLimited(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) return output.toByteArray()
            require(output.size() + count <= MAX_BODY_BYTES) { "上游响应超过 2 MiB 限制" }
            output.write(buffer, 0, count)
        }
    }
}
