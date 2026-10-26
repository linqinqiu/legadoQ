package io.legado

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path

/**
 * 自定义品牌（用户 2026-10-23：「允许自定义图标和名称」）。
 *
 * 装在 `brand.json`（安装根，与 `port.txt` / `agent-profiles.json` 同级）+ 图标字节存在
 * `brand/` 子目录里。选"安装根的文件"而不是数据库：这台服务可以整体搬盘、改名，
 * 品牌属于"这一台机器长什么样"，与 `agent-profiles.json` 同一类，不进库才跟着目录走。
 *
 * 刻意**不改** [BuildInfo.title]：`/healthz` 的 title 恒为「legadoQ」。
 * 桌面壳（`DesktopLauncher`）用"响应里含 legadoQ"判断端口上是不是自己那个实例
 * （`isLegadoQOn`），改 title 会让改名后的壳认为端口上是别人的服务、再起第二个进程。
 * 品牌名只影响 PWA 的安装名、标签页标题与应用内显示。
 */
@Serializable
data class Brand(
    /** PWA 安装名与界面标题；空 = 用内置的「legadoQ」。 */
    val name: String = "",
    /** 桌面/手机主屏幕上那格空间不够时用的短名；空 = 回落 [name]。 */
    val shortName: String = "",
    /** 主题色（状态栏与 PWA 底色）。留空则沿用内置皮肤的取值。 */
    val themeColor: String = "",
    /** 自定义图标的文件名（存在 `brand/` 下）；空 = 用随包图标。 */
    val iconFile: String = "",
) {
    val displayName: String get() = name.ifBlank { BuildInfo.title }
    val displayShortName: String get() = shortName.ifBlank { name.ifBlank { BuildInfo.title } }
    /** 图标是否真的可用：文件名在，且文件还在磁盘上（手动删过文件也不算有）。 */
    val hasIcon: Boolean get() = iconFile.isNotBlank()
}

/**
 * 品牌的读写。图标字节走白名单魔数校验，**不收 SVG** ——
 * 与封面/媒体代理同一条纪律（`CoverCache` 明确 `require(type != "image/svg+xml")`、
 * `MediaRoutes` 把同源 SVG 降级成 octet-stream）：SVG 可以带脚本，
 * 而品牌图标会被浏览器当"本站自己的资源"取用，等于自己给自己开一条同源脚本执行面。
 */
object BrandStore {
    private const val FILE_NAME = "brand.json"
    private const val ICON_DIR = "brand"
    /** 与媒体侧同一档上限：图标用不到更大的，超大图只会拖慢安装。 */
    const val MAX_ICON_BYTES = 5L * 1024 * 1024

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true; prettyPrint = true }

    private fun fileOf(homeDirectory: Path) = homeDirectory.resolve(FILE_NAME)
    private fun iconDirOf(homeDirectory: Path) = homeDirectory.resolve(ICON_DIR)

    /** 读品牌。没有文件、或文件坏了都回落到空品牌（= 内置外观），并留下可见的说明。 */
    fun load(homeDirectory: Path): Brand {
        val file = fileOf(homeDirectory)
        if (!Files.isReadable(file)) return Brand()
        val brand = runCatching {
            // 容忍带 BOM 的文件：很多编辑器与 PowerShell 默认写 BOM，kotlinx 见了会整份解析失败。
            val raw = Files.readString(file, Charsets.UTF_8)
            val text = if (raw.isNotEmpty() && raw[0] == '\uFEFF') raw.substring(1) else raw
            json.decodeFromString(Brand.serializer(), text)
        }.getOrElse { error ->
            System.err.println("[brand] brand.json 读不出来，按内置外观继续：${error.message ?: error::class.simpleName}")
            return Brand()
        }
        // 图标文件被手动删过时不要把死路径继续发给界面（那只会得到一个 404 图标）。
        return if (brand.hasIcon && !Files.isRegularFile(iconDirOf(homeDirectory).resolve(brand.iconFile)))
            brand.copy(iconFile = "") else brand
    }

    fun save(homeDirectory: Path, brand: Brand): Brand {
        Files.createDirectories(homeDirectory)
        Files.writeString(fileOf(homeDirectory), json.encodeToString(Brand.serializer(), sanitize(brand)), Charsets.UTF_8)
        return load(homeDirectory)
    }

    /** 撤掉自定义，回到内置品牌与内置图标。图标文件一并删掉，不留孤儿字节。 */
    fun clear(homeDirectory: Path): Brand {
        val icon = iconDirOf(homeDirectory)
        runCatching { Files.exists(icon).let { if (it) Files.list(icon).use { stream -> stream.forEach { p -> runCatching { Files.deleteIfExists(p) } } } } }
        Files.deleteIfExists(fileOf(homeDirectory))
        return Brand()
    }

    /** 界面传来的值先收边：名称不能带换行（它要进 manifest 的 JSON 与 `<title>`），长度要设上限。 */
    fun sanitize(brand: Brand): Brand = brand.copy(
        name = brand.name.replace('\r', ' ').replace('\n', ' ').trim().take(40),
        shortName = brand.shortName.replace('\r', ' ').replace('\n', ' ').trim().take(20),
        themeColor = normalizeColor(brand.themeColor),
    )

    /** 只认 `#rgb` / `#rrggbb` 两种写法，别的（带名字、带空格、带脚本的）一律丢回空。 */
    private fun normalizeColor(value: String): String {
        val v = value.trim()
        return if (Regex("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$").matches(v)) v.lowercase() else ""
    }

    /**
     * 按**魔数**认图（不信 Content-Type，也不信文件名）——
     * 这是媒体侧已经采用的同一判据（`MediaRoutes` 注释：按魔数判图）。
     * 返回归一化后的类型；认不出就 null（拒收）。
     */
    fun sniffImageType(bytes: ByteArray): String? {
        if (bytes.size < 12) return null
        fun head(n: Int) = bytes.take(n).toByteArray()
        if (head(8).contentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))) return "image/png"
        if (head(3).contentEquals(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte()))) return "image/jpeg"
        if (head(4).toString(Charsets.ISO_8859_1) == "RIFF" && bytes.copyOfRange(8, 12).toString(Charsets.ISO_8859_1) == "WEBP") return "image/webp"
        return null
    }

    /**
     * 存一张自定义图标。只收 PNG / JPEG / WebP（按魔数），拒 SVG，限 [MAX_ICON_BYTES]。
     * @return 存下来的文件名；拒收时返回 null 并由调用方给一句人话。
     */
    fun saveIcon(homeDirectory: Path, bytes: ByteArray): String? {
        if (bytes.isEmpty() || bytes.size.toLong() > MAX_ICON_BYTES) return null
        val type = sniffImageType(bytes) ?: return null
        val dir = iconDirOf(homeDirectory)
        Files.createDirectories(dir)
        // 固定文件名：换一张就覆盖同一格，界面上的 URL 不用变、也不会在磁盘上堆出几十个历史图标。
        val name = "icon." + type.substringAfter('/').replace("jpeg", "jpg")
        dir.toFile().listFiles()?.forEach { other ->
            if (other.name != name) runCatching { Files.deleteIfExists(other.toPath()) }
        }
        Files.write(dir.resolve(name), bytes)
        return name
    }

    fun iconBytes(homeDirectory: Path, brand: Brand): Pair<ByteArray, String>? {
        if (brand.iconFile.isBlank()) return null
        val file = iconDirOf(homeDirectory).resolve(brand.iconFile)
        if (!Files.isRegularFile(file)) return null
        val data = runCatching { Files.readAllBytes(file) }.getOrNull() ?: return null
        val type = sniffImageType(data) ?: return null
        return data to type
    }

    /** 只认类型不读全文件（manifest 改写要的是 MIME，不是字节）。 */
    fun iconType(homeDirectory: Path, brand: Brand): String? = iconBytes(homeDirectory, brand)?.second

    fun deleteIcon(homeDirectory: Path): Brand {
        val current = load(homeDirectory)
        if (current.iconFile.isNotBlank()) {
            runCatching { Files.deleteIfExists(iconDirOf(homeDirectory).resolve(current.iconFile)) }
        }
        return save(homeDirectory, current.copy(iconFile = ""))
    }
}
