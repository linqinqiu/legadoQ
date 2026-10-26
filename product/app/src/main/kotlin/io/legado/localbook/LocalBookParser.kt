package io.legado.localbook

import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.parser.Parser
import java.io.ByteArrayInputStream
import java.io.File
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

data class ParsedBook(
    val title: String,
    val author: String? = null,
    val intro: String? = null,
    val coverBytes: ByteArray? = null,
    val coverContentType: String? = null,
    val chapters: List<ParsedChapter>,
    /**
     * 这次实际是哪条规则切出来的目录（`builtin` 或规则 id）。
     * 单独报出来是因为"用户选了 A 规则、实际生效的是 B"这件事必须能看见，
     * 否则界面上那个选择器就是在骗人。
     */
    val tocRuleUsed: String? = null,
)

data class ParsedChapter(
    val title: String,
    val content: String,
)

object LocalBookParser {

    const val LOC_BOOK_SOURCE_ID = "loc_book"

    // EPUB（zip）解压闸门：`ZipInputStream.readAllBytes()` 无上限，一个几百 KB 的 zip 炸弹能解出几十 GB
    // 把堆打爆。单个 entry、整包总量、条目数三条都封顶，超了直接拒绝导入。
    private const val MAX_EPUB_ENTRY_BYTES = 64 * 1024 * 1024
    private const val MAX_EPUB_TOTAL_BYTES = 512L * 1024 * 1024
    private const val MAX_EPUB_ENTRIES = 10_000

    // 中文小说章节识别核心正则（增强版）
    // 匹配格式包括：
    // - 第X章/回/节/卷/集/篇/部（数字、中文、混合）
    // - Chapter X / Vol. X
    // - 纯数字前缀：1. 2. 3. 或 一、二、三、
    // - 特殊章节：引子/序言/楔子/尾声/后记/番外/终章/前言/附录
    // - 卷部：上部/下部/中部/前传/后传/外传/特别篇
    // - 标题后缀：`第一章 起源`、`3. 起飞`、`第1章：归来`（分隔符可以只是空格）
    //
    // 两个坑，改的时候别碰回去：
    // ① 所有分支必须整体套在一个 `(?: … )` 里再上 `^…$`。`Regex.matches` 要整行匹配，
    //    写成顶层 `^(?:A)|(?:B)|…$` 时每条分支各自被 `^`/`$` 卡成不一样的形状
    //    （只有第一条带 `^`、只有最后一条带 `$`），"第X章 + 空格 + 标题"这类最常见写法反而匹配不上。
    // ② 上一版这里多了一个右括号，`Pattern` 编译失败 → `LocalBookParser` 的类初始化直接抛
    //    `ExceptionInInitializerError`，整个对象此后全是 `NoClassDefFoundError`：
    //    表现不是"分章不准"，而是**本地书导入整条功能是死的**。所以这一组的用例
    //    （LocalBookParserTest）必须先能跑起来再谈别的。
    // 「自动选规则」要用它判断"开头那一行本身就是一条标题"（见 `TocRules.suggest`），所以不能是 private。
    internal val CHAPTER_TITLE_REGEX = Regex(
        """^(?:(?:第\s*[0-9零一二三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+[章回节卷集篇部幕计])|(?:Chapter|Vol\.?)\s+[0-9]+|(?:[0-9]{1,4}[.\s、]|[零一二三四五六七八九十百千万]{1,4}[、.]\s*)|(?:引子|序(?:言|章)?|楔子|尾(?:声|章)|后记|番外|终章|前言|附(?:录|记)|跋)|(?:上部|下部|中部|前传|后传|外传|特别篇))(?:\s*[-—·:：]?\s*.+)?$""",
        RegexOption.IGNORE_CASE
    )

    /**
     * TXT 里写的 `<img src="http…">` 换成占位行。
     *
     * 只认绝对 http(s) 地址：TXT 是纯文本，没有"相对哪篇文档"的基准，
     * 相对路径解析出来必然是错的（拼成包根去取会拿到不相干的文件，或者 404）。
     * 认不了的地址连标签一起去掉 —— 留一行 `<img src="…">` 字面文本，
     * 用户看到的是标签，还以为是我们把图弄坏了。
     */
    private val TXT_IMG_TAG = Regex(
        "(?i)<img[^>]*?\\b(?:data-original|data-src|src)\\s*=\\s*[\"']([^\"'\\s>]+)[\"'][^>]*>",
    )

    private fun preserveTxtImages(line: String): String {
        if (!line.contains("<img", ignoreCase = true)) return line
        return TXT_IMG_TAG.replace(line) { match ->
            val src = match.groupValues[1].trim()
            if (src.startsWith("http:", true) || src.startsWith("https:", true)) "\n![图片]($src)\n" else ""
        }
    }

    fun parse(filename: String, bytes: ByteArray, ruleKey: String? = null, bookId: String = ""): ParsedBook {
        val lowerName = filename.lowercase()
        return when {
            lowerName.endsWith(".epub") -> parseEpub(filename, bytes, bookId)
            lowerName.endsWith(".txt") || lowerName.endsWith(".text") -> parseTxt(filename, bytes, ruleKey)
            else -> {
                // 自动探测是否为 zip/epub 结构
                if (bytes.size >= 4 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4B.toByte()) {
                    runCatching { parseEpub(filename, bytes, bookId) }.getOrElse { parseTxt(filename, bytes, ruleKey) }
                } else {
                    parseTxt(filename, bytes, ruleKey)
                }
            }
        }
    }

    /**
     * 包内图片的取图地址。
     *
     * EPUB 里的插图在 zip 里，不会自己出现在网上，所以必须回服务端按 entry 取
     * （上游是 `EpubFile.getImage(book, href)`，我们走一条只读路由，语义相同）。
     * 参数放查询串而不是路径通配（`/books/local/{id}/asset/{path...}`）：
     * zip 路径带斜杠与 `%`，通配段的解码规则各家不同，一个参数把这件事变成一次编码。
     */
    private fun localAssetUrl(bookId: String, zipPath: String): String =
        "/api/books/local/asset?bookId=${java.net.URLEncoder.encode(bookId, "UTF-8")}" +
            "&path=${java.net.URLEncoder.encode(zipPath, "UTF-8")}"

    /** 按 EPUB 规范解析相对引用：`images/p1.png` 是相对**当前那篇 XHTML** 的，不是相对包根。 */
    private fun resolveZipPath(baseDir: String, raw: String): String {
        val joined = if (raw.startsWith("/")) raw.removePrefix("/") else "$baseDir/$raw"
        return normalizeZipPath(joined)
    }

    /**
     * 把正文里的 `<img>` / SVG `<image>` 换成 `![图片](地址)` 占位行。
     *
     * 为什么是"换成一行文本"而不是留着标签：整条正文链路（净化规则、离线缓存、TTS、
     * 前后端之间的字符串）走的是同一种行文本结构，前端 `contentImageUrl` 认的就是这一行 ——
     * 与在线书那边 `RuleRunner.preserveContentImages` 是同一个口径，两套数据结构迟早漂移。
     * 原来这里是直接 `body().text()`，`<img>` 整个消失，所以"EPUB 有图也看不见"。
     */
    private fun preserveImages(doc: Document, entryPath: String, bookId: String) {
        val baseDir = if (entryPath.contains('/')) entryPath.substringBeforeLast('/') else ""
        for (img in doc.select("img, image")) {
            val raw = img.attr("src").ifBlank { img.attr("xlink:href") }.trim()
            // data: 内联图整块丢掉（与在线侧同一处理）：一张 base64 图能到几 MB，
            // 塞进正文缓存会把"一行文本"的结构撑坏。
            if (raw.isBlank() || raw.startsWith("data:")) {
                img.remove()
                continue
            }
            val target = if (raw.startsWith("http:", true) || raw.startsWith("https:", true)) {
                raw
            } else if (bookId.isBlank()) {
                // 没有 bookId 就取不到包内资源（只有单测会走到这里），不生成一个必然 404 的地址
                img.remove()
                continue
            } else {
                localAssetUrl(bookId, resolveZipPath(baseDir, raw))
            }
            img.replaceWith(org.jsoup.nodes.Element("p").text("![图片]($target)"))
        }
    }

    /**
     * TXT 文本自动探测编码与分章
     *
     * [ruleKey]：`null`/`auto` 按正文打分选一条上游规则，`builtin` 强制走下面那条内置逐行匹配，
     * 其余是 `assets/txtTocRule.json` 里的规则 id。
     */
    fun parseTxt(filename: String, bytes: ByteArray, ruleKey: String? = null): ParsedBook {
        val (detectedTitle, detectedAuthor) = extractTitleAndAuthorFromFilename(filename)
        val text = decodeText(bytes)

        val chosen: TxtTocRule? = when {
            ruleKey == TocRules.BUILTIN -> null
            ruleKey.isNullOrBlank() || ruleKey == TocRules.AUTO -> TocRules.suggest(text)
            else -> TocRules.byId(ruleKey.toIntOrNull() ?: Int.MIN_VALUE)
        }
        val regex = chosen?.let { TocRules.regexFor(it.id.toString()) }
        if (chosen != null && regex != null) {
            val byRule = TocRules.split(text, regex)
            // 只切出 0 或 1 章 = 这条规则在这本书上不成立，回落逐行匹配。
            // 用户显式选的也会回落 —— 那件事由 tocRuleUsed 报出去，不在界面上装"生效了"。
            if (byRule.size > 1) {
                return ParsedBook(
                    title = detectedTitle,
                    author = detectedAuthor,
                    intro = if (byRule.first().title == "前言") byRule.first().content.take(300) else null,
                    chapters = byRule,
                    tocRuleUsed = chosen.id.toString(),
                )
            }
        }

        val lines = text.lines()
        val chapters = mutableListOf<ParsedChapter>()

        var currentTitle: String? = null
        val currentContent = StringBuilder()

        for (line in lines) {
            val trimmed = line.trim()
            if (trimmed.isNotEmpty() && CHAPTER_TITLE_REGEX.matches(trimmed)) {
                if (currentTitle != null) {
                    chapters.add(ParsedChapter(currentTitle, currentContent.toString().trim()))
                    currentContent.clear()
                } else if (currentContent.isNotBlank()) {
                    // 第一章之前的内容作为前言/引子（最多保留 2000 字）
                    val prologue = currentContent.toString().trim().take(2000)
                    chapters.add(ParsedChapter("前言", prologue))
                    currentContent.clear()
                }
                currentTitle = trimmed
            } else {
                if (currentContent.isNotEmpty()) {
                    currentContent.append("\n")
                }
                currentContent.append(preserveTxtImages(line))
            }
        }

        if (currentTitle != null) {
            chapters.add(ParsedChapter(currentTitle, currentContent.toString().trim()))
        } else if (currentContent.isNotBlank()) {
            val remaining = currentContent.toString().trim()
            if (chapters.isEmpty()) {
                // 全书无章节匹配，按字数智能分页切分
                chapters.addAll(paginateText(remaining))
            } else {
                chapters.add(ParsedChapter("尾声", remaining))
            }
        }

        val finalChapters = if (chapters.isEmpty()) {
            listOf(ParsedChapter("正文", text.trim()))
        } else chapters

        // TXT 没有封面可言：以前按书名哈希生成一张彩色 SVG，一书架本地书下去就是彩虹，
        // 现在留空，由界面的主题化文字占位承担（BookCover → .cover-fallback）。
        return ParsedBook(
            title = detectedTitle,
            author = detectedAuthor,
            intro = if (finalChapters.firstOrNull()?.title == "前言") finalChapters.first().content.take(300) else null,
            chapters = finalChapters,
            // 走到这里就是内置那条（包括"选了某条规则但它切不出第二章"的回落）
            tocRuleUsed = TocRules.BUILTIN,
        )
    }

    /**
     * EPUB 规范解压与元数据、目录、正文提取
     */
    fun parseEpub(filename: String, bytes: ByteArray, bookId: String = ""): ParsedBook {
        val entries = mutableMapOf<String, ByteArray>()
        var totalBytes = 0L
        ZipInputStream(ByteArrayInputStream(bytes)).use { zis ->
            var entry: ZipEntry? = zis.nextEntry
            while (entry != null) {
                if (!entry.isDirectory) {
                    val name = normalizeZipPath(entry.name)
                    require(entries.size < MAX_EPUB_ENTRIES) { "EPUB 条目数超过 $MAX_EPUB_ENTRIES 上限" }
                    val data = readBoundedEntry(zis, MAX_EPUB_ENTRY_BYTES)
                    totalBytes += data.size
                    require(totalBytes <= MAX_EPUB_TOTAL_BYTES) { "EPUB 解压后超过 ${MAX_EPUB_TOTAL_BYTES / 1024 / 1024} MiB 上限" }
                    entries[name] = data
                }
                entry = zis.nextEntry
            }
        }

        // 1. 定位 container.xml
        val containerXmlBytes = entries["META-INF/container.xml"]
            ?: entries.entries.firstOrNull { it.key.equals("META-INF/container.xml", ignoreCase = true) }?.value
            ?: throw IllegalArgumentException("无效的 EPUB 文件：缺少 META-INF/container.xml")

        val containerDoc = Jsoup.parse(String(containerXmlBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
        val rootfile = containerDoc.select("rootfiles > rootfile").firstOrNull()
            ?: containerDoc.select("rootfile").firstOrNull()
            ?: throw IllegalArgumentException("无效的 EPUB 文件：未找到 rootfile")

        val opfPath = normalizeZipPath(rootfile.attr("full-path"))
        val opfBytes = entries[opfPath]
            ?: entries.entries.firstOrNull { it.key.equals(opfPath, ignoreCase = true) }?.value
            ?: throw IllegalArgumentException("未找到 OPF 描述文件：$opfPath")

        val opfBaseDir = if (opfPath.contains('/')) opfPath.substringBeforeLast('/') + "/" else ""
        val opfDoc = Jsoup.parse(String(opfBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())

        // 2. 提取元数据
        val (fileTitle, fileAuthor) = extractTitleAndAuthorFromFilename(filename)
        val title = opfDoc.select("metadata > dc|title, metadata > title").firstOrNull()?.text()?.trim()
            ?.ifBlank { null } ?: fileTitle
        val author = opfDoc.select("metadata > dc|creator, metadata > creator").firstOrNull()?.text()?.trim()
            ?.ifBlank { null } ?: fileAuthor
        val intro = opfDoc.select("metadata > dc|description, metadata > description").firstOrNull()?.text()?.trim()
            ?.ifBlank { null }

        // 3. Manifest 映射 (id -> href, media-type, properties)
        data class ManifestItem(val id: String, val href: String, val mediaType: String, val properties: String)
        val manifest = mutableMapOf<String, ManifestItem>()
        for (item in opfDoc.select("manifest > item")) {
            val id = item.attr("id")
            val rawHref = item.attr("href")
            val href = try { URLDecoder.decode(rawHref, "UTF-8") } catch (_: Throwable) { rawHref }
            val fullHref = normalizeZipPath(opfBaseDir + href)
            val mediaType = item.attr("media-type")
            val properties = item.attr("properties")
            manifest[id] = ManifestItem(id, fullHref, mediaType, properties)
        }

        // 4. 提取封面
        var coverBytes: ByteArray? = null
        var coverContentType: String? = null

        // 查找 meta cover 属性
        val coverMetaId = opfDoc.select("metadata > meta[name=cover]").attr("content").ifBlank { null }
        val coverItem = (coverMetaId?.let { manifest[it] })
            ?: manifest.values.firstOrNull { it.properties.contains("cover-image") }
            ?: manifest.values.firstOrNull { it.id.equals("cover", ignoreCase = true) && it.mediaType.startsWith("image/") }
            ?: manifest.values.firstOrNull { it.href.contains("cover", ignoreCase = true) && it.mediaType.startsWith("image/") }

        if (coverItem != null) {
            val imgData = findZipEntry(entries, coverItem.href)
            if (imgData != null && imgData.isNotEmpty()) {
                coverBytes = imgData
                coverContentType = coverItem.mediaType.ifBlank { "image/jpeg" }
            }
        }

        // 5. 提取目录 (NCX 或 Nav 或 Spine)
        val chapters = mutableListOf<ParsedChapter>()

        // 尝试 NCX 目录
        val spineTocId = opfDoc.select("spine").attr("toc").ifBlank { null }
        val ncxItem = (spineTocId?.let { manifest[it] })
            ?: manifest.values.firstOrNull { it.mediaType == "application/x-dtbncx+xml" || it.href.endsWith(".ncx", ignoreCase = true) }

        if (ncxItem != null) {
            val ncxBytes = findZipEntry(entries, ncxItem.href)
            if (ncxBytes != null) {
                val ncxBaseDir = if (ncxItem.href.contains('/')) ncxItem.href.substringBeforeLast('/') + "/" else ""
                val ncxDoc = Jsoup.parse(String(ncxBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
                val navPoints = ncxDoc.select("navMap > navPoint, navPoint")
                for (np in navPoints) {
                    val label = np.select("navLabel > text").firstOrNull()?.text()?.trim() ?: "章节"
                    val src = np.select("content").attr("src").substringBefore('#')
                    if (src.isNotBlank()) {
                        val fullPath = normalizeZipPath(ncxBaseDir + src)
                        val htmlBytes = findZipEntry(entries, fullPath)
                        if (htmlBytes != null) {
                            val content = extractHtmlContent(htmlBytes, fullPath, bookId)
                            if (content.isNotBlank()) {
                                chapters.add(ParsedChapter(label, content))
                            }
                        }
                    }
                }
            }
        }

        // 若 NCX 解析为空，尝试 EPUB 3 Nav
        if (chapters.isEmpty()) {
            val navItem = manifest.values.firstOrNull { it.properties.contains("nav") }
            if (navItem != null) {
                val navBytes = findZipEntry(entries, navItem.href)
                if (navBytes != null) {
                    val navBaseDir = if (navItem.href.contains('/')) navItem.href.substringBeforeLast('/') + "/" else ""
                    val navDoc = Jsoup.parse(String(navBytes, StandardCharsets.UTF_8))
                    val links = navDoc.select("nav[epub|type=toc] a, nav a")
                    for (a in links) {
                        val label = a.text().trim().ifBlank { "章节" }
                        val src = a.attr("href").substringBefore('#')
                        if (src.isNotBlank()) {
                            val fullPath = normalizeZipPath(navBaseDir + src)
                            val htmlBytes = findZipEntry(entries, fullPath)
                            if (htmlBytes != null) {
                                val content = extractHtmlContent(htmlBytes, fullPath, bookId)
                                if (content.isNotBlank()) {
                                    chapters.add(ParsedChapter(label, content))
                                }
                            }
                        }
                    }
                }
            }
        }

        // 若仍为空，按 Spine 线性顺序读取
        if (chapters.isEmpty()) {
            val itemrefs = opfDoc.select("spine > itemref")
            var idx = 1
            for (itemref in itemrefs) {
                val idref = itemref.attr("idref")
                val item = manifest[idref] ?: continue
                val htmlBytes = findZipEntry(entries, item.href) ?: continue
                val (extractedTitle, content) = extractHtmlTitleAndContent(htmlBytes, idx, item.href, bookId)
                if (content.isNotBlank()) {
                    chapters.add(ParsedChapter(extractedTitle, content))
                    idx++
                }
            }
        }

        val finalChapters = if (chapters.isEmpty()) {
            // 图片现在会被提成占位行，所以走到这里是真的什么都没有（不是"只有图片"了）
            listOf(ParsedChapter("正文", "本书正文解析为空：没有文本，也没有可提取的图片资源。"))
        } else chapters

        return ParsedBook(
            title = title,
            author = author,
            intro = intro,
            coverBytes = coverBytes,
            coverContentType = coverContentType,
            chapters = finalChapters,
        )
    }

    private fun findZipEntry(entries: Map<String, ByteArray>, path: String): ByteArray? {
        val norm = normalizeZipPath(path)
        return entries[norm] ?: entries.entries.firstOrNull { it.key.equals(norm, ignoreCase = true) }?.value
    }

    /**
     * 按上限读一个 zip entry（防 zip 炸弹）。超限抛异常，导入直接被拒。
     * `ZipInputStream.readAllBytes()` 无上限 —— 一个几百 KB 的压缩包能声明几十 GB 的解压体积。
     */
    private fun readBoundedEntry(zis: ZipInputStream, limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        var total = 0
        while (true) {
            val n = zis.read(buf)
            if (n < 0) break
            total += n
            require(total <= limit) { "EPUB 单个文件解压后超过 ${limit / 1024 / 1024} MiB 上限" }
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    /**
     * jsoup 的 `Element.text()` 会把所有空白（含换行）压成单个空格 —— 用它取正文，
     * 上面 `prepend("\n\n")` 造出来的段落边界就全没了，`![图片](…)` 占位行也会被并进
     * 前后句子中间，于是前端那条"整行必须是占位"的正则永远匹配不上，图就又不显示了。
     * `wholeText()` 原样保留空白，段落边界交给 `cleanText` 统一收。
     */
    private fun bodyText(doc: Document): String = doc.body()?.wholeText() ?: doc.wholeText()

    private fun extractHtmlContent(bytes: ByteArray, entryPath: String, bookId: String): String {
        val html = String(bytes, StandardCharsets.UTF_8)
        val doc = Jsoup.parse(html)
        doc.select("script, style, link, meta").remove()
        // 先换图片再取文本：`body().text()` 会把 `<img>` 整个吞掉，这就是"EPUB 有图也看不见"的原因
        preserveImages(doc, entryPath, bookId)
        // 将块级元素转换为换行
        doc.select("p, div, br, h1, h2, h3, h4, h5, h6, tr, li, blockquote").prepend("\n\n")
        return cleanText(bodyText(doc))
    }

    private fun extractHtmlTitleAndContent(bytes: ByteArray, defaultIndex: Int, entryPath: String, bookId: String): Pair<String, String> {
        val html = String(bytes, StandardCharsets.UTF_8)
        val doc = Jsoup.parse(html)
        doc.select("script, style, link, meta").remove()
        val titleCandidate = doc.select("h1, h2, title").firstOrNull()?.text()?.trim()
        val title = if (!titleCandidate.isNullOrBlank() && titleCandidate.length <= 40) {
            titleCandidate
        } else {
            "第 $defaultIndex 章"
        }
        preserveImages(doc, entryPath, bookId)
        doc.select("p, div, br, h1, h2, h3, h4, h5, h6, tr, li, blockquote").prepend("\n\n")
        return title to cleanText(bodyText(doc))
    }

    private fun cleanText(text: String): String {
        return text.lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString("\n\n")
    }

    private fun paginateText(text: String, chunkSize: Int = 4000): List<ParsedChapter> {
        if (text.length <= chunkSize) {
            return listOf(ParsedChapter("正文", text))
        }
        val chapters = mutableListOf<ParsedChapter>()
        var start = 0
        var page = 1
        while (start < text.length) {
            var end = (start + chunkSize).coerceAtMost(text.length)
            if (end < text.length) {
                // 尝试在自然换行处切分（避免从句子中间劈开）
                val newlineIdx = text.lastIndexOf('\n', end)
                if (newlineIdx > start + chunkSize / 2) {
                    end = newlineIdx + 1
                }
            }
            val chunk = text.substring(start, end).trim()
            if (chunk.isNotEmpty()) {
                // 标题只写"第 X 节"。上一版在这里加了"（共约 Y 节）"，意图是让人知道总共分了几个，
                // 但目录里每一条都挂一遍总数只是噪声，而且"共约"是按字数估的：自然换行会让实际段数与估算不符，
                // 写进标题就是把一个不确定的数字变成看起来确定的。总数阅读器本来就显示（第 x / y 章）。
                chapters.add(ParsedChapter("第 $page 节", chunk))
                page++
            }
            start = end
        }
        return chapters
    }

    /**
     * 智能编码探测：UTF-8, UTF-8 BOM, UTF-16, GB18030/GBK
     */
    fun decodeText(bytes: ByteArray): String {
        if (bytes.isEmpty()) return ""

        // 1. 检查 BOM
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
            return String(bytes, 3, bytes.size - 3, StandardCharsets.UTF_8)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
            return String(bytes, 2, bytes.size - 2, StandardCharsets.UTF_16BE)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
            return String(bytes, 2, bytes.size - 2, StandardCharsets.UTF_16LE)
        }

        // 2. 尝试严格 UTF-8 解码
        try {
            val decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val charBuffer = decoder.decode(ByteBuffer.wrap(bytes))
            return charBuffer.toString()
        } catch (_: Throwable) {
            // UTF-8 严格解码失败
        }

        // 3. 尝试 GB18030 (向下兼容 GBK, GB2312)
        try {
            val gbkCharset = Charset.forName("GB18030")
            val decoder = gbkCharset.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val charBuffer = decoder.decode(ByteBuffer.wrap(bytes))
            return charBuffer.toString()
        } catch (_: Throwable) {
            // GB18030 严格解码失败
        }

        // 4. 容错回退
        return String(bytes, StandardCharsets.UTF_8)
    }

    /**
     * 从文件名中提取书名与作者
     */
    fun extractTitleAndAuthorFromFilename(filename: String): Pair<String, String?> {
        val cleanName = filename.substringBeforeLast('.').trim()
        val authorRegexes = listOf(
            Regex("""(?:作者|著)[:：\s]+([^\s_\(\)\[\]《》【】]+)"""),
            Regex("""[《【\[](.+?)[》】\]]\s*(?:作者|著)?[:：\s]*([^\s_\(\)\[\]《》【】]+)"""),
            Regex("""^(.+?)[_—\-\s]+(?:作者|著)?[:：\s]*([^\s_\(\)\[\]《》【】]+)$"""),
            Regex("""^(.+?)\s*\(([^\(\)]+)\)$"""),
        )

        for (regex in authorRegexes) {
            val match = regex.find(cleanName)
            if (match != null) {
                val groups = match.groupValues
                if (groups.size == 3) {
                    val title = sanitizeTitle(groups[1])
                    val author = groups[2].trim()
                    if (title.isNotBlank() && author.isNotBlank()) {
                        return title to author
                    }
                } else if (groups.size == 2) {
                    val author = groups[1].trim()
                    val title = sanitizeTitle(cleanName.replace(match.value, ""))
                    if (title.isNotBlank() && author.isNotBlank()) {
                        return title to author
                    }
                }
            }
        }

        return sanitizeTitle(cleanName) to null
    }

    private fun sanitizeTitle(raw: String): String {
        return raw.replace(Regex("""^[《【\[(]+"""), "")
            .replace(Regex("""[》】\])]+$"""), "")
            .trim()
            .ifBlank { "未知书籍" }
    }

    private fun normalizeZipPath(path: String): String {
        val parts = path.replace('\\', '/').split('/')
        val stack = mutableListOf<String>()
        for (part in parts) {
            if (part == "." || part.isEmpty()) continue
            if (part == "..") {
                if (stack.isNotEmpty()) stack.removeAt(stack.size - 1)
            } else {
                stack.add(part)
            }
        }
        return stack.joinToString("/")
    }
}
