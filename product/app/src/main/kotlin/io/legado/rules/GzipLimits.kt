package io.legado.rules

import java.io.ByteArrayOutputStream
import java.util.zip.GZIPInputStream

/**
 * 限量解压（防「压缩炸弹」）。
 *
 * ## 为什么不能直接用 `GZIPInputStream(...).readBytes()`
 *
 * `readBytes()` 没有上限，而一个几百字节的 GZIP 能解出几十 GB。解压是**宿主侧的内存分配**，
 * 一条 Rhino 指令都不产生 —— [JsGuard] 的 `observeInstructionCount` 永远等不到回调，
 * 墙钟守卫全程失明。结果是直接 `OutOfMemoryError`，而 `OutOfMemoryError` 是 `Error` 不是
 * `Exception`，脚本层与调用方的 `runCatching` 都兜不住，整条工作线程连同正在跑的书源一起被打掉。
 *
 * 这里改成流式读、边读边记账：输出一旦超过 `maxBytes` 立刻抛错中断，绝不把整个包解完再检查。
 *
 * ## 为什么单独成一个文件、且 `internal` 可见
 *
 * 原来它是 [JavaPackages] 的私有成员，于是「上限真的生效」这件事**没法测**：
 * 要构造一个解压后超限的包，就得把十几 MB 的字节数组喂进 Rhino，而 Rhino 会把字节数组
 * 按元素装箱成 JS 数组，测试进程自己先 OOM（实测 17/20/24MB 三种 payload 全部触发
 * `Native memory allocation (mmap) failed`，`DOS error 1455` 是 Windows 页面文件被打满，
 * 挂掉的是 Gradle 测试执行器 —— 测的就不是被测代码了）。
 *
 * 提成顶层纯函数后，判据可以在 Kotlin 里直接调它：17MB 输入、16MB 上限，
 * 峰值内存约 35MB，毫无压力。判据见 `GzipLimitsTest`。
 *
 * 这个文件**不依赖 `io.legado` 的任何东西**，是将来把沙箱层拆成独立模块时的天然候选。
 */
object GzipLimits {

    /** 单次解压的输出上限。真实书源页面压缩包里没有这么大的东西。 */
    const val MAX_UNZIP_BYTES: Int = 16 * 1024 * 1024

    /**
     * 解压 [input]，输出超过 [maxBytes] 时抛错中断。
     *
     * 抛 `IllegalArgumentException` 而不是 `Error`，是为了让脚本层的 `runCatching`
     *（以及调用方的 `runCatching`）能正常兜住并降级成空结果，而不是把线程炸掉。
     *
     * @throws IllegalArgumentException 解压输出超过上限
     */
    fun unzipBounded(input: ByteArray, maxBytes: Int = MAX_UNZIP_BYTES): ByteArray {
        require(maxBytes > 0) { "maxBytes 必须为正数，实际 $maxBytes" }
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        GZIPInputStream(input.inputStream()).use { stream ->
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                if (out.size() > maxBytes - read) {
                    throw IllegalArgumentException(
                        "GZIP 解压超过 ${maxBytes / (1024 * 1024)}MB 上限，已中断（疑似压缩炸弹）",
                    )
                }
                out.write(buffer, 0, read)
            }
        }
        return out.toByteArray()
    }
}
