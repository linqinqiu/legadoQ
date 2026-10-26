package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.backup.BackupStore
import io.legado.data.Database
import io.legado.data.clampShelfProgress
import io.legado.data.importLocalBook
import io.legado.data.shelfBook
import io.legado.localbook.LocalBookParser
import io.legado.localbook.TocRules
import io.legado.model.ApiError
import io.legado.model.LocalBookReparseRequest
import io.legado.model.LocalBookReparseResult
import io.legado.model.TocRuleApplyResult
import io.legado.model.TocRuleDeleteResult
import io.legado.model.TocRuleList
import io.legado.model.TocRuleOption
import io.legado.model.TocRuleResetResult
import io.legado.model.TocRuleSaveRequest
import io.legado.model.TocRuleSaveResult
import io.legado.model.TocRuleToggleRequest
import io.legado.model.TocRuleToggleResult
import io.legado.ops.logParsing
import java.nio.file.Path

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：TXT 分章规则表与本地书重切目录。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.tocRulesRoutes(
    database: Database,
    backupKeep: BackupStore,
    localBooksDirectory: Path,
) {
        /**
         * 「阅读设置 → 本地书目录」的可选规则清单：`auto` + `builtin` + 随包那 26 条里编译得出来的。
         * 坏正则在这里就已经被滤掉了（`TocRules.candidates`），界面上不会摆一个用了就报错的选项。
         */
        get("/books/toc-rules") {
            // 清单发**全部能编译的规则**，不是只发启用的那几条：手动选与参与自动打分是两件事
            call.respond(TocRuleList(
                options = listOf(
                    TocRuleOption(TocRules.AUTO, TocRules.label(TocRules.AUTO)),
                    TocRuleOption(TocRules.BUILTIN, TocRules.label(TocRules.BUILTIN), builtIn = true),
                ) + TocRules.all.map { rule ->
                    TocRuleOption(
                        key = rule.id.toString(),
                        label = rule.name,
                        example = rule.example.orEmpty(),
                        rule = rule.rule,
                        enable = rule.enable,
                        // 随包那张表里 id -100 就是"内置逐行匹配"：没有正则不等于坏，别标成编译失败
                        builtIn = rule.id == TocRules.PACKAGED_BUILTIN_ID,
                        broken = !TocRules.compiles(rule.id),
                        removable = TocRules.removable(rule.id),
                    )
                },
                enabled = TocRules.all.count { it.enable },
                total = TocRules.all.size,
                fromBackup = TocRules.customCount,
                overridden = TocRules.hasOverrides,
            ))
        }
        post("/books/toc-rules/toggle") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<TocRuleToggleRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            val id = request.key.toIntOrNull()
                ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "只有具体规则能开关，auto 与内置不行"))
            val updated = TocRules.setEnable(id, request.enable)
                ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("rule_missing", "没有这条规则"))
            call.respond(TocRuleToggleResult(updated.id, updated.name, updated.enable))
        }
        /*
         * 新建 / 修改一条分章规则（用户 2026-10-03：「txt目录规则可新建可编辑」）。
         * 正则编不出来时回的是这条规则自己的错，不是 500 —— 界面上要能就地说明"哪一列不行"。
         */
        post("/books/toc-rules/save") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<TocRuleSaveRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            if (request.name.isBlank() || request.rule.isBlank()) {
                return@post call.respond(HttpStatusCode.BadRequest, ApiError("rule_incomplete", "名字与正则都得填"))
            }
            if (!TocRules.patternUsable(request.rule.trim())) {
                return@post call.respond(
                    HttpStatusCode.BadRequest,
                    ApiError("rule_uncompilable", "这条正则在本机编译不出来，存进去会切不出章；先改到能编译"),
                )
            }
            // 不填 key = 新建；填了但不是数字要顶回去 —— 当成新建会把"改一条"变成"多一条"
            val id = when {
                request.key.isNullOrBlank() -> null
                else -> request.key.trim().toIntOrNull()
                    ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "key 要么不填（新建），要么是规则 id"))
            }
            val saved = TocRules.save(id, request.name, request.rule, request.example, request.enable)
                ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("rule_missing", "没有这条规则（或它不属于本机规则表）"))
            call.respond(TocRuleSaveResult(saved.id, saved.name, saved.rule, saved.enable, TocRules.all.size))
        }
        post("/books/toc-rules/delete") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<TocRuleToggleRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            val id = request.key.toIntOrNull()
                ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "只有具体规则能删"))
            if (TocRules.packaged.any { it.id == id }) {
                return@post call.respond(
                    HttpStatusCode.BadRequest,
                    ApiError("packaged_rule", "随包那条规则不能删，可以取消它的「自动」勾选；要整张还原用「恢复随包那份」"),
                )
            }
            val removed = TocRules.remove(id)
            call.respond(TocRuleDeleteResult(removed, TocRules.all.size))
        }
        /*
         * 撤掉本机改动，回到随包那 26 条（套用过之后要能反悔，门禁也要能还原用户的规则表）。
         */
        post("/books/toc-rules/reset") {
            if (!call.requireSameOriginWrite()) return@post
            call.respond(TocRuleResetResult(cleared = TocRules.clearOverrides(), total = TocRules.all.size))
        }
        /*
         * 套用「手机备份里那份 txtTocRule.json」（用户 2026-10-02：「手机导入的备份里面会有这个相关的」）。
         * 只读服务器上已经收下的那条，不接受请求体里现编的表 —— 否则这条写接口就成了"任意改规则表"。
         */
        post("/books/toc-rules/apply-backup") {
            if (!call.requireSameOriginWrite()) return@post
            val text = backupKeep.read("txtTocRule.json")
                ?: return@post call.respond(
                    HttpStatusCode.NotFound,
                    ApiError("no_backup_entry", "服务器上还没有手机备份里的 TXT 分章规则；先在「备份包」导入一个带这条目的包"),
                )
            val report = TocRules.applyBackup(text)
            call.respond(TocRuleApplyResult(
                matched = report["matched"] ?: 0,
                flipped = report["flipped"] ?: 0,
                added = report["added"] ?: 0,
                unusable = report["unusable"] ?: 0,
                total = report["total"] ?: 0,
            ))
        }
        /**
         * 换一条目录规则，把这本本地书重切一遍（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
         *
         * 原始文件在导入时就整本留在 `local_books/` 里，所以换规则不必让用户重新上传。
         * 重切会覆盖目录并清掉正文缓存 —— 章节编号整体错位之后留着旧正文等于让读者读到错章。
         * 两种情况**拒绝并保留原目录**：一条规则切不出第二个章节、原文件已经不在本机。
         */
        post("/books/reparse-local") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<LocalBookReparseRequest>() }.getOrElse {
                return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_body", "缺少 sourceId / bookUrl / ruleKey"))
            }
            val bookId = request.bookUrl.removePrefix("local://").substringBefore('/').trim()
            if (request.sourceId != LocalBookParser.LOC_BOOK_SOURCE_ID || bookId.isEmpty()) {
                return@post call.respond(HttpStatusCode.BadRequest, ApiError("not_local_book", "只有导入到本机的书才有目录规则可换"))
            }
            val existing = database.shelfBook(request.sourceId, request.bookUrl)
                ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("book_missing", "书架上没有这本书"))
            val file = runCatching {
                localBooksDirectory.toFile().listFiles()?.firstOrNull { it.isFile && it.name.startsWith("$bookId.") }
            }.getOrNull()
                ?: return@post call.respond(
                    HttpStatusCode.NotFound,
                    ApiError("local_file_missing", "本机找不到这本书的原始文件（可能被清理过），重新导入一次才能换规则"),
                )
            val parsed = try {
                LocalBookParser.parse(file.name, file.readBytes(), request.ruleKey, bookId)
            } catch (error: Throwable) {
                Unit.logParsing("本地书重切目录失败", mapOf("书名" to existing.name, "规则" to request.ruleKey, "原因" to (error.message ?: "")), error)
                return@post call.respond(HttpStatusCode.BadGateway, ApiError("reparse_failed", error.message ?: "重切目录失败"))
            }
            val askedForSpecific = request.ruleKey != TocRules.AUTO && request.ruleKey != TocRules.BUILTIN
            if (askedForSpecific && parsed.tocRuleUsed == TocRules.BUILTIN) {
                // 回落意味着这条规则在这本书上切不出第二个章节：直接把整本书变成一章是破坏，
                // 所以这里不写库，把原因说清楚让用户换一条。
                return@post call.respond(
                    HttpStatusCode.BadGateway,
                    ApiError("rule_carved_nothing", "这条规则在这本书上切不出第二个章节，已保留原目录；换一条或改用自动"),
                )
            }
            database.importLocalBook(bookId, parsed, null, existing.groupId)
            database.clampShelfProgress(request.sourceId, request.bookUrl, parsed.chapters.size)
            val used = parsed.tocRuleUsed ?: TocRules.BUILTIN
            call.respond(
                LocalBookReparseResult(
                    success = true,
                    name = parsed.title,
                    totalChapters = parsed.chapters.size,
                    tocRuleUsed = used,
                    ruleLabel = TocRules.label(used),
                    fellBack = used == TocRules.BUILTIN && request.ruleKey == TocRules.AUTO,
                ),
            )
        }
}


