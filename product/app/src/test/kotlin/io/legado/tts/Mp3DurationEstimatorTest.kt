package io.legado.tts

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `Mp3DurationEstimator` 的判据。
 *
 * 它决定朗读条上「已读到第几秒」和跨章连播的进度，估错了用户会看到进度条自己跳。
 * 纯字节解析，不需要真语音流 —— 所以直接喂构造出来的帧头。
 *
 * 帧头都是按 MPEG 规范现算的，不是抄一段真文件：
 * - MPEG1 Layer III / 128kbps / 44100Hz → `FF FB 90 00`，帧长 417，每帧 1152 采样 ≈ 26ms
 * - MPEG2 Layer III / 80kbps / 22050Hz → `FF F3 90 00`，帧长 261，每帧 576 采样 ≈ 26ms
 */
class Mp3DurationEstimatorTest {

    private fun mpeg1Frame(): ByteArray = frame(0xFF, 0xFB, 0x90, 0x00, frameLength = 417)
    private fun mpeg2Frame(): ByteArray = frame(0xFF, 0xF3, 0x90, 0x00, frameLength = 261)

    /** 一帧 = 4 字节头 + 剩余填充，整帧长度必须是 417/261，否则解析器会把它当不完整帧留在 pending。 */
    private fun frame(b0: Int, b1: Int, b2: Int, b3: Int, frameLength: Int): ByteArray {
        val bytes = ByteArray(frameLength)
        bytes[0] = b0.toByte()
        bytes[1] = b1.toByte()
        bytes[2] = b2.toByte()
        bytes[3] = b3.toByte()
        return bytes
    }

    @Test
    fun `一帧 MPEG1 记 26 毫秒`() {
        val estimator = Mp3DurationEstimator()
        estimator.add(mpeg1Frame())
        assertEquals(26L, estimator.durationMs())
    }

    @Test
    fun `两帧累计`() {
        val estimator = Mp3DurationEstimator()
        estimator.add(mpeg1Frame() + mpeg1Frame())
        assertEquals(52L, estimator.durationMs())
    }

    @Test
    fun `一帧被拆成两片投喂，拼起来只算一次`() {
        val estimator = Mp3DurationEstimator()
        val frame = mpeg1Frame()

        estimator.add(frame.copyOfRange(0, 200))
        assertEquals("半帧不该计时", 0L, estimator.durationMs())

        estimator.add(frame.copyOfRange(200, frame.size))
        assertEquals("补齐后正好一帧", 26L, estimator.durationMs())
    }

    @Test
    fun `ID3v2 头整个跳过，不把标签当帧`() {
        val estimator = Mp3DurationEstimator()
        // ID3v2.3：'I''D''3' + 版本 2 字节 + 标志 1 字节 + synchsafe 长度 4 字节，然后 10 字节内容
        val tag = byteArrayOf(
            'I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(),
            0x03, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x0A,
        ) + ByteArray(10)

        estimator.add(tag + mpeg1Frame())
        assertEquals("标签不该被算成时长", 26L, estimator.durationMs())
    }

    @Test
    fun `帧前的垃圾字节被逐字节跳过，不影响后面的帧`() {
        val estimator = Mp3DurationEstimator()
        estimator.add(ByteArray(17) { 0x00 } + mpeg1Frame())
        assertEquals(26L, estimator.durationMs())
    }

    @Test
    fun `空分片直接忽略`() {
        val estimator = Mp3DurationEstimator()
        estimator.add(ByteArray(0))
        assertEquals(0L, estimator.durationMs())
    }

    @Test
    fun `MPEG2 帧每帧 576 采样，同样是 26 毫秒`() {
        val estimator = Mp3DurationEstimator()
        estimator.add(mpeg2Frame())
        assertEquals("576 * 1000 / 22050 = 26", 26L, estimator.durationMs())
    }

    @Test
    fun `非法帧头不会被当成帧，也不会抛`() {
        val estimator = Mp3DurationEstimator()
        // 0xFF 但第二位不是 111xxxxx：不是帧同步字
        val notASync = ByteArray(417) { 0x00 }
        notASync[0] = 0xFF.toByte()
        notASync[1] = 0x00

        estimator.add(notASync + mpeg1Frame())
        assertEquals("只有后面那帧算数", 26L, estimator.durationMs())
    }

    @Test
    fun `帧长声明超出已收字节时先不计，等补齐`() {
        val estimator = Mp3DurationEstimator()
        val frame = mpeg1Frame()
        estimator.add(frame.copyOfRange(0, 100))
        assertEquals(0L, estimator.durationMs())
        estimator.add(frame.copyOfRange(100, frame.size))
        assertEquals(26L, estimator.durationMs())
    }
}
