package io.legado

import io.legado.tts.EdgeTtsToken
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * v2 令牌的逐字节对账（阶段 3.5）。
 *
 * 期望值由参考实现 `edge-tts` 的 `generate_sec_ms_gec_v2(timestamp)` 生成
 * （2026-11-22，edge-tts 7.x）。算法不是标准 SHA-256，固定样本是唯一能防
 * "看起来像哈希但服务端不认"的判据。
 */
class EdgeTtsTokenTest {

    @Test
    fun `固定时间戳与参考实现逐字节一致`() {
        assertEquals(
            "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
            EdgeTtsToken.generateSecMsGec(0.0),
        )
        assertEquals(
            "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
            EdgeTtsToken.generateSecMsGec(1_700_000_000.0),
        )
        assertEquals(
            "0D2CD3B6AAA5E541-BCE6E175551E0811773CF301887D1A6B4066CF246A6D4086BDFD0A62D5C9795B",
            EdgeTtsToken.generateSecMsGec(1_795_336_622.0),
        )
    }

    @Test
    fun `格式是 16 位 CS64 加 64 位 SHA256`() {
        val token = EdgeTtsToken.generateSecMsGec(1_795_336_800.0)
        assert(token.matches(Regex("^[0-9A-F]{16}-[0-9A-F]{64}$"))) { "令牌格式不对：$token" }
    }
}
