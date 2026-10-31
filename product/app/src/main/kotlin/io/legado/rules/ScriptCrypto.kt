package io.legado.rules

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 书源脚本用的对称/摘要加密（上游 `help/crypto/` 那一套的等价实现）。
 *
 * 为什么要照抄上游而不是自己定口径：启用库里有 **44 处** `java.createSymmetricCrypto`、
 * 21 处 `java.HMacHex`、12 处 `java.digestHex`、115 处 `java.base64DecodeToByteArray`
 * —— 这些调用点是社区源**按上游行为写的**（参数顺序、默认 transformation、hex/base64 自动判别、
 * DES 密钥截断），差一个细节就是解出乱码或者干脆报错，而报错在界面上只显示成「正文取不到」。
 *
 * 对齐清单（`SymmetricCryptoAndroid.kt`、`CryptoUtils.kt`、`JsEncodeUtils.kt`）：
 * - `transformation` 里没有 `/` 时补成 `ALG/ECB/PKCS5Padding`；密钥算法取第一段；
 * - DES 密钥超 8 字节截断、DESede 超 24 截断；
 * - ECB 或没给 iv 时不带 iv（给了 iv 也不是 ECB 才用 CBC 参数）；
 * - `decrypt(String)`：偶数长度且全是十六进制字符时按 hex 解，否则按 base64 解；
 * - base64 解码对空白、缺 `=`、url-safe(`-`/`_`) 宽容（上游那句注释说的就是书源实际会这么写）；
 * - hex 一律小写。
 */
internal object ScriptCrypto {

    private const val HEX_CHARS = "0123456789abcdef"

    fun bytesToHex(bytes: ByteArray): String {
        val builder = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            builder.append(HEX_CHARS[v ushr 4]).append(HEX_CHARS[v and 0x0F])
        }
        return builder.toString()
    }

    fun hexToBytes(text: String): ByteArray {
        val clean = text.filterNot { it.isWhitespace() }
        require(clean.length % 2 == 0) { "十六进制长度必须是偶数" }
        return ByteArray(clean.length / 2) { index ->
            clean.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    /** 上游 `base64ToByteArray` 对缺 `=`、url-safe、空白都宽容 —— 书源真是这么传的。 */
    fun base64ToBytes(text: String): ByteArray {
        val clean = text.filterNot { it.isWhitespace() }.replace('\r', ' ').replace('\n', ' ').trim()
        if (clean.isEmpty()) return ByteArray(0)
        val normalized = clean.replace('-', '+').replace('_', '/')
        val padded = normalized.padEnd((normalized.length + 3) / 4 * 4, '=')
        return runCatching { Base64.getDecoder().decode(padded) }
            .recoverCatching { Base64.getUrlDecoder().decode(clean) }
            .getOrElse { ByteArray(0) }
    }

    fun bytesToBase64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun digestHex(data: String, algorithm: String): String =
        bytesToHex(digestBytes(data, algorithm))

    fun digestBase64(data: String, algorithm: String): String =
        bytesToBase64(digestBytes(data, algorithm))

    fun digestBytes(data: String, algorithm: String): ByteArray =
        MessageDigest.getInstance(algorithm).digest(data.toByteArray(Charsets.UTF_8))

    fun hmacHex(data: String, algorithm: String, key: String): String =
        bytesToHex(hmacBytes(data, algorithm, key))

    fun hmacBase64(data: String, algorithm: String, key: String): String =
        bytesToBase64(hmacBytes(data, algorithm, key))

    fun hmacBytes(data: String, algorithm: String, key: String): ByteArray {
        val mac = Mac.getInstance(algorithm)
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), algorithm))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8))
    }

    /**
     * 对称加解密对象（上游 `SymmetricCryptoAndroid`）。
     *
     * `key` / `iv` 允许是字符串（按 UTF-8 取字节）或脚本传来的字节数组 ——
     * 实测有源写 `java.base64DecodeToByteArray(body)` 之后把前 16 字节 `.slice(0,16)` 当 iv 传回来。
     */
    class Symmetric(
        transformation: String,
        key: ByteArray,
        iv: ByteArray? = null,
    ) {
        private val fullTransformation = if (transformation.contains('/')) transformation
        else "$transformation/ECB/PKCS5Padding"
        private val keyAlgorithm = transformation.substringBefore('/')
        private val secretKey = SecretKeySpec(normalizedKey(key, keyAlgorithm), keyAlgorithm)
        private var ivBytes: ByteArray? = iv?.takeIf { it.isNotEmpty() }

        fun setIv(iv: ByteArray?): Symmetric {
            ivBytes = iv?.takeIf { it.isNotEmpty() }?.copyOf()
            return this
        }

        fun encrypt(data: ByteArray): ByteArray = cipher(Cipher.ENCRYPT_MODE).doFinal(data)

        fun encrypt(data: String, charset: String? = null): ByteArray =
            encrypt(data.toByteArray(charset?.let { runCatching { java.nio.charset.Charset.forName(it) }.getOrNull() } ?: Charsets.UTF_8))

        fun encryptBase64(data: String, charset: String? = null): String = bytesToBase64(encrypt(data, charset))

        fun encryptBase64(data: ByteArray): String = bytesToBase64(encrypt(data))

        fun encryptHex(data: String, charset: String? = null): String = bytesToHex(encrypt(data, charset))

        fun encryptHex(data: ByteArray): String = bytesToHex(encrypt(data))

        /** 上游 `encryptStr`：把密文字节直接按 UTF-8 读成字符串（源再自己拼进 URL 的少见写法）。 */
        fun encryptStr(data: String): String = String(encrypt(data), Charsets.UTF_8)

        fun decrypt(data: ByteArray): ByteArray = cipher(Cipher.DECRYPT_MODE).doFinal(data)

        /** 上游 `decrypt(String)`：像十六进制就按 hex，否则按 base64。 */
        fun decrypt(data: String): ByteArray = decrypt(looksLikeHex(data).let { if (it) hexToBytes(data) else base64ToBytes(data) })

        fun decryptStr(data: String): String = String(decrypt(data), Charsets.UTF_8)

        fun decryptStr(data: ByteArray): String = String(decrypt(data), Charsets.UTF_8)

        fun decryptBase64(data: String): ByteArray = decrypt(base64ToBytes(data))

        fun decryptHex(data: String): ByteArray = decrypt(hexToBytes(data))

        private fun cipher(mode: Int): Cipher {
            val cipher = Cipher.getInstance(fullTransformation)
            val currentIv = ivBytes
            if (currentIv == null || fullTransformation.contains("/ECB/", ignoreCase = true)) {
                cipher.init(mode, secretKey)
            } else {
                cipher.init(mode, secretKey, IvParameterSpec(currentIv))
            }
            return cipher
        }

        private companion object {
            /** 上游 `normalizedKey`：DES 只取前 8 字节、DESede 前 24 字节。 */
            fun normalizedKey(key: ByteArray, algorithm: String): ByteArray = when {
                algorithm.equals("DES", true) && key.size > 8 -> key.copyOf(8)
                algorithm.equals("DESede", true) && key.size > 24 -> key.copyOf(24)
                else -> key
            }

            fun looksLikeHex(text: String): Boolean {
                val clean = text.filterNot { it.isWhitespace() }
                return clean.length % 2 == 0 && clean.isNotEmpty() &&
                    clean.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }
            }
        }
    }

    /** 脚本传来的值 → 字节数组（字符串按 UTF-8；JS 数组按元素取，兼容元素是 Number/字符串）。 */
    fun toBytes(value: Any?): ByteArray = when (value) {
        null -> ByteArray(0)
        is ByteArray -> value
        is Number -> byteArrayOf(value.toByte())
        is Iterable<*> -> value.map { (it as? Number)?.toByte() ?: it?.toString()?.toByteOrNull() ?: 0 }.toByteArray()
        is Array<*> -> toBytes(value.asList())
        else -> value.toString().toByteArray(Charsets.UTF_8)
    }

    /** 字节数组 → JS 能用的数字数组（`[0,255]`，脚本会 `.slice()` / `[]` 取）。 */
    fun unsigned(bytes: ByteArray): List<Int> = bytes.map { it.toInt() and 0xFF }
}
