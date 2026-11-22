package io.legado.tts

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Edge TTS 的 `Sec-MS-GEC` v2 令牌。
 *
 * 2026-11 起，`speech.platform.bing.com` 只认 v2：
 * - `Sec-MS-GEC` = `<16 位 CS64>-<64 位 SHA256>`；
 * - `Sec-MS-GEC-Version` = `2-<Chromium 完整版本>`。
 * 旧版单段 SHA256 + `1-` 前缀会直接得到 `403 Invalid Request`（2026-11-22 实测）。
 *
 * 这里逐行移植 `edge-tts` 的 `drm.py`（MIT），包括它那套**改过初始状态与常量**的
 * SHA-256 和 CS64 混合运算。不要换成 JDK 的 `MessageDigest("SHA-256")`：算法不是标准
 * SHA-256，标准实现算出来的值服务端不认。
 *
 * 时间口径也要照抄：`edge-tts` 用浮点秒计算 Windows file time，结果超过 2^53 后
 * 会按 double 的精度舍入，再用 `%.0f` 取整；用 Long 精确乘会得到不同的末位数字。
 */
internal object EdgeTtsToken {

    const val TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"

    private const val WIN_EPOCH = 11_644_473_600.0
    private const val MASK = 0xFFFFFFFFL

    private val SHA256_INITIAL = longArrayOf(
        0x6A09E667L, 0xBB67AE85L, 0x3C6EF372L, 0xA54FF53AL,
        0x510E527FL, 0x9B05688CL, 0x1F83D9ABL, 0x5BE0CD19L,
    )

    private val SHA256_STATE = longArrayOf(
        0xFD9FBEA2L, 0x91243CE7L, 0xBE499094L, 0xCD2E1E0AL,
        0x6C006F49L, 0x04BD35ABL, 0xFEB0A7E4L, 0x03EFFBD2L,
    )

    private val SHA256_SCHEDULE = longArrayOf(
        0xEB24BF9EL, 0x1558691FL, 0xA0C09EE2L, 0x0CFA32BAL, 0xA622EE8CL,
        0xD1DD9491L, 0xC0DD25A0L, 0xF9E70AB6L, 0xF0C31573L, 0x7058CE4EL,
        0x7188E606L, 0x00E5AB33L, 0xD258B060L, 0x72766564L,
    )

    private val SHA256_ROUND_CONSTANTS = longArrayOf(
        0x428A2F98L, 0x71374491L, 0xB5C0FBCFL, 0xE9B5DBA5L, 0x3956C25BL,
        0x59F111F1L, 0x923F82A4L, 0xAB1C5ED5L, 0xD807AA98L, 0x12835B01L,
        0x243185BEL, 0x550C7DC3L, 0x72BE5D74L, 0x80DEB1FEL, 0x9BDC06A7L,
        0xC19BF174L, 0xE49B69C1L, 0xEFBE4786L, 0x0FC19DC6L, 0x240CA1CCL,
        0x2DE92C6FL, 0x4A7484AAL, 0x5CB0A9DCL, 0x76F988DAL, 0x983E5152L,
        0xA831C66DL, 0xB00327C8L, 0xBF597FC7L, 0xC6E00BF3L, 0xD5A79147L,
        0x06CA6351L, 0x14292967L, 0x27B70A85L, 0x2E1B2138L, 0x4D2C6DFCL,
        0x53380D13L, 0x650A7354L, 0x766A0ABBL, 0x81C2C92EL, 0x92722C85L,
        0xA2BFE8A1L, 0xA81A664BL, 0xC24B8B70L, 0xC76C51A3L, 0xD192E819L,
        0xD6990624L, 0xF40E3585L, 0x106AA070L, 0x19A4C116L, 0x1E376C08L,
        0x2748774CL, 0x34B0BCB5L, 0x391C0CB3L, 0x4ED8AA4AL, 0x5B9CCA4FL,
        0x682E6FF3L, 0x748F82EEL, 0x78A5636FL, 0x84C87814L, 0x8CC70208L,
        0x90BEFFFAL, 0xA4506CEBL, 0xBEF9A3F7L, 0xC67178F2L,
    )

    private const val SHA256_ADJUSTMENT = 0xC9DC06A7L
    private val SHA256_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.copyOf().also {
        it[14] = SHA256_ADJUSTMENT
    }
    private const val SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80L
    private const val SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0L

    private val CS64_COEFFICIENTS = longArrayOf(
        0xE82E91B1L, 0xB32700D0L,
        0x44DE24C6L, 0x88DFF51DL,
        0x3BEB65BCL, 0x29514038L,
        0xC89C5933L, 0xB328CBDFL,
        0x8D1EC211L, 0xD405B4D5L,
        0x314EF5D5L, 0x26E55F3CL,
        0xE92491B1L, 0x607801C6L,
        0xF0A5B9D5L, 0x82B2C1FBL,
        0x06064CF3L, 0xFA51A3DAL,
        0xDA79FA60L, 0x207CC464L,
        0xBED20560L, 0x3C3C74F3L,
        0x89F9C9F8L, 0xD2D14B61L,
        0x35FA38C6L, 0xBB04A2C1L,
        0xCB49E3C6L, 0xC5626167L,
    )

    private const val CS64_FACTOR = 0x82893933L
    private const val CS64_ADJUSTMENT0 = 0xF2F90B1AL
    private const val CS64_ADJUSTMENT1 = 0x0B1A0000L

    /** 与 `edge-tts` 的 `generate_sec_ms_gec()` 等价；[unixTimestamp] 仅测试用。 */
    fun generateSecMsGec(unixTimestamp: Double = System.currentTimeMillis() / 1000.0): String {
        var ticks = unixTimestamp + WIN_EPOCH
        ticks -= ticks % 300.0
        // 这里必须用 Double：乘积超过 2^53，Long 精确乘会得到不同的末位数字。
        ticks *= 10_000_000.0
        val fileTimeTicks = ticks.toLong()
        val data = "$fileTimeTicks$TRUSTED_CLIENT_TOKEN".toByteArray(StandardCharsets.US_ASCII)
        val (cs64, sha256) = tokenHash(data)
        return "$cs64-$sha256"
    }

    private fun tokenHash(data: ByteArray): Pair<String, String> {
        val digest = sha256Digest(data)
        val (swapLast, swapAcc) = cs64Digest(data, digest)
        val cs64 = buildString {
            append(littleEndianHex(swapLast))
            append(littleEndianHex(swapAcc))
        }
        val sha256 = digest.joinToString("") { "%02X".format(it) }
        return cs64 to sha256
    }

    private fun littleEndianHex(value: Long): String {
        val v = value and MASK
        return "%02X%02X%02X%02X".format(
            v and 0xFF, (v ushr 8) and 0xFF, (v ushr 16) and 0xFF, (v ushr 24) and 0xFF,
        )
    }

    // ---------------------------------------------------------------- 改版 SHA-256

    private fun rotr(value: Long, bits: Int): Long =
        ((value ushr bits) or (value shl (32 - bits))) and MASK

    private fun rol16(value: Long): Long =
        ((value shl 16) or (value ushr 16)) and MASK

    private fun sigma0(value: Long): Long =
        ((value ushr 7) xor (value shl 25) xor (value ushr 18) xor (value shl 14) xor (value ushr 3)) and MASK

    private fun sigma1(value: Long): Long =
        ((value ushr 17) xor (value shl 15) xor (value ushr 19) xor (value shl 13) xor (value ushr 10)) and MASK

    private fun sha256Rounds(state: LongArray, words: LongArray, firstRound: Int = 0): LongArray {
        var a = state[0]
        var b = state[1]
        var c = state[2]
        var d = state[3]
        var e = state[4]
        var f = state[5]
        var g = state[6]
        var h = state[7]
        val constants = if (firstRound == 14) SHA256_BLOCK_CONSTANTS else SHA256_ROUND_CONSTANTS
        for (index in firstRound until 64) {
            val s1 = rotr(e, 6) xor rotr(e, 11) xor rotr(e, 25)
            val ch = (e and f) xor (e.inv() and g)
            val temp1 = (h + s1 + ch + constants[index] + words[index]) and MASK
            val s0 = rotr(a, 2) xor rotr(a, 13) xor rotr(a, 22)
            val maj = (a and b) xor (a and c) xor (b and c)
            val temp2 = (s0 + maj) and MASK
            h = g
            g = f
            f = e
            e = (d + temp1) and MASK
            d = c
            c = b
            b = a
            a = (temp1 + temp2) and MASK
        }
        return longArrayOf(a, b, c, d, e, f, g, h)
    }

    private fun expandSchedule(words: LongArray, firstWord: Int) {
        for (index in firstWord until 64) {
            val x = words[index - 2]
            val y = words[index - 15]
            val s1 = (x ushr 17) xor (x shl 15) xor (x ushr 19) xor (x shl 13) xor (x ushr 10)
            val s0 = (y ushr 7) xor (y shl 25) xor (y ushr 18) xor (y shl 14) xor (y ushr 3)
            words[index] = (s1 + words[index - 7] + s0 + words[index - 16]) and MASK
        }
    }

    private fun sha256Init(data: ByteArray): LongArray {
        val words = LongArray(64)
        words[14] = intFromBytesBigEndian(data, 0, 3)
        words[15] = intFromBytesBigEndian(data, 3, 7)
        for (index in 16..29) {
            var value = SHA256_SCHEDULE[index - 16]
            if (index - 2 >= 14) {
                value += if (index == 16) {
                    sigma1(words[index - 2]) xor SHA256_SIGMA1_ADJUSTMENT
                } else {
                    sigma1(words[index - 2])
                }
            }
            if (index - 7 >= 14) value += words[index - 7]
            if (index - 15 >= 14) {
                value += if (index == 29) {
                    sigma0(words[index - 15]) xor SHA256_SIGMA0_ADJUSTMENT
                } else {
                    sigma0(words[index - 15])
                }
            }
            words[index] = value and MASK
        }
        words[30] = (
            sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] +
                SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]
            ) and MASK
        expandSchedule(words, 31)
        val working = sha256Rounds(SHA256_STATE, words, 14)
        return LongArray(8) { (SHA256_INITIAL[it] + working[it]) and MASK }
    }

    private fun sha256Digest(data: ByteArray): ByteArray {
        require(data.size >= 7) { "Token salt must contain at least seven bytes" }
        val length = 57 + data.size
        val padded = ByteArrayOutputStream()
        padded.write(data, 7, data.size - 7)
        padded.write(0x80)
        val zeros = ((55 - length) % 64 + 64) % 64
        repeat(zeros) { padded.write(0) }
        val bitLength = length.toLong() * 8
        for (shift in 56 downTo 0 step 8) {
            padded.write(((bitLength ushr shift) and 0xFF).toInt())
        }
        val bytes = padded.toByteArray()
        var state = sha256Init(data)
        var offset = 0
        while (offset < bytes.size) {
            val words = LongArray(64)
            for (i in 0 until 16) {
                words[i] = intFromBytesBigEndian(bytes, offset + i * 4, offset + i * 4 + 4)
            }
            expandSchedule(words, 16)
            val working = sha256Rounds(state, words)
            state = LongArray(8) { (state[it] + working[it]) and MASK }
            offset += 64
        }
        val out = ByteArray(32)
        for (i in 0 until 8) {
            val value = state[i]
            out[i * 4] = ((value ushr 24) and 0xFF).toByte()
            out[i * 4 + 1] = ((value ushr 16) and 0xFF).toByte()
            out[i * 4 + 2] = ((value ushr 8) and 0xFF).toByte()
            out[i * 4 + 3] = (value and 0xFF).toByte()
        }
        return out
    }

    // ---------------------------------------------------------------- CS64

    private fun wordsLe4Even(data: ByteArray): LongArray {
        val paddedSize = (data.size + 3) / 4 * 4
        val padded = data.copyOf(paddedSize)
        var count = paddedSize / 4
        if (count % 2 != 0) count += 1
        val words = LongArray(count)
        for (i in 0 until paddedSize / 4) {
            words[i] = intFromBytesLittleEndian(padded, i * 4)
        }
        return words
    }

    private fun cs64Digest(data: ByteArray, digest: ByteArray): Pair<Long, Long> {
        var keyA = intFromBytesLittleEndian(digest, 0) or 1L
        var keyB = intFromBytesLittleEndian(digest, 4) or 1L
        keyA = keyA and MASK
        keyB = keyB and MASK
        val factors = longArrayOf((keyA * CS64_FACTOR) and MASK, (keyB * CS64_FACTOR) and MASK)

        val terms = ArrayList<Long>(64)
        val offsets = ArrayList<Long>(64)
        for (index in CS64_COEFFICIENTS.indices step 2) {
            val coefficientIndex = index / 2
            terms.add((CS64_COEFFICIENTS[index] * factors[coefficientIndex % 2]) and MASK)
            offsets.add(CS64_COEFFICIENTS[index + 1])
        }

        val withPrefix = ByteArray(data.size + 1)
        System.arraycopy(data, 0, withPrefix, 1, data.size)
        val words = wordsLe4Even(withPrefix)
        for ((index, word) in words.withIndex()) {
            var term = word * (if (index % 2 == 0) keyA else keyB)
            var offset = rol16(word) * (if (index % 2 == 0) 0xEF0569FBL else 0xC31713DBL)
            if (index == 0) {
                term += CS64_ADJUSTMENT0 * factors[0]
                offset += CS64_ADJUSTMENT1
            }
            terms.add(term and MASK)
            offsets.add(offset and MASK)
        }

        var swapAcc = 0L
        var swapLast = 0L
        var state = 0L
        var acc = 0L
        var index = 0
        while (index < terms.size) {
            val x = terms[index]
            val y = terms[index + 1]

            var t = rol16((offsets[index] + x) and MASK)
            var q = (t * 0x76F50F34L) and MASK
            swapAcc = (swapAcc + (rol16(q) * 0xC3EFEA97L + q) and MASK) and MASK

            t = rol16((offsets[index + 1] + y) and MASK)
            q = (t * 0x1881CE3CL) and MASK
            swapLast = (rol16(q) * 0x35BD1EC9L + q) and MASK
            swapAcc = (swapAcc + swapLast) and MASK

            state = (state * keyA + x) and MASK
            state = (rol16(state) * 0xCF98B111L) and MASK
            state = (rol16(state) * 0x87085B9FL) and MASK
            state = (rol16(state) * 0x12CEB96DL) and MASK
            state = (rol16(state) * 0x257E1D83L) and MASK
            acc = (acc + state) and MASK

            t = (state * keyB + y) and MASK
            t = (rol16(t) * 0xA27416F5L) and MASK
            t = (rol16(t) * 0xD38396FFL) and MASK
            state = (rol16((rol16(t) * 0x7C932B89L) and MASK) * 0xBFA49F69L) and MASK
            acc = (acc + state) and MASK

            index += 2
        }
        return (swapLast xor state) to (swapAcc xor acc)
    }

    // ---------------------------------------------------------------- 字节工具

    private fun intFromBytesBigEndian(data: ByteArray, from: Int, to: Int): Long {
        var value = 0L
        for (i in from until to) value = (value shl 8) or (data[i].toLong() and 0xFF)
        return value and MASK
    }

    private fun intFromBytesLittleEndian(data: ByteArray, offset: Int): Long {
        var value = 0L
        for (i in 0 until 4) {
            if (offset + i >= data.size) break
            value = value or ((data[offset + i].toLong() and 0xFF) shl (8 * i))
        }
        return value and MASK
    }
}
