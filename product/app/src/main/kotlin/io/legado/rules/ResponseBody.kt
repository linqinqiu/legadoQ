package io.legado.rules

import io.legado.decodeStrict
import io.legado.decodeTextAuto
import io.legado.detectCharset
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.charset.Charset
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream

/**
 * 响应体解码：gzip/deflate 解压 + 字符集判定 + 有上限读取。
 *
 * 纯字节逻辑，不碰网络与 JS —— 从 `RuleRunner` 的 HTTP 段里单独切出来（见
 * `docs/research/研究-阅读器拆分续-下一步.md` 之外的后端拆分计划）。抽走后 `RuleRunner`
 * 只留一行 `resolveBodyCharset` 委托，`ResponseCharsetTest` 照旧直接调它。
 */
internal object ResponseBody {
    const val MAX_BODY_BYTES = 2 * 1024 * 1024

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
    fun resolveBodyCharset(bytes: ByteArray, declared: Charset?, contentType: String?): Charset =
        detectCharset(bytes, declared, contentType)

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
            // 超限是「上游给的东西太大」，不是「调用参数非法」：抛 `IllegalArgumentException`
            // 会被 HTTP 层按 400 invalid_request 报给用户，让人去改自己的书源。
            if (output.size() + count > MAX_BODY_BYTES) throw RuleExecutionException("上游响应超过 2 MiB 限制")
            output.write(buffer, 0, count)
        }
    }
}
