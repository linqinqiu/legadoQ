package io.legado.model

import kotlinx.serialization.Serializable

/**
 * 本地 TXT 的目录规则（阶段 3.2 从 `localbook/TxtTocRule.kt` 归位）。
 *
 * 字段与上游 `data/entities/TxtTocRule.kt` 对齐；内置那 26 条来自上游
 * `app/src/main/assets/defaultData/txtTocRule.json`（LegadoTeam/legado，GPL-3.0，
 * 本项目同为 GPL-3.0），**原样作为随包资源 `assets/txtTocRule.json` 装进来，不手抄**：
 * 这些正则里有 `节(?!课)`、`正文(?!完|结)`、`部(?![分赛游])` 这类负向排除，
 * 抄错一个字就会把"第一节课程"当成一章，或者反过来整本书切不出一章。
 */
@Serializable
data class TxtTocRule(
    val id: Int = 0,
    val name: String = "",
    val rule: String = "",
    /** 上游用它挂"标题净化 JS"；随包这 26 条里都是空的，接上之前不参与解析。 */
    val replacement: String = "",
    val example: String? = null,
    val serialNumber: Int = -1,
    val enable: Boolean = true,
)
